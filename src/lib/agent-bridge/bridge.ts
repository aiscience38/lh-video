import type { Readable, Writable } from "node:stream";

/**
 * Transport-neutral agent bridge.
 *
 * This module owns the loopback HTTP client, the production gate-approval rule,
 * the MCP tool catalog and the newline-framed stdio dispatcher. It deliberately
 * lives outside `src/server` so the CLI and the stdio entry can execute it with
 * Node's built-in type stripping (Node 22.18+). `src/server/mcp/server.ts` is
 * the server-only composition root for Next code.
 */

export const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "lh-video-agent-bridge";
export const MCP_SERVER_VERSION = "0.1.0";

export type JsonObject = Record<string, unknown>;
export type BridgeEnvironment = Record<string, string | undefined>;

/** A bridge failure always carries a stable code, mirroring the app's error codes. */
export type BridgeFailure = Error & { code: string; status?: number };

export function bridgeFailure(code: string, message: string, status?: number): BridgeFailure {
    const failure = new Error(message) as BridgeFailure;
    failure.code = code;
    if (status !== undefined) failure.status = status;
    return failure;
}

export function failureCode(error: unknown, fallback = "ERR_BRIDGE_UNKNOWN"): string {
    if (typeof error === "object" && error !== null && "code" in error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && code) return code;
    }
    return fallback;
}

export function failureMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackHost(hostname: string): boolean {
    const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return LOOPBACK_HOSTS.has(bare.toLowerCase());
}

export interface BridgeConfig {
    baseUrl: string;
    timeoutMs: number;
}

/**
 * The bridge authenticates nothing: it relies on the app's single-operator
 * loopback guard. A remote base URL would either fail the Origin check or
 * silently point the agent at someone else's workspace, so it is refused here.
 */
export function readBridgeConfig(environment: BridgeEnvironment = {}): BridgeConfig {
    const raw = (environment.LH_VIDEO_BASE_URL ?? DEFAULT_BASE_URL).trim();
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw bridgeFailure("ERR_BRIDGE_BASE_URL", `LH_VIDEO_BASE_URL is not an absolute URL: ${raw || "(empty)"}.`);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
        || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
        throw bridgeFailure("ERR_BRIDGE_BASE_URL", `LH_VIDEO_BASE_URL must be a bare http(s) origin without credentials, path, query or fragment: ${raw}.`);
    }
    if (!isLoopbackHost(url.hostname)) {
        throw bridgeFailure("ERR_BRIDGE_NOT_LOOPBACK", `LH_VIDEO_BASE_URL must point at loopback (localhost, 127.0.0.1 or [::1]); ${url.hostname} is not local. The agent bridge has no remote authentication.`);
    }
    const timeoutMs = Number(environment.LH_VIDEO_TIMEOUT_MS ?? "20000");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
        throw bridgeFailure("ERR_BRIDGE_TIMEOUT", "LH_VIDEO_TIMEOUT_MS must be an integer between 1000 and 300000 milliseconds.");
    }
    return { baseUrl: url.origin, timeoutMs };
}

export const LIBRARY_KINDS = ["character", "scene", "storyboard"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export function isLibraryKind(value: unknown): value is LibraryKind {
    return typeof value === "string" && (LIBRARY_KINDS as readonly string[]).includes(value);
}

export interface ListLibraryInput {
    kind?: LibraryKind;
    q?: string;
}

export interface CreateGenerationTaskInput {
    modelId: string;
    prompt?: string;
    variantId?: string;
    settings?: JsonObject;
    duration?: string | number;
    aspectRatio?: string;
    resolution?: string;
    clientSubmissionId?: string;
}

export interface ReadLedgerInput {
    productionId: string;
}

export interface AdvanceStopInput {
    productionId: string;
    stopId: string;
    note?: string;
}

export interface BridgeApi {
    getHealth(): Promise<unknown>;
    listProductions(): Promise<unknown>;
    listLibrary(input?: ListLibraryInput): Promise<unknown>;
    getTask(taskId: string): Promise<unknown>;
    createGenerationTask(input: CreateGenerationTaskInput): Promise<unknown>;
    readLedger(input: ReadLedgerInput): Promise<unknown>;
    advanceProductionStop(input: AdvanceStopInput): Promise<unknown>;
}

export type BridgeClient = BridgeApi;

export interface BridgeClientOptions {
    config: BridgeConfig;
    fetchImpl?: typeof fetch;
}

interface RequestOptions {
    method?: "GET" | "POST";
    body?: BodyInit;
    headers?: Record<string, string>;
}

function requireIdentifier(value: unknown, field: string, maximum = 256): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || text.length > maximum) {
        throw bridgeFailure("ERR_BRIDGE_INVALID_ARGUMENT", `${field} must be a non-empty string of at most ${maximum} characters.`);
    }
    return text;
}

function optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
        throw bridgeFailure("ERR_BRIDGE_INVALID_ARGUMENT", `${field} must be a string when present.`);
    }
    const text = value.trim();
    return text || undefined;
}

function optionalDuration(value: unknown): string | number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) return value.trim();
    throw bridgeFailure("ERR_BRIDGE_INVALID_ARGUMENT", "duration must be a number or non-empty string when present.");
}

function optionalSettings(value: unknown): JsonObject | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isJsonObject(value)) {
        throw bridgeFailure("ERR_BRIDGE_INVALID_ARGUMENT", "settings must be a JSON object when present.");
    }
    return value;
}

function apiErrorCode(payload: unknown, status: number): string {
    if (isJsonObject(payload) && typeof payload.error === "string" && payload.error) return payload.error;
    return `HTTP_${status}`;
}

function describeConnectionFailure(error: unknown): string {
    const cause = isJsonObject(error) && "cause" in error ? error.cause : undefined;
    const detail = cause instanceof Error ? cause.message : failureMessage(error);
    return detail || "connection failed";
}

function productionDetail(payload: unknown): unknown {
    if (isJsonObject(payload) && isJsonObject(payload.production)) return payload.production;
    return payload;
}

/**
 * Gate approval is opt-in per production. Only the literal boolean `true`
 * passes: a missing flag, `"true"`, 1 or a nested object are all denials.
 */
export function assertAgentApproval(production: unknown, productionId?: string): void {
    if (isJsonObject(production) && production.agentCanApprove === true) return;
    throw bridgeFailure(
        "ERR_AGENT_APPROVAL_DENIED",
        `Production ${productionId ?? "(unknown)"} does not set agentCanApprove=true. The bridge will not approve or advance a production gate without an explicit per-production opt-in.`,
        403,
    );
}

