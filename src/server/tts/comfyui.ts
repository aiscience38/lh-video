import "server-only";

import { randomUUID } from "node:crypto";
import ttsTemplateJson from "@/server/catalog/comfyui-templates/qwen3-tts.json";
import {
    TtsError,
    assertTtsText,
    isMp3Audio,
    type TtsAvailability,
    type TtsSynthesisSettings,
    type TtsSynthResult,
    type TtsVoice,
} from "./contract";

/**
 * Optional ComfyUI TTS adapter for the GX10.
 *
 * It deliberately reuses the ComfyUI transport shape (`/prompt`, `/history`,
 * `/view`) instead of importing the image/video provider: the catalog template
 * parser only understands image and video outputs, and TTS must not widen that
 * contract. The shipped graph is `FB_Qwen3TTSVoiceDesign` -> `SaveAudioMP3`;
 * `/object_info` discovery decides whether the host actually exposes it.
 */

interface GraphNode {
    class_type: string;
    inputs: Record<string, unknown>;
}
type Graph = Record<string, GraphNode>;

interface VoicePreset {
    id: string;
    name: string;
    language: string;
    instruct: string;
}

interface TemplateParam {
    id: string;
    target: [string, string];
}

interface TtsTemplate {
    id: string;
    label: string;
    requiredNodes: string[];
    ttsNode: string;
    outputNode: string;
    graph: Graph;
    params: TemplateParam[];
    voices: VoicePreset[];
}

const TEMPLATE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NODE_ID = /^[1-9][0-9]{0,8}$/;
const VOICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED_PARAMS = ["text", "speaker", "language", "speed"] as const;
const LANGUAGES = ["Auto", "Chinese", "English", "Japanese", "Korean", "French", "German", "Spanish",
    "Portuguese", "Russian", "Italian"];
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const DISCOVERY_CACHE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 750;
/**
 * Qwen3TTS on a cold GX10 can spend minutes loading weights before the first
 * audio chunk; 120s reported a false timeout on a healthy job. Override with
 * COMFYUI_TTS_TIMEOUT_MS (5s..15min).
 */
function defaultTimeoutMs(): number {
    const raw = Number(process.env.COMFYUI_TTS_TIMEOUT_MS);
    return Number.isFinite(raw) && raw >= 5_000 && raw <= 900_000 ? raw : 300_000;
}
const CLIENT_ID = randomUUID();

