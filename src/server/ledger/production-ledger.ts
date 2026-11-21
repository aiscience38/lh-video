import "server-only";

import path from "node:path";
import { z } from "zod";
import { ASSET_ID_PATTERN } from "@/server/library/contract";
import { readJson, productionsRoot, writeJsonAtomic } from "@/server/productions/atomic";
import {
    isValidSlug,
    PRODUCTION_NOT_FOUND_ERROR,
    type Production,
    type ProductionEffort,
} from "@/server/productions/contract";
import {
    appendAsset,
    assetRecordDraftSchema,
    LEDGER_INVALID_ERROR,
    ledgerTotals,
    listAssets,
    type AssetRecord,
    type LedgerTotals,
} from "./store";

/**
 * Per-production view over the asset ledger.
 *
 * The ledger itself is one append-only document for the whole workspace. A
 * production owns only a link list at `productions/<slug>/ledger.json`; the
 * panel resolves those ids against the ledger so a production never copies a
 * record and can never show spend it did not record.
 *
 * Budgets are plan caps by effort tier, not a stored balance: spend is always
 * derived from the ledger, so reconciling the bar is one read.
 */

export const PRODUCTION_LEDGER_FILE = "ledger.json";
export const PRODUCTION_LEDGER_VERSION = 1;
export const PRODUCTION_LEDGER_INVALID_ERROR = "ERR_PRODUCTION_LEDGER_INVALID";

export const PRODUCTION_BUDGETS_USD: Record<ProductionEffort, number> = {
    quick: 5,
    standard: 25,
    studio: 100,
};

export const productionLedgerDocumentSchema = z.object({
    version: z.literal(PRODUCTION_LEDGER_VERSION),
    assetIds: z.array(z.string().regex(ASSET_ID_PATTERN)).max(10_000),
});

export type ProductionLedgerDocument = z.infer<typeof productionLedgerDocumentSchema>;

export interface ProductionBudget {
    effort: ProductionEffort;
    budgetUsd: number;
    spentUsd: number;
    remainingUsd: number;
    /** Clamped 0-100 so the bar never overflows on an overspend. */
    percentUsed: number;
    overBudget: boolean;
}

export interface ProductionLedgerView {
    records: AssetRecord[];
    totals: LedgerTotals;
    budget: ProductionBudget;
}

interface ProductionLedgerGlobals {
    __productionLedgerQueue?: Promise<unknown>;
}
const shared = globalThis as typeof globalThis & ProductionLedgerGlobals;

const BUDGET_EPSILON = 1e-9;

function ledgerError(code: string): Error {
    const error = new Error(code);
    (error as Error & { code?: string }).code = code;
    return error;
}

function roundUsd(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
}

/** Serializes link-list writes in this process; writeJsonAtomic protects across processes. */
async function withProductionLedgerLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = shared.__productionLedgerQueue ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    shared.__productionLedgerQueue = pending.catch(() => undefined);
    return pending;
}

function productionDirectory(slug: string): string {
    if (!isValidSlug(slug)) throw ledgerError(PRODUCTION_NOT_FOUND_ERROR);
    return path.join(productionsRoot(), slug);
}

export function productionLedgerFile(slug: string): string {
    return path.join(productionDirectory(slug), PRODUCTION_LEDGER_FILE);
}

async function readProductionLedgerDocument(slug: string): Promise<ProductionLedgerDocument> {
    try {
        return await readJson(productionLedgerFile(slug), productionLedgerDocumentSchema);
    } catch (error) {
        if (error instanceof Error && error.message === PRODUCTION_NOT_FOUND_ERROR) {
            return { version: PRODUCTION_LEDGER_VERSION, assetIds: [] };
        }
        if (error instanceof Error && error.message === "ERR_PRODUCTION_INVALID") {
            throw ledgerError(PRODUCTION_LEDGER_INVALID_ERROR);
        }
        throw error;
    }
}

/**
 * Resolves the production's linked ids against the live ledger. Ids whose
 * record disappeared are skipped rather than guessed, so totals always equal
 * the rows a human can see.
 */
export async function readProductionLedger(production: Production): Promise<ProductionLedgerView> {
    const document = await readProductionLedgerDocument(production.slug);
    const assets = new Map((await listAssets()).map((record) => [record.assetId, record]));
    const records = document.assetIds.flatMap((assetId) => {
        const record = assets.get(assetId);
        return record ? [record] : [];
    });
    const totals = ledgerTotals(records);
    const budgetUsd = PRODUCTION_BUDGETS_USD[production.effort];
    const spentUsd = totals.totalUsd;
    const remainingUsd = roundUsd(Math.max(0, budgetUsd - spentUsd));
    return {
        records,
        totals,
        budget: {
            effort: production.effort,
            budgetUsd,
            spentUsd,
            remainingUsd,
            percentUsed: budgetUsd > 0 ? Math.min(100, roundUsd((spentUsd / budgetUsd) * 100)) : 100,
            overBudget: spentUsd > budgetUsd + BUDGET_EPSILON,
        },
    };
}

/**
 * Appends one record to the shared ledger, then links it to this production.
 * The link list is written atomically; a failed link leaves the global record
 * intact rather than pretending the production was charged.
 */
export async function appendProductionAsset(
    production: Production,
    draft: unknown,
): Promise<AssetRecord> {
    return withProductionLedgerLock(async () => {
        const parsed = assetRecordDraftSchema.safeParse(draft);
        if (!parsed.success) throw ledgerError(LEDGER_INVALID_ERROR);
        const document = await readProductionLedgerDocument(production.slug);
        const record = await appendAsset(parsed.data);
        if (document.assetIds.includes(record.assetId)) {
            throw ledgerError(PRODUCTION_LEDGER_INVALID_ERROR);
        }
        await writeJsonAtomic(productionLedgerFile(production.slug), {
            version: PRODUCTION_LEDGER_VERSION,
            assetIds: [...document.assetIds, record.assetId],
        } satisfies ProductionLedgerDocument);
        return record;
    });
}
