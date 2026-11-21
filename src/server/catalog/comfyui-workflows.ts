import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { STORAGE_ROOT } from "@/server/config/storage-paths";
import { readBoundedResponse } from "@/server/media/transfer";
import { parseComfyuiTemplate, type ComfyuiGraph, type ComfyuiTemplate, type ComfyuiTemplateParam } from "./comfyui";

/**
 * Imported workflows are ComfyUI API-format graphs. The node classes are
 * checked against a cached GET /object_info allowlist so a typo or a node that
 * is not installed on the target host is rejected before anything is saved.
 * The cache is written under the private storage root; importing never talks to
 * the generation endpoints and never submits a prompt.
 */
export const COMFYUI_NODE_CACHE = path.join(STORAGE_ROOT, "comfyui-object-info.json");
const MAX_WORKFLOW_BYTES = 512 * 1024;
const MAX_NODES = 512;
const MAX_INPUTS = 20_000;
const MAX_CLASSES = 20_000;
const NODE_ID = /^[1-9][0-9]{0,8}$/;
const INPUT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const CLASS_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,119}$/;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

export class ComfyWorkflowError extends Error {
    constructor(readonly code: string, readonly detail?: string) {
        super(code);
        this.name = "ComfyWorkflowError";
    }
}

const fail = (code: string, detail?: string): never => { throw new ComfyWorkflowError(code, detail); };

export type ComfyuiCanonicalKey = "prompt" | "negative_prompt" | "width" | "height" | "seed" | "cfg";

export const COMFYUI_CANONICAL_KEYS: readonly ComfyuiCanonicalKey[] = ["prompt", "negative_prompt", "width", "height", "seed", "cfg"];

interface CanonicalRule {
    label: string;
    type: ComfyuiTemplateParam["type"];
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    fallback: string | number | undefined;
}

const RULES: Record<ComfyuiCanonicalKey, CanonicalRule> = {
    prompt: { label: "Prompt", type: "string", required: true, maxLength: 4096, fallback: undefined },
    negative_prompt: { label: "Negative prompt", type: "string", maxLength: 2048, fallback: "" },
    width: { label: "Width", type: "integer", minimum: 64, maximum: 8192, fallback: 1024 },
    height: { label: "Height", type: "integer", minimum: 64, maximum: 8192, fallback: 1024 },
    seed: { label: "Seed", type: "integer", minimum: 0, maximum: 4_294_967_295, fallback: 0 },
    cfg: { label: "CFG", type: "number", minimum: 0, maximum: 100, fallback: 1 },
};

