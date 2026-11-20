import { NextResponse } from "next/server";
import { readBoundedJson, requestFailure } from "@/server/http/request-limits";
import {
    LIBRARY_CONFLICT_ERROR,
    LIBRARY_INVALID_ERROR,
    LIBRARY_KIND_ERROR,
    LIBRARY_NOT_FOUND_ERROR,
} from "@/server/library/contract";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";
import { createScene, listScenes, type SceneShotInput } from "@/server/scenes/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCENES_BODY_MAX_BYTES = 256 * 1024;
const QUERY_MAX_LENGTH = 120;

function sceneFailure(error: unknown): Response {
    const code = error instanceof Error ? error.message : "";
    const status = code === LIBRARY_NOT_FOUND_ERROR ? 404
        : code === LIBRARY_CONFLICT_ERROR ? 409
            : code === LIBRARY_KIND_ERROR || code === LIBRARY_INVALID_ERROR ? 400
                : 503;
    return applyWorkspaceHeaders(NextResponse.json({ error: status === 503 ? "ERR_LIBRARY_UNAVAILABLE" : code }, { status }));
}

export async function GET(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length > QUERY_MAX_LENGTH) {
        return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_INVALID_ERROR }, { status: 400 }));
    }
    try {
        const scenes = await listScenes();
        const needle = query.toLowerCase();
        const filtered = needle
            ? scenes.filter((scene) => scene.name.toLowerCase().includes(needle) || scene.slug.includes(needle))
            : scenes;
        return applyWorkspaceHeaders(NextResponse.json({ scenes: filtered, count: filtered.length }));
    } catch (error) {
        return sceneFailure(error);
    }
}

export async function POST(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    let body: unknown;
    try {
        body = await readBoundedJson(request, SCENES_BODY_MAX_BYTES);
    } catch (error) {
        return requestFailure(error);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_INVALID_ERROR }, { status: 400 }));
    }
    const { name, shots } = body as Record<string, unknown>;
    if (typeof name !== "string" || (shots !== undefined && !Array.isArray(shots))) {
        return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_INVALID_ERROR }, { status: 400 }));
    }
    try {
        const scene = await createScene(name, (shots ?? []) as SceneShotInput[]);
        return applyWorkspaceHeaders(NextResponse.json({ scene }, { status: 201 }));
    } catch (error) {
        return sceneFailure(error);
    }
}
