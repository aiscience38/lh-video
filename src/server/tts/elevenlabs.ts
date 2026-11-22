import "server-only";

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
 * ElevenLabs adapter.
 *
 * The API key is environment-only (`ELEVENLABS_API_KEY`): synthesis is billed,
 * so a saved browser connection must never be able to swap the credential.
 * Synthesis is submitted exactly once. A network failure after the request has
 * left this process may still have produced (and billed) audio upstream, so
 * the adapter never retries a synthesis attempt.
 */

const API_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL = "eleven_multilingual_v2";
const VOICE_CACHE_MS = 60_000;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const VOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface ElevenLabsOptions {
    /** Test seam; production reads `ELEVENLABS_API_KEY`. */
    apiKey?: string;
    fetcher?: typeof fetch;
    now?: () => number;
}

interface VoiceCacheEntry {
    key: string;
    expiresAt: number;
    voices: TtsVoice[];
}

let voiceCache: VoiceCacheEntry | undefined;

function apiKeyOf(options: ElevenLabsOptions): string | undefined {
    const value = (options.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "").trim();
    return value || undefined;
}

function fetcherOf(options: ElevenLabsOptions): typeof fetch {
    return options.fetcher ?? fetch;
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

async function send(options: ElevenLabsOptions, url: string, init: RequestInit): Promise<Response> {
    try {
        return await fetcherOf(options)(url, { ...init, cache: "no-store" });
    } catch {
        throw new TtsError("upstream_down", "ERR_TTS_UPSTREAM_DOWN");
    }
}

async function readJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        throw new TtsError("malformed_result", "ERR_TTS_MALFORMED_RESULT", response.status);
    }
}

function voiceFrom(value: unknown): TtsVoice | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const id = record.voice_id;
    const name = record.name;
    if (typeof id !== "string" || !VOICE_ID_PATTERN.test(id) || typeof name !== "string" || !name.trim()) return undefined;
    const labels = record.labels && typeof record.labels === "object" && !Array.isArray(record.labels)
        ? record.labels as Record<string, unknown>
        : {};
    const language = typeof labels.language === "string" && labels.language.trim()
        ? labels.language.trim().slice(0, 64)
        : "unknown";
    let previewUrl: string | undefined;
    if (typeof record.preview_url === "string" && record.preview_url.length <= 2048) {
        try {
            const url = new URL(record.preview_url);
            if (url.protocol === "https:" || url.protocol === "http:") previewUrl = url.toString();
        } catch { /* A malformed preview link is omitted, not fatal. */ }
    }
    return { id, name: name.trim().slice(0, 120), language, ...(previewUrl ? { previewUrl } : {}) };
}

/**
 * GET /v1/voices, cached for 60 s per credential. The account voice library is
 * small, but a settings screen can poll the availability endpoint.
 */
export async function listElevenLabsVoices(options: ElevenLabsOptions = {}): Promise<TtsVoice[]> {
    const key = apiKeyOf(options);
    if (!key) throw new TtsError("not_configured", "ERR_TTS_NO_API_KEY");
    const now = options.now?.() ?? Date.now();
    if (voiceCache && voiceCache.key === key && voiceCache.expiresAt > now) {
        return voiceCache.voices.map((voice) => ({ ...voice }));
    }
    const response = await send(options, `${API_BASE}/voices`, {
        method: "GET",
        headers: { Accept: "application/json", "xi-api-key": key },
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw statusError(response.status, response.headers.get("retry-after"));
    }
    const payload = await readJson(response);
    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    if (!record || !Array.isArray(record.voices)) throw new TtsError("malformed_result", "ERR_TTS_MALFORMED_RESULT");
    const voices: TtsVoice[] = [];
    for (const item of record.voices) {
        const voice = voiceFrom(item);
        if (voice) voices.push(voice);
        if (voices.length >= 1000) break;
    }
    const entry: VoiceCacheEntry = { key, expiresAt: Date.now() + VOICE_CACHE_MS, voices };
    voiceCache = entry;
    return voices.map((voice) => ({ ...voice }));
}

/**
 * POST /v1/text-to-speech/{voiceId}. Never retried; see the module comment.
 * Returns raw MP3 bytes, not a URL, so the caller controls materialization.
 */
export async function synthesizeElevenLabs(
    voiceId: string,
    text: string,
    settings: TtsSynthesisSettings = {},
    options: ElevenLabsOptions = {},
): Promise<TtsSynthResult> {
    const key = apiKeyOf(options);
    if (!key) throw new TtsError("not_configured", "ERR_TTS_NO_API_KEY");
    if (typeof voiceId !== "string" || !VOICE_ID_PATTERN.test(voiceId)) {
        throw new TtsError("invalid_request", "ERR_TTS_VOICE_ID");
    }
    assertTtsText(text);
    const modelId = settings.modelId?.trim() || DEFAULT_MODEL;
    if (!MODEL_ID_PATTERN.test(modelId)) throw new TtsError("invalid_request", "ERR_TTS_SETTINGS");
    const voiceSettings: Record<string, number> = {};
    for (const [field, value, minimum, maximum] of [
        ["stability", settings.stability, 0, 1],
        ["similarity_boost", settings.similarityBoost, 0, 1],
        ["style", settings.style, 0, 1],
        // ElevenLabs currently accepts 0.7-1.2 for the speech-rate multiplier.
        ["speed", settings.speed, 0.7, 1.2],
    ] as const) {
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
            throw new TtsError("invalid_request", "ERR_TTS_SETTINGS");
        }
        voiceSettings[field] = value;
    }
    const body: Record<string, unknown> = { text: text.trim(), model_id: modelId };
    if (Object.keys(voiceSettings).length) body.voice_settings = voiceSettings;
    const response = await send(options, `${API_BASE}/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
            Accept: "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": key,
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw statusError(response.status, response.headers.get("retry-after"));
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
        await response.body?.cancel();
        throw new TtsError("malformed_result", "ERR_TTS_AUDIO_TOO_LARGE", response.status);
    }
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
        throw new TtsError("malformed_result", "ERR_TTS_MALFORMED_RESULT", response.status);
    }
    if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES || !isMp3Audio(bytes)) {
        throw new TtsError("malformed_result", "ERR_TTS_MALFORMED_RESULT", response.status);
    }
    return { bytes, mimeType: "audio/mpeg" };
}

/**
 * Never throws: the providers endpoint must always answer so the UI can show a
 * disabled row with a reason instead of a failed panel.
 */
export async function elevenLabsAvailability(options: ElevenLabsOptions = {}): Promise<TtsAvailability> {
    if (!apiKeyOf(options)) return { configured: false, reachable: false, reason: "no_api_key" };
    try {
        await listElevenLabsVoices(options);
        return { configured: true, reachable: true };
    } catch (error) {
        if (error instanceof TtsError && error.code === "auth") {
            // The host answered, but this credential cannot use it.
            return { configured: true, reachable: true, reason: "unauthorized" };
        }
        return { configured: true, reachable: false, reason: "upstream_down" };
    }
}
