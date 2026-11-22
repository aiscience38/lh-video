import { NextResponse } from "next/server";
import { listTrash } from "@/server/library/trash";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only listing of library/.trash; deletion and restore are separate operator actions. */
export async function GET(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    try {
        const entries = await listTrash();
        return applyWorkspaceHeaders(NextResponse.json({ entries, count: entries.length }));
    } catch {
        return applyWorkspaceHeaders(NextResponse.json({ error: "ERR_LIBRARY_UNAVAILABLE" }, { status: 503 }));
    }
}