function recordOf(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasEntries(value: unknown): boolean {
    const record = recordOf(value);
    return Boolean(record && Object.keys(record).length > 0);
}

/** The shipped template is validated once at module load; a typo fails fast. */
function parseTemplate(value: unknown): TtsTemplate {
    const record = recordOf(value);
    if (!record || typeof record.id !== "string" || !TEMPLATE_ID.test(record.id)
        || typeof record.label !== "string" || !record.label.trim()
        || !Array.isArray(record.requiredNodes) || record.requiredNodes.some(node => typeof node !== "string" || !node)
        || typeof record.ttsNode !== "string" || !NODE_ID.test(record.ttsNode)
        || typeof record.outputNode !== "string" || !NODE_ID.test(record.outputNode)) {
        throw new Error("ERR_TTS_TEMPLATE");
    }
    const graphRecord = recordOf(record.graph);
    if (!graphRecord) throw new Error("ERR_TTS_TEMPLATE");
    const graph: Graph = {};
    for (const [id, rawNode] of Object.entries(graphRecord)) {
        const node = recordOf(rawNode);
        if (!NODE_ID.test(id) || !node || typeof node.class_type !== "string" || !node.class_type
            || !recordOf(node.inputs)) throw new Error("ERR_TTS_TEMPLATE");
        graph[id] = { class_type: node.class_type, inputs: { ...recordOf(node.inputs)! } };
    }
    if (!graph[record.ttsNode] || !graph[record.outputNode]) throw new Error("ERR_TTS_TEMPLATE");
    const params: TemplateParam[] = [];
    if (!Array.isArray(record.params)) throw new Error("ERR_TTS_TEMPLATE");
    for (const rawParam of record.params) {
        const param = recordOf(rawParam);
        if (!param || typeof param.id !== "string" || !Array.isArray(param.target) || param.target.length !== 2
            || typeof param.target[0] !== "string" || typeof param.target[1] !== "string") throw new Error("ERR_TTS_TEMPLATE");
        const target = [param.target[0], param.target[1]] as [string, string];
        if (!graph[target[0]] || !Object.hasOwn(graph[target[0]].inputs, target[1])) throw new Error("ERR_TTS_TEMPLATE");
        params.push({ id: param.id, target });
    }
    for (const id of REQUIRED_PARAMS) {
        if (!params.some(param => param.id === id)) throw new Error("ERR_TTS_TEMPLATE");
    }
    if (!Array.isArray(record.voices) || !record.voices.length) throw new Error("ERR_TTS_TEMPLATE");
    const voices: VoicePreset[] = [];
    for (const rawVoice of record.voices) {
        const voice = recordOf(rawVoice);
        if (!voice || typeof voice.id !== "string" || !VOICE_ID.test(voice.id)
            || typeof voice.name !== "string" || !voice.name.trim()
            || typeof voice.language !== "string" || !voice.language.trim()
            || typeof voice.instruct !== "string" || !voice.instruct.trim()) throw new Error("ERR_TTS_TEMPLATE");
        if (voices.some(existing => existing.id === voice.id)) throw new Error("ERR_TTS_TEMPLATE");
        voices.push({ id: voice.id, name: voice.name.trim(), language: voice.language.trim(), instruct: voice.instruct.trim() });
    }
    return {
        id: record.id, label: record.label.trim(), requiredNodes: record.requiredNodes as string[],
        ttsNode: record.ttsNode, outputNode: record.outputNode, graph, params, voices,
    };
}

const TEMPLATE = parseTemplate(ttsTemplateJson);

export interface ComfyuiTtsOptions {
    /** Test seam; production reads `COMFYUI_BASE_URL`. */
    baseUrl?: string;
    /** Optional LAN bearer token, matching the ComfyUI provider convention. */
    apiKey?: string;
    fetcher?: typeof fetch;
    now?: () => number;
    pollIntervalMs?: number;
    timeoutMs?: number;
}

interface DiscoveryCache {
    baseUrl: string;
    expiresAt: number;
    nodes: string[];
}

let discoveryCache: DiscoveryCache | undefined;

function baseUrlOf(options: ComfyuiTtsOptions): string | undefined {
    const raw = (options.baseUrl ?? process.env.COMFYUI_BASE_URL ?? "").trim();
    if (!raw) return undefined;
    try {
        const url = new URL(raw);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
            || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return undefined;
        return url.origin;
    } catch {
        return undefined;
    }
}

function requireBaseUrl(options: ComfyuiTtsOptions): string {
    const baseUrl = baseUrlOf(options);
    if (!baseUrl) throw new TtsError("not_configured", "ERR_TTS_NO_BASE_URL");
    return baseUrl;
}

function headersOf(options: ComfyuiTtsOptions, json: boolean): Record<string, string> {
    const secret = (options.apiKey ?? process.env.COMFYUI_API_KEY ?? "").trim();
    return {
        Accept: "application/json",
        ...(json ? { "Content-Type": "application/json" } : {}),
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    };
}

function retryAfterSeconds(value: string | null): number | undefined {
    if (!value) return undefined;
    if (/^\d{1,6}$/.test(value.trim())) return Math.min(Number(value.trim()), 86_400);
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.max(0, Math.min(Math.ceil((parsed - Date.now()) / 1000), 86_400));
}

function statusError(status: number, retryAfter: string | null): TtsError {
    if (status === 401 || status === 403) return new TtsError("auth", "ERR_TTS_AUTH", status);
    if (status === 429) return new TtsError("quota", "ERR_TTS_QUOTA", status, retryAfterSeconds(retryAfter));
    if (status >= 500) return new TtsError("upstream_down", "ERR_TTS_UPSTREAM_DOWN", status);
    return new TtsError("invalid_request", "ERR_TTS_INVALID_REQUEST", status);
}

async function send(options: ComfyuiTtsOptions, url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
    try {
        return await (options.fetcher ?? fetch)(url, {
            ...init,
            cache: "no-store",
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        throw new TtsError("upstream_down", "ERR_TTS_UPSTREAM_DOWN");
    }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        throw new TtsError("malformed_result", "ERR_TTS_MALFORMED_RESULT", response.status);
    }
    const record = recordOf(payload);
    if (!record) throw new TtsError("malformed_result", "ERR_TTS_MALFORMED_RESULT", response.status);
    return record;
}

/**
 * GET /object_info, cached for 60 s. Used to prove the host really exposes the
 * shipped node classes before the voices endpoint advertises presets.
 */
export async function discoverComfyuiTts(options: ComfyuiTtsOptions = {}): Promise<{ nodes: string[]; supported: boolean }> {
    const baseUrl = requireBaseUrl(options);
    const now = options.now?.() ?? Date.now();
    if (discoveryCache && discoveryCache.baseUrl === baseUrl && discoveryCache.expiresAt > now) {
        return { nodes: [...discoveryCache.nodes], supported: isSupported(discoveryCache.nodes) };
    }
    const response = await send(options, `${baseUrl}/object_info`, {
        method: "GET", headers: headersOf(options, false),
    }, 20_000);
    if (!response.ok) {
        await response.body?.cancel();
        throw statusError(response.status, response.headers.get("retry-after"));
    }
    const payload = await readJson(response);
    const nodes = Object.keys(payload);
    discoveryCache = { baseUrl, expiresAt: Date.now() + DISCOVERY_CACHE_MS, nodes };
    return { nodes: [...nodes], supported: isSupported(nodes) };
}

function isSupported(nodes: readonly string[]): boolean {
    return TEMPLATE.requiredNodes.every(node => nodes.includes(node));
}

/**
 * Never throws: mirrors the ElevenLabs availability contract so the providers
 * endpoint can render a disabled row without a failed request.
 */
export async function comfyuiAvailability(options: ComfyuiTtsOptions = {}): Promise<TtsAvailability> {
    const baseUrl = baseUrlOf(options);
    if (!baseUrl) return { configured: false, reachable: false, reason: "no_base_url" };
    try {
        const response = await send(options, `${baseUrl}/system_stats`, {
            method: "GET", headers: headersOf(options, false),
        }, 8_000);
        await response.body?.cancel();
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                return { configured: true, reachable: true, reason: "unauthorized" };
            }
            return { configured: true, reachable: false, reason: "upstream_down" };
        }
        return { configured: true, reachable: true };
    } catch {
        return { configured: true, reachable: false, reason: "upstream_down" };
    }
}

