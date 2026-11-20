import "server-only";

import { randomUUID } from "node:crypto";
import { parseModelFields } from "@/models/parameter-schema";
import type { GeneratedAsset, GenerationProvider, ProviderConnectionContext, ProviderGenerationRequest, ProviderPollRequest, ProviderPollResult, ProviderSubmission } from "@/providers/types";
import { getComfyuiTemplate, validateComfyuiParam, type ComfyuiGraph, type ComfyuiTemplate } from "@/server/catalog/comfyui";
import { boundResponseBody, fetchRemoteMedia, mediaByteLimit } from "@/server/media/transfer";
import { createProviderTransport, invalidProviderResponse, providerHttpError, providerObject, ProviderRequestError } from "./request-error";
import { getMediaSlot } from "./utils";

/** Stable for the lifetime of the process, as the ComfyUI contract expects. */
const CLIENT_ID = randomUUID();
const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME_TYPES: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
};
type Json = Record<string, unknown>;

interface ComfyuiOperation {
    version: 1;
    promptId: string;
    /** Pinned so an accepted prompt is observed at the endpoint that queued it. */
    baseUrl: string;
    templateId: string;
    mediaType: "image" | "video";
}

export interface ComfyuiHealth {
    comfyuiVersion?: string;
    devices: number;
}

interface Upload {
    url: string;
    node: string;
    input: string;
    filename: string;
}

interface Options {
    fetcher?: typeof fetch;
}

const fail = (code: string, options?: { submissionUncertain?: boolean }): never => {
    throw new ProviderRequestError(code, options);
};

/** ComfyUI is reached over the LAN or Tailscale, so plain HTTP and bare IPs are expected. */
export function comfyuiBaseUrl(value: unknown): string {
    if (typeof value !== "string" || value.length > 2048 || !value.trim()) throw new ProviderRequestError("ERR_COMFYUI_BASE_URL");
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new ProviderRequestError("ERR_COMFYUI_BASE_URL"); }
    const parsed = url!;
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) throw new ProviderRequestError("ERR_COMFYUI_BASE_URL");
    // The documented deployment is a LAN/Tailscale host. Refusing public origins
    // keeps a saved connection from turning this adapter into an open proxy.
    if (!isLocalHost(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""))) throw new ProviderRequestError("ERR_COMFYUI_BASE_URL");
    return parsed.origin;
}

function isLocalHost(host: string): boolean {
    if (!host) return false;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".ts.net")) return true;
    if (!host.includes(".") && !host.includes(":")) return true;
    if (host.includes(":")) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
    const octets = host.split(".");
    if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return false;
    const [a, b] = octets.map(Number);
    return a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31
        || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254;
}

function extensionOf(url: string): string {
    try {
        const match = /\.([a-z0-9]{1,5})$/i.exec(new URL(url).pathname);
        if (match && ["png", "jpg", "jpeg", "webp"].includes(match[1].toLowerCase())) return match[1].toLowerCase();
    } catch { /* The media slot URL is validated when it is fetched. */ }
    return "png";
}

function hasEntries(value: unknown): boolean {
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Json).length > 0);
}

/** History failures carry node errors either at the top level or inside an execution_error message. */
function executionFailure(entry: Json): string | undefined {
    const status = entry.status && typeof entry.status === "object" && !Array.isArray(entry.status) ? entry.status as Json : {};
    const messages = Array.isArray(status.messages) ? status.messages : [];
    for (const message of messages) {
        if (!Array.isArray(message) || message.length !== 2) continue;
        const [kind, info] = message;
        const data = info && typeof info === "object" && !Array.isArray(info) ? info as Json : {};
        if (kind === "execution_error") return hasEntries(data.node_errors) ? "ERR_COMFYUI_NODE_ERRORS" : "ERR_COMFYUI_EXECUTION_FAILED";
        if (kind === "execution_interrupted") return "ERR_COMFYUI_CANCELLED";
    }
    if (hasEntries(entry.node_errors) || hasEntries(status.node_errors)) return "ERR_COMFYUI_NODE_ERRORS";
    if (status.status_str === "error") return "ERR_COMFYUI_EXECUTION_FAILED";
    return undefined;
}

/**
 * Map canonical parameters and validated field values onto the template's node
 * inputs. Every value is checked against the template before it can reach a graph.
 */
