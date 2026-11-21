import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { syncDirectory } from "@/server/config/durable-fs";
import { assertStorageContained, ensureStorageDirectory, productionsRoot, readJson, writeJsonAtomic } from "./atomic";
import {
    activeStop,
    compareProductions,
    gateDecisionSchema,
    gateRequestSchema,
    initialStopStates,
    isValidSlug,
    MAX_GATE_OPTIONS,
    MAX_SLUG_LENGTH,
    PRODUCTION_BLOCKED_ERROR,
    PRODUCTION_COMPLETE_ERROR,
    PRODUCTION_CONFLICT_ERROR,
    PRODUCTION_GATE_PENDING_ERROR,
    PRODUCTION_ID_PATTERN,
    PRODUCTION_INVALID_ERROR,
    PRODUCTION_NOT_FOUND_ERROR,
    PRODUCTION_STOPS,
    PRODUCTION_STOP_LOCKED_ERROR,
    productionCreateSchema,
    productionSchema,
    productionUpdateSchema,
    GATE_DECIDED_ERROR,
    GATE_INVALID_ERROR,
    GATE_NOT_FOUND_ERROR,
    slugify,
    stopStatesSchema,
    stopTransitionSchema,
    type Gate,
    type GateOption,
    type Production,
    type ProductionStop,
    type StopState,
    type StopStates,
} from "./contract";

const PRODUCTION_FILE = "production.json";
const MAX_SLUG_ATTEMPTS = 1000;

interface ProductionGlobals {
    __productionWriteQueue?: Promise<unknown>;
}
const shared = globalThis as typeof globalThis & ProductionGlobals;
shared.__productionWriteQueue ??= Promise.resolve();

function productionError(code: string): Error {
    return new Error(code);
}

/** Serializes in-process writes; atomic rename still protects across processes. */
async function withProductionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = shared.__productionWriteQueue ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    shared.__productionWriteQueue = pending.catch(() => undefined);
    return pending;
}

function productionDirectory(slug: string): string {
    return path.join(productionsRoot(), slug);
}

function productionFile(slug: string): string {
    return path.join(productionDirectory(slug), PRODUCTION_FILE);
}

function nextTimestamp(previous: string): string {
    const parsed = Date.parse(previous);
    const now = Date.now();
    return new Date(Number.isFinite(parsed) && now <= parsed ? parsed + 1 : now).toISOString();
}

function suffixedSlug(base: string, attempt: number): string {
    const suffix = `-${attempt}`;
    const stem = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, "");
    return `${stem}${suffix}`;
}

export async function listProductions(): Promise<Production[]> {
    const directory = productionsRoot();
    let entries;
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const productions: Production[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
        let production: Production;
        try {
            production = await readJson(productionFile(entry.name), productionSchema);
        } catch (error) {
            if (error instanceof Error && error.message === PRODUCTION_NOT_FOUND_ERROR) continue;
            throw error;
        }
        if (production.slug !== entry.name) throw productionError(PRODUCTION_INVALID_ERROR);
        productions.push(production);
    }
    productions.sort(compareProductions);
    return productions;
}

export async function readProduction(id: string): Promise<Production | undefined> {
    if (typeof id !== "string" || !PRODUCTION_ID_PATTERN.test(id)) return undefined;
    const productions = await listProductions();
    return productions.find((production) => production.id === id);
}

export async function findProductionBySlug(slug: string): Promise<Production | undefined> {
    if (!isValidSlug(slug)) return undefined;
    try {
        const production = await readJson(productionFile(slug), productionSchema);
        return production.slug === slug ? production : undefined;
    } catch (error) {
        if (error instanceof Error && error.message === PRODUCTION_NOT_FOUND_ERROR) return undefined;
        throw error;
    }
}

export async function createProduction(input: unknown): Promise<Production> {
    const parsed = productionCreateSchema.safeParse(input);
    if (!parsed.success) throw productionError(PRODUCTION_INVALID_ERROR);
    return withProductionLock(async () => {
        const base = slugify(parsed.data.title);
        if (!isValidSlug(base)) throw productionError(PRODUCTION_INVALID_ERROR);
        const directory = await ensureStorageDirectory(productionsRoot());
        for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
            const slug = attempt === 1 ? base : suffixedSlug(base, attempt);
            if (!isValidSlug(slug)) throw productionError(PRODUCTION_INVALID_ERROR);
            const target = productionDirectory(slug);
            try {
                await fs.mkdir(target);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
                throw error;
            }
            const timestamp = new Date().toISOString();
            const candidate = {
                id: randomUUID(),
                slug,
                title: parsed.data.title,
                brief: parsed.data.brief,
                effort: parsed.data.effort,
                stopStates: initialStopStates(),
                gates: [],
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            let production: Production;
            try {
                production = productionSchema.parse(candidate);
            } catch {
                await fs.rmdir(target).catch(() => undefined);
                throw productionError(PRODUCTION_INVALID_ERROR);
            }
            try {
                await writeJsonAtomic(productionFile(slug), production);
            } catch (error) {
                await fs.rmdir(target).catch(() => undefined);
                throw error;
            }
            await syncDirectory(directory).catch(() => undefined);
            return production;
        }
        throw productionError(PRODUCTION_CONFLICT_ERROR);
    });
}