/** Image output classes this image-only adapter can collect from /history. */
const OUTPUT_CLASSES: Record<string, string> = {
    SaveImage: "image/png",
    SaveAnimatedWEBP: "image/webp",
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedWalk(value: unknown): void {
    const pending = [{ value, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
        const item = pending.pop()!;
        if (++nodes > MAX_INPUTS) fail("ERR_COMFYUI_WORKFLOW_INVALID");
        if (!isRecord(item.value) && !Array.isArray(item.value)) continue;
        if (item.depth > 12) fail("ERR_COMFYUI_WORKFLOW_INVALID");
        for (const [key, child] of Object.entries(item.value)) {
            if (unsafeKeys.has(key)) fail("ERR_COMFYUI_WORKFLOW_INVALID");
            pending.push({ value: child, depth: item.depth + 1 });
        }
    }
}

/** Parse and structurally validate an API-format prompt graph. */
export function parseComfyuiWorkflowGraph(json: string): ComfyuiGraph {
    if (typeof json !== "string" || !json.trim()) fail("ERR_COMFYUI_WORKFLOW_JSON");
    if (Buffer.byteLength(json, "utf8") > MAX_WORKFLOW_BYTES) fail("ERR_COMFYUI_WORKFLOW_INVALID", "Workflow JSON is too large.");
    let value: unknown;
    try { value = JSON.parse(json); } catch { return fail("ERR_COMFYUI_WORKFLOW_JSON"); }
    if (!isRecord(value)) fail("ERR_COMFYUI_WORKFLOW_INVALID", "An API-format graph is an object keyed by node id.");
    const graph = value as Record<string, unknown>;
    const ids = Object.keys(graph);
    if (!ids.length) fail("ERR_COMFYUI_WORKFLOW_INVALID", "The workflow has no nodes.");
    if (ids.length > MAX_NODES) fail("ERR_COMFYUI_WORKFLOW_INVALID", "The workflow has too many nodes.");
    boundedWalk(graph);
    const result: ComfyuiGraph = {};
    for (const id of ids) {
        if (!NODE_ID.test(id)) fail("ERR_COMFYUI_WORKFLOW_INVALID", `Node id "${id.slice(0, 40)}" is not an API-format id.`);
        const node = graph[id];
        if (!isRecord(node)) throw new ComfyWorkflowError("ERR_COMFYUI_WORKFLOW_INVALID", `Node ${id} must contain class_type and inputs.`);
        if (Object.keys(node).some(key => !["class_type", "inputs", "_meta"].includes(key))) {
            throw new ComfyWorkflowError("ERR_COMFYUI_WORKFLOW_INVALID", `Node ${id} must contain class_type and inputs.`);
        }
        const classType = node.class_type;
        const inputs = node.inputs;
        if (typeof classType !== "string" || !CLASS_TYPE.test(classType) || !isRecord(inputs)) {
            throw new ComfyWorkflowError("ERR_COMFYUI_WORKFLOW_INVALID", `Node ${id} must contain class_type and inputs.`);
        }
        let inputCount = 0;
        for (const [name, input] of Object.entries(inputs as Record<string, unknown>)) {
            if (!INPUT_NAME.test(name)) fail("ERR_COMFYUI_WORKFLOW_INVALID", `Node ${id} has an invalid input name.`);
            if (++inputCount > MAX_INPUTS) fail("ERR_COMFYUI_WORKFLOW_INVALID");
            // API-format links are always [sourceNodeId, sourceOutputIndex].
            if (!Array.isArray(input)) continue;
            if (input.length !== 2 || typeof input[0] !== "string" || !NODE_ID.test(input[0])
                || !Number.isInteger(input[1]) || (input[1] as number) < 0 || (input[1] as number) > 4095) {
                fail("ERR_COMFYUI_WORKFLOW_INVALID", `Node ${id}.${name} has an invalid link.`);
            }
            if (!Object.hasOwn(graph, input[0])) fail("ERR_COMFYUI_WORKFLOW_INVALID", `Node ${id}.${name} links to a missing node.`);
        }
        result[id] = { class_type: classType, inputs: inputs as Record<string, unknown> };
    }
    return result;
}

export function graphInputTargets(graph: ComfyuiGraph): Array<{ node: string; input: string; literal: string | number | boolean | null }> {
    return Object.entries(graph).flatMap(([node, value]) => Object.entries(value.inputs)
        .filter(([, input]) => !Array.isArray(input))
        .map(([input, literal]) => ({ node, input, literal: literal === undefined ? null : literal as string | number | boolean | null })));
}

export function targetKey(node: string, input: string): string {
    return `${node}.${input}`;
}

/** Cached /object_info class list. A stale-but-readable cache is enough to validate imports. */
export async function readComfyuiNodeCache(): Promise<{ classes: string[]; fetchedAt: string } | undefined> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(COMFYUI_NODE_CACHE, "utf8"));
        if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.classes) || !parsed.classes.length
            || parsed.classes.length > MAX_CLASSES || typeof parsed.fetchedAt !== "string") return undefined;
        const classes = parsed.classes.filter((entry): entry is string => typeof entry === "string" && CLASS_TYPE.test(entry));
        return classes.length ? { classes: [...new Set(classes)].sort(), fetchedAt: parsed.fetchedAt } : undefined;
    } catch { return undefined; }
}

async function writeComfyuiNodeCache(classes: string[]): Promise<string> {
    const fetchedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(COMFYUI_NODE_CACHE), { recursive: true });
    const temporary = `${COMFYUI_NODE_CACHE}.${process.pid}.tmp`;
    try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, fetchedAt, classes }), "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, COMFYUI_NODE_CACHE);
    } catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
    return fetchedAt;
}

