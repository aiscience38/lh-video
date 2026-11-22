import { NextResponse } from "next/server";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";
import { isTtsProviderId } from "@/server/tts/contract";
import { listComfyuiTtsVoices } from "@/server/tts/comfyui";
import { listElevenLabsVoices } from "@/server/tts/elevenlabs";
import { ttsFailure } from "@/server/tts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tts/voices?provider=elevenlabs|comfyui */
export async function GET(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const provider = new URL(request.url).searchParams.get("provider");
    if (!isTtsProviderId(provider)) {
        return applyWorkspaceHeaders(NextResponse.json({ error: "ERR_TTS_PROVIDER" }, { status: 400 }));
    }
    try {
        const voices = provider === "elevenlabs" ? await listElevenLabsVoices() : await listComfyuiTtsVoices();
        return applyWorkspaceHeaders(NextResponse.json({ provider, voices }));
    } catch (error) {
        return ttsFailure(error);
    }
}
