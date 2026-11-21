import { NextResponse } from "next/server";
import { MOTION_PRESETS_LIST } from "@/server/catalog/motion-presets";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";

/** Static camera motion catalog; the composer filters it by capability family. */
export async function GET(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    return applyWorkspaceHeaders(NextResponse.json({ presets: MOTION_PRESETS_LIST }));
}
