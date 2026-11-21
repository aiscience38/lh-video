import "server-only";

import { z } from "zod";

/**
 * Production contract.
 *
 * A production is one JSON document at
 * `STORAGE_ROOT/productions/<slug>/production.json`. It owns its own pipeline
 * stop states and its append-only gate log; nothing here touches the creative
 * library or its assets.
 */

/** Ordered pipeline stops. A production can only move forward through this list. */
export const PRODUCTION_STOPS = ["concept", "outline", "storyboard", "sound", "cut", "delivery"] as const;
export type ProductionStop = (typeof PRODUCTION_STOPS)[number];

export const STOP_STATES = ["waiting", "working", "done", "blocked"] as const;
export type StopState = (typeof STOP_STATES)[number];

export const PRODUCTION_EFFORTS = ["quick", "standard", "studio"] as const;
export type ProductionEffort = (typeof PRODUCTION_EFFORTS)[number];

export const GATE_STATES = ["pending", "approved", "rejected"] as const;
export type GateState = (typeof GATE_STATES)[number];

/** A decision can only approve or reject; both are final for that gate. */
export const GATE_DECISIONS = ["approved", "rejected"] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

export const PRODUCTION_NOT_FOUND_ERROR = "ERR_PRODUCTION_NOT_FOUND";
export const PRODUCTION_INVALID_ERROR = "ERR_PRODUCTION_INVALID";
export const PRODUCTION_CONFLICT_ERROR = "ERR_PRODUCTION_CONFLICT";
export const PRODUCTION_BLOCKED_ERROR = "ERR_PRODUCTION_BLOCKED";
export const PRODUCTION_COMPLETE_ERROR = "ERR_PRODUCTION_COMPLETE";
export const PRODUCTION_STOP_LOCKED_ERROR = "ERR_PRODUCTION_STOP_LOCKED";
export const PRODUCTION_GATE_PENDING_ERROR = "ERR_PRODUCTION_GATE_PENDING";
export const GATE_NOT_FOUND_ERROR = "ERR_GATE_NOT_FOUND";
export const GATE_INVALID_ERROR = "ERR_GATE_INVALID";
export const GATE_DECIDED_ERROR = "ERR_GATE_DECIDED";

/** Matches production and gate identifiers; always safe as a path segment. */
export const PRODUCTION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;
export const MAX_SLUG_LENGTH = 49;
export const MAX_GATE_OPTIONS = 6;

/** Windows device names cannot be directory names, even lowercase and without extension. */
const RESERVED_SLUGS = new Set([
    "con", "prn", "aux", "nul", "clock$",
    ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
    ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export function isValidSlug(value: unknown): value is string {
    return typeof value === "string" && SLUG_PATTERN.test(value) && !RESERVED_SLUGS.has(value);
}

/** Derives a lowercase, separator-safe slug; callers validate the result before creating. */
export function slugify(title: string): string {
    return title
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_SLUG_LENGTH)
        .replace(/-+$/g, "");
}

export function isProductionStop(value: unknown): value is ProductionStop {
    return typeof value === "string" && (PRODUCTION_STOPS as readonly string[]).includes(value);
}

export function isStopState(value: unknown): value is StopState {
    return typeof value === "string" && (STOP_STATES as readonly string[]).includes(value);
}

export function isGateState(value: unknown): value is GateState {
    return typeof value === "string" && (GATE_STATES as readonly string[]).includes(value);
}

const productionIdSchema = z.uuid();
const slugSchema = z.string().refine(isValidSlug, { error: PRODUCTION_INVALID_ERROR });
const timestampSchema = z.iso.datetime({ offset: true });
const titleSchema = z.string().trim().min(1).max(120);
const briefSchema = z.string().max(4000);
const noteSchema = z.string().max(2000);
const stopSchema = z.enum(PRODUCTION_STOPS);
const optionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, { error: GATE_INVALID_ERROR });
const gateStateSchema = z.enum(GATE_STATES);

/** One selectable answer on a gate. At most one option is recommended. */
export const gateOptionSchema = z.object({
    id: optionIdSchema,
    label: z.string().trim().min(1).max(160),
    detail: z.string().max(600).default(""),
    recommended: z.boolean().default(false),
});
export type GateOption = z.infer<typeof gateOptionSchema>;

