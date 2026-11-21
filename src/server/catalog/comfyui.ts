import "server-only";

import { z } from "zod";
import qwenT2i from "./comfyui-templates/qwen-t2i.json";
import type { CustomFieldCapability, ImageModelCapability, MediaSlotCapability } from "@/models/capabilities/types";

/**
 * ComfyUI graphs are data, not code: the reviewed JSON templates below are
 * validated with zod (and cross-referenced against the node graph) before any
 * request is built. Only documented GX10 node classes are used.
 */
export type ComfyuiMode = "image" | "video";
export type ComfyuiGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export interface ComfyuiTemplateParam {
    id: string;
    label: string;
    type: "string" | "number" | "integer";
    target: [string, string];
    required?: boolean;
    default?: string | number;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    description?: string;
}

export interface ComfyuiTemplateMediaSlot {
    id: string;
    label: string;
    kind: "image" | "video" | "audio";
    target: [string, string];
    required?: boolean;
    description?: string;
}

export interface ComfyuiTemplateOutput {
    node: string;
    kind: "image" | "video";
    mimeType?: string;
}

export interface ComfyuiTemplate {
    id: string;
    label: string;
    family: string;
    description?: string;
    mode: ComfyuiMode;
    source: string;
    graph: ComfyuiGraph;
    params: ComfyuiTemplateParam[];
    mediaSlots: ComfyuiTemplateMediaSlot[];
    outputs: ComfyuiTemplateOutput[];
}

const nodeId = z.string().regex(/^[1-9][0-9]{0,8}$/);
const inputName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const graphNode = z.strictObject({
    class_type: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,119}$/),
    inputs: z.record(inputName, z.unknown()),
});
const target = z.tuple([nodeId, inputName]);
const param = z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    label: z.string().trim().min(1).max(120),
    type: z.enum(["string", "number", "integer"]),
    target,
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number()]).optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    minLength: z.number().int().nonnegative().max(100_000).optional(),
    maxLength: z.number().int().positive().max(100_000).optional(),
    description: z.string().trim().min(1).max(400).optional(),
});
const mediaSlot = z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    label: z.string().trim().min(1).max(120),
    kind: z.enum(["image", "video", "audio"]),
    target,
    required: z.boolean().optional(),
    description: z.string().trim().min(1).max(400).optional(),
});
const output = z.strictObject({
    node: nodeId,
    kind: z.enum(["image", "video"]),
    mimeType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]{1,80}$/).optional(),
});
const template = z.strictObject({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    label: z.string().trim().min(1).max(120),
    family: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(400).optional(),
    mode: z.enum(["image", "video"]),
    source: z.string().trim().min(1).max(300),
    graph: z.record(nodeId, graphNode),
    params: z.array(param).max(64),
    mediaSlots: z.array(mediaSlot).max(16),
    outputs: z.array(output).min(1).max(8),
});

/** A template may only target inputs that exist and are not links to another node. */
export function parseComfyuiTemplate(value: unknown): ComfyuiTemplate {
    const parsed = template.safeParse(value);
    if (!parsed.success) throw new Error("ERR_COMFYUI_TEMPLATE");
    const result = parsed.data as unknown as ComfyuiTemplate;
    const ids = new Set<string>();
    for (const item of result.params) {
        if (ids.has(item.id)) throw new Error("ERR_COMFYUI_TEMPLATE");
        ids.add(item.id);
        const node = result.graph[item.target[0]];
        if (!node || !Object.hasOwn(node.inputs, item.target[1]) || Array.isArray(node.inputs[item.target[1]])) throw new Error("ERR_COMFYUI_TEMPLATE");
        if (item.minimum !== undefined && item.maximum !== undefined && item.minimum > item.maximum) throw new Error("ERR_COMFYUI_TEMPLATE");
        if (item.minLength !== undefined && item.maxLength !== undefined && item.minLength > item.maxLength) throw new Error("ERR_COMFYUI_TEMPLATE");
        if (item.default !== undefined && !validateComfyuiParam(item, item.default)) throw new Error("ERR_COMFYUI_TEMPLATE");
    }
    for (const slot of result.mediaSlots) {
        if (ids.has(slot.id)) throw new Error("ERR_COMFYUI_TEMPLATE");
        ids.add(slot.id);
        const node = result.graph[slot.target[0]];
        if (!node || !Object.hasOwn(node.inputs, slot.target[1]) || Array.isArray(node.inputs[slot.target[1]])) throw new Error("ERR_COMFYUI_TEMPLATE");
    }
    if (new Set(result.mediaSlots.map(slot => slot.id)).size !== result.mediaSlots.length) throw new Error("ERR_COMFYUI_TEMPLATE");
    for (const item of result.outputs) if (!result.graph[item.node]) throw new Error("ERR_COMFYUI_TEMPLATE");
    return result;
}