export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
    const { config } = options;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
        throw bridgeFailure("ERR_BRIDGE_FETCH", "This Node runtime does not expose global fetch. Use Node 22 or newer.");
    }

    async function request(path: string, init: RequestOptions = {}): Promise<unknown> {
        const url = new URL(path, config.baseUrl);
        if (url.origin !== config.baseUrl) {
            throw bridgeFailure("ERR_BRIDGE_BASE_URL", `Refusing to call outside the configured origin: ${url.origin}.`);
        }
        const method = init.method ?? "GET";
        const headers = new Headers(init.headers);
        headers.set("accept", "application/json");
        // guardWorkspaceRequest compares Origin exactly for every mutation.
        if (method !== "GET") headers.set("origin", config.baseUrl);
        let response: Response;
        try {
            response = await fetchImpl(url, {
                method,
                headers,
                body: init.body,
                redirect: "error",
                signal: AbortSignal.timeout(config.timeoutMs),
            });
        } catch (error) {
            throw bridgeFailure("ERR_BRIDGE_UNREACHABLE", `${config.baseUrl} did not answer ${method} ${path}: ${describeConnectionFailure(error)}.`);
        }
        let text = "";
        try {
            text = await response.text();
        } catch {
            text = "";
        }
        let payload: unknown = null;
        if (text.trim()) {
            try {
                payload = JSON.parse(text);
            } catch {
                throw bridgeFailure("ERR_BRIDGE_INVALID_RESPONSE", `${path} returned non-JSON (HTTP ${response.status}). The bridge only talks to the local LH Video API.`);
            }
        }
        if (!response.ok) {
            const code = apiErrorCode(payload, response.status);
            throw bridgeFailure(code, `${path} failed: HTTP ${response.status} ${code}.`, response.status);
        }
        if (payload === null) {
            throw bridgeFailure("ERR_BRIDGE_INVALID_RESPONSE", `${path} returned an empty body (HTTP ${response.status}).`);
        }
        return payload;
    }

    return {
        getHealth: () => request("/api/health"),
        listProductions: () => request("/api/productions"),
        listLibrary(input = {}) {
            const params = new URLSearchParams();
            if (input.kind !== undefined) {
                if (!isLibraryKind(input.kind)) {
                    throw bridgeFailure("ERR_BRIDGE_INVALID_ARGUMENT", `kind must be one of ${LIBRARY_KINDS.join(", ")}.`);
                }
                params.set("kind", input.kind);
            }
            if (input.q) params.set("q", input.q);
            const query = params.toString();
            return request(`/api/library${query ? `?${query}` : ""}`);
        },
        getTask: (taskId) => request(`/api/tasks/${encodeURIComponent(requireIdentifier(taskId, "task_id"))}`),
        createGenerationTask(input) {
            const modelId = requireIdentifier(input.modelId, "model_id");
            const settings = { ...(optionalSettings(input.settings) ?? {}) };
            if (input.duration !== undefined && input.duration !== null) settings.duration = String(input.duration);
            if (input.aspectRatio !== undefined) settings.aspectRatio = input.aspectRatio;
            const form = new FormData();
            form.set("model_id", modelId);
            form.set("prompt", input.prompt ?? "");
            const variant = optionalString(input.variantId, "variant_id") ?? optionalString(input.resolution, "resolution");
            if (variant) form.set("variant_id", variant);
            if (Object.keys(settings).length > 0) form.set("settings", JSON.stringify(settings));
            const submissionId = optionalString(input.clientSubmissionId, "client_submission_id");
            if (submissionId) form.set("client_submission_id", submissionId);
            return request("/api/generate", { method: "POST", body: form });
        },
        readLedger: (input) => request(`/api/productions/${encodeURIComponent(requireIdentifier(input.productionId, "production_id"))}/ledger`),
        async advanceProductionStop(input) {
            const productionId = requireIdentifier(input.productionId, "production_id");
            const stopId = requireIdentifier(input.stopId, "stop_id");
            // Never POST first: the gate flag is checked against the production
            // as it exists right now, so a revoked opt-in cannot be raced.
            const detail = await request(`/api/productions/${encodeURIComponent(productionId)}`);
            const production = productionDetail(detail);
            assertAgentApproval(production, productionId);
            const note = optionalString(input.note, "note");
            return request(`/api/productions/${encodeURIComponent(productionId)}/stops/${encodeURIComponent(stopId)}/advance`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ stopId, approvedBy: "agent", ...(note ? { note } : {}) }),
            });
        },
    };
}