export function buildComfyuiRequest(request: ProviderGenerationRequest, template = getComfyuiTemplate(request.providerModelId, request.mediaType)): { template: ComfyuiTemplate; graph: ComfyuiGraph; uploads: Upload[] } {
    if (!template || template.mode !== request.mediaType) fail("ERR_COMFYUI_UNSUPPORTED_MODEL");
    const rule = template!;
    const { values, errors } = parseModelFields(request.capabilities, request.params.field_values ?? {});
    if (errors.length) fail("ERR_COMFYUI_PARAMETER");
    const params = request.params;
    const canonical: Record<string, unknown> = {
        prompt: params.prompt, negative_prompt: params.negative_prompt, width: params.width,
        height: params.height, seed: params.seed, cfg: params.cfg_scale,
    };
    const graph = structuredClone(rule.graph);
    const submitted = request.params.field_values ?? {};
    for (const parameter of rule.params) {
        // parseModelFields supplies defaults, so only explicitly submitted field
        // values may conflict with a canonical parameter.
        const explicit = Object.hasOwn(submitted, parameter.id) && submitted[parameter.id] !== "" && submitted[parameter.id] !== null;
        const fieldValue = explicit ? values[parameter.id] : undefined;
        const canonicalValue = Object.hasOwn(canonical, parameter.id) ? canonical[parameter.id] : undefined;
        if (canonicalValue !== undefined && fieldValue !== undefined && JSON.stringify(canonicalValue) !== JSON.stringify(fieldValue)) fail("ERR_COMFYUI_PARAMETER");
        let value = canonicalValue !== undefined ? canonicalValue : fieldValue;
        if (value === undefined || value === "") value = parameter.default;
        if (typeof value === "string" && parameter.id === "prompt") value = value.trim();
        if (value === undefined || value === "") {
            if (parameter.required) fail(parameter.id === "prompt" ? "ERR_COMFYUI_PROMPT" : "ERR_COMFYUI_PARAMETER_REQUIRED");
            continue;
        }
        if (!validateComfyuiParam(parameter, value)) fail(parameter.id === "prompt" ? "ERR_COMFYUI_PROMPT" : "ERR_COMFYUI_PARAMETER");
        graph[parameter.target[0]].inputs[parameter.target[1]] = value;
    }
    const uploads: Upload[] = [];
    for (const key of Object.keys(request.media.slots ?? {})) {
        if (!rule.mediaSlots.some(slot => slot.id === key)) fail("ERR_COMFYUI_UNSUPPORTED_MEDIA");
    }
    if (request.media.elements?.length) fail("ERR_COMFYUI_UNSUPPORTED_MEDIA");
    for (const slot of rule.mediaSlots) {
        const urls = getMediaSlot(request.media, slot.id).filter(value => typeof value === "string" && value.length > 0);
        if (urls.length > 1) fail("ERR_COMFYUI_UNSUPPORTED_MEDIA");
        if (!urls.length) {
            if (slot.required) fail("ERR_COMFYUI_MEDIA_REQUIRED");
            continue;
        }
        uploads.push({ url: urls[0], node: slot.target[0], input: slot.target[1], filename: `${slot.id}.${extensionOf(urls[0])}` });
    }
    return { template: rule, graph, uploads };
}

function operationOf(request: ProviderPollRequest): ComfyuiOperation {
    const operation = request.operation as Partial<ComfyuiOperation> | null;
    if (!operation || operation.version !== 1 || typeof operation.promptId !== "string" || !PROMPT_ID.test(operation.promptId)
        || typeof operation.templateId !== "string" || operation.templateId !== request.providerModelId
        || operation.mediaType !== request.mediaType) fail("ERR_COMFYUI_OPERATION");
    const value = operation!;
    return { version: 1, promptId: value.promptId!, baseUrl: comfyuiBaseUrl(value.baseUrl), templateId: value.templateId!, mediaType: value.mediaType! };
}

export class ComfyuiProvider implements GenerationProvider {
    readonly id = "comfyui" as const;

    constructor(private readonly options: Options = {}) {}

    private baseUrl(connection?: ProviderConnectionContext): string {
        const metadata = connection?.metadata ?? {};
        const configured = typeof metadata.baseUrl === "string" && metadata.baseUrl.trim() ? metadata.baseUrl : process.env.COMFYUI_BASE_URL;
        if (!configured?.trim()) fail("ERR_COMFYUI_NOT_CONFIGURED");
        return comfyuiBaseUrl(configured);
    }

    /** COMFYUI_API_KEY is optional: the GX10 requires no bearer token on the LAN. */
    private headers(connection: ProviderConnectionContext | undefined, json: boolean): Record<string, string> {
        const secret = connection?.secret?.trim();
        return { Accept: "application/json", ...(json ? { "Content-Type": "application/json" } : {}), ...(secret ? { Authorization: `Bearer ${secret}` } : {}) };
    }

