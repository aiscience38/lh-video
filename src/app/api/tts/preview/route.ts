import { NextResponse } from "next/server";
import { readBoundedJson, requestFailure } from "@/server/http/request-limits";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";
import { materializeTtsAsset } from "@/server/tts/assets";
import { synthesizeComfyui } from "@/server/tts/comfyui";
import { assertTtsText, isTtsProviderId, type TtsSynthesisSettings } from "@/server/tts/contract";
import { synthesizeElevenLabs } from "@/server/tts/elevenlabs";
import { ttsFailure } from "@/server/tts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREVIEW_BODY_MAX_BYTES = 16_384;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

function invalid(code: string): Response {
    return applyWorkspaceHeaders(NextResponse.json({ error: code }, { status: 400 }));
}

/**
 * POST /api/tts/preview { provider, voiceId, text, language?, speed? }
 *
 * One synthesis attempt, one materialized MP3 asset, one ledger row flagged
 * `estimated` for the billed provider. This route never retries.
 */
export async function POST(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    let body: unknown;
    try {
        body = await readBoundedJson(request, PREVIEW_BODY_MAX_BYTES);
    } catch (error) {
        return requestFailure(error);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("ERR_TTS_INVALID_REQUEST");
    const record = body as Record<string, unknown>;
    const provider = record.provider;
    if (!isTtsProviderId(provider)) return invalid("ERR_TTS_PROVIDER");
    const voiceId = typeof record.voiceId === "string" ? record.voiceId.trim() : "";
    if (!voiceId || voiceId.length > 600 || CONTROL_CHARACTERS.test(voiceId)) return invalid("ERR_TTS_VOICE_ID");
    const text = record.text;
    try {
        assertTtsText(text);
    } catch (error) {
        return ttsFailure(error);
    }
    const settings: TtsSynthesisSettings = {};
    if (record.language !== undefined) {
        if (typeof record.language !== "string" || !record.language.trim() || record.language.length > 32) {
            return invalid("ERR_TTS_SETTINGS");
        }
        settings.language = record.language.trim();
    }
    if (record.speed !== undefined) {
        if (typeof record.speed !== "number" || !Number.isFinite(record.speed)) return invalid("ERR_TTS_SETTINGS");
        settings.speed = record.speed;
    }
    if (record.modelId !== undefined) {
        if (typeof record.modelId !== "string" || !record.modelId.trim() || record.modelId.length > 64) {
            return invalid("ERR_TTS_SETTINGS");
        }
        settings.modelId = record.modelId.trim();
    }
    try {
        const result = provider === "elevenlabs"
            ? await synthesizeElevenLabs(voiceId, text, settings)
            : await synthesizeComfyui(text, { ...settings, speaker: voiceId });
        const asset = await materializeTtsAsset(provider, text, result, settings.modelId);
        return applyWorkspaceHeaders(NextResponse.json(asset, { status: 200 }));
    } catch (error) {
        return ttsFailure(error);
    }
}
