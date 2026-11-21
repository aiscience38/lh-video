import { NextResponse } from "next/server";
import { readBoundedJson, requestFailure } from "@/server/http/request-limits";
import { requestGate } from "@/server/productions/store";
import { PRODUCTION_BODY_MAX_BYTES, invalidBody, isPlainObject, productionFailure } from "@/server/productions/http";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Opens a human gate on the production's active stop. */
export async function POST(request: Request, context: Context) {
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
        const { production, gate } = await requestGate(id, body);
        return applyWorkspaceHeaders(NextResponse.json({ production, gate }, { status: 201 }));
    } catch (error) {
        return productionFailure(error);
    }
}
