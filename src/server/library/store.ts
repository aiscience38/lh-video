import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { syncDirectory } from "@/server/config/durable-fs";
import { assertStorageContained, ensureStorageDirectory, libraryRoot, readJson, writeJsonAtomic } from "./atomic";
import {
    createSchemaFor,
    isLibraryKind,
    isValidSlug,
    LIBRARY_CONFLICT_ERROR,
    LIBRARY_INVALID_ERROR,
    LIBRARY_KIND_ERROR,
    LIBRARY_KIND_FILES,
    LIBRARY_KIND_FOLDERS,
    LIBRARY_NOT_FOUND_ERROR,
    MAX_SLUG_LENGTH,
    schemaForKind,
    slugify,
    updateSchemaFor,
    type LibraryEntity,
    type LibraryKind,
} from "./contract";

const LIBRARY_DIR = libraryRoot();
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_SLUG_ATTEMPTS = 1000;

type LibraryCacheEntry = { mtimeMs: number; entities: LibraryEntity[] };
type LibraryCache = Map<LibraryKind, LibraryCacheEntry>;

interface LibraryGlobals {
    __libraryEntityCache?: LibraryCache;
    __libraryWriteQueues?: Map<LibraryKind, Promise<unknown>>;
}
const shared = globalThis as typeof globalThis & LibraryGlobals;
shared.__libraryEntityCache ??= new Map();
shared.__libraryWriteQueues ??= new Map();
const cache = shared.__libraryEntityCache;
const queues = shared.__libraryWriteQueues;

function libraryError(code: string): Error {
    return new Error(code);
}

function assertKind(kind: unknown): asserts kind is LibraryKind {
    if (!isLibraryKind(kind)) throw libraryError(LIBRARY_KIND_ERROR);
}

function kindDirectory(kind: LibraryKind): string {
    return path.join(LIBRARY_DIR, LIBRARY_KIND_FOLDERS[kind]);
}

function entityDirectory(kind: LibraryKind, slug: string): string {
    return path.join(kindDirectory(kind), slug);
}

function entityFile(kind: LibraryKind, slug: string): string {
    return path.join(entityDirectory(kind, slug), LIBRARY_KIND_FILES[kind]);
}

function invalidate(kind: LibraryKind): void {
    cache.delete(kind);
}

/** Serializes in-process writes per kind; atomic rename still protects across processes. */
async function withKindLock<T>(kind: LibraryKind, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(kind) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    queues.set(kind, pending.catch(() => undefined));
    return pending;
}

function compareEntities(a: LibraryEntity, b: LibraryEntity): number {
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/**
 * Scans one kind directory. The directory mtime is the cache key: every
 * mutation in this contract replaces or renames a directory entry, which
 * bumps it. Writes in this process also invalidate explicitly.
 */
async function scanEntities(kind: LibraryKind): Promise<LibraryEntity[]> {
    const directory = kindDirectory(kind);
    let stats;
    try {
        stats = await fs.stat(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            invalidate(kind);
            return [];
        }
        throw error;
    }
    const cached = cache.get(kind);
    if (cached && cached.mtimeMs === stats.mtimeMs) return structuredClone(cached.entities);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const entities: LibraryEntity[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
        let entity: LibraryEntity;
        try {
            entity = await readJson(entityFile(kind, entry.name), schemaForKind(kind));
        } catch (error) {
            if (error instanceof Error && error.message === LIBRARY_NOT_FOUND_ERROR) continue;
            throw error;
        }
        if (entity.kind !== kind || entity.slug !== entry.name) throw libraryError(LIBRARY_INVALID_ERROR);
        entities.push(entity);
    }
    entities.sort(compareEntities);
    cache.set(kind, { mtimeMs: stats.mtimeMs, entities: structuredClone(entities) });
    return entities;
}

export async function listEntities(kind: LibraryKind): Promise<LibraryEntity[]> {
    assertKind(kind);
    return scanEntities(kind);
}

export async function findEntityBySlug(kind: LibraryKind, slug: string): Promise<LibraryEntity | undefined> {
    assertKind(kind);
    if (!isValidSlug(slug)) throw libraryError(LIBRARY_INVALID_ERROR);
    try {
        const entity = await readJson(entityFile(kind, slug), schemaForKind(kind));
        if (entity.kind !== kind || entity.slug !== slug) throw libraryError(LIBRARY_INVALID_ERROR);
        return entity;
    } catch (error) {
        if (error instanceof Error && error.message === LIBRARY_NOT_FOUND_ERROR) return undefined;
        throw error;
    }
}

export async function readEntity(kind: LibraryKind, id: string): Promise<LibraryEntity | undefined> {
    assertKind(kind);
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return undefined;
    const entities = await scanEntities(kind);
    return entities.find((entity) => entity.id === id);
}

function suffixedSlug(base: string, attempt: number): string {
    const suffix = `-${attempt}`;
    const stem = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, "");
    return `${stem}${suffix}`;
}

