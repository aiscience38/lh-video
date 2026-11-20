import { NextRequest, NextResponse } from "next/server";
import { readGenerationForm, requestFailure } from "@/server/http/request-limits";
import { saveInputLocally } from "@/server/media/storage";
import { toJpeg } from "@/server/media/input-upload";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOADED_URL = /^\/api\/uploaded\/([a-f0-9]{64})\.jpg$/;

function assetFailure(code: string, status: number): Response {
    return applyWorkspaceHeaders(NextResponse.json({ error: code }, { status }));
}

/**
 * Store one character reference image in the workspace uploads folder.
 * The asset id is content addressed, so re-uploading the same image is idempotent.
 */
export async function POST(request: NextRequest) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;

    let form: FormData;
    try {
        form = await readGenerationForm(request);
    } catch (error) {
        return requestFailure(error);
    }

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return assetFailure("ERR_EMPTY_MEDIA", 400);
    try {
        const jpeg = await toJpeg(Buffer.from(await file.arrayBuffer()));
        const url = await saveInputLocally(jpeg, ".jpg");
        const match = UPLOADED_URL.exec(url);
        if (!match) return assetFailure("ERR_LIBRARY_UNAVAILABLE", 503);
        return applyWorkspaceHeaders(NextResponse.json({ assetId: `asset_${match[1]}`, url }, { status: 201 }));
    } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === "ERR_UNSUPPORTED_MEDIA_TYPE") return assetFailure(code, 415);
        if (code === "ERR_MEDIA_TOO_LARGE" || code === "ERR_IMAGE_PIXEL_LIMIT") return assetFailure(code, 413);
        if (code === "ERR_EMPTY_MEDIA") return assetFailure(code, 400);
        return assetFailure("ERR_LIBRARY_UNAVAILABLE", 503);
    }
}