export function validateComfyuiParam(rule: ComfyuiTemplateParam, value: unknown): boolean {
    if (rule.type === "string") {
        if (typeof value !== "string") return false;
        if (rule.minLength !== undefined && value.length < rule.minLength) return false;
        return rule.maxLength === undefined || value.length <= rule.maxLength;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (rule.type === "integer" && !Number.isSafeInteger(value)) return false;
    if (rule.minimum !== undefined && value < rule.minimum) return false;
    return rule.maximum === undefined || value <= rule.maximum;
}

const templates = [parseComfyuiTemplate(qwenT2i)];
export const COMFYUI_TEMPLATES: Record<string, ComfyuiTemplate> = Object.fromEntries(templates.map(entry => [entry.id, entry]));

/**
 * Imported templates are persisted by the provider store and registered here
 * before capability validation. The reviewed JSON templates above stay in the
 * read-only map so a test can prove the shipped set.
 */
const importedTemplates = new Map<string, ComfyuiTemplate>();

export function registerComfyuiTemplates(values: readonly ComfyuiTemplate[]): void {
    for (const value of values) {
        const template = parseComfyuiTemplate(value);
        if (Object.hasOwn(COMFYUI_TEMPLATES, template.id)) continue;
        importedTemplates.set(template.id, template);
    }
}

export function unregisterComfyuiTemplate(id: string): void {
    importedTemplates.delete(id);
}

export function listImportedComfyuiTemplates(): ComfyuiTemplate[] {
    return [...importedTemplates.values()];
}

export function getComfyuiTemplate(id: string | undefined, mode?: ComfyuiMode): ComfyuiTemplate | undefined {
    const entry = id ? COMFYUI_TEMPLATES[id] ?? importedTemplates.get(id) : undefined;
    return entry && (!mode || entry.mode === mode) ? entry : undefined;
}

/** Parameters with a canonical control are not duplicated as custom fields. */
const CANONICAL = new Set(["prompt"]);

function customField(rule: ComfyuiTemplateParam): CustomFieldCapability {
    return rule.type === "string"
        ? { id: rule.id, label: rule.label, type: "text", ...(rule.required ? { required: true } : {}),
            ...(rule.minLength !== undefined ? { minLength: rule.minLength } : {}),
            ...(rule.maxLength !== undefined ? { maxLength: rule.maxLength } : {}),
            ...(typeof rule.default === "string" ? { default: rule.default } : {}),
            ...(rule.description ? { description: rule.description } : {}) }
        : { id: rule.id, label: rule.label, type: "number", ...(rule.required ? { required: true } : {}),
            ...(rule.type === "integer" ? { step: 1 } : {}),
            ...(rule.minimum !== undefined ? { minimum: rule.minimum } : {}),
            ...(rule.maximum !== undefined ? { maximum: rule.maximum } : {}),
            ...(typeof rule.default === "number" ? { default: rule.default } : {}),
            ...(rule.description ? { description: rule.description } : {}) };
}

function capabilitySlot(slot: ComfyuiTemplateMediaSlot): MediaSlotCapability {
    return { id: slot.id, label: slot.label, kind: slot.kind, required: slot.required, multiple: false,
        max_count: 1, min_count: slot.required ? 1 : 0, accept: "url_only",
        ...(slot.description ? { description: slot.description } : {}) };
}

/** The template's parameters are the only surface this adapter exposes to the UI. */
export function comfyuiCapabilities(template: ComfyuiTemplate): ImageModelCapability {
    const find = (id: string) => template.params.find(entry => entry.id === id);
    const prompt = find("prompt");
    const seed = find("seed");
    return {
        id: `comfyui:${template.id}`,
        label: template.label,
        family: template.family,
        variant: "ComfyUI",
        group: "ComfyUI",
        category: "Generate",
        provider: "comfyui",
        provider_model_id: template.id,
        provider_mode: "image-model",
        prompt_required: true,
        prompt_supported: true,
        ...(prompt?.maxLength !== undefined ? { prompt_max: prompt.maxLength } : {}),
        duration: false,
        aspect_ratio: false,
        size: false,
        resolution_variant: false,
        negative_prompt: Boolean(find("negative_prompt")),
        cfg_scale: Boolean(find("cfg")),
        style: false,
        shot_type: false,
        prompt_expansion: false,
        elements: false,
        ...(seed ? { seed: { minimum: seed.minimum ?? 0, maximum: seed.maximum ?? 4294967295 } } : {}),
        media_slots: template.mediaSlots.map(capabilitySlot),
        custom_fields: template.params.filter(rule => !CANONICAL.has(rule.id)).map(customField),
        has_edit_variant: false,
        sort_key: 1,
    };
}

export const COMFYUI_IMAGE_CAPABILITIES: Record<string, ImageModelCapability> = Object.fromEntries(
    templates.filter(entry => entry.mode === "image").map(entry => [`comfyui:${entry.id}`, comfyuiCapabilities(entry)]),
);