/**
 * Return the node classes advertised by GET /object_info. Cached results are
 * reused unless `refresh` is requested; only class names are kept on disk.
 */
export async function getComfyuiNodeClasses(options: { baseUrl: string; secret?: string; refresh?: boolean; fetcher?: typeof fetch }): Promise<{ classes: string[]; fetchedAt: string; cached: boolean }> {
    if (!options.refresh) {
        const cached = await readComfyuiNodeCache();
        if (cached) return { ...cached, cached: true };
    }
    const fetcher = options.fetcher ?? fetch;
    let response: Response;
    try {
        response = await fetcher(`${options.baseUrl}/object_info`, {
            method: "GET", cache: "no-store", signal: AbortSignal.timeout(15_000),
            headers: { Accept: "application/json", ...(options.secret ? { Authorization: `Bearer ${options.secret}` } : {}) },
        });
    } catch { return fail("ERR_COMFYUI_NODE_LIST"); }
    if (!response.ok) { await response.body?.cancel(); return fail("ERR_COMFYUI_NODE_LIST"); }
    let payload: unknown;
    try { payload = JSON.parse((await readBoundedResponse(response, { maxBytes: 8 * 1024 * 1024 })).toString("utf8")); }
    catch { return fail("ERR_COMFYUI_NODE_LIST"); }
    if (!isRecord(payload)) fail("ERR_COMFYUI_NODE_LIST");
    const classes = Object.keys(payload as Record<string, unknown>).filter(entry => CLASS_TYPE.test(entry)).slice(0, MAX_CLASSES).sort();
    if (!classes.length) fail("ERR_COMFYUI_NODE_LIST");
    return { classes, fetchedAt: await writeComfyuiNodeCache(classes), cached: false };
}

export interface ComfyuiWorkflowImport {
    id: string;
    label: string;
    family?: string;
    description?: string;
    json: string;
    mapping: Partial<Record<ComfyuiCanonicalKey, [string, string]>>;
    output: string;
}

function parseMapping(value: unknown): Partial<Record<ComfyuiCanonicalKey, [string, string]>> {
    if (!isRecord(value)) throw new ComfyWorkflowError("ERR_COMFYUI_WORKFLOW_MAPPING");
    const mapping: Partial<Record<ComfyuiCanonicalKey, [string, string]>> = {};
    for (const [key, target] of Object.entries(value)) {
        if (!COMFYUI_CANONICAL_KEYS.includes(key as ComfyuiCanonicalKey)) fail("ERR_COMFYUI_WORKFLOW_MAPPING");
        if (target === null || target === undefined || target === "") continue;
        if (!Array.isArray(target) || target.length !== 2) throw new ComfyWorkflowError("ERR_COMFYUI_WORKFLOW_MAPPING");
        const [node, input] = target;
        if (typeof node !== "string" || typeof input !== "string" || !NODE_ID.test(node) || !INPUT_NAME.test(input)) throw new ComfyWorkflowError("ERR_COMFYUI_WORKFLOW_MAPPING");
        mapping[key as ComfyuiCanonicalKey] = [node, input];
    }
    return mapping;
}

function paramFor(key: ComfyuiCanonicalKey, target: [string, string], graph: ComfyuiGraph): ComfyuiTemplateParam {
    const rule = RULES[key];
    const literal = graph[target[0]].inputs[target[1]];
    let value: string | number | undefined;
    if (key === "prompt" || key === "negative_prompt") {
        if (typeof literal !== "string") fail("ERR_COMFYUI_WORKFLOW_MAPPING", `${rule.label} must target a text input.`);
        value = key === "negative_prompt" ? "" : undefined;
    } else {
        if (typeof literal !== "number" || !Number.isFinite(literal)) fail("ERR_COMFYUI_WORKFLOW_MAPPING", `${rule.label} must target a numeric input.`);
        const numeric = literal as number;
        value = numeric >= (rule.minimum ?? -Infinity) && numeric <= (rule.maximum ?? Infinity)
            && (rule.type !== "integer" || Number.isSafeInteger(numeric)) ? numeric : rule.fallback as number;
    }
    return {
        id: key, label: rule.label, type: rule.type, target,
        ...(rule.required ? { required: true } : {}),
        ...(value !== undefined ? { default: value } : {}),
        ...(rule.minLength !== undefined ? { minLength: rule.minLength } : {}),
        ...(rule.maxLength !== undefined ? { maxLength: rule.maxLength } : {}),
        ...(rule.minimum !== undefined ? { minimum: rule.minimum } : {}),
        ...(rule.maximum !== undefined ? { maximum: rule.maximum } : {}),
    };
}

