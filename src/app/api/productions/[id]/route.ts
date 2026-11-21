import { NextResponse } from "next/server";
import { readBoundedJson, requestFailure } from "@/server/http/request-limits";
import { advanceProduction, readProduction, setStopState, updateProduction } from "@/server/productions/store";
import { PRODUCTION_BODY_MAX_BYTES, invalidBody, isPlainObject, productionFailure } from "@/server/productions/http";
import { PRODUCTION_NOT_FOUND_ERROR } from "@/server/productions/contract";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { id } = await context.params;
    try {
        const production = await readProduction(id);
        return production
            ? applyWorkspaceHeaders(NextResponse.json({ production }))
            : applyWorkspaceHeaders(NextResponse.json({ error: PRODUCTION_NOT_FOUND_ERROR }, { status: 404 }));
    } catch (error) {
        return productionFailure(error);
    }
}

/**
 * Descriptive fields, stop state changes and advances all flow through the
 * store so no client can rewrite the whole document or skip a stop.
 */
export async function PATCH(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { id } = await context.params;
    let body: unknown;
    try {
        body = await readBoundedJson(request, PRODUCTION_BODY_MAX_BYTES);
    } catch (error) {
        return requestFailure(error);
    }
    if (!isPlainObject(body)) return invalidBody();
    try {
        const production = body.advance === true
            ? await advanceProduction(id)
            : body.stop !== undefined || body.state !== undefined
                ? await setStopState(id, body)
                : await updateProduction(id, body);
        return applyWorkspaceHeaders(NextResponse.json({ production }));
    } catch (error) {
        return productionFailure(error);
    }
}
