import { NextResponse } from "next/server";
import { readBoundedJson, requestFailure } from "@/server/http/request-limits";
import { createEntity, listEntities } from "@/server/library/store";
import { isLibraryKind, LIBRARY_INVALID_ERROR, LIBRARY_KINDS, LIBRARY_KIND_ERROR, type LibraryEntity, type LibraryKind } from "@/server/library/contract";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIBRARY_BODY_MAX_BYTES = 256 * 1024;
const QUERY_MAX_LENGTH = 120;

function libraryFailure(error: unknown): Response {
    const code = error instanceof Error ? error.message : "";
    const status = code === "ERR_LIBRARY_NOT_FOUND" ? 404
        : code === "ERR_LIBRARY_CONFLICT" ? 409
            : code === "ERR_LIBRARY_KIND" || code === "ERR_LIBRARY_INVALID" ? 400
                : 503;
    return applyWorkspaceHeaders(NextResponse.json({ error: status === 503 ? "ERR_LIBRARY_UNAVAILABLE" : code }, { status }));
}

function compareEntities(a: LibraryEntity, b: LibraryEntity): number {
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

export async function GET(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const url = new URL(request.url);
    const requested = url.searchParams.get("kind");
    if (requested !== null && !isLibraryKind(requested)) {
        return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_KIND_ERROR }, { status: 400 }));
    }
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length > QUERY_MAX_LENGTH) {
        return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_INVALID_ERROR }, { status: 400 }));
    }
    const kinds: LibraryKind[] = isLibraryKind(requested) ? [requested] : [...LIBRARY_KINDS];
    try {
        const entities = (await Promise.all(kinds.map((kind) => listEntities(kind)))).flat();
        const needle = query.toLowerCase();
        const filtered = needle
            ? entities.filter((entity) => entity.name.toLowerCase().includes(needle) || entity.slug.includes(needle))
            : entities;
        filtered.sort(compareEntities);
        return applyWorkspaceHeaders(NextResponse.json({ entities: filtered, count: filtered.length }));
    } catch (error) {
        return libraryFailure(error);
    }
}

export async function POST(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    let body: unknown;
    try {
        body = await readBoundedJson(request, LIBRARY_BODY_MAX_BYTES);
    } catch (error) {
        return requestFailure(error);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_INVALID_ERROR }, { status: 400 }));
    }
    const kind = (body as Record<string, unknown>).kind;
    if (!isLibraryKind(kind)) {
        return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_KIND_ERROR }, { status: 400 }));
    }
    try {
        const entity = await createEntity(kind, body);
        return applyWorkspaceHeaders(NextResponse.json({ entity }, { status: 201 }));
    } catch (error) {
        return libraryFailure(error);
    }
}
