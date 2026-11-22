import { AssetError, PRIVATE_MEDIA_HEADERS, assetErrorResponse } from "@/server/media/asset-source";
import { openTtsAudio } from "@/server/media/storage";
import { guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ASSET_ID = /^[a-f0-9]{64}$/;

/** GET /api/tts/audio/{assetId} -> the materialized MP3, inline. */
export async function GET(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    try {
        const { assetId } = await params;
        if (!ASSET_ID.test(assetId)) throw new AssetError("ERR_UNSAFE_ASSET_PATH");
        const source = await openTtsAudio(`${assetId}.mp3`, { signal: request.signal });
        try {
            const data = await source.handle.readFile({ signal: source.signal });
            return new Response(new Uint8Array(data), {
                status: 200,
                headers: {
                    ...PRIVATE_MEDIA_HEADERS,
                    "Content-Type": source.mimeType,
                    "Content-Disposition": `inline; filename="${assetId}.mp3"`,
                    "Content-Length": String(data.length),
                    "Accept-Ranges": "bytes",
                },
            });
        } finally {
            await source.handle.close();
        }
    } catch (error) {
        return assetErrorResponse(error);
    }
}
