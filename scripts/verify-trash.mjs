import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModuleLoader } from "./test-module-loader.mjs";

/** Values produced by the VM loader have a different Array prototype; compare plain data. */
const plain = value => JSON.parse(JSON.stringify(value));

async function harness(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "library-trash-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const loader = createModuleLoader({
        env: { OPEN_HIGGSFIELD_STORAGE_DIR: dir, NODE_ENV: "development", APP_DEMO_MODE: "false" },
        mocks: { "next/server": { NextResponse: Response } },
    });
    return { dir, loader, trash: loader.load("@/server/library/trash"), route: loader.load("src/app/api/library/trash/route.ts") };
}

async function seed(root, kindFolder, folder, document) {
    const directory = path.join(root, "library", ".trash", kindFolder, folder);
    await fs.mkdir(directory, { recursive: true });
    if (document !== undefined) {
        const file = kindFolder === "characters" ? "character.json" : kindFolder === "scenes" ? "scene.json" : "storyboard.json";
        await fs.writeFile(path.join(directory, file), typeof document === "string" ? document : JSON.stringify(document), "utf8");
    }
}

test("parses the Windows-safe trash timestamp, including retry suffixes", async (t) => {
    const { trash } = await harness(t);
    assert.equal(trash.parseTrashedAt("ana-2026-11-20T18-30-00-000Z"), "2026-11-20T18:30:00.000Z");
    assert.equal(trash.parseTrashedAt("ana-2026-11-20T18-30-00-000Z-2"), "2026-11-20T18:30:00.000Z");
    assert.equal(trash.parseTrashedAt("ana"), null);
    assert.equal(trash.parseTrashedAt("ana-2026-99-99T18-30-00-000Z"), null);
});

test("lists folders per kind with parsed dates and readable names", async (t) => {
    const { dir, trash } = await harness(t);
    await seed(dir, "characters", "ana-2026-11-20T18-30-00-000Z", { name: "Ana" });
    await seed(dir, "characters", "ana-2026-11-21T09-00-00-000Z-2", { name: "  Ana later  " });
    await seed(dir, "scenes", "broken-folder", { name: "No timestamp" });
    await seed(dir, "storyboards", "board-2026-11-19T10-00-00-000Z", "{not json");
    await fs.writeFile(path.join(dir, "library", ".trash", "characters", "stray.txt"), "ignored", "utf8");

    const entries = await trash.listTrash();
    assert.deepEqual(plain(entries.map(entry => entry.folder)), [
        "ana-2026-11-21T09-00-00-000Z-2",
        "ana-2026-11-20T18-30-00-000Z",
        "board-2026-11-19T10-00-00-000Z",
        "broken-folder",
    ]);
    assert.deepEqual(plain(entries.map(entry => entry.kind)), ["character", "character", "storyboard", "scene"]);
    assert.equal(entries[0].name, "Ana later");
    assert.equal(entries[0].trashedAt, "2026-11-21T09:00:00.000Z");
    assert.equal(entries[2].name, null);
    assert.equal(entries[3].trashedAt, null);
});

test("missing trash directories and the GET route return an empty read-only listing", async (t) => {
    const { dir, loader, route } = await harness(t);
    assert.deepEqual(plain(await loader.load("@/server/library/trash").listTrash()), []);
    const response = await route.GET(new Request("http://127.0.0.1/api/library/trash"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(plain(await response.json()), { entries: [], count: 0 });

    await seed(dir, "characters", "ana-2026-11-20T18-30-00-000Z", { name: "Ana" });
    const populated = await route.GET(new Request("http://127.0.0.1/api/library/trash"));
    const body = await populated.json();
    assert.equal(body.count, 1);
    assert.equal(body.entries[0].kind, "character");
    assert.equal(body.entries[0].folder, "ana-2026-11-20T18-30-00-000Z");
    assert.equal(body.entries[0].trashedAt, "2026-11-20T18:30:00.000Z");
    assert.equal(body.entries[0].name, "Ana");
});
