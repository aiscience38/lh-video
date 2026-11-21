import { NextResponse } from "next/server";
import { z } from "zod";
import { readBoundedJson, requestFailure } from "@/server/http/request-limits";
import { readProduction } from "@/server/productions/store";
import { invalidBody, isPlainObject } from "@/server/productions/http";
import { PRODUCTION_NOT_FOUND_ERROR } from "@/server/productions/contract";
import {
    QA_REPORT_BODY_MAX_BYTES,
    QA_REPORT_INVALID_ERROR,
    readQaReport,
    qaReportInputSchema,
    saveQaContactSheet,
    writeQaReport,
    type QaReportDocument,
} from "@/server/productions/qa-report";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const submissionSchema = z.strictObject({
    report: qaReportInputSchema.omit({ contactSheetPath: true }),
    /** Base64 PNG; only the server decides where the sheet is stored. */
    contactSheetPng: z.string().min(1).max(6_000_000).optional(),
});

function reportView(id: string, document: QaReportDocument) {
    return {
        durationSeconds: document.durationSeconds,
        hasVideo: document.hasVideo,
        hasAudio: document.hasAudio,
        findings: document.findings,
        updatedAt: document.updatedAt,
        contactSheetUrl: document.contactSheetPath
            ? `/api/productions/${encodeURIComponent(id)}/qa/contact-sheet`
            : null,
    };
}

function qaFailure(error: unknown): Response {
    const code = error instanceof Error ? error.message : "";
    if (code === PRODUCTION_NOT_FOUND_ERROR) {
        return applyWorkspaceHeaders(NextResponse.json({ error: code }, { status: 404 }));
    }
    if (code === QA_REPORT_INVALID_ERROR) {
        return applyWorkspaceHeaders(NextResponse.json({ error: code }, { status: 400 }));
    }
    return applyWorkspaceHeaders(NextResponse.json({ error: "ERR_QA_UNAVAILABLE" }, { status: 503 }));
}

/** Returns the stored QA report, or `report: null` when the cut has not been checked yet. */
export async function GET(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { id } = await context.params;
    try {
        const production = await readProduction(id);
        if (!production) return qaFailure(new Error(PRODUCTION_NOT_FOUND_ERROR));
        const document = await readQaReport(production);
        return applyWorkspaceHeaders(NextResponse.json({ report: document ? reportView(id, document) : null }));
    } catch (error) {
        return qaFailure(error);
    }
}

/**
 * Persists one QA report for this production. The optional contact sheet is
 * stored as a production-owned PNG, then referenced by its guarded GET route.
 */
export async function POST(request: Request, context: Context) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    const { id } = await context.params;
    let body: unknown;
    try {
        body = await readBoundedJson(request, QA_REPORT_BODY_MAX_BYTES);
    } catch (error) {
        return requestFailure(error);
    }
    if (!isPlainObject(body)) return invalidBody();
    const parsed = submissionSchema.safeParse(body);
    if (!parsed.success) return qaFailure(new Error(QA_REPORT_INVALID_ERROR));
    if (parsed.data.contactSheetPng && !parsed.data.report.hasVideo) {
        return qaFailure(new Error(QA_REPORT_INVALID_ERROR));
    }
    try {
        const production = await readProduction(id);
        if (!production) return qaFailure(new Error(PRODUCTION_NOT_FOUND_ERROR));
        let contactSheetPath = "";
        if (parsed.data.contactSheetPng) {
            const bytes = Buffer.from(parsed.data.contactSheetPng, "base64");
            contactSheetPath = await saveQaContactSheet(production, bytes);
        }
        const document = await writeQaReport(production, { ...parsed.data.report, contactSheetPath });
        return applyWorkspaceHeaders(NextResponse.json({ report: reportView(id, document) }, { status: 201 }));
    } catch (error) {
        return qaFailure(error);
    }
}
