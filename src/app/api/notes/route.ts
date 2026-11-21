import { NextResponse } from "next/server";
import { readBoundedJson, requestFailure } from "@/server/http/request-limits";
import {
    createNote,
    isValidSubjectId,
    listNotes,
    NOTES_INVALID_ERROR,
    NOTES_NOT_FOUND_ERROR,
    renderReviewMarkdown,
} from "@/server/notes/store";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOTES_BODY_MAX_BYTES = 64 * 1024;

function notesFailure(error: unknown): Response {
    const code = error instanceof Error ? error.message : "";
    const status = code === NOTES_NOT_FOUND_ERROR ? 404
        : code === NOTES_INVALID_ERROR ? 400
            : 503;
    const exposed = status === 503 ? "ERR_NOTES_UNAVAILABLE" : code;
    return applyWorkspaceHeaders(NextResponse.json({ error: exposed }, { status }));
}

function invalidRequest(): Response {
    return applyWorkspaceHeaders(NextResponse.json({ error: NOTES_INVALID_ERROR }, { status: 400 }));
}

/**
 * GET  /api/notes?subjectId=<id>                    → { subjectId, notes, count }
 * GET  /api/notes?subjectId=<id>&format=markdown    → REVIEW.md attachment
 * POST /api/notes  { subjectId, taskId?, assetId?, tSeconds, text, decision? }
 */
export async function GET(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const url = new URL(request.url);
    const subjectId = url.searchParams.get("subjectId") ?? "";
    if (!isValidSubjectId(subjectId)) return invalidRequest();
    try {
        if (url.searchParams.get("format") === "markdown") {
            const markdown = await renderReviewMarkdown(subjectId);
            return applyWorkspaceHeaders(new NextResponse(markdown, {
                status: 200,
                headers: {
                    "Content-Type": "text/markdown; charset=utf-8",
                    "Content-Disposition": "attachment; filename=\"REVIEW.md\"",
                },
            }));
        }
        const notes = await listNotes(subjectId);
        return applyWorkspaceHeaders(NextResponse.json({ subjectId, notes, count: notes.length }));
    } catch (error) {
        return notesFailure(error);
    }
}

export async function POST(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    let body: unknown;
    try {
        body = await readBoundedJson(request, NOTES_BODY_MAX_BYTES);
    } catch (error) {
        return requestFailure(error);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return invalidRequest();
    const record = body as Record<string, unknown>;
    const subjectId = record.subjectId;
    if (!isValidSubjectId(subjectId)) return invalidRequest();
    try {
        const note = await createNote(subjectId, record);
        return applyWorkspaceHeaders(NextResponse.json({ note }, { status: 201 }));
    } catch (error) {
        return notesFailure(error);
    }
}
