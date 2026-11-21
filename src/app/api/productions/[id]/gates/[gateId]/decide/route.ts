import { NextResponse } from "next/server";
import { readBoundedJson, requestFailure } from "@/server/http/request-limits";
import { decideGate } from "@/server/productions/store";
import { PRODUCTION_BODY_MAX_BYTES, invalidBody, isPlainObject, productionFailure } from "@/server/productions/http";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; gateId: string }> };

/** Records the single decision for a pending gate. Approving also advances the stop. */
export async function POST(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { id, gateId } = await context.params;
    let body: unknown;
    try {
        body = await readBoundedJson(request, PRODUCTION_BODY_MAX_BYTES);
    } catch (error) {
        return requestFailure(error);
    }
    if (!isPlainObject(body)) return invalidBody();
    try {
        const { production, gate } = await decideGate(id, gateId, body);
        return applyWorkspaceHeaders(NextResponse.json({ production, gate }));
    } catch (error) {
        return productionFailure(error);
    }
}