/** Updates only descriptive fields. Stops and gates never move through this path. */
export async function updateProduction(id: string, patch: unknown): Promise<Production> {
    if (typeof id !== "string" || !PRODUCTION_ID_PATTERN.test(id)) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
    const parsed = productionUpdateSchema.safeParse(patch);
    if (!parsed.success) throw productionError(PRODUCTION_INVALID_ERROR);
    const changes = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
    if (Object.keys(changes).length === 0) throw productionError(PRODUCTION_INVALID_ERROR);
    return withProductionLock(async () => {
        const current = await readProduction(id);
        if (!current) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
        const next = productionSchema.parse({ ...current, ...changes, updatedAt: nextTimestamp(current.updatedAt) });
        await writeJsonAtomic(productionFile(current.slug), next);
        return next;
    });
}

/** Moves the active stop to working or blocked. Done is only reachable through advance. */
export async function setStopState(id: string, input: unknown): Promise<Production> {
    if (typeof id !== "string" || !PRODUCTION_ID_PATTERN.test(id)) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
    const parsed = stopTransitionSchema.safeParse(input);
    if (!parsed.success) throw productionError(PRODUCTION_INVALID_ERROR);
    return withProductionLock(async () => {
        const current = await readProduction(id);
        if (!current) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
        const active = activeStop(current.stopStates);
        if (active !== parsed.data.stop) throw productionError(PRODUCTION_STOP_LOCKED_ERROR);
        if (current.gates.some((gate) => gate.stop === active && gate.state === "pending")) {
            throw productionError(PRODUCTION_GATE_PENDING_ERROR);
        }
        if (current.stopStates[active] === parsed.data.state) return current;
        const stopStates = stopStatesSchema.parse({ ...current.stopStates, [active]: parsed.data.state });
        const next = productionSchema.parse({ ...current, stopStates, updatedAt: nextTimestamp(current.updatedAt) });
        await writeJsonAtomic(productionFile(current.slug), next);
        return next;
    });
}

function advancedStopStates(stopStates: StopStates): StopStates {
    const active = activeStop(stopStates);
    if (!active) throw productionError(PRODUCTION_COMPLETE_ERROR);
    if (stopStates[active] === "blocked") throw productionError(PRODUCTION_BLOCKED_ERROR);
    const index = PRODUCTION_STOPS.indexOf(active);
    const nextStop = PRODUCTION_STOPS[index + 1];
    const updated: StopStates = { ...stopStates, [active]: "done" };
    if (nextStop) updated[nextStop] = "working";
    return stopStatesSchema.parse(updated);
}

/** Marks the active stop done and starts the next one. Never skips a stop. */
export async function advanceProduction(id: string): Promise<Production> {
    if (typeof id !== "string" || !PRODUCTION_ID_PATTERN.test(id)) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
    return withProductionLock(async () => {
        const current = await readProduction(id);
        if (!current) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
        const active = activeStop(current.stopStates);
        if (!active) throw productionError(PRODUCTION_COMPLETE_ERROR);
        if (current.stopStates[active] === "blocked") throw productionError(PRODUCTION_BLOCKED_ERROR);
        if (current.gates.some((gate) => gate.stop === active && gate.state === "pending")) {
            throw productionError(PRODUCTION_GATE_PENDING_ERROR);
        }
        const stopStates = advancedStopStates(current.stopStates);
        const next = productionSchema.parse({ ...current, stopStates, updatedAt: nextTimestamp(current.updatedAt) });
        await writeJsonAtomic(productionFile(current.slug), next);
        return next;
    });
}

function buildGateOptions(options: Array<{ label: string; detail: string; recommended: boolean }>): GateOption[] {
    if (options.filter((option) => option.recommended).length > 1) throw productionError(GATE_INVALID_ERROR);
    const recommendedIndex = Math.max(0, options.findIndex((option) => option.recommended));
    return options.map((option, index) => ({
        id: `opt-${index + 1}`,
        label: option.label,
        detail: option.detail,
        recommended: index === recommendedIndex,
    }));
}