/** The shipped presets are only listed when /object_info confirms the nodes. */
export async function listComfyuiTtsVoices(options: ComfyuiTtsOptions = {}): Promise<TtsVoice[]> {
    const discovery = await discoverComfyuiTts(options);
    if (!discovery.supported) return [];
    return TEMPLATE.voices.map(({ id, name, language }) => ({ id, name, language }));
}

function instructionFor(speaker: string | undefined, speed: number | undefined): string {
    const requested = (speaker ?? "").trim();
    const preset = TEMPLATE.voices.find(voice => voice.id === requested);
    const fallback = typeof TEMPLATE.graph[TEMPLATE.ttsNode].inputs.instruct === "string"
        ? String(TEMPLATE.graph[TEMPLATE.ttsNode].inputs.instruct)
        : TEMPLATE.voices[0].instruct;
    const base = preset?.instruct ?? (requested || fallback);
    const rate = speed ?? 1;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0.5 || rate > 2) {
        throw new TtsError("invalid_request", "ERR_TTS_SETTINGS");
    }
    const pace = rate === 1 ? "" : ` Speak at approximately ${rate.toFixed(2).replace(/\.?0+$/, "")}x the normal pace.`;
    return `${base}${pace}`.slice(0, 2000);
}

/** Exported for tests: the graph is data, so it can be asserted without a host. */
export function buildComfyuiTtsGraph(text: string, settings: TtsSynthesisSettings = {}): Graph {
    assertTtsText(text);
    const language = (settings.language ?? "Auto").trim();
    if (!LANGUAGES.includes(language)) throw new TtsError("invalid_request", "ERR_TTS_LANGUAGE");
    const graph = structuredClone(TEMPLATE.graph);
    const node = graph[TEMPLATE.ttsNode];
    node.inputs.text = text.trim();
    node.inputs.language = language;
    node.inputs.instruct = instructionFor(settings.speaker, settings.speed);
    return graph;
}

interface AudioReference {
    filename: string;
    subfolder: string;
    type: string;
}

function audioReference(entry: Record<string, unknown>): AudioReference | undefined {
    const outputs = recordOf(entry.outputs);
    if (!outputs) return undefined;
    const node = recordOf(outputs[TEMPLATE.outputNode]);
    if (!node || !Array.isArray(node.audio) || !node.audio.length) return undefined;
    const item = recordOf(node.audio[0]);
    if (!item) throw new TtsError("malformed_result", "ERR_TTS_MALFORMED_RESULT");
    const filename = item.filename;
    const subfolder = item.subfolder ?? "";
    const type = item.type ?? "output";
    if (typeof filename !== "string" || !filename || filename.length > 512 || /[\\/]/.test(filename)
        || typeof subfolder !== "string" || subfolder.length > 512 || subfolder.split("/").some(part => part === "..")
        || !["output", "temp", "input"].includes(String(type))) {
        throw new TtsError("malformed_result", "ERR_TTS_MALFORMED_RESULT");
    }
    return { filename, subfolder, type: String(type) };
}

