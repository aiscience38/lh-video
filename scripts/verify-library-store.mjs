import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModuleLoader } from "./test-module-loader.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const UUID_ONE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const UUID_TWO = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

async function harness(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "library-store-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const env = { OPEN_HIGGSFIELD_STORAGE_DIR: dir, NODE_ENV: "development" };
    const loader = createModuleLoader({ env, mocks: { "next/server": { NextResponse: Response } } });
    return {
        dir,
        env,
        loader,
        store: loader.load("@/server/library/store"),
        contract: loader.load("@/server/library/contract"),
        listRoute: loader.load("src/app/api/library/route.ts"),
        itemRoute: loader.load("src/app/api/library/[kind]/[id]/route.ts"),
    };
}

function apiRequest(url, method = "GET", body) {
    const headers = { origin: "http://127.0.0.1:3120", host: "127.0.0.1:3120", "sec-fetch-site": "same-origin" };
    if (body !== undefined) headers["content-type"] = "application/json";
    return new Request(`http://localhost:3120${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

function context(kind, id) {
    return { params: Promise.resolve({ kind, id }) };
}

test("store creates, lists, finds and reads one document per entity", async (t) => {
    const { dir, store } = await harness(t);
    assert.deepEqual(plain(await store.listEntities("character")), []);
    const entity = await store.createEntity("character", { name: "Ana", notes: "Lead", assetIds: ["asset_reference_1"] });
    assert.equal(entity.kind, "character");
    assert.equal(entity.slug, "ana");
    assert.equal(entity.notes, "Lead");
    assert.deepEqual(plain(entity.assetIds), ["asset_reference_1"]);
    const file = path.join(dir, "library", "characters", "ana", "character.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(raw.kind, "character");
    assert.equal(raw.id, entity.id);
    assert.equal(raw.slug, "ana");
    const listed = await store.listEntities("character");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, entity.id);
    const found = await store.findEntityBySlug("character", "ana");
    assert.equal(found.id, entity.id);
    assert.equal((await store.readEntity("character", entity.id)).name, "Ana");
    assert.equal(await store.readEntity("character", UUID_TWO), undefined);
    assert.equal(await store.findEntityBySlug("character", "missing"), undefined);
    assert.deepEqual(plain(await store.listEntities("scene")), []);
});

test("slug collisions receive -2 and -3 suffixes without exceeding the slug limit", async (t) => {
    const { dir, store, contract } = await harness(t);
    const first = await store.createEntity("character", { name: "Ana" });
    const second = await store.createEntity("character", { name: "Ana" });
    const third = await store.createEntity("character", { name: "Ana" });
    assert.deepEqual([first.slug, second.slug, third.slug], ["ana", "ana-2", "ana-3"]);
    for (const slug of ["ana", "ana-2", "ana-3"]) {
        assert.equal(await fs.access(path.join(dir, "library", "characters", slug, "character.json")).then(() => true, () => false), true);
    }
    const longName = "Story ".repeat(12).trim();
    const longFirst = await store.createEntity("scene", { name: longName });
    const longSecond = await store.createEntity("scene", { name: longName });
    for (const entity of [longFirst, longSecond]) {
        assert.ok(entity.slug.length <= contract.MAX_SLUG_LENGTH, `slug too long: ${entity.slug}`);
        assert.equal(contract.isValidSlug(entity.slug), true);
    }
    assert.notEqual(longFirst.slug, longSecond.slug);
    assert.equal((await store.listEntities("character")).length, 3);
});

test("updates persist, reject identity changes and always bump updatedAt", async (t) => {
    const { dir, store, contract } = await harness(t);
    const entity = await store.createEntity("character", { name: "Ana", notes: "Old" });
    const updated = await store.updateEntity("character", entity.id, { notes: "New", assetIds: ["asset_2"] });
    assert.equal(updated.notes, "New");
    assert.deepEqual(plain(updated.assetIds), ["asset_2"]);
    assert.equal(updated.id, entity.id);
    assert.equal(updated.slug, "ana");
    assert.ok(Date.parse(updated.updatedAt) > Date.parse(entity.updatedAt));
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "library", "characters", "ana", "character.json"), "utf8"));
    assert.equal(onDisk.notes, "New");
    assert.equal(onDisk.updatedAt, updated.updatedAt);
    const identity = await store.updateEntity("character", entity.id, { id: entity.id, kind: "character", slug: "ana", notes: "Same identity" });
    assert.equal(identity.notes, "Same identity", "unchanged identity fields are accepted");
    for (const patch of [{ slug: "other" }, { id: UUID_TWO }, { kind: "scene" }, { createdAt: "2026-01-01T00:00:00Z" }, { name: "" }]) {
        await assert.rejects(store.updateEntity("character", entity.id, patch), /ERR_LIBRARY_INVALID/, JSON.stringify(patch));
    }
    await assert.rejects(store.updateEntity("character", UUID_TWO, { notes: "x" }), /ERR_LIBRARY_NOT_FOUND/);
    await assert.rejects(store.updateEntity("character", "../ana", { notes: "x" }), /ERR_LIBRARY_NOT_FOUND/);
    assert.equal(contract.characterSchema.safeParse(onDisk).success, true);
});

test("delete moves the folder into .trash and never touches referenced media", async (t) => {
    const { dir, store } = await harness(t);
    const media = path.join(dir, "uploads", "asset_reference_1.png");
    await fs.mkdir(path.dirname(media), { recursive: true });
    await fs.writeFile(media, "synthetic media bytes", "utf8");
    const entity = await store.createEntity("character", { name: "Ana", assetIds: ["asset_reference_1"] });
    const folder = path.join(dir, "library", "characters", "ana");
    assert.equal(await store.deleteEntity("character", entity.id), true);
    assert.equal(await fs.access(folder).then(() => true, () => false), false);
    const trash = path.join(dir, "library", ".trash", "characters");
    const entries = await fs.readdir(trash);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^ana-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    const trashed = JSON.parse(await fs.readFile(path.join(trash, entries[0], "character.json"), "utf8"));
    assert.equal(trashed.id, entity.id);
    assert.equal(await fs.readFile(media, "utf8"), "synthetic media bytes");
    assert.equal(await store.readEntity("character", entity.id), undefined);
    assert.deepEqual(plain(await store.listEntities("character")), []);
    assert.equal(await store.deleteEntity("character", entity.id), false);
});

test("a scene with two shots round-trips through a fresh store instance", async (t) => {
    const { dir, env, store } = await harness(t);
    const shots = [
        { id: UUID_ONE, order: 0, prompt: "Wide establishing shot", params: { seed: 7, aspect: "16:9" }, assetIds: ["asset_1"], taskIds: ["task_1"] },
        { id: UUID_TWO, order: 1, prompt: "Close up" },
    ];
    const scene = await store.createEntity("scene", { name: "Opening", shots });
    assert.equal(scene.slug, "opening");
    assert.equal(scene.shots.length, 2);
    assert.equal(scene.shots[1].capabilityId, null);
    const file = path.join(dir, "library", "scenes", "opening", "scene.json");
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).shots.length, 2);

    const freshStore = createModuleLoader({ env }).load("@/server/library/store");
    const loaded = await freshStore.findEntityBySlug("scene", "opening");
    assert.equal(loaded.id, scene.id);
    assert.equal(loaded.kind, "scene");
    assert.equal(loaded.shots.length, 2);
    assert.deepEqual(plain(loaded.shots), plain(scene.shots));
    assert.equal(loaded.shots[0].prompt, "Wide establishing shot");
    assert.deepEqual(plain(loaded.shots[0].params), { seed: 7, aspect: "16:9" });
    assert.deepEqual(plain(loaded.shots[0].taskIds), ["task_1"]);
    assert.equal(loaded.shots[1].order, 1);
});

test("a storyboard stores productionId and defaulted panel fields", async (t) => {
    const { dir, store } = await harness(t);
    const storyboard = await store.createEntity("storyboard", {
        name: "Teaser",
        productionId: "production_1",
        shots: [{ id: UUID_ONE, order: 0, intent: "Reveal" }],
    });
    assert.equal(storyboard.productionId, "production_1");
    assert.equal(storyboard.shots[0].seconds, 3);
    assert.equal(storyboard.shots[0].keyframeAssetId, null);
    assert.equal(storyboard.shots[0].camera, "");
    const raw = JSON.parse(await fs.readFile(path.join(dir, "library", "storyboards", "teaser", "storyboard.json"), "utf8"));
    assert.equal(raw.productionId, "production_1");
    assert.equal(raw.shots.length, 1);
});

test("store rejects unknown kinds and traversal slugs", async (t) => {
    const { store } = await harness(t);
    await assert.rejects(store.listEntities("video"), /ERR_LIBRARY_KIND/);
    await assert.rejects(store.findEntityBySlug("character", "../x"), /ERR_LIBRARY_INVALID/);
    await assert.rejects(store.findEntityBySlug("character", "a/b"), /ERR_LIBRARY_INVALID/);
    await assert.rejects(store.findEntityBySlug("character", "con"), /ERR_LIBRARY_INVALID/);
    await assert.rejects(store.createEntity("character", { name: "!!!" }), /ERR_LIBRARY_INVALID/);
    await assert.rejects(store.createEntity("character", { name: "x".repeat(121) }), /ERR_LIBRARY_INVALID/);
    assert.equal(await store.readEntity("character", "../../etc"), undefined);
});

test("library routes list, create, read, update and delete with stable error codes", async (t) => {
    const { listRoute, itemRoute } = await harness(t);
    const invalidKind = await listRoute.GET(apiRequest("/api/library?kind=video"));
    assert.equal(invalidKind.status, 400);
    assert.equal((await invalidKind.json()).error, "ERR_LIBRARY_KIND");

    const invalidBody = await listRoute.POST(apiRequest("/api/library", "POST", { name: "Ana" }));
    assert.equal(invalidBody.status, 400);
    assert.equal((await invalidBody.json()).error, "ERR_LIBRARY_KIND");

    const invalidEntity = await listRoute.POST(apiRequest("/api/library", "POST", { kind: "character", name: "" }));
    assert.equal(invalidEntity.status, 400);
    assert.equal((await invalidEntity.json()).error, "ERR_LIBRARY_INVALID");

    const created = await listRoute.POST(apiRequest("/api/library", "POST", { kind: "character", name: "Ana" }));
    assert.equal(created.status, 201);
    const { entity } = await created.json();
    assert.equal(entity.slug, "ana");

    const listed = await listRoute.GET(apiRequest("/api/library?kind=character&q=an"));
    assert.equal(listed.status, 200);
    const payload = await listed.json();
    assert.equal(payload.count, 1);
    assert.equal(payload.entities[0].id, entity.id);

    const read = await itemRoute.GET(apiRequest(`/api/library/character/${entity.id}`), context("character", entity.id));
    assert.equal(read.status, 200);
    assert.equal((await read.json()).entity.id, entity.id);

    const patched = await itemRoute.PATCH(apiRequest(`/api/library/character/${entity.id}`, "PATCH", { notes: "Updated" }),
        context("character", entity.id));
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).entity.notes, "Updated");

    const conflict = await itemRoute.PATCH(apiRequest(`/api/library/character/${entity.id}`, "PATCH", { slug: "other" }),
        context("character", entity.id));
    assert.equal(conflict.status, 400);
    assert.equal((await conflict.json()).error, "ERR_LIBRARY_INVALID");

    const wrongKind = await itemRoute.GET(apiRequest(`/api/library/video/${entity.id}`), context("video", entity.id));
    assert.equal(wrongKind.status, 400);
    assert.equal((await wrongKind.json()).error, "ERR_LIBRARY_KIND");

    const missing = await itemRoute.GET(apiRequest(`/api/library/character/${UUID_TWO}`), context("character", UUID_TWO));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "ERR_LIBRARY_NOT_FOUND");

    const deleted = await itemRoute.DELETE(apiRequest(`/api/library/character/${entity.id}`, "DELETE"), context("character", entity.id));
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).ok, true);

    const gone = await itemRoute.GET(apiRequest(`/api/library/character/${entity.id}`), context("character", entity.id));
    assert.equal(gone.status, 404);
});
