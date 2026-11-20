import { NextResponse } from "next/server";
import { assertEmptyBody, readBoundedJson, requestFailure } from "@/server/http/request-limits";
import {
    LIBRARY_CONFLICT_ERROR,
    LIBRARY_INVALID_ERROR,
    LIBRARY_KIND_ERROR,
    LIBRARY_NOT_FOUND_ERROR,
} from "@/server/library/contract";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";
import { deleteScene, readScene, updateSceneShots, type SceneShotInput } from "@/server/scenes/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCENES_BODY_MAX_BYTES = 256 * 1024;

type Context = { params: Promise<{ id: string }> };

function sceneFailure(error: unknown): Response {
    const code = error instanceof Error ? error.message : "";
    const status = code === LIBRARY_NOT_FOUND_ERROR ? 404
        : code === LIBRARY_CONFLICT_ERROR ? 409
            : code === LIBRARY_KIND_ERROR || code === LIBRARY_INVALID_ERROR ? 400
                : 503;
    return applyWorkspaceHeaders(NextResponse.json({ error: status === 503 ? "ERR_LIBRARY_UNAVAILABLE" : code }, { status }));
}

function missingScene(): Response {
    return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_NOT_FOUND_ERROR }, { status: 404 }));
}

export async function GET(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { id } = await context.params;
    try {
        const scene = await readScene(id);
        return scene
            ? applyWorkspaceHeaders(NextResponse.json({ scene }))
            : missingScene();
    } catch (error) {
        return sceneFailure(error);
    }
}

export async function PATCH(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { id } = await context.params;
    let body: unknown;
    try {
        body = await readBoundedJson(request, SCENES_BODY_MAX_BYTES);
    } catch (error) {
        return requestFailure(error);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_INVALID_ERROR }, { status: 400 }));
    }
    const shots = (body as Record<string, unknown>).shots;
    if (!Array.isArray(shots)) {
        return applyWorkspaceHeaders(NextResponse.json({ error: LIBRARY_INVALID_ERROR }, { status: 400 }));
    }
    try {
        const scene = await updateSceneShots(id, shots as SceneShotInput[]);
        return applyWorkspaceHeaders(NextResponse.json({ scene }));
    } catch (error) {
        return sceneFailure(error);
    }
}

export async function DELETE(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    try {
        await assertEmptyBody(request);
    } catch (error) {
        return requestFailure(error);
    }
    const { id } = await context.params;
    try {
        const deleted = await deleteScene(id);
        return deleted
            ? applyWorkspaceHeaders(NextResponse.json({ ok: true }))
            : missingScene();
    } catch (error) {
        return sceneFailure(error);
    }
}
