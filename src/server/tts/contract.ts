import "server-only";

/**
 * Shared text-to-speech contract.
 *
 * The two supported providers are deliberately different: ElevenLabs is a
 * hosted, billed API with an account voice library; ComfyUI is the local GX10
 * graph runner with a shipped voice-design template. Callers should only ever
 * depend on the types below so a new provider does not leak its own error
 * shapes into routes or UI code.
 */

export const TTS_PROVIDER_IDS = ["elevenlabs", "comfyui"] as const;
export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];

export function isTtsProviderId(value: unknown): value is TtsProviderId {
    return typeof value === "string" && (TTS_PROVIDER_IDS as readonly string[]).includes(value);
}

export interface TtsVoice {
    id: string;
    name: string;
    /** BCP-47-ish label supplied by the provider, or "unknown" when it has none. */
    language: string;
    previewUrl?: string;
}

export type TtsAvailabilityReason = "no_api_key" | "no_base_url" | "upstream_down" | "unauthorized";

export interface TtsAvailability {
    configured: boolean;
    reachable: boolean;
    reason?: TtsAvailabilityReason;
}

export interface TtsSynthResult {
    bytes: Uint8Array;
    mimeType: string;
}

/**
 * Optional per-request synthesis controls. Providers ignore settings they do
 * not support instead of forwarding them blindly upstream.
 */
export interface TtsSynthesisSettings {
    modelId?: string;
    speaker?: string;
    language?: string;
    /** Playback-rate multiplier; ComfyUI folds it into the voice instruction. */
    speed?: number;
    stability?: number;
    similarityBoost?: number;
    style?: number;
}

export type TtsErrorCode =
    | "auth"
    | "quota"
    | "invalid_request"
    | "upstream_down"
    | "malformed_result"
    | "not_configured";

/** One taxonomy for both adapters, so routes map provider failures identically. */
export class TtsError extends Error {
    constructor(
        readonly code: TtsErrorCode,
        message: string = code,
        readonly status?: number,
        readonly retryAfterSeconds?: number,
    ) {
        super(message);
        this.name = "TtsError";
    }
}

/** A spoken line longer than this is rejected before any billable request. */
export const TTS_TEXT_MAX_LENGTH = 2000;

export function assertTtsText(value: unknown): asserts value is string {
    if (typeof value !== "string") throw new TtsError("invalid_request", "ERR_TTS_TEXT_REQUIRED");
    const text = value.trim();
    if (!text) throw new TtsError("invalid_request", "ERR_TTS_TEXT_REQUIRED");
    if (text.length > TTS_TEXT_MAX_LENGTH) throw new TtsError("invalid_request", "ERR_TTS_TEXT_TOO_LONG");
}

/** Accepts both ID3-tagged and bare MPEG-1 Layer III frames. */
export function isMp3Audio(bytes: Uint8Array): boolean {
    return bytes.length >= 4
        && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
            || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
}
