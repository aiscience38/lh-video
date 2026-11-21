import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { STORAGE_ROOT } from "@/server/config/storage-paths";
import { readJson, writeJsonAtomic } from "@/server/library/atomic";
import { ASSET_ID_PATTERN } from "@/server/library/contract";

/**
 * Asset ledger and budget guard.
 *
 * Every generated or uploaded asset gets exactly one append-only record at
 * `STORAGE_ROOT/ledger/assets.json`. The whole document is replaced through
 * `writeJsonAtomic` (temp file + fsync + rename), and in-process appends are
 * serialized, so a reader never observes a partial ledger.
 *
 * `estimated: true` marks a quoted cost that has been held but not settled;
 * `ledgerTotals` keeps the two pools apart so a production can show committed
 * spend and outstanding holds without conflating them.
 */

export const LEDGER_VERSION = 1;
export const LEDGER_INVALID_ERROR = "ERR_LEDGER_INVALID";
export const LEDGER_CONFLICT_ERROR = "ERR_LEDGER_CONFLICT";
export const LEDGER_CORRUPT_ERROR = "ERR_LEDGER_CORRUPT";
export const BUDGET_EXCEEDED_ERROR = "ERR_BUDGET_EXCEEDED";
export const BUDGET_INVALID_ERROR = "ERR_BUDGET_INVALID";

/** The only provider whose generations are treated as free: it runs on local hardware. */
export const FREE_PROVIDER_ID = "comfyui";

/** Budget comparisons use this slack so 0.1 + 0.2 does not read as overspend. */
const BUDGET_EPSILON = 1e-9;
const USD_DECIMALS = 6;
const MAX_USD = 1_000_000;

export const LEDGER_DIR = path.join(STORAGE_ROOT, "ledger");
export const LEDGER_FILE = path.join(LEDGER_DIR, "assets.json");

const timestampSchema = z.iso.datetime({ offset: true });
const providerIdSchema = z.string().min(1).max(64);
const promptHashSchema = z.string().regex(/^[a-f0-9]{64}$/, { error: LEDGER_INVALID_ERROR });
const costSchema = z.number().finite().min(0).max(MAX_USD);

export const ASSET_SOURCES = ["upload", "provider"] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

/**
 * One ledger entry. `license` is free text because rights metadata arrives
 * from providers in prose; `promptHash` pins the exact prompt (sha256 hex) so
 * two generations of the same prompt can be compared without storing text.
 */
export const assetRecordSchema = z.object({
    assetId: z.string().regex(ASSET_ID_PATTERN, { error: LEDGER_INVALID_ERROR }),
    source: z.enum(ASSET_SOURCES),
    provider: providerIdSchema,
    model: z.string().min(1).max(200),
    promptHash: promptHashSchema,
    costUsd: costSchema,
    license: z.string().min(1).max(200),
    createdAt: timestampSchema,
    estimated: z.boolean(),
}).refine(
    (record) => record.provider !== FREE_PROVIDER_ID || record.costUsd === 0,
    { error: `${LEDGER_INVALID_ERROR}: ${FREE_PROVIDER_ID} records must cost 0`, path: ["costUsd"] },
);
export type AssetRecord = z.infer<typeof assetRecordSchema>;

/** What a caller supplies; `createdAt` defaults to now and cost/estimated to 0/false. */
export const assetRecordDraftSchema = z.object({
    assetId: z.string().regex(ASSET_ID_PATTERN, { error: LEDGER_INVALID_ERROR }),
    source: z.enum(ASSET_SOURCES),
    provider: providerIdSchema,
    model: z.string().min(1).max(200),
    promptHash: promptHashSchema,
    costUsd: costSchema.default(0),
    license: z.string().min(1).max(200).default("unknown"),
    createdAt: timestampSchema.optional(),
    estimated: z.boolean().default(false),
});
export type AssetRecordDraft = z.input<typeof assetRecordDraftSchema>;

export const ledgerDocumentSchema = z.object({
    version: z.literal(LEDGER_VERSION),
    records: z.array(assetRecordSchema),
});
export type LedgerDocument = z.infer<typeof ledgerDocumentSchema>;

export interface LedgerProviderTotal {
    count: number;
    totalUsd: number;
}

export interface LedgerTotals {
    count: number;
    /** Exact plus estimated spend, rounded to six decimals. */
    totalUsd: number;
    /** Settled records only (`estimated: false`). */
    exactUsd: number;
    /** Outstanding holds (`estimated: true`). */
    estimatedUsd: number;
    byProvider: Record<string, LedgerProviderTotal>;
}

interface LedgerGlobals {
    __assetLedgerQueue?: Promise<unknown>;
}
const shared = globalThis as typeof globalThis & LedgerGlobals;

function ledgerError(code: string): Error {
    const error = new Error(code);
    (error as Error & { code?: string }).code = code;
    return error;
}

/** sha256 of the exact prompt text; the ledger stores the digest, not the prompt. */
export function hashPrompt(prompt: string): string {
    if (typeof prompt !== "string") throw ledgerError(LEDGER_INVALID_ERROR);
    return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function roundUsd(value: number): number {
    return Math.round(value * 10 ** USD_DECIMALS) / 10 ** USD_DECIMALS;
}

/** Serializes append/read-modify-write cycles in this process. */
async function withLedgerLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = shared.__assetLedgerQueue ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.catch(() => undefined);
    shared.__assetLedgerQueue = settled;
    void settled.then(() => {
        if (shared.__assetLedgerQueue === settled) shared.__assetLedgerQueue = undefined;
    });
    return pending;
}