/** Opens a pending gate on the active stop. One pending gate at a time. */
export async function requestGate(id: string, input: unknown): Promise<{ production: Production; gate: Gate }> {
    if (typeof id !== "string" || !PRODUCTION_ID_PATTERN.test(id)) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
    const parsed = gateRequestSchema.safeParse(input);
    if (!parsed.success) throw productionError(GATE_INVALID_ERROR);
    if (parsed.data.options.length > MAX_GATE_OPTIONS) throw productionError(GATE_INVALID_ERROR);
    return withProductionLock(async () => {
        const current = await readProduction(id);
        if (!current) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
        const active = activeStop(current.stopStates);
        if (active !== parsed.data.stop) throw productionError(PRODUCTION_STOP_LOCKED_ERROR);
        if (current.stopStates[active] === "blocked") throw productionError(PRODUCTION_BLOCKED_ERROR);
        if (current.gates.some((gate) => gate.state === "pending")) throw productionError(PRODUCTION_GATE_PENDING_ERROR);
        const options = buildGateOptions(parsed.data.options);
        const gate: Gate = {
            id: randomUUID(),
            productionId: current.id,
            stop: active,
            state: "pending",
            options,
            selected: null,
            note: parsed.data.note,
            decidedAt: null,
        };
        const next = productionSchema.parse({
            ...current,
            gates: [...current.gates, gate],
            updatedAt: nextTimestamp(current.updatedAt),
        });
        await writeJsonAtomic(productionFile(current.slug), next);
        return { production: next, gate };
    });
}

/**
 * Decides one pending gate exactly once. Approving advances the stop; rejecting
 * leaves the pipeline where it is. A decided gate is never rewritten again.
 */
export async function decideGate(
    id: string,
    gateId: string,
    input: unknown,
): Promise<{ production: Production; gate: Gate }> {
    if (typeof id !== "string" || !PRODUCTION_ID_PATTERN.test(id)) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
    if (typeof gateId !== "string" || !PRODUCTION_ID_PATTERN.test(gateId)) throw productionError(GATE_NOT_FOUND_ERROR);
    const parsed = gateDecisionSchema.safeParse(input);
    if (!parsed.success) throw productionError(GATE_INVALID_ERROR);
    return withProductionLock(async () => {
        const current = await readProduction(id);
        if (!current) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
        const index = current.gates.findIndex((gate) => gate.id === gateId);
        if (index < 0) throw productionError(GATE_NOT_FOUND_ERROR);
        const existing = current.gates[index];
        if (existing.state !== "pending") throw productionError(GATE_DECIDED_ERROR);
        if (!existing.options.some((option) => option.id === parsed.data.selected)) throw productionError(GATE_INVALID_ERROR);
        const stop = existing.stop;
        if (activeStop(current.stopStates) !== stop) throw productionError(PRODUCTION_STOP_LOCKED_ERROR);
        if (current.stopStates[stop] === "blocked") throw productionError(PRODUCTION_BLOCKED_ERROR);
        const decidedAt = nextTimestamp(current.updatedAt);
        const decided: Gate = {
            ...existing,
            state: parsed.data.decision,
            selected: parsed.data.selected,
            note: parsed.data.note ?? existing.note,
            decidedAt,
        };
        const gates = [...current.gates];
        gates[index] = decided;
        const stopStates = parsed.data.decision === "approved" ? advancedStopStates(current.stopStates) : current.stopStates;
        const next = productionSchema.parse({ ...current, gates, stopStates, updatedAt: decidedAt });
        await writeJsonAtomic(productionFile(current.slug), next);
        return { production: next, gate: decided };
    });
}

/** Moves the production folder under `productions/.trash/<slug>-<timestamp>`. */
export async function deleteProduction(id: string): Promise<boolean> {
    if (typeof id !== "string" || !PRODUCTION_ID_PATTERN.test(id)) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
    return withProductionLock(async () => {
        const current = await readProduction(id);
        if (!current) return false;
        const trash = await ensureStorageDirectory(path.join(productionsRoot(), ".trash"));
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        let target = path.join(trash, `${current.slug}-${stamp}`);
        for (let attempt = 2; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
            try {
                await fs.access(target);
                target = path.join(trash, `${current.slug}-${stamp}-${attempt}`);
            } catch {
                break;
            }
        }
        await assertStorageContained(trash);
        try {
            await fs.rename(productionDirectory(current.slug), target);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
        await syncDirectory(productionsRoot()).catch(() => undefined);
        return true;
    });
}

export type { Gate, GateOption, Production, ProductionStop, StopState, StopStates };