    private async upload(baseUrl: string, upload: Upload, graph: ComfyuiGraph, connection: ProviderConnectionContext | undefined, transport: ReturnType<typeof createProviderTransport>) {
        const media = await fetchRemoteMedia(upload.url, { signal: transport.signal, maxBytes: mediaByteLimit("image/") });
        const form = new FormData();
        form.set("image", new Blob([new Uint8Array(media.data)], { type: media.mimeType }), upload.filename);
        form.set("overwrite", "true");
        const secret = connection?.secret?.trim();
        const response = await transport.fetch(`${baseUrl}/upload/image`, { method: "POST", cache: "no-store",
            headers: { Accept: "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: form });
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError("COMFYUI", "submit", response.status, response.headers.get("retry-after")); }
        let payload: unknown;
        try { payload = await response.json(); } catch { throw invalidProviderResponse("COMFYUI", "submit"); }
        const result = providerObject(payload, "COMFYUI", "submit");
        const name = result.name;
        if (typeof name !== "string" || !name || name.length > 512 || /[\\/]/.test(name)) throw invalidProviderResponse("COMFYUI", "submit");
        const subfolder = typeof result.subfolder === "string" && result.subfolder.length <= 512 ? result.subfolder.replace(/^\/+|\/+$/g, "") : "";
        graph[upload.node].inputs[upload.input] = subfolder ? `${subfolder}/${name}` : name;
    }

    async submit(request: ProviderGenerationRequest): Promise<ProviderSubmission> {
        if (request.signal?.aborted) fail("ERR_COMFYUI_ABORTED");
        const baseUrl = this.baseUrl(request.connection);
        const { template, graph, uploads } = buildComfyuiRequest(request);
        const transport = createProviderTransport("COMFYUI", "submit", request.signal, this.options.fetcher);
        transport.assertActive();
        try {
            for (const upload of uploads) await this.upload(baseUrl, upload, graph, request.connection, transport);
            const response = await transport.fetch(`${baseUrl}/prompt`, {
                method: "POST", cache: "no-store", headers: this.headers(request.connection, true),
                body: JSON.stringify({ prompt: graph, client_id: CLIENT_ID }),
            });
            if (!response.ok) { await response.body?.cancel(); throw providerHttpError("COMFYUI", "submit", response.status, response.headers.get("retry-after")); }
            let payload: unknown;
            try { payload = await response.json(); } catch { throw invalidProviderResponse("COMFYUI", "submit"); }
            const result = providerObject(payload, "COMFYUI", "submit");
            const promptId = result.prompt_id;
            if (typeof promptId !== "string" || !PROMPT_ID.test(promptId)) throw invalidProviderResponse("COMFYUI", "submit");
            // A queued prompt with rejected nodes must never be reported as accepted.
            if (hasEntries(result.node_errors)) fail("ERR_COMFYUI_NODE_ERRORS", { submissionUncertain: true });
            return { status: "CREATED", providerTaskId: promptId, operation: { version: 1, promptId, baseUrl, templateId: template.id, mediaType: request.mediaType } satisfies ComfyuiOperation };
        } catch (error) { throw transport.classify(error); }
    }

    async poll(request: ProviderPollRequest): Promise<ProviderPollResult> {
        return this.observe(request);
    }

    /** GET /history/{prompt_id}; completed history is downloaded through GET /view. */
    async observe(request: ProviderPollRequest): Promise<ProviderPollResult> {
        const operation = operationOf(request);
        const template = getComfyuiTemplate(operation.templateId, operation.mediaType);
        if (!template) fail("ERR_COMFYUI_OPERATION");
        const transport = createProviderTransport("COMFYUI", "poll", request.signal, this.options.fetcher);
        transport.assertActive();
        try {
            const response = await transport.fetch(`${operation.baseUrl}/history/${operation.promptId}`, { method: "GET", cache: "no-store", headers: this.headers(request.connection, false) });
            if (!response.ok) { await response.body?.cancel(); throw providerHttpError("COMFYUI", "poll", response.status, response.headers.get("retry-after")); }
            let payload: unknown;
            try { payload = await response.json(); } catch { throw invalidProviderResponse("COMFYUI", "poll"); }
            const history = providerObject(payload, "COMFYUI", "poll");
            if (history[operation.promptId] === undefined) return { status: "IN_PROGRESS", operation };
            const entry = providerObject(history[operation.promptId], "COMFYUI", "poll");
            const failure = executionFailure(entry);
            if (failure) return { status: failure === "ERR_COMFYUI_CANCELLED" ? "CANCELLED" : "FAILED", error: failure, operation };
            const outputs = entry.outputs === undefined ? {} : providerObject(entry.outputs, "COMFYUI", "poll");
            const assets = await this.assets(operation, template!, outputs, transport, request.connection);
            if (!assets.length) return { status: "IN_PROGRESS", operation };
            return { status: "COMPLETED", assets, operation };
        } catch (error) { throw transport.classify(error); }
    }

    private async assets(operation: ComfyuiOperation, template: ComfyuiTemplate, outputs: Json, transport: ReturnType<typeof createProviderTransport>, connection: ProviderConnectionContext | undefined): Promise<GeneratedAsset[]> {
        const assets: GeneratedAsset[] = [];
        for (const output of template.outputs) {
            const node = outputs[output.node];
            if (!node || typeof node !== "object" || Array.isArray(node)) continue;
            const list = (node as Json)[output.kind === "video" ? "videos" : "images"];
            if (!Array.isArray(list)) continue;
            for (const item of list) {
                if (assets.length >= 16) break;
                const image = providerObject(item, "COMFYUI", "poll");
                const filename = image.filename, subfolder = image.subfolder ?? "", type = image.type ?? "output";
                if (typeof filename !== "string" || !filename || filename.length > 512 || /[\\/]/.test(filename)) throw invalidProviderResponse("COMFYUI", "poll");
                if (typeof subfolder !== "string" || subfolder.length > 512 || subfolder.split("/").some(part => part === "..")) throw invalidProviderResponse("COMFYUI", "poll");
                if (!["output", "temp", "input"].includes(String(type))) throw invalidProviderResponse("COMFYUI", "poll");
                const url = `${operation.baseUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(String(type))}`;
                const response = await transport.fetch(url, { method: "GET", cache: "no-store", headers: this.headers(connection, false) });
                if (!response.ok) { await response.body?.cancel(); throw providerHttpError("COMFYUI", "poll", response.status, response.headers.get("retry-after")); }
                const bounded = boundResponseBody(response, { signal: transport.signal, maxBytes: mediaByteLimit(`${output.kind}/`) });
                const data = new Uint8Array(await bounded.arrayBuffer());
                if (!data.byteLength) throw invalidProviderResponse("COMFYUI", "poll");
                const extension = /\.([a-z0-9]{1,5})$/i.exec(filename)?.[1].toLowerCase();
                const declared = extension ? MIME_TYPES[extension] ?? output.mimeType : output.mimeType;
                assets.push({ data, ...(declared ? { mimeType: declared } : {}) });
            }
        }
        return assets;
    }

    /** POST /queue { delete: [prompt_id] }. Safe to call for an already finished prompt. */
    async cancel(promptId: string, connection?: ProviderConnectionContext): Promise<void> {
        if (!PROMPT_ID.test(promptId)) fail("ERR_COMFYUI_OPERATION");
        const baseUrl = this.baseUrl(connection);
        const transport = createProviderTransport("COMFYUI", "poll", undefined, this.options.fetcher);
        try {
            const response = await transport.fetch(`${baseUrl}/queue`, { method: "POST", cache: "no-store", headers: this.headers(connection, true), body: JSON.stringify({ delete: [promptId] }) });
            if (!response.ok) { await response.body?.cancel(); throw providerHttpError("COMFYUI", "poll", response.status, response.headers.get("retry-after")); }
            await response.body?.cancel();
        } catch (error) { throw transport.classify(error); }
    }

    /** GET /system_stats. Non-billable, so it is safe before submitting work. */
    async health(connection?: ProviderConnectionContext): Promise<ComfyuiHealth> {
        const baseUrl = this.baseUrl(connection);
        const transport = createProviderTransport("COMFYUI", "poll", undefined, this.options.fetcher);
        try {
            const response = await transport.fetch(`${baseUrl}/system_stats`, { method: "GET", cache: "no-store", headers: this.headers(connection, false) });
            if (!response.ok) { await response.body?.cancel(); throw providerHttpError("COMFYUI", "poll", response.status, response.headers.get("retry-after")); }
            let payload: unknown;
            try { payload = await response.json(); } catch { throw invalidProviderResponse("COMFYUI", "poll"); }
            const result = providerObject(payload, "COMFYUI", "poll");
            const system = result.system && typeof result.system === "object" && !Array.isArray(result.system) ? result.system as Json : {};
            const version = typeof system.comfyui_version === "string" && system.comfyui_version.length <= 64 ? system.comfyui_version : undefined;
            return { ...(version ? { comfyuiVersion: version } : {}), devices: Array.isArray(result.devices) ? result.devices.length : 0 };
        } catch (error) { throw transport.classify(error); }
    }
}