/** Reads the document; a missing file is an empty ledger, a malformed one is CORRUPT. */
async function readDocument(): Promise<LedgerDocument> {
    try {
        return await readJson(LEDGER_FILE, ledgerDocumentSchema);
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "ERR_LIBRARY_NOT_FOUND") return { version: LEDGER_VERSION, records: [] };
        if (message === "ERR_LIBRARY_INVALID") throw ledgerError(LEDGER_CORRUPT_ERROR);
        throw error;
    }
}

export async function listAssets(): Promise<AssetRecord[]> {
    return [...(await readDocument()).records];
}

export async function readAsset(assetId: string): Promise<AssetRecord | undefined> {
    if (typeof assetId !== "string" || !ASSET_ID_PATTERN.test(assetId)) return undefined;
    const records = (await readDocument()).records;
    return records.find((record) => record.assetId === assetId);
}

/**
 * Appends one record and returns it. Duplicate asset ids are rejected: the
 * ledger is one row per asset, so a re-generation needs a new asset id.
 */
export async function appendAsset(input: AssetRecordDraft): Promise<AssetRecord> {
    const parsed = assetRecordDraftSchema.safeParse(input);
    if (!parsed.success) throw ledgerError(LEDGER_INVALID_ERROR);
    let record: AssetRecord;
    try {
        record = assetRecordSchema.parse({
            ...parsed.data,
            createdAt: parsed.data.createdAt ?? new Date().toISOString(),
        });
    } catch {
        throw ledgerError(LEDGER_INVALID_ERROR);
    }
    return withLedgerLock(async () => {
        const document = await readDocument();
        if (document.records.some((existing) => existing.assetId === record.assetId)) {
            throw ledgerError(LEDGER_CONFLICT_ERROR);
        }
        const next: LedgerDocument = { version: LEDGER_VERSION, records: [...document.records, record] };
        await writeJsonAtomic(LEDGER_FILE, next);
        return record;
    });
}

/** Pure totals over any record slice, so a caller can scope spend without rereading. */
export function ledgerTotals(records: readonly AssetRecord[]): LedgerTotals {
    let exactUsd = 0;
    let estimatedUsd = 0;
    const byProvider: Record<string, LedgerProviderTotal> = {};
    for (const record of records) {
        if (record.estimated) estimatedUsd += record.costUsd;
        else exactUsd += record.costUsd;
        const bucket = byProvider[record.provider] ?? { count: 0, totalUsd: 0 };
        bucket.count += 1;
        bucket.totalUsd += record.costUsd;
        byProvider[record.provider] = bucket;
    }
    return {
        count: records.length,
        totalUsd: roundUsd(exactUsd + estimatedUsd),
        exactUsd: roundUsd(exactUsd),
        estimatedUsd: roundUsd(estimatedUsd),
        byProvider: Object.fromEntries(
            Object.keys(byProvider)
                .sort()
                .map((provider) => [provider, {
                    count: byProvider[provider].count,
                    totalUsd: roundUsd(byProvider[provider].totalUsd),
                }]),
        ),
    };
}

export async function ledgerSummary(): Promise<LedgerTotals> {
    return ledgerTotals((await readDocument()).records);
}

export interface BudgetAllowance {
    ok: true;
    providerId: string;
    /** What the caller quoted for this generation. */
    estimateUsd: number;
    /** What this generation is charged: the quote, or 0 for the free provider. */
    chargedUsd: number;
    /** Budget left after the hold is taken. */
    remainingUsd: number;
}

export interface BudgetBlock {
    ok: false;
    /** Stable machine-readable reason; the UI must not parse the detail text. */
    reason: typeof BUDGET_EXCEEDED_ERROR;
    providerId: string;
    estimateUsd: number;
    chargedUsd: 0;
    /** Budget left before the hold. */
    remainingUsd: number;
    shortfallUsd: number;
}

export type BudgetDecision = BudgetAllowance | BudgetBlock;

function money(value: number, name: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_USD) {
        throw ledgerError(`${BUDGET_INVALID_ERROR}: ${name}`);
    }
    return value;
}

function normaliseProvider(providerId: string): string {
    if (typeof providerId !== "string") throw ledgerError(`${BUDGET_INVALID_ERROR}: providerId`);
    const normalised = providerId.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalised)) throw ledgerError(`${BUDGET_INVALID_ERROR}: providerId`);
    return normalised;
}

/**
 * Decides whether one more generation fits the production budget.
 *
 * Paid providers (anything that is not `comfyui`) are blocked when the quote
 * exceeds what is left; the block carries `reason: "ERR_BUDGET_EXCEEDED"`.
 * `comfyui` is charged 0 and is therefore never blocked, even when the budget
 * is already exhausted: it runs on local hardware and adds no spend.
 */
export function checkBudget(
    productionBudgetUsd: number,
    spentUsd: number,
    estimateUsd: number,
    providerId: string,
): BudgetDecision {
    const budget = money(productionBudgetUsd, "productionBudgetUsd");
    const spent = money(spentUsd, "spentUsd");
    const estimate = money(estimateUsd, "estimateUsd");
    const provider = normaliseProvider(providerId);
    const remaining = roundUsd(budget - spent);

    if (provider === FREE_PROVIDER_ID) {
        return { ok: true, providerId: provider, estimateUsd: estimate, chargedUsd: 0, remainingUsd: remaining };
    }
    if (estimate <= remaining + BUDGET_EPSILON) {
        return {
            ok: true,
            providerId: provider,
            estimateUsd: estimate,
            chargedUsd: estimate,
            remainingUsd: roundUsd(remaining - estimate),
        };
    }
    return {
        ok: false,
        reason: BUDGET_EXCEEDED_ERROR,
        providerId: provider,
        estimateUsd: estimate,
        chargedUsd: 0,
        remainingUsd: remaining,
        shortfallUsd: roundUsd(estimate - remaining),
    };
}
