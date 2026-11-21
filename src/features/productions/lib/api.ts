import type { Gate, Production, ProductionLedger, ProductionQa, ProductionStop, StopState } from "../types";

export class ProductionRequestError extends Error {
    constructor(public readonly code: string, public readonly status: number) {
        super(code);
        this.name = "ProductionRequestError";
    }
}

const KNOWN_CODES = new Set([
    "ERR_PRODUCTION_NOT_FOUND",
    "ERR_PRODUCTION_INVALID",
    "ERR_PRODUCTION_CONFLICT",
    "ERR_PRODUCTION_BLOCKED",
    "ERR_PRODUCTION_COMPLETE",
    "ERR_PRODUCTION_STOP_LOCKED",
    "ERR_PRODUCTION_GATE_PENDING",
    "ERR_GATE_NOT_FOUND",
    "ERR_GATE_INVALID",
    "ERR_GATE_DECIDED",
    "ERR_PRODUCTIONS_UNAVAILABLE",
]);

async function productionRequest<T>(url: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
        response = await fetch(url, { ...init, headers: { Accept: "application/json", ...init?.headers } });
    } catch {
        throw new ProductionRequestError("ERR_PRODUCTIONS_UNAVAILABLE", 0);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const code = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : "ERR_REQUEST_INVALID";
        throw new ProductionRequestError(code, response.status);
    }
    return body as T;
}

export function productionErrorKey(error: unknown): string {
    const code = error instanceof ProductionRequestError ? error.code : "";
    return KNOWN_CODES.has(code) ? `errors.${code}` : "errors.generic";
}

export async function listProductions(): Promise<Production[]> {
    const body = await productionRequest<{ productions: Production[] }>("/api/productions", { cache: "no-store" });
    return body.productions;
}

export async function getProduction(id: string): Promise<Production> {
    const body = await productionRequest<{ production: Production }>(`/api/productions/${encodeURIComponent(id)}`, { cache: "no-store" });
    return body.production;
}

export interface CreateProductionInput {
    title: string;
    brief: string;
    effort: Production["effort"];
}

export async function createProduction(input: CreateProductionInput): Promise<Production> {
    const body = await productionRequest<{ production: Production }>("/api/productions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
    return body.production;
}

export async function advanceProduction(id: string): Promise<Production> {
    const body = await productionRequest<{ production: Production }>(`/api/productions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ advance: true }),
    });
    return body.production;
}

export async function setStopState(id: string, stop: ProductionStop, state: Extract<StopState, "working" | "blocked">): Promise<Production> {
    const body = await productionRequest<{ production: Production }>(`/api/productions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stop, state }),
    });
    return body.production;
}

export interface GateRequest {
    stop: ProductionStop;
    note: string;
    options: Array<{ label: string; detail?: string; recommended?: boolean }>;
}

export async function requestGate(id: string, input: GateRequest): Promise<{ production: Production; gate: Gate }> {
    return productionRequest<{ production: Production; gate: Gate }>(`/api/productions/${encodeURIComponent(id)}/gates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

export interface GateDecision {
    decision: "approved" | "rejected";
    selected: string;
    note?: string;
}

export async function decideGate(id: string, gateId: string, input: GateDecision): Promise<{ production: Production; gate: Gate }> {
    return productionRequest<{ production: Production; gate: Gate }>(
        `/api/productions/${encodeURIComponent(id)}/gates/${encodeURIComponent(gateId)}/decide`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        },
    );
}

/** Ledger rows, totals and the budget bar for one production. */
export async function getProductionLedger(id: string): Promise<ProductionLedger> {
    return productionRequest<ProductionLedger>(`/api/productions/${encodeURIComponent(id)}/ledger`, { cache: "no-store" });
}

/** The stored QA report; `report: null` means the cut has not been checked. */
export async function getProductionQa(id: string): Promise<ProductionQa> {
    return productionRequest<ProductionQa>(`/api/productions/${encodeURIComponent(id)}/qa`, { cache: "no-store" });
}
