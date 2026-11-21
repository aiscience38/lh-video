import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createModuleLoader } from "./test-module-loader.mjs";

const ORIGIN = "http://127.0.0.1:3120";

/** Windows ships bsdtar in System32; a git-bash PATH can shadow it with an MSYS build. */
function tarBinary() {
    if (process.platform === "win32") {
        const candidate = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
        return existsSync(candidate) ? candidate : "tar";
    }
    return "tar";
}

function apiRequest(url, method = "GET", body) {
    const headers = { origin: ORIGIN, host: "127.0.0.1:3120", "sec-fetch-site": "same-origin" };
    if (body !== undefined) headers["content-type"] = "application/json";
    return new Request(`${ORIGIN}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function harness(t, env = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "library-export-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const loader = createModuleLoader({
        env: { OPEN_HIGGSFIELD_STORAGE_DIR: dir, NODE_ENV: "development", ...env },
        mocks: { "next/server": { NextResponse: Response } },
    });
    return {
        dir,
        exportsDir: path.join(dir, "EXPORTS"),
        route: loader.load("src/app/api/library/export/route.ts"),
        backup: loader.load("@/server/library/backup"),
        listRoute: loader.load("src/app/api/library/route.ts"),
    };
}

async function createAna(listRoute) {
    const response = await listRoute.POST(apiRequest("/api/library", "POST", {
        kind: "character",
        name: "Ana",
        notes: "Backed up",
        assetIds: ["asset_backup_1"],
    }));
    assert.equal(response.status, 201);
    return (await response.json()).entity;
}

function assertContained(directory, candidate) {
    const relative = path.relative(directory, candidate);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${candidate} escapes ${directory}`);
}

test("export path guard refuses traversal, absolute and unknown names", async (t) => {
    const { backup, exportsDir } = await harness(t);
    assert.equal(backup.exportsDirectory(), exportsDir);
    const valid = backup.resolveExportFile("library-2026-01-01T00-00-00-000Z.tar.gz");
    assert.equal(valid, path.join(exportsDir, "library-2026-01-01T00-00-00-000Z.tar.gz"));

    const refusals = [
        "../library-escape.tar.gz",
        "..\\library-escape.tar.gz",
        path.join(exportsDir, "..", "library-escape.tar.gz"),
        path.join(os.tmpdir(), "library-escape.tar.gz"),
        "library-evil.tar.gz/../library-escape.tar.gz",
        "notes.txt",
        "",
    ];
    for (const name of refusals) {
        assert.throws(() => backup.resolveExportFile(name), /ERR_LIBRARY_INVALID/, `accepted ${JSON.stringify(name)}`);
    }
});

test("export archives the library and lists a created entity (manifest fallback when tar is absent)", async (t) => {
    const { route, listRoute, dir, exportsDir } = await harness(t);
    const entity = await createAna(listRoute);

    const response = await route.POST(apiRequest("/api/library/export", "POST"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.ok(body.path, "the response reports an absolute output path");
    assert.ok(path.isAbsolute(body.path));
    assertContained(exportsDir, body.path);
    assert.equal(body.count, 1);

    if (body.mode === "tar") {
        assert.match(body.path, /library-[0-9TZ-]+\.tar\.gz$/);
        const stats = await fs.stat(body.path);
        assert.ok(stats.size > 0);
        const listing = spawnSync(tarBinary(), ["-tzf", body.path], { encoding: "utf8" });
        assert.equal(listing.status, 0, listing.stderr);
        const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
        assert.ok(entries.length > 0);
        assert.ok(entries.every(entry => entry.startsWith("library/")), `unexpected entry outside library/: ${entries.find(entry => !entry.startsWith("library/"))}`);
        assert.ok(entries.includes("library/characters/ana/character.json"), listing.stdout);
        const document = JSON.parse(await fs.readFile(path.join(dir, "library", "characters", "ana", "character.json"), "utf8"));
        assert.equal(document.id, entity.id);
    } else {
        assert.equal(body.mode, "manifest");
        assert.match(body.path, /\.manifest\.json$/);
        assert.match(body.note, /tar/i);
        const manifest = JSON.parse(await fs.readFile(body.path, "utf8"));
        assert.equal(manifest.format, "lh-library-manifest");
        assert.equal(manifest.entities.length, 1);
        assert.equal(manifest.entities[0].id, entity.id);
        assert.equal(manifest.entities[0].name, "Ana");
        assert.equal(manifest.counts.character, 1);
    }
});

test("a host without tar returns a manifest-only JSON export with a clear note", async (t) => {
    const { route, listRoute, exportsDir } = await harness(t, { LIBRARY_TAR_COMMAND: "lh-video-no-such-tar-binary" });
    await createAna(listRoute);
    const response = await route.POST(apiRequest("/api/library/export", "POST"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mode, "manifest");
    assert.match(body.note, /tar is not available on this host/);
    assert.match(body.note, /uploads\//);
    assert.match(body.path, /library-[0-9TZ-]+\.manifest\.json$/);
    assertContained(exportsDir, body.path);
    assert.equal(body.manifest.entities.find(entry => entry.name === "Ana").slug, "ana");
    const manifest = JSON.parse(await fs.readFile(body.path, "utf8"));
    assert.equal(manifest.note, body.note);
    assert.equal(manifest.entities.find(entry => entry.name === "Ana").slug, "ana");
});

test("export refuses a POST without the workspace origin header", async (t) => {
    const { route } = await harness(t);
    const response = await route.POST(new Request(`${ORIGIN}/api/library/export`, { method: "POST" }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "ERR_ORIGIN_FORBIDDEN");
});
