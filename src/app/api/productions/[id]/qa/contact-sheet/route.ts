import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { readProduction } from "@/server/productions/store";
import { PRODUCTION_NOT_FOUND_ERROR } from "@/server/productions/contract";
import { QA_CONTACT_SHEET_FILE, qaContactSheetFile, readQaReport } from "@/server/productions/qa-report";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const NOT_FOUND_ERROR = "ERR_QA_CONTACT_SHEET_NOT_FOUND";

function notFound(): Response {
    return applyWorkspaceHeaders(NextResponse.json({ error: NOT_FOUND_ERROR }, { status: 404 }));
}

/**
 * Serves the stored contact sheet for this production's QA report. Only the
 * production-owned sheet path is accepted, so the route cannot become a
 * general storage reader.
 */
export async function GET(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { id } = await context.params;
    try {
        const production = await readProduction(id);
        if (!production) {
            return applyWorkspaceHeaders(NextResponse.json({ error: PRODUCTION_NOT_FOUND_ERROR }, { status: 404 }));
        }
        const report = await readQaReport(production);
        if (!report?.contactSheetPath) return notFound();
        const expected = path.resolve(qaContactSheetFile(production.slug));
        if (path.resolve(report.contactSheetPath) !== expected || path.basename(expected) !== QA_CONTACT_SHEET_FILE) {
            return notFound();
        }
        const bytes = await fs.readFile(expected);
        return applyWorkspaceHeaders(new Response(new Uint8Array(bytes), {
            headers: {
                "Content-Type": "image/png",
                "Content-Length": String(bytes.byteLength),
            },
        }));
    } catch {
        return notFound();
    }
}