export interface ToolDefinition {
    name: string;
    title: string;
    description: string;
    inputSchema: JsonObject;
    annotations: JsonObject;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export const TOOLS: ToolDefinition[] = [
    {
        name: "list_productions",
        title: "List productions",
        description: "List every production in the local LH Video workspace, including its stage, active stop and agentCanApprove flag.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: READ_ONLY,
    },
    {
        name: "list_library",
        title: "List library entities",
        description: "List creative library characters, scenes and storyboards. Filter by kind and/or a case-insensitive name/slug query.",
        inputSchema: {
            type: "object",
            properties: {
                kind: { type: "string", enum: [...LIBRARY_KINDS], description: "Restrict results to one entity kind." },
                q: { type: "string", description: "Case-insensitive name or slug fragment." },
            },
            additionalProperties: false,
        },
        annotations: READ_ONLY,
    },
    {
        name: "get_task",
        title: "Get generation task",
        description: "Read one video generation task by id, including status, model, prompt and output asset.",
        inputSchema: {
            type: "object",
            properties: { task_id: { type: "string", description: "Task identifier returned by create_generation_task." } },
            required: ["task_id"],
            additionalProperties: false,
        },
        annotations: { ...READ_ONLY, idempotentHint: true },
    },
    {
        name: "create_generation_task",
        title: "Create generation task",
        description: "Submit a billable video generation to the local app's configured provider. The app validates the model and settings; this tool never retries a submission.",
        inputSchema: {
            type: "object",
            properties: {
                model_id: { type: "string", description: "Runtime video model id from GET /api/models." },
                prompt: { type: "string", description: "Generation prompt; may be empty only when the model does not require one." },
                variant_id: { type: "string", description: "Resolution variant id when the model exposes one." },
                settings: { type: "object", description: "Model settings object (duration, aspectRatio, negativePrompt, seed, cfgScale, fieldValues, ...)." },
                duration: { type: ["string", "number"], description: "Convenience override merged into settings.duration." },
                aspect_ratio: { type: "string", description: "Convenience override merged into settings.aspectRatio." },
                resolution: { type: "string", description: "Resolution variant id used when variant_id is omitted." },
                client_submission_id: { type: "string", description: "Optional UUID correlating client-side state; never a provider id." },
            },
            required: ["model_id"],
            additionalProperties: false,
        },
        annotations: MUTATING,
    },
    {
        name: "read_ledger",
        title: "Read production ledger",
        description: "Read the append-only decision and approval ledger for one production.",
        inputSchema: {
            type: "object",
            properties: { production_id: { type: "string", description: "Production identifier." } },
            required: ["production_id"],
            additionalProperties: false,
        },
        annotations: READ_ONLY,
    },
    {
        name: "advance_production_stop",
        title: "Advance a production stop",
        description: "Approve and advance the production's current stop. Refused with ERR_AGENT_APPROVAL_DENIED unless that production sets agentCanApprove to the literal boolean true.",
        inputSchema: {
            type: "object",
            properties: {
                production_id: { type: "string", description: "Production identifier." },
                stop_id: { type: "string", description: "Stop/gate identifier to advance." },
                note: { type: "string", description: "Optional human-readable decision note stored in the ledger." },
            },
            required: ["production_id", "stop_id"],
            additionalProperties: false,
        },
        annotations: { ...MUTATING, destructiveHint: true },
    },
];

export async function callTool(api: BridgeApi, name: string, args: unknown): Promise<unknown> {
    const input = args === undefined ? {} : args;
    if (!isJsonObject(input)) {
        throw bridgeFailure("ERR_BRIDGE_INVALID_ARGUMENT", "Tool arguments must be a JSON object.");
    }
    switch (name) {
        case "list_productions":
            return api.listProductions();
        case "list_library": {
            const kind = input.kind;
            if (kind !== undefined && !isLibraryKind(kind)) {
                throw bridgeFailure("ERR_BRIDGE_INVALID_ARGUMENT", `kind must be one of ${LIBRARY_KINDS.join(", ")}.`);
            }
            return api.listLibrary({ kind, q: optionalString(input.q, "q") });
        }
        case "get_task":
            return api.getTask(requireIdentifier(input.task_id, "task_id"));
        case "create_generation_task":
            return api.createGenerationTask({
                modelId: requireIdentifier(input.model_id, "model_id"),
                prompt: optionalString(input.prompt, "prompt"),
                variantId: optionalString(input.variant_id, "variant_id"),
                settings: optionalSettings(input.settings),
                duration: optionalDuration(input.duration),
                aspectRatio: optionalString(input.aspect_ratio, "aspect_ratio"),
                resolution: optionalString(input.resolution, "resolution"),
                clientSubmissionId: optionalString(input.client_submission_id, "client_submission_id"),
            });
        case "read_ledger":
            return api.readLedger({ productionId: requireIdentifier(input.production_id, "production_id") });
        case "advance_production_stop":
            return api.advanceProductionStop({
                productionId: requireIdentifier(input.production_id, "production_id"),
                stopId: requireIdentifier(input.stop_id, "stop_id"),
                note: optionalString(input.note, "note"),
            });
        default:
            throw bridgeFailure("ERR_UNKNOWN_TOOL", `Unknown tool: ${name}. Call tools/list to see the supported tools.`);
    }
}

export interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: string | number | null;
    result?: unknown;
    error?: { code: number; message: string };
}

export interface McpServer {
    handle(message: unknown): Promise<JsonRpcResponse | null>;
}

