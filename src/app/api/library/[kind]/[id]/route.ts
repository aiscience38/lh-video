import { NextResponse } from "next/server";
import { assertEmptyBody, readBoundedJson, requestFailure } from "@/server/http/request-limits";
import { deleteEntity, readEntity, updateEntity } from "@/server/library/store";
import { isLibraryKind, LIBRARY_INVALID_ERROR, LIBRARY_KIND_ERROR } from "@/server/library/contract";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIBRARY_BODY_MAX_BYTES = 256 * 1024;

type Context = { params: Promise<{ kind: string; id: string }> };

function libraryFailure(error: unknown): Response {
    const code = error instanceof Error ? error.message : "";
    const status = code === "ERR_LIBRARY_NOT_FOUND" ? 404
        : code === "ERR_LIBRARY_CONFLICT" ? 409
            : code === "ERR_LIBRARY_KIND" || code === "ERR_LIBRARY_INVALID" ? 400
                : 503;
    return applyWorkspaceHeaders(NextResponse.json({ error: status === 503 ? "ERR_LIBRARY_UNAVAILABLE" : code }, { status }));
}

function kindFailure(): Response {
    return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_KIND_ERROR }, { status: 400 }));
}

export async function GET(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { kind, id } = await context.params;
    if (!isLibraryKind(kind)) return kindFailure();
    try {
        const entity = await readEntity(kind, id);
        return entity
            ? applyWorkspaceHeaders(NextResponse.json({ entity }))
            : applyWorkspaceHeaders(NextResponse.json({ error: "ERR_LIBRARY_NOT_FOUND" }, { status: 404 }));
    } catch (error) {
        return libraryFailure(error);
    }
}

export async function PATCH(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { kind, id } = await context.params;
    if (!isLibraryKind(kind)) return kindFailure();
    let body: unknown;
    try {
        body = await readBoundedJson(request, LIBRARY_BODY_MAX_BYTES);
    } catch (error) {
        return requestFailure(error);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_INVALID_ERROR }, { status: 400 }));
    }
    try {
        const entity = await updateEntity(kind, id, body);
        return applyWorkspaceHeaders(NextResponse.json({ entity }));
    } catch (error) {
        return libraryFailure(error);
    }
}

export async function DELETE(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { kind, id } = await context.params;
    if (!isLibraryKind(kind)) return kindFailure();
    try {
        await assertEmptyBody(request);
    } catch (error) {
        return requestFailure(error);
    }
    try {
        const deleted = await deleteEntity(kind, id);
        return deleted
            ? applyWorkspaceHeaders(NextResponse.json({ ok: true }))
            : applyWorkspaceHeaders(NextResponse.json({ error: "ERR_LIBRARY_NOT_FOUND" }, { status: 404 }));
    } catch (error) {
        return libraryFailure(error);
    }
}
