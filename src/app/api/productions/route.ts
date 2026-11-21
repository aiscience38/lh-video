import { NextResponse } from "next/server";
import { readBoundedJson, requestFailure } from "@/server/http/request-limits";
import { createProduction, listProductions } from "@/server/productions/store";
import { PRODUCTION_BODY_MAX_BYTES, invalidBody, isPlainObject, productionFailure } from "@/server/productions/http";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    try {
        const productions = await listProductions();
        return applyWorkspaceHeaders(NextResponse.json({ productions, count: productions.length }));
    } catch (error) {
        return productionFailure(error);
    }
}

export async function POST(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    let body: unknown;
    try {
        body = await readBoundedJson(request, PRODUCTION_BODY_MAX_BYTES);
    } catch (error) {
        return requestFailure(error);
    }
    if (!isPlainObject(body)) return invalidBody();
    try {
        const production = await createProduction(body);
        return applyWorkspaceHeaders(NextResponse.json({ production }, { status: 201 }));
    } catch (error) {
        return productionFailure(error);
    }
}