/** Mirrors the image/video adapter's history failure parsing. */
function executionFailure(entry: Record<string, unknown>): TtsError | undefined {
    const status = recordOf(entry.status) ?? {};
    const messages = Array.isArray(status.messages) ? status.messages : [];
    for (const message of messages) {
        if (!Array.isArray(message) || message.length !== 2) continue;
        const [kind, info] = message;
        const data = recordOf(info) ?? {};
        if (kind === "execution_error") {
            return hasEntries(data.node_errors)
                ? new TtsError("invalid_request", "ERR_TTS_NODE_ERRORS")
                : new TtsError("upstream_down", "ERR_TTS_EXECUTION_FAILED");
        }
        if (kind === "execution_interrupted") return new TtsError("upstream_down", "ERR_TTS_INTERRUPTED");
    }
    if (hasEntries(entry.node_errors) || hasEntries(status.node_errors)) {
        return new TtsError("invalid_request", "ERR_TTS_NODE_ERRORS");
    }
    if (status.status_str === "error") return new TtsError("upstream_down", "ERR_TTS_EXECUTION_FAILED");
    return undefined;
}

function completed(entry: Record<string, unknown>): boolean {
    const status = recordOf(entry.status);
    return Boolean(status && (status.completed === true || status.status_str === "success"));
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function submit(options: ComfyuiTtsOptions, baseUrl: string, graph: Graph): Promise<string> {
    const response = await send(options, `${baseUrl}/prompt`, {
        method: "POST",
        headers: headersOf(options, true),
        body: JSON.stringify({ prompt: graph, client_id: CLIENT_ID }),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw statusError(response.status, response.headers.get("retry-after"));
    }
    const payload = await readJson(response);
    // A queued prompt with rejected nodes is never a submission.
    if (hasEntries(payload.node_errors)) throw new TtsError("invalid_request", "ERR_TTS_NODE_ERRORS");
    const promptId = payload.prompt_id;
    if (typeof promptId !== "string" || !PROMPT_ID.test(promptId)) {
        throw new TtsError("malformed_result", "ERR_TTS_MALFORMED_RESULT");
    }
    return promptId;
}

async function downloadAudio(options: ComfyuiTtsOptions, baseUrl: string, reference: AudioReference): Promise<Uint8Array> {
    const url = `${baseUrl}/view?filename=${encodeURIComponent(reference.filename)}`
        + `&subfolder=${encodeURIComponent(reference.subfolder)}&type=${encodeURIComponent(reference.type)}`;
    const response = await send(options, url, { method: "GET", headers: headersOf(options, false) });
    if (!response.ok) {
        await response.body?.cancel();
        throw statusError(response.status, response.headers.get("retry-after"));
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
        await response.body?.cancel();
        throw new TtsError("malformed_result", "ERR_TTS_AUDIO_TOO_LARGE");
    }
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
        throw new TtsError("malformed_result", "ERR_TTS_MALFORMED_RESULT");
    }
    if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES || !isMp3Audio(bytes)) {
        throw new TtsError("malformed_result", "ERR_TTS_MALFORMED_RESULT");
    }
    return bytes;
}

/**
 * POST /prompt, poll GET /history/{prompt_id}, then download GET /view.
 * Like the image adapter there is no automatic re-submission: a timeout leaves
 * the queued prompt observable on the host instead of silently queuing a
 * second render.
 */
export async function synthesizeComfyui(
    text: string,
    settings: TtsSynthesisSettings = {},
    options: ComfyuiTtsOptions = {},
): Promise<TtsSynthResult> {
    const baseUrl = requireBaseUrl(options);
    const graph = buildComfyuiTtsGraph(text, settings);
    const promptId = await submit(options, baseUrl, graph);
    const deadline = Date.now() + (options.timeoutMs ?? defaultTimeoutMs());
    const interval = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    for (;;) {
        const response = await send(options, `${baseUrl}/history/${promptId}`, {
            method: "GET", headers: headersOf(options, false),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw statusError(response.status, response.headers.get("retry-after"));
        }
        const history = await readJson(response);
        const entry = recordOf(history[promptId]);
        if (entry) {
            const failure = executionFailure(entry);
            if (failure) throw failure;
            const reference = audioReference(entry);
            if (reference) {
                const bytes = await downloadAudio(options, baseUrl, reference);
                return { bytes, mimeType: "audio/mpeg" };
            }
            if (completed(entry)) throw new TtsError("malformed_result", "ERR_TTS_MALFORMED_RESULT");
        }
        if (Date.now() >= deadline) throw new TtsError("upstream_down", "ERR_TTS_TIMEOUT");
        await sleep(interval);
    }
}
