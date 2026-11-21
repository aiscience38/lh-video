import "server-only";

import { NextResponse } from "next/server";
import { applyWorkspaceHeaders } from "@/server/security/workspace-access";
import {
    GATE_DECIDED_ERROR,
    GATE_INVALID_ERROR,
    GATE_NOT_FOUND_ERROR,
    PRODUCTION_BLOCKED_ERROR,
    PRODUCTION_COMPLETE_ERROR,
    PRODUCTION_CONFLICT_ERROR,
    PRODUCTION_GATE_PENDING_ERROR,
    PRODUCTION_INVALID_ERROR,
    PRODUCTION_NOT_FOUND_ERROR,
    PRODUCTION_STOP_LOCKED_ERROR,
} from "./contract";

export const PRODUCTION_BODY_MAX_BYTES = 64 * 1024;

const CONFLICT_CODES = new Set<string>([
    PRODUCTION_CONFLICT_ERROR,
    PRODUCTION_BLOCKED_ERROR,
    PRODUCTION_COMPLETE_ERROR,
    PRODUCTION_STOP_LOCKED_ERROR,
    PRODUCTION_GATE_PENDING_ERROR,
    GATE_DECIDED_ERROR,
]);

/** Maps store error codes to stable HTTP responses without leaking internals. */
export function productionFailure(error: unknown): Response {
    const code = error instanceof Error ? error.message : "";
    const status = code === PRODUCTION_NOT_FOUND_ERROR || code === GATE_NOT_FOUND_ERROR ? 404
        : code === PRODUCTION_INVALID_ERROR || code === GATE_INVALID_ERROR ? 400
            : CONFLICT_CODES.has(code) ? 409
                : 503;
    return applyWorkspaceHeaders(
        NextResponse.json({ error: status === 503 ? "ERR_PRODUCTIONS_UNAVAILABLE" : code }, { status }),
    );
}

export function invalidBody(): Response {
    return applyWorkspaceHeaders(NextResponse.json({ error: PRODUCTION_INVALID_ERROR }, { status: 400 }));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