/**
 * Compile an imported API-format graph into the same reviewed template shape
 * the adapter already consumes. Unknown node classes never reach persistence.
 */
export function compileComfyuiWorkflow(input: unknown, allowlist: readonly string[]): ComfyuiTemplate {
    if (!isRecord(input)) fail("ERR_COMFYUI_WORKFLOW_INVALID");
    const body = input as Record<string, unknown>;
    if (typeof body.id !== "string" || typeof body.label !== "string" || typeof body.json !== "string" || typeof body.output !== "string") {
        fail("ERR_COMFYUI_WORKFLOW_INVALID");
    }
    const id = (body.id as string).trim();
    const label = (body.label as string).trim();
    const family = typeof body.family === "string" && body.family.trim() ? body.family.trim() : "ComfyUI";
    const description = typeof body.description === "string" && body.description.trim() ? body.description.trim() : undefined;
    if (!id || id.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) fail("ERR_COMFYUI_WORKFLOW_INVALID", "The template id must be lowercase letters, digits and single hyphens.");
    if (!label || label.length > 120) fail("ERR_COMFYUI_WORKFLOW_INVALID", "The template name is too long.");
    if (family.length > 120) fail("ERR_COMFYUI_WORKFLOW_INVALID");
    if (description && description.length > 400) fail("ERR_COMFYUI_WORKFLOW_INVALID");
    const graph = parseComfyuiWorkflowGraph(body.json as string);
    const known = new Set(allowlist);
    const unknown = [...new Set(Object.values(graph).map(node => node.class_type).filter(classType => !known.has(classType)))];
    if (unknown.length) fail("ERR_COMFYUI_WORKFLOW_NODE", `Unknown node classes: ${unknown.slice(0, 5).join(", ")}`);
    const mapping = parseMapping(body.mapping);
    if (!mapping.prompt) fail("ERR_COMFYUI_WORKFLOW_MAPPING", "Map a graph input to the prompt parameter.");
    const output = (body.output as string).trim();
    if (!NODE_ID.test(output) || !Object.hasOwn(graph, output)) fail("ERR_COMFYUI_WORKFLOW_OUTPUT");
    const mimeType = OUTPUT_CLASSES[graph[output].class_type];
    if (!mimeType) fail("ERR_COMFYUI_WORKFLOW_OUTPUT", "Choose a SaveImage or SaveAnimatedWEBP output node.");
    const used = new Set<string>();
    const params: ComfyuiTemplateParam[] = [];
    for (const key of COMFYUI_CANONICAL_KEYS) {
        const target = mapping[key];
        if (!target) continue;
        const node = graph[target[0]];
        if (!node || !Object.hasOwn(node.inputs, target[1]) || Array.isArray(node.inputs[target[1]])) {
            fail("ERR_COMFYUI_WORKFLOW_MAPPING", `${RULES[key].label} targets a missing or linked input.`);
        }
        const keyOfTarget = targetKey(target[0], target[1]);
        if (used.has(keyOfTarget)) fail("ERR_COMFYUI_WORKFLOW_MAPPING", "Two parameters target the same input.");
        used.add(keyOfTarget);
        params.push(paramFor(key, target, graph));
    }
    const template = {
        id, label, family, ...(description ? { description } : {}), mode: "image" as const,
        source: "custom workflow import",
        graph, params, mediaSlots: [],
        outputs: [{ node: output, kind: "image" as const, mimeType }],
    };
    try { return parseComfyuiTemplate(template); }
    catch { return fail("ERR_COMFYUI_WORKFLOW_INVALID"); }
}
