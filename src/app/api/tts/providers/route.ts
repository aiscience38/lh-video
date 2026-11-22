import { NextResponse } from "next/server";
import { guardWorkspaceRequest, applyWorkspaceHeaders } from "@/server/security/workspace-access";
import { comfyuiAvailability } from "@/server/tts/comfyui";
import { elevenLabsAvailability } from "@/server/tts/elevenlabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tts/providers -> one availability row per provider, never a throw. */
export async function GET(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    try {
        const [elevenlabs, comfyui] = await Promise.all([elevenLabsAvailability(), comfyuiAvailability()]);
        return applyWorkspaceHeaders(NextResponse.json({ providers: { elevenlabs, comfyui } }));
    } catch {
        return applyWorkspaceHeaders(NextResponse.json({ error: "ERR_TTS_UNAVAILABLE" }, { status: 503 }));
    }
}