function nextTimestamp(previous: string): string {
    const parsed = Date.parse(previous);
    const now = Date.now();
    return new Date(Number.isFinite(parsed) && now <= parsed ? parsed + 1 : now).toISOString();
}

export async function createEntity(kind: LibraryKind, input: unknown): Promise<LibraryEntity> {
    assertKind(kind);
    const parsed = createSchemaFor(kind).safeParse(input);
    if (!parsed.success) throw libraryError(LIBRARY_INVALID_ERROR);
    return withKindLock(kind, async () => {
        const base = slugify((parsed.data as { name: string }).name);
        if (!isValidSlug(base)) throw libraryError(LIBRARY_INVALID_ERROR);
        const directory = await ensureStorageDirectory(kindDirectory(kind));
        for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
            const slug = attempt === 1 ? base : suffixedSlug(base, attempt);
            if (!isValidSlug(slug)) throw libraryError(LIBRARY_INVALID_ERROR);
            const target = entityDirectory(kind, slug);
            try {
                await fs.mkdir(target);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
                throw error;
            }
            const timestamp = new Date().toISOString();
            const candidate = { ...parsed.data, id: randomUUID(), kind, slug, createdAt: timestamp, updatedAt: timestamp };
            let entity: LibraryEntity;
            try {
                entity = schemaForKind(kind).parse(candidate);
            } catch {
                await fs.rmdir(target).catch(() => undefined);
                throw libraryError(LIBRARY_INVALID_ERROR);
            }
            try {
                await writeJsonAtomic(entityFile(kind, slug), entity);
            } catch (error) {
                await fs.rmdir(target).catch(() => undefined);
                throw error;
            }
            invalidate(kind);
            await syncDirectory(directory).catch(() => undefined);
            return entity;
        }
        throw libraryError(LIBRARY_CONFLICT_ERROR);
    });
}

export async function updateEntity(kind: LibraryKind, id: string, patch: unknown): Promise<LibraryEntity> {
    assertKind(kind);
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw libraryError(LIBRARY_NOT_FOUND_ERROR);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw libraryError(LIBRARY_INVALID_ERROR);
    const existing = await readEntity(kind, id);
    if (!existing) throw libraryError(LIBRARY_NOT_FOUND_ERROR);
    const record = patch as Record<string, unknown>;
    for (const key of ["id", "kind", "slug", "createdAt"] as const) {
        if (Object.hasOwn(record, key) && record[key] !== existing[key]) throw libraryError(LIBRARY_INVALID_ERROR);
    }
    const parsed = updateSchemaFor(kind).safeParse(record);
    if (!parsed.success) throw libraryError(LIBRARY_INVALID_ERROR);
    return withKindLock(kind, async () => {
        const current = await readEntity(kind, id);
        if (!current) throw libraryError(LIBRARY_NOT_FOUND_ERROR);
        const changes = Object.fromEntries(
            Object.entries(parsed.data as Record<string, unknown>).filter(([, value]) => value !== undefined),
        );
        const next = schemaForKind(kind).parse({ ...current, ...changes, updatedAt: nextTimestamp(current.updatedAt) });
        await writeJsonAtomic(entityFile(kind, current.slug), next);
        invalidate(kind);
        return next;
    });
}

/**
 * Moves the entity folder under `library/.trash/<kind>/<slug>-<timestamp>`.
 * Referenced media in uploads/downloads is never touched; the folder and its
 * JSON document still exist for operator restore.
 */
export async function deleteEntity(kind: LibraryKind, id: string): Promise<boolean> {
    assertKind(kind);
    const existing = await readEntity(kind, id);
    if (!existing) return false;
    return withKindLock(kind, async () => {
        const current = await readEntity(kind, id);
        if (!current) return false;
        const trash = await ensureStorageDirectory(path.join(LIBRARY_DIR, ".trash", LIBRARY_KIND_FOLDERS[kind]));
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
            await fs.rename(entityDirectory(kind, current.slug), target);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
        invalidate(kind);
        await syncDirectory(kindDirectory(kind)).catch(() => undefined);
        return true;
    });
}
