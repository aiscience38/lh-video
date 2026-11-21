import { NextResponse } from "next/server";
import { deleteNote, isValidSubjectId, NOTES_INVALID_ERROR, NOTES_NOT_FOUND_ERROR } from "@/server/notes/store";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function invalidRequest(): Response {
    return applyWorkspaceHeaders(NextResponse.json({ error: NOTES_INVALID_ERROR }, { status: 400 }));
}

/**
 * DELETE /api/notes/<noteId>?subjectId=<id>
 * The note id alone is not unique across subjects, so the subject is required.
 */
export async function DELETE(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { id } = await context.params;
    const subjectId = new URL(request.url).searchParams.get("subjectId") ?? "";
    if (!isValidSubjectId(subjectId) || !id) return invalidRequest();
    try {
        const removed = await deleteNote(subjectId, id);
        if (!removed) {
            return applyWorkspaceHeaders(NextResponse.json({ error: NOTES_NOT_FOUND_ERROR }, { status: 404 }));
        }
        return applyWorkspaceHeaders(NextResponse.json({ ok: true, id }));
    } catch (error) {
        const code = error instanceof Error ? error.message : "";
        const status = code === NOTES_INVALID_ERROR ? 400 : 503;
        return applyWorkspaceHeaders(NextResponse.json({ error: status === 503 ? "ERR_NOTES_UNAVAILABLE" : code }, { status }));
    }
}
