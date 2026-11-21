import { NextResponse } from "next/server";
import { readBoundedJson, requestFailure } from "@/server/http/request-limits";
import { LIBRARY_INVALID_ERROR } from "@/server/library/contract";
import { addShot, removeShot, reorderShots, setKeyframe, type StoryboardShotDraft } from "@/server/library/storyboards";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIBRARY_BODY_MAX_BYTES = 256 * 1024;

type Context = { params: Promise<{ id: string }> };

function libraryFailure(error: unknown): Response {
    const code = error instanceof Error ? error.message : "";
    const status = code === "ERR_LIBRARY_NOT_FOUND" ? 404
        : code === "ERR_LIBRARY_CONFLICT" ? 409
            : code === "ERR_LIBRARY_KIND" || code === "ERR_LIBRARY_INVALID" ? 400
                : 503;
    return applyWorkspaceHeaders(NextResponse.json({ error: status === 503 ? "ERR_LIBRARY_UNAVAILABLE" : code }, { status }));
}

function invalidBody(): Response {
    return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_INVALID_ERROR }, { status: 400 }));
}

/**
 * Shot operations that are awkward through the generic PATCH (it only
 * replaces the whole `shots` array). Read, rename and storyboard delete stay
 * on `/api/library/storyboard/[id]`.
 *
 * Body: `{ "action": "add", "shot": { ... } }`,
 *       `{ "action": "reorder", "orderedIds": ["<uuid>", ...] }`,
 *       `{ "action": "remove", "shotId": "<uuid>" }` or
 *       `{ "action": "keyframe", "shotId": "<uuid>", "assetId": "<id>|null" }`.
 */
export async function POST(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { id } = await context.params;
    let body: unknown;
    try {
        body = await readBoundedJson(request, LIBRARY_BODY_MAX_BYTES);
    } catch (error) {
        return requestFailure(error);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return invalidBody();
    const record = body as Record<string, unknown>;
    try {
        if (record.action === "add") {
            // The helper re-validates this untrusted draft; the cast only satisfies the signature.
            const entity = await addShot(id, (record.shot ?? {}) as StoryboardShotDraft);
            return applyWorkspaceHeaders(NextResponse.json({ entity }, { status: 201 }));
        }
        if (record.action === "reorder") {
            if (!Array.isArray(record.orderedIds)) return invalidBody();
            const entity = await reorderShots(id, record.orderedIds as string[]);
            return applyWorkspaceHeaders(NextResponse.json({ entity }));
        }
        if (record.action === "remove") {
            if (typeof record.shotId !== "string") return invalidBody();
            const entity = await removeShot(id, record.shotId);
            return applyWorkspaceHeaders(NextResponse.json({ entity }));
        }
        if (record.action === "keyframe") {
            if (typeof record.shotId !== "string") return invalidBody();
            if (record.assetId !== null && typeof record.assetId !== "string") return invalidBody();
            const entity = await setKeyframe(id, record.shotId, record.assetId);
            return applyWorkspaceHeaders(NextResponse.json({ entity }));
        }
        return invalidBody();
    } catch (error) {
        return libraryFailure(error);
    }
}
