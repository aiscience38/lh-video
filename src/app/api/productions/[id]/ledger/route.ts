import { NextResponse } from "next/server";
import { readBoundedJson, requestFailure } from "@/server/http/request-limits";
import { readProduction } from "@/server/productions/store";
import { invalidBody, isPlainObject, PRODUCTION_BODY_MAX_BYTES } from "@/server/productions/http";
import { PRODUCTION_NOT_FOUND_ERROR } from "@/server/productions/contract";
import { appendProductionAsset, readProductionLedger } from "@/server/ledger/production-ledger";
import { LEDGER_CONFLICT_ERROR, LEDGER_INVALID_ERROR } from "@/server/ledger/store";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const LEDGER_ERRORS = new Set<string>([LEDGER_INVALID_ERROR, LEDGER_CONFLICT_ERROR, "ERR_PRODUCTION_LEDGER_INVALID"]);

function ledgerFailure(error: unknown): Response {
    const code = error instanceof Error ? error.message : "";
    if (code === PRODUCTION_NOT_FOUND_ERROR) {
        return applyWorkspaceHeaders(NextResponse.json({ error: code }, { status: 404 }));
    }
    if (LEDGER_ERRORS.has(code)) {
        return applyWorkspaceHeaders(NextResponse.json({ error: code }, { status: code === LEDGER_CONFLICT_ERROR ? 409 : 400 }));
    }
    return applyWorkspaceHeaders(NextResponse.json({ error: "ERR_LEDGER_UNAVAILABLE" }, { status: 503 }));
}

/** Lists the ledger rows this production is charged for, with totals and its budget bar. */
export async function GET(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { id } = await context.params;
    try {
        const production = await readProduction(id);
        if (!production) return ledgerFailure(new Error(PRODUCTION_NOT_FOUND_ERROR));
        const ledger = await readProductionLedger(production);
        return applyWorkspaceHeaders(NextResponse.json(ledger));
    } catch (error) {
        return ledgerFailure(error);
    }
}

/**
 * Records one asset for this production. The ledger document remains the only
 * cost authority; this route appends through the store and links the id.
 */
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
        const production = await readProduction(id);
        if (!production) return ledgerFailure(new Error(PRODUCTION_NOT_FOUND_ERROR));
        const record = await appendProductionAsset(production, body);
        return applyWorkspaceHeaders(NextResponse.json({ record }, { status: 201 }));
    } catch (error) {
        return ledgerFailure(error);
    }
}
