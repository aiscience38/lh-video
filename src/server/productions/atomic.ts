import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { STORAGE_ROOT } from "@/server/config/storage-paths";
import { syncDirectory } from "@/server/config/durable-fs";
import { PRODUCTION_INVALID_ERROR, PRODUCTION_NOT_FOUND_ERROR } from "./contract";

/**
 * Durable JSON storage for productions.
 *
 * Same durability contract as the library writer (dot-prefixed temp file,
 * fsync, rename, directory flush) but deliberately local: production documents
 * live under `productions/` and must never depend on library storage semantics.
 */

export interface JsonSchema<T> {
    parse(value: unknown): T;
}

function productionError(code: string): Error {
    return new Error(code);
}

function missing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Lexical containment check; symlinks are re-checked with real paths below. */
export function resolveWithinStorage(target: string): string {
    const root = path.resolve(STORAGE_ROOT);
    const resolved = path.resolve(target);
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return resolved;
    throw productionError(PRODUCTION_INVALID_ERROR);
}

function realPathWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realStorageRoot(): Promise<string> {
    try {
        return await fs.realpath(STORAGE_ROOT);
    } catch (error) {
        throw productionError(missing(error) ? PRODUCTION_NOT_FOUND_ERROR : PRODUCTION_INVALID_ERROR);
    }
}

export function productionsRoot(): string {
    return path.join(STORAGE_ROOT, "productions");
}

/** Creates a directory inside storage and proves its canonical path stays inside the root. */
export async function ensureStorageDirectory(directory: string): Promise<string> {
    const resolved = resolveWithinStorage(directory);
    await fs.mkdir(path.resolve(STORAGE_ROOT), { recursive: true });
    const canonicalRoot = await realStorageRoot();
    let ancestor = resolved;
    while (true) {
        try {
            await fs.lstat(ancestor);
            break;
        } catch (error) {
            if (!missing(error)) throw error;
            const parent = path.dirname(ancestor);
            if (parent === ancestor) throw productionError(PRODUCTION_INVALID_ERROR);
            ancestor = parent;
        }
    }
    const canonicalAncestor = await fs.realpath(ancestor);
    if (!realPathWithin(canonicalRoot, canonicalAncestor)) throw productionError(PRODUCTION_INVALID_ERROR);
    await fs.mkdir(resolved, { recursive: true });
    const canonical = await fs.realpath(resolved);
    if (!realPathWithin(canonicalRoot, canonical)) throw productionError(PRODUCTION_INVALID_ERROR);
    return resolved;
}

/** Rejects paths outside STORAGE_ROOT, including directories reached through a symlink. */
export async function assertStorageContained(target: string): Promise<void> {
    const resolved = resolveWithinStorage(target);
    const canonicalRoot = await realStorageRoot();
    let canonical: string;
    try {
        canonical = await fs.realpath(resolved);
    } catch (error) {
        throw productionError(missing(error) ? PRODUCTION_NOT_FOUND_ERROR : PRODUCTION_INVALID_ERROR);
    }
    if (!realPathWithin(canonicalRoot, canonical)) throw productionError(PRODUCTION_INVALID_ERROR);
}

/** Writes one JSON document atomically: temp file, fsync, rename, directory flush. */
export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
    const file = resolveWithinStorage(target);
    const directory = path.dirname(file);
    let body: string;
    try {
        body = `${JSON.stringify(value, null, 2)}\n`;
    } catch {
        throw productionError(PRODUCTION_INVALID_ERROR);
    }
    await ensureStorageDirectory(directory);
    const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(body, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(temporary, file);
        await syncDirectory(directory);
    } catch (error) {
        await fs.unlink(temporary).catch(() => undefined);
        throw error;
    }
}

/** Reads and validates one JSON document. Missing files are NOT_FOUND; invalid ones are INVALID. */
export async function readJson<T>(target: string, schema: JsonSchema<T>): Promise<T> {
    const file = resolveWithinStorage(target);
    const canonicalRoot = await realStorageRoot();
    let canonical: string;
    try {
        canonical = await fs.realpath(file);
    } catch (error) {
        if (missing(error)) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
        throw error;
    }
    if (!realPathWithin(canonicalRoot, canonical)) throw productionError(PRODUCTION_INVALID_ERROR);
    let raw: string;
    try {
        raw = await fs.readFile(canonical, "utf8");
    } catch (error) {
        if (missing(error)) throw productionError(PRODUCTION_NOT_FOUND_ERROR);
        throw error;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw productionError(PRODUCTION_INVALID_ERROR);
    }
    try {
        return schema.parse(value);
    } catch {
        throw productionError(PRODUCTION_INVALID_ERROR);
    }
}
