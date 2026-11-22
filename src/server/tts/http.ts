import "server-only";

import { applyWorkspaceHeaders } from "@/server/security/workspace-access";
import { TtsError, type TtsErrorCode } from "./contract";

const STATUS: Record<TtsErrorCode, number> = {
    auth: 401,
    quota: 429,
    invalid_request: 400,
    malformed_result: 502,
    not_configured: 503,
    upstream_down: 503,
};

const CODE: Record<TtsErrorCode, string> = {
    auth: "ERR_TTS_AUTH",
    quota: "ERR_TTS_QUOTA",
    invalid_request: "ERR_TTS_INVALID_REQUEST",
    malformed_result: "ERR_TTS_MALFORMED_RESULT",
    not_configured: "ERR_TTS_NOT_CONFIGURED",
    upstream_down: "ERR_TTS_UPSTREAM_DOWN",
};

/** One HTTP mapping for both adapters; never exposes provider response text. */
export function ttsFailure(error: unknown): Response {
    const tts = error instanceof TtsError ? error : undefined;
    const kind = tts?.code ?? "upstream_down";
    const message = error instanceof Error ? error.message : "";
    const exposed = /^ERR_TTS_[A-Z0-9_]+$/.test(message) ? message : CODE[kind];
    const headers: Record<string, string> = {};
    if (kind === "quota" && tts?.retryAfterSeconds !== undefined) headers["Retry-After"] = String(tts.retryAfterSeconds);
    return applyWorkspaceHeaders(Response.json({ error: exposed }, { status: STATUS[kind], headers }));
}
