import "server-only";

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { libraryRoot } from "./atomic";
import { LIBRARY_KINDS, LIBRARY_KIND_FILES, LIBRARY_KIND_FOLDERS, type LibraryKind } from "./contract";

export interface TrashEntry {
    kind: LibraryKind;
    folder: string;
    /** ISO timestamp parsed from the `<slug>-<timestamp>` folder suffix, if it has one. */
    trashedAt: string | null;
    /** Entity name read from the JSON document inside the trashed folder, when readable. */
    name: string | null;
}

/**
 * Deleted folders are named `<slug>-<timestamp>[-<attempt>]` where the
 * timestamp is `new Date().toISOString()` with `:` and `.` replaced by `-`.
 */
const TRASH_SUFFIX = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-\d+)?$/;
const MAX_NAME_LENGTH = 200;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

export function parseTrashedAt(folder: string): string | null {
    const match = TRASH_SUFFIX.exec(folder);
    if (!match) return null;
    const [date, time] = match[1].split("T");
    const parts = time.replace(/Z$/, "").split("-");
    if (parts.length !== 4) return null;
    const candidate = `${date}T${parts[0]}:${parts[1]}:${parts[2]}.${parts[3]}Z`;
    const parsed = Date.parse(candidate);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

async function readTrashedName(directory: string, kind: LibraryKind): Promise<string | null> {
    try {
        const file = path.join(directory, LIBRARY_KIND_FILES[kind]);
        const stats = await fs.stat(file);
        if (!stats.isFile() || stats.size > MAX_DOCUMENT_BYTES) return null;
        const document: unknown = JSON.parse(await fs.readFile(file, "utf8"));
        if (!document || typeof document !== "object" || Array.isArray(document)) return null;
        const name = (document as { name?: unknown }).name;
        if (typeof name !== "string") return null;
        const trimmed = name.trim();
        return trimmed ? trimmed.slice(0, MAX_NAME_LENGTH) : null;
    } catch {
        // A missing or unreadable document is normal after a partial move; the folder is still listed.
        return null;
    }
}

/** Newest deletion first; folders without a parseable timestamp sort last. */
export async function listTrash(): Promise<TrashEntry[]> {
    const groups = await Promise.all(LIBRARY_KINDS.map(async kind => {
        const directory = path.join(libraryRoot(), ".trash", LIBRARY_KIND_FOLDERS[kind]);
        let dirents: Dirent[];
        try {
            dirents = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
        return await Promise.all(dirents
            .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith("."))
            .map(async (dirent): Promise<TrashEntry> => ({
                kind,
                folder: dirent.name,
                trashedAt: parseTrashedAt(dirent.name),
                name: await readTrashedName(path.join(directory, dirent.name), kind),
            })));
    }));
    return groups.flat().sort((left, right) => {
        const leftTime = left.trashedAt ? Date.parse(left.trashedAt) : 0;
        const rightTime = right.trashedAt ? Date.parse(right.trashedAt) : 0;
        return rightTime - leftTime || left.folder.localeCompare(right.folder);
    });
}
