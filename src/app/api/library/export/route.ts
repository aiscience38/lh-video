import "server-only";

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { STORAGE_ROOT } from "@/server/config/storage-paths";
import { ensureStorageDirectory, libraryRoot, writeJsonAtomic } from "@/server/library/atomic";
import { exportsDirectory, resolveExportFile } from "@/server/library/backup";
import { LIBRARY_INVALID_ERROR, LIBRARY_KINDS, type LibraryEntity } from "@/server/library/contract";
import { listEntities } from "@/server/library/store";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TAR_TIMEOUT_MS = 120_000;
const TAR_UNAVAILABLE_CODES = new Set(["ENOENT", "EACCES", "EPERM"]);

interface TarResult {
    /** False when the OS has no usable tar binary. */
    available: boolean;
    ok: boolean;
    detail: string;
}

/**
 * Windows resolves a bare `tar` through PATH, which a git-bash style PATH can
 * point at an MSYS binary that refuses to start under Node. Prefer the system
 * bsdtar that ships with Windows 10+; operators can override the command.
 */
function resolveTarCommand(): string {
    const configured = (process.env.LIBRARY_TAR_COMMAND ?? "").trim();
    if (configured) return configured;
    if (process.platform === "win32") {
        const systemTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
        if (existsSync(systemTar)) return systemTar;
    }
    return "tar";
}

function runTar(command: string, archive: string): Promise<TarResult> {
    return new Promise(resolve => {
        let settled = false;
        let stderr = "";
        const child = spawn(command, ["-czf", archive, "-C", STORAGE_ROOT, "library"], {
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe"],
        });
        const timer = setTimeout(() => child.kill(), TAR_TIMEOUT_MS);
        child.stderr?.on("data", chunk => {
            if (stderr.length < 4096) stderr += String(chunk);
        });
        child.once("error", error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const code = (error as NodeJS.ErrnoException).code ?? "";
            resolve({
                available: !TAR_UNAVAILABLE_CODES.has(code),
                ok: false,
                detail: code || "ERR_TAR_SPAWN",
            });
        });
        child.once("close", code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ available: true, ok: code === 0, detail: code === 0 ? "" : stderr.trim().slice(0, 500) || `ERR_TAR_EXIT_${code}` });
        });
    });
}

interface LibraryManifest {
    format: "lh-library-manifest";
    version: 1;
    createdAt: string;
    note: string;
    counts: Record<string, number>;
    entities: LibraryEntity[];
}

async function buildManifest(createdAt: string, note: string): Promise<LibraryManifest> {
    const lists = await Promise.all(LIBRARY_KINDS.map(async kind => [kind, await listEntities(kind)] as const));
    return {
        format: "lh-library-manifest",
        version: 1,
        createdAt,
        note,
        counts: Object.fromEntries(lists.map(([kind, entities]) => [kind, entities.length])),
        entities: lists.flatMap(([, entities]) => entities),
    };
}

async function countEntities(): Promise<number> {
    const counts = await Promise.all(LIBRARY_KINDS.map(kind => listEntities(kind).then(entities => entities.length)));
    return counts.reduce((total, count) => total + count, 0);
}

function backupFailure(error: unknown): Response {
    const code = error instanceof Error ? error.message : "";
    const status = code === LIBRARY_INVALID_ERROR ? 400 : 503;
    return applyWorkspaceHeaders(NextResponse.json({ error: status === 400 ? code : "ERR_LIBRARY_UNAVAILABLE" }, { status }));
}

/**
 * Archives `library/` with the OS tar into `EXPORTS/library-<timestamp>.tar.gz`.
 * Hosts without tar get a manifest-only JSON export instead, written next to
 * where the archive would have gone.
 */
export async function POST(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;

    const createdAt = new Date().toISOString();
    const stamp = createdAt.replace(/[:.]/g, "-");
    try {
        const directory = await ensureStorageDirectory(exportsDirectory());
        // tar needs the source folder to exist even when the library is empty.
        await ensureStorageDirectory(libraryRoot());
        const archive = resolveExportFile(`library-${stamp}.tar.gz`);
        const manifestPath = resolveExportFile(`library-${stamp}.manifest.json`);
        // Read the entities before writing anything so a corrupt document fails
        // the request rather than leaving an archive the response does not own.
        const count = await countEntities();
        const command = resolveTarCommand();
        const tar = await runTar(command, archive);

        if (tar.available && tar.ok) {
            const stats = await fs.stat(archive).catch(() => null);
            if (stats?.isFile() && stats.size > 0) {
                return applyWorkspaceHeaders(NextResponse.json({
                    ok: true,
                    mode: "tar",
                    path: archive,
                    directory,
                    count,
                    bytes: stats.size,
                    createdAt,
                }));
            }
            await fs.rm(archive, { force: true }).catch(() => undefined);
        } else if (tar.available) {
            await fs.rm(archive, { force: true }).catch(() => undefined);
            return applyWorkspaceHeaders(NextResponse.json({ error: "ERR_LIBRARY_UNAVAILABLE", detail: tar.detail }, { status: 503 }));
        }

        const note = tar.available
            ? "tar produced no archive on this host, so the library documents were exported as JSON only. Referenced media in uploads/ is not included."
            : "tar is not available on this host, so the library documents were exported as JSON only. Referenced media in uploads/ is not included.";
        const manifest = await buildManifest(createdAt, note);
        await writeJsonAtomic(manifestPath, manifest);
        return applyWorkspaceHeaders(NextResponse.json({
            ok: true,
            mode: "manifest",
            path: manifestPath,
            directory,
            count: manifest.entities.length,
            note,
            manifest,
            createdAt,
        }));
    } catch (error) {
        return backupFailure(error);
    }
}