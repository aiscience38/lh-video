export const PRODUCTION_STOPS = ["concept", "outline", "storyboard", "sound", "cut", "delivery"] as const;
export type ProductionStop = (typeof PRODUCTION_STOPS)[number];

export type StopState = "waiting" | "working" | "done" | "blocked";
export type ProductionEffort = "quick" | "standard" | "studio";
export type GateState = "pending" | "approved" | "rejected";

export type StopStates = Record<ProductionStop, StopState>;

export interface GateOption {
    id: string;
    label: string;
    detail: string;
    recommended: boolean;
}

export interface Gate {
    id: string;
    productionId: string;
    stop: ProductionStop;
    state: GateState;
    options: GateOption[];
    selected: string | null;
    note: string;
    decidedAt: string | null;
}

export interface Production {
    id: string;
    slug: string;
    title: string;
    brief: string;
    effort: ProductionEffort;
    stopStates: StopStates;
    gates: Gate[];
    createdAt: string;
    updatedAt: string;
}

export type StopTone = "amber" | "violet" | "green" | "red";

/** Amber waits, violet works, green is done and red is blocked. */
export function stopTone(state: StopState): StopTone {
    switch (state) {
        case "waiting": return "amber";
        case "working": return "violet";
        case "done": return "green";
        case "blocked": return "red";
        default: return "amber";
    }
}

/** The only stop a production may act on: the first one that is not done. */
export function activeStop(stopStates: StopStates): ProductionStop | null {
    return PRODUCTION_STOPS.find((stop) => stopStates[stop] !== "done") ?? null;
}

export function pendingGate(production: Production): Gate | undefined {
    return production.gates.find((gate) => gate.state === "pending");
}

/** The recommended option, or the first one, is what a decision card preselects. */
export function recommendedOption(gate: Gate): GateOption | undefined {
    return gate.options.find((option) => option.recommended) ?? gate.options[0];
}

export function optionLabel(gate: Gate, optionId: string | null): string | undefined {
    if (!optionId) return undefined;
    return gate.options.find((option) => option.id === optionId)?.label;
}

const ATTENTION_RANK: Record<StopState, number> = { waiting: 0, blocked: 1, working: 2, done: 3 };

/** Board rank mirrors the server contract: waiting and pending decisions first. */
export function attentionRank(production: Production): number {
    if (production.gates.some((gate) => gate.state === "pending")) return 0;
    const stop = activeStop(production.stopStates);
    return stop ? ATTENTION_RANK[production.stopStates[stop]] : ATTENTION_RANK.done;
}

/** Waiting-first board order, newest activity breaking ties. */
export function sortedForBoard(productions: Production[]): Production[] {
    return [...productions].sort((a, b) => {
        const rank = attentionRank(a) - attentionRank(b);
        if (rank !== 0) return rank;
        const updated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
        if (updated !== 0) return updated;
        return a.title.localeCompare(b.title);
    });
}

export function isComplete(production: Production): boolean {
    return activeStop(production.stopStates) === null;
}

/* ---------- Ledger ---------- */

export interface LedgerRecord {
    assetId: string;
    source: "upload" | "provider";
    provider: string;
    model: string;
    promptHash: string;
    costUsd: number;
    license: string;
    createdAt: string;
    estimated: boolean;
}

export interface LedgerProviderTotal {
    count: number;
    totalUsd: number;
}

export interface LedgerTotals {
    count: number;
    totalUsd: number;
    exactUsd: number;
    estimatedUsd: number;
    byProvider: Record<string, LedgerProviderTotal>;
}

export interface ProductionBudget {
    effort: ProductionEffort;
    budgetUsd: number;
    spentUsd: number;
    remainingUsd: number;
    percentUsed: number;
    overBudget: boolean;
}

export interface ProductionLedger {
    records: LedgerRecord[];
    totals: LedgerTotals;
    budget: ProductionBudget;
}

/* ---------- QA ---------- */

export const QA_FINDING_TYPES = ["black", "frozen", "silence", "flash", "loudness", "duration"] as const;
export type QaFindingType = (typeof QA_FINDING_TYPES)[number];
export type QaSeverity = "error" | "warning" | "info";

export interface QaFinding {
    type: QaFindingType;
    severity: QaSeverity;
    tStart: number;
    tEnd: number;
    detail: string;
}

export interface ProductionQaReport {
    durationSeconds: number;
    hasVideo: boolean;
    hasAudio: boolean;
    findings: QaFinding[];
    updatedAt: string;
    contactSheetUrl: string | null;
}

export interface ProductionQa {
    report: ProductionQaReport | null;
}
