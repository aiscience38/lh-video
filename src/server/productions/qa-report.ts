import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { syncDirectory } from "@/server/config/durable-fs";
import {
    assertStorageContained,
    ensureStorageDirectory,
    productionsRoot,
    readJson,
    resolveWithinStorage,
    writeJsonAtomic,
} from "./atomic";
import { isValidSlug, PRODUCTION_NOT_FOUND_ERROR, type Production } from "./contract";

/**
 * Per-production QA reports.
 *
 * A QA run produces one report; the harness keeps it beside the production at
 * `productions/<slug>/qa.json` so the detail page can show findings without
 * rerunning ffmpeg. The report document stores the contact-sheet path, but the
 * HTTP surface never exposes a filesystem path: it serves the sheet through
 * its own guarded route and returns that URL instead.
 */

export const QA_REPORT_FILE = "qa.json";
export const QA_CONTACT_SHEET_FILE = "qa-contact-sheet.png";
export const QA_REPORT_VERSION = 1;
export const QA_REPORT_INVALID_ERROR = "ERR_QA_REPORT_INVALID";
export const QA_REPORT_NOT_FOUND_ERROR = "ERR_QA_REPORT_NOT_FOUND";
export const QA_CONTACT_SHEET_MAX_BYTES = 4 * 1024 * 1024;
export const QA_REPORT_BODY_MAX_BYTES = 8 * 1024 * 1024;

/** Mirrors the finding types `runQa` emits; kept local so the schema is the single gate. */
export const QA_FINDING_TYPES = ["black", "frozen", "silence", "flash", "loudness", "duration"] as const;
export const QA_SEVERITIES = ["error", "warning", "info"] as const;

const findingTypeSchema = z.enum(QA_FINDING_TYPES);
const severitySchema = z.enum(QA_SEVERITIES);
const secondsSchema = z.number().finite().min(0).max(86_400);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const qaFindingSchema = z.strictObject({
    type: findingTypeSchema,
    severity: severitySchema,
    tStart: secondsSchema,
    tEnd: secondsSchema,
    detail: z.string().min(1).max(2000),
}).refine((finding) => finding.tEnd >= finding.tStart, { error: `${QA_REPORT_INVALID_ERROR}: tEnd before tStart`, path: ["tEnd"] });

export type StoredQaFinding = z.infer<typeof qaFindingSchema>;

/** What a caller may submit; paths and timestamps stay server-owned. */
export const qaReportInputSchema = z.strictObject({
    durationSeconds: secondsSchema,
    hasVideo: z.boolean(),
    hasAudio: z.boolean(),
    findings: z.array(qaFindingSchema).max(500),
    contactSheetPath: z.string().max(2048).default(""),
});

export const qaReportDocumentSchema = z.strictObject({
    version: z.literal(QA_REPORT_VERSION),
    updatedAt: z.iso.datetime({ offset: true }),
    durationSeconds: secondsSchema,
    hasVideo: z.boolean(),
    hasAudio: z.boolean(),
    contactSheetPath: z.string().max(2048),
    findings: z.array(qaFindingSchema).max(500),
});

export type QaReportDocument = z.infer<typeof qaReportDocumentSchema>;
export type QaReportInput = z.input<typeof qaReportInputSchema>;

function qaError(code: string): Error {
    const error = new Error(code);
    (error as Error & { code?: string }).code = code;
    return error;
}

function productionDirectory(slug: string): string {
    if (!isValidSlug(slug)) throw qaError(PRODUCTION_NOT_FOUND_ERROR);
    return path.join(productionsRoot(), slug);
}

export function qaReportFile(slug: string): string {
    return path.join(productionDirectory(slug), QA_REPORT_FILE);
}

export function qaContactSheetFile(slug: string): string {
    return path.join(productionDirectory(slug), QA_CONTACT_SHEET_FILE);
}

/** Missing reports are empty state, not an error; malformed reports are INVALID. */
export async function readQaReport(production: Production): Promise<QaReportDocument | null> {
    try {
        return await readJson(qaReportFile(production.slug), qaReportDocumentSchema);
    } catch (error) {
        if (error instanceof Error && error.message === PRODUCTION_NOT_FOUND_ERROR) return null;
        if (error instanceof Error && error.message === "ERR_PRODUCTION_INVALID") throw qaError(QA_REPORT_INVALID_ERROR);
        throw error;
    }
}

/**
 * A stored sheet must live inside this production's folder. Otherwise a report
 * could point the guarded image route at any file in storage.
 */
async function containedSheetPath(production: Production, candidate: string): Promise<string> {
    if (!candidate) return "";
    const directory = path.resolve(productionDirectory(production.slug));
    const resolved = resolveWithinStorage(candidate);
    const relative = path.relative(directory, resolved);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw qaError(QA_REPORT_INVALID_ERROR);
    }
    await assertStorageContained(resolved);
    const stats = await fs.stat(resolved).catch(() => undefined);
    if (!stats?.isFile()) throw qaError(QA_REPORT_INVALID_ERROR);
    return resolved;
}

/** Validates and writes the report document atomically. */
export async function writeQaReport(production: Production, input: QaReportInput): Promise<QaReportDocument> {
    const parsed = qaReportInputSchema.safeParse(input);
    if (!parsed.success) throw qaError(QA_REPORT_INVALID_ERROR);
    const contactSheetPath = await containedSheetPath(production, parsed.data.contactSheetPath);
    const document: QaReportDocument = {
        version: QA_REPORT_VERSION,
        updatedAt: new Date().toISOString(),
        durationSeconds: parsed.data.durationSeconds,
        hasVideo: parsed.data.hasVideo,
        hasAudio: parsed.data.hasAudio,
        contactSheetPath,
        findings: parsed.data.findings,
    };
    await writeJsonAtomic(qaReportFile(production.slug), document);
    return document;
}

/** Writes the contact sheet beside the production with the same durability contract as JSON. */
export async function saveQaContactSheet(production: Production, bytes: Uint8Array): Promise<string> {
    // Normalise first: a Buffer from another realm still has to pass the same checks.
    const sheet = bytes && typeof bytes.byteLength === "number" ? Buffer.from(bytes) : Buffer.alloc(0);
    if (sheet.byteLength === 0 || sheet.byteLength > QA_CONTACT_SHEET_MAX_BYTES) {
        throw qaError(QA_REPORT_INVALID_ERROR);
    }
    if (!sheet.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw qaError(QA_REPORT_INVALID_ERROR);
    }
    const target = qaContactSheetFile(production.slug);
    const directory = path.dirname(target);
    await ensureStorageDirectory(directory);
    const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(sheet);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(temporary, target);
        await syncDirectory(directory);
    } catch (error) {
        await fs.unlink(temporary).catch(() => undefined);
        throw error;
    }
    return target;
}