/**
 * One human gate. Gates are append-only: deciding a gate rewrites only that
 * record once, and any later change of mind needs a brand new gate.
 */
export const gateSchema = z.object({
    id: productionIdSchema,
    productionId: productionIdSchema,
    stop: stopSchema,
    state: gateStateSchema,
    options: z.array(gateOptionSchema).min(1).max(MAX_GATE_OPTIONS),
    selected: optionIdSchema.nullable(),
    note: noteSchema.default(""),
    decidedAt: timestampSchema.nullable(),
});
export type Gate = z.infer<typeof gateSchema>;

/** All six stops are always present so a state map is never partially defined. */
export const stopStatesSchema = z.object({
    concept: z.enum(STOP_STATES),
    outline: z.enum(STOP_STATES),
    storyboard: z.enum(STOP_STATES),
    sound: z.enum(STOP_STATES),
    cut: z.enum(STOP_STATES),
    delivery: z.enum(STOP_STATES),
});
export type StopStates = z.infer<typeof stopStatesSchema>;

export const productionSchema = z.object({
    id: productionIdSchema,
    slug: slugSchema,
    title: titleSchema,
    brief: briefSchema.default(""),
    effort: z.enum(PRODUCTION_EFFORTS),
    stopStates: stopStatesSchema,
    gates: z.array(gateSchema).default(() => []),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
});
export type Production = z.infer<typeof productionSchema>;

export const productionCreateSchema = z.strictObject({
    title: titleSchema,
    brief: briefSchema.default(""),
    effort: z.enum(PRODUCTION_EFFORTS).default("standard"),
});
export type ProductionCreateInput = z.infer<typeof productionCreateSchema>;

/** Update schema drops server-owned fields: stops and gates only move through their own functions. */
export const productionUpdateSchema = z.strictObject({
    title: titleSchema.optional(),
    brief: briefSchema.optional(),
    effort: z.enum(PRODUCTION_EFFORTS).optional(),
});
export type ProductionUpdateInput = z.infer<typeof productionUpdateSchema>;

export const stopTransitionSchema = z.strictObject({
    stop: stopSchema,
    state: z.enum(["working", "blocked"]),
});
export type StopTransitionInput = z.infer<typeof stopTransitionSchema>;

const gateOptionInputSchema = z.object({
    label: z.string().trim().min(1).max(160),
    detail: z.string().max(600).default(""),
    recommended: z.boolean().default(false),
});

export const gateRequestSchema = z.strictObject({
    stop: stopSchema,
    note: noteSchema.default(""),
    options: z.array(gateOptionInputSchema).min(1).max(MAX_GATE_OPTIONS),
});
export type GateRequestInput = z.infer<typeof gateRequestSchema>;

export const gateDecisionSchema = z.strictObject({
    decision: z.enum(GATE_DECISIONS),
    selected: optionIdSchema,
    note: noteSchema.optional(),
});
export type GateDecisionInput = z.infer<typeof gateDecisionSchema>;

/** A fresh production waits on every stop; nothing is working until it advances. */
export function initialStopStates(): StopStates {
    return {
        concept: "waiting",
        outline: "waiting",
        storyboard: "waiting",
        sound: "waiting",
        cut: "waiting",
        delivery: "waiting",
    };
}

/** The only stop a production may act on: the first one that is not done. */
export function activeStop(stopStates: StopStates): ProductionStop | null {
    return PRODUCTION_STOPS.find((stop) => stopStates[stop] !== "done") ?? null;
}

export function pendingGate(production: Production): Gate | undefined {
    return production.gates.find((gate) => gate.state === "pending");
}

const ATTENTION_RANK: Record<StopState, number> = { waiting: 0, blocked: 1, working: 2, done: 3 };

/** Board order: waiting and pending decisions first, then blocked, working and delivered. */
export function productionAttentionRank(production: Production): number {
    if (production.gates.some((gate) => gate.state === "pending")) return 0;
    const stop = activeStop(production.stopStates);
    return stop ? ATTENTION_RANK[production.stopStates[stop]] : ATTENTION_RANK.done;
}

export function compareProductions(a: Production, b: Production): number {
    const rank = productionAttentionRank(a) - productionAttentionRank(b);
    if (rank !== 0) return rank;
    const updated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (updated !== 0) return updated;
    return a.title.localeCompare(b.title) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}