const INSTRUCTIONS = [
    "Local-only LH Video agent bridge. It talks to one self-hosted workspace on loopback; it holds no credentials and has no remote access.",
    "Read list_productions and list_library before generating. create_generation_task submits a billable provider request and is never retried automatically.",
    "advance_production_stop approves a human gate. It is refused unless the production itself sets agentCanApprove=true; never work around that refusal or edit production state by other means.",
].join(" ");

function resultResponse(id: string | number | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
}

function render(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? "null";
    } catch {
        return String(value);
    }
}

export function createMcpServer(api: BridgeApi, options: { name?: string; version?: string } = {}): McpServer {
    const name = options.name ?? MCP_SERVER_NAME;
    const version = options.version ?? MCP_SERVER_VERSION;
    return {
        async handle(message) {
            if (!isJsonObject(message)) return errorResponse(null, -32600, "Invalid Request: expected a JSON-RPC object.");
            const hasId = Object.hasOwn(message, "id");
            const rawId = message.id;
            const id = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
            if (hasId && rawId !== null && typeof rawId !== "string" && typeof rawId !== "number") {
                return errorResponse(null, -32600, "Invalid Request: id must be a string, number or null.");
            }
            if (typeof message.method !== "string" || !message.method) {
                return hasId ? errorResponse(id, -32600, "Invalid Request: method must be a string.") : null;
            }
            const method = message.method;
            switch (method) {
                case "initialize":
                    return resultResponse(id, {
                        protocolVersion: MCP_PROTOCOL_VERSION,
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: { name, version },
                        instructions: INSTRUCTIONS,
                    });
                case "notifications/initialized":
                case "notifications/cancelled":
                    return null;
                case "ping":
                    return resultResponse(id, {});
                case "tools/list":
                    return resultResponse(id, { tools: TOOLS });
                case "tools/call": {
                    const params = message.params;
                    if (!isJsonObject(params) || typeof params.name !== "string" || !params.name) {
                        return errorResponse(id, -32602, "Invalid params: tools/call requires { name, arguments }.");
                    }
                    try {
                        const value = await callTool(api, params.name, params.arguments);
                        return resultResponse(id, {
                            content: [{ type: "text", text: render(value) }],
                            structuredContent: value,
                            isError: false,
                        });
                    } catch (error) {
                        return resultResponse(id, {
                            content: [{ type: "text", text: `${failureCode(error)}: ${failureMessage(error)}` }],
                            isError: true,
                        });
                    }
                }
                default:
                    return hasId ? errorResponse(id, -32601, `Method not found: ${method}`) : null;
            }
        },
    };
}

export interface StdioStreams {
    input: Readable;
    output: Writable;
}

/** MCP stdio framing is one JSON-RPC message per line, with no Content-Length header. */
export function serveStdio(server: McpServer, streams: StdioStreams): Promise<void> {
    return new Promise((resolve, reject) => {
        streams.input.setEncoding("utf8");
        let buffer = "";
        let tail: Promise<void> = Promise.resolve();
        const write = (response: JsonRpcResponse) => {
            streams.output.write(`${JSON.stringify(response)}\n`);
        };
        const handleLine = (text: string) => {
            let message: unknown;
            try {
                message = JSON.parse(text);
            } catch {
                write(errorResponse(null, -32700, "Parse error: each line must be one JSON-RPC message."));
                return;
            }
            tail = tail.then(async () => {
                try {
                    const response = await server.handle(message);
                    if (response) write(response);
                } catch (error) {
                    const id = isJsonObject(message) && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null;
                    write(errorResponse(id, -32603, `Internal error: ${failureMessage(error)}`));
                }
            });
        };
        streams.input.on("data", (chunk: string) => {
            buffer += chunk;
            let index = buffer.indexOf("\n");
            while (index >= 0) {
                const text = buffer.slice(0, index).replace(/\r$/, "");
                buffer = buffer.slice(index + 1);
                if (text.trim()) handleLine(text);
                index = buffer.indexOf("\n");
            }
        });
        streams.input.on("end", () => {
            if (buffer.trim()) handleLine(buffer);
            tail.then(() => resolve(), reject);
        });
        streams.input.on("error", reject);
    });
}
