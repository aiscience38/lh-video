import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModuleLoader } from "./test-module-loader.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const UUID_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const UUID_B = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const UUID_C = "6ba7b811-9dad-41d1-80b4-00c04fd430c8";
const UUID_UNKNOWN = "9d3e1c62-6a41-4f0e-8a37-5b9b0c9f2f11";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function harness(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyboards-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const env = { OPEN_HIGGSFIELD_STORAGE_DIR: dir, NODE_ENV: "development" };
    const loader = createModuleLoader({ env, mocks: { "next/server": { NextResponse: Response } } });
    return {
        dir,
        env,
        storyboards: loader.load("@/server/library/storyboards"),
        shotsRoute: loader.load("src/app/api/library/storyboard/[id]/shots/route.ts"),
    };
}

function apiRequest(url, method = "GET", body, origin = "http://127.0.0.1:3120") {
    const headers = { origin, host: "127.0.0.1:3120", "sec-fetch-site": "same-origin" };
    if (body !== undefined) headers["content-type"] = "application/json";
    return new Request(`http://localhost:3120${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

function context(id) {
    return { params: Promise.resolve({ id }) };
}

function documentPath(dir, slug) {
    return path.join(dir, "library", "storyboards", slug, "storyboard.json");
}

async function readDocument(dir, slug) {
    return JSON.parse(await fs.readFile(documentPath(dir, slug), "utf8"));
}

async function exists(target) {
    return fs.access(target).then(() => true, () => false);
}

test("createStoryboard stores productionId and addShot appends normalized panels", async (t) => {
    const { dir, storyboards } = await harness(t);
    const board = await storyboards.createStoryboard("Teaser Cut", "production_lh_1");
    assert.equal(board.kind, "storyboard");
    assert.equal(board.name, "Teaser Cut");
    assert.equal(board.slug, "teaser-cut");
    assert.equal(board.productionId, "production_lh_1");
    assert.deepEqual(plain(board.shots), []);
    assert.match(board.id, UUID_PATTERN);
    assert.ok(Date.parse(board.updatedAt) >= Date.parse(board.createdAt));

    const first = await storyboards.addShot(board.id, { id: UUID_A, intent: "Wide establishing shot", seconds: 4, camera: "24mm wide" });
    assert.deepEqual(first.shots.map((shot) => shot.id), [UUID_A]);
    assert.equal(first.shots[0].order, 0);
    assert.equal(first.shots[0].intent, "Wide establishing shot");
    assert.equal(first.shots[0].seconds, 4);
    assert.equal(first.shots[0].camera, "24mm wide");
    assert.equal(first.shots[0].keyframeAssetId, null);
    assert.ok(Date.parse(first.updatedAt) > Date.parse(board.updatedAt), "addShot bumps updatedAt");

    // A caller-supplied order is ignored: the array index is authoritative.
    const second = await storyboards.addShot(board.id, { id: UUID_B, intent: "Close on hands", camera: "macro", order: 99 });
    const third = await storyboards.addShot(board.id, { id: UUID_C });
    assert.deepEqual(second.shots.map((shot) => shot.order), [0, 1]);
    assert.equal(third.shots.length, 3);
    assert.deepEqual(third.shots.map((shot) => shot.id), [UUID_A, UUID_B, UUID_C]);
    assert.deepEqual(third.shots.map((shot) => shot.order), [0, 1, 2]);
    assert.equal(third.shots[1].seconds, 3, "seconds defaults to 3");
    assert.equal(third.shots[2].intent, "");
    assert.equal(third.shots[2].camera, "");
    assert.equal(third.shots[2].keyframeAssetId, null);
    assert.ok(Date.parse(third.updatedAt) > Date.parse(second.updatedAt));

    const raw = await readDocument(dir, "teaser-cut");
    assert.equal(raw.id, board.id);
    assert.equal(raw.kind, "storyboard");
    assert.equal(raw.productionId, "production_lh_1");
    assert.deepEqual(raw.shots.map((shot) => shot.order), [0, 1, 2]);

    const generated = await storyboards.addShot(board.id, { intent: "Generated id" });
    assert.match(generated.shots[3].id, UUID_PATTERN);
    assert.equal(generated.shots[3].order, 3);
    assert.deepEqual(plain(await storyboards.readStoryboard(board.id)), plain(generated));
});

test("setKeyframe pins an asset id and the storyboard reloads through a fresh store", async (t) => {
    const { dir, env, storyboards } = await harness(t);
    const board = await storyboards.createStoryboard("Keyframe Board");
    assert.equal(board.productionId, null, "productionId defaults to null");
    await storyboards.addShot(board.id, { id: UUID_A, intent: "Panel one" });
    await storyboards.addShot(board.id, { id: UUID_B, intent: "Panel two" });
    await storyboards.addShot(board.id, { id: UUID_C, intent: "Panel three" });

    const keyed = await storyboards.setKeyframe(board.id, UUID_B, "asset_keyframe_01");
    assert.equal(keyed.shots[1].keyframeAssetId, "asset_keyframe_01");
    assert.equal(keyed.shots[0].keyframeAssetId, null);
    assert.equal(keyed.shots[2].keyframeAssetId, null);
    assert.ok(Date.parse(keyed.updatedAt) > Date.parse(board.updatedAt));

    const dashed = await storyboards.setKeyframe(board.id, UUID_A, "asset-keyframe_02");
    assert.equal(dashed.shots[0].keyframeAssetId, "asset-keyframe_02");
    const cleared = await storyboards.setKeyframe(board.id, UUID_A, null);
    assert.equal(cleared.shots[0].keyframeAssetId, null);

    const before = plain(await storyboards.readStoryboard(board.id));
    for (const assetId of ["bad id!", "a/b", "", "x".repeat(129), 42]) {
        await assert.rejects(storyboards.setKeyframe(board.id, UUID_C, assetId), /ERR_LIBRARY_INVALID/, JSON.stringify(assetId));
        await assert.rejects(storyboards.addShot(board.id, { intent: "bad keyframe", keyframeAssetId: assetId }), /ERR_LIBRARY_INVALID/);
    }
    assert.deepEqual(plain(await storyboards.readStoryboard(board.id)), before, "rejected writes leave the document untouched");
    await assert.rejects(storyboards.setKeyframe(board.id, UUID_UNKNOWN, "asset_keyframe_01"), /ERR_LIBRARY_INVALID/);
    await assert.rejects(storyboards.addShot(board.id, { id: UUID_A, intent: "duplicate panel id" }), /ERR_LIBRARY_INVALID/);
    await assert.rejects(storyboards.setKeyframe(UUID_UNKNOWN, UUID_A, "asset_keyframe_01"), /ERR_LIBRARY_NOT_FOUND/);
    await assert.rejects(storyboards.addShot(UUID_UNKNOWN, { intent: "orphan" }), /ERR_LIBRARY_NOT_FOUND/);

    const raw = await readDocument(dir, "keyframe-board");
    assert.equal(raw.shots[1].keyframeAssetId, "asset_keyframe_01");

    const fresh = createModuleLoader({ env }).load("@/server/library/storyboards");
    const reloaded = await fresh.readStoryboard(board.id);
    assert.equal(reloaded.id, board.id);
    assert.equal(reloaded.slug, "keyframe-board");
    assert.equal(reloaded.productionId, null);
    assert.deepEqual(reloaded.shots.map((shot) => shot.id), [UUID_A, UUID_B, UUID_C]);
    assert.deepEqual(reloaded.shots.map((shot) => shot.order), [0, 1, 2]);
    assert.deepEqual(reloaded.shots.map((shot) => shot.keyframeAssetId), [null, "asset_keyframe_01", null]);
    assert.deepEqual(reloaded.shots.map((shot) => shot.intent), ["Panel one", "Panel two", "Panel three"]);
    assert.deepEqual(plain(reloaded.updatedAt), raw.updatedAt);
    const listed = await fresh.listStoryboards();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, board.id);
});

test("reorderShots renormalizes order, persists and rejects non-permutations", async (t) => {
    const { env, storyboards } = await harness(t);
    const board = await storyboards.createStoryboard("Order Board", "production_lh_2");
    for (const [id, intent] of [[UUID_A, "A"], [UUID_B, "B"], [UUID_C, "C"]]) {
        await storyboards.addShot(board.id, { id, intent });
    }

    const reordered = await storyboards.reorderShots(board.id, [UUID_C, UUID_A, UUID_B]);
    assert.deepEqual(reordered.shots.map((shot) => shot.id), [UUID_C, UUID_A, UUID_B]);
    assert.deepEqual(reordered.shots.map((shot) => shot.order), [0, 1, 2]);
    assert.deepEqual(reordered.shots.map((shot) => shot.intent), ["C", "A", "B"]);

    const before = plain(await storyboards.readStoryboard(board.id));
    for (const orderedIds of [[UUID_A, UUID_B], [UUID_A, UUID_A, UUID_B], [UUID_A, UUID_B, UUID_UNKNOWN], [], "nope", null]) {
        await assert.rejects(storyboards.reorderShots(board.id, orderedIds), /ERR_LIBRARY_INVALID/, JSON.stringify(orderedIds));
    }
    assert.deepEqual(plain(await storyboards.readStoryboard(board.id)), before, "failed reorders do not write");
    await assert.rejects(storyboards.reorderShots(UUID_UNKNOWN, [UUID_A]), /ERR_LIBRARY_NOT_FOUND/);

    const appended = await storyboards.addShot(board.id, { intent: "D" });
    assert.equal(appended.shots.length, 4);
    assert.equal(appended.shots[3].order, 3, "append continues after a reorder");

    const fresh = createModuleLoader({ env }).load("@/server/library/storyboards");
    const reloaded = await fresh.readStoryboard(board.id);
    assert.deepEqual(reloaded.shots.map((shot) => shot.id), [UUID_C, UUID_A, UUID_B, appended.shots[3].id]);
    assert.deepEqual(reloaded.shots.map((shot) => shot.order), [0, 1, 2, 3]);
    assert.deepEqual(plain(await fresh.listStoryboards()), [plain(reloaded)]);
});

test("removeShot drops one panel and renormalizes the rest", async (t) => {
    const { dir, storyboards } = await harness(t);
    const board = await storyboards.createStoryboard("Removal Board");
    for (const id of [UUID_A, UUID_B, UUID_C]) await storyboards.addShot(board.id, { id, intent: id });

    const remaining = await storyboards.removeShot(board.id, UUID_B);
    assert.deepEqual(remaining.shots.map((shot) => shot.id), [UUID_A, UUID_C]);
    assert.deepEqual(remaining.shots.map((shot) => shot.order), [0, 1]);
    assert.equal((await readDocument(dir, "removal-board")).shots.length, 2);

    await assert.rejects(storyboards.removeShot(board.id, UUID_B), /ERR_LIBRARY_INVALID/, "already removed");
    await assert.rejects(storyboards.removeShot(board.id, UUID_UNKNOWN), /ERR_LIBRARY_INVALID/);
    await assert.rejects(storyboards.removeShot(UUID_UNKNOWN, UUID_A), /ERR_LIBRARY_NOT_FOUND/);

    const last = await storyboards.removeShot(board.id, UUID_A);
    assert.deepEqual(plain(last.shots.map((shot) => shot.id)), [UUID_C]);
    assert.deepEqual(plain(await storyboards.listStoryboards()).map((item) => item.shots.length), [1]);
});

test("deleteStoryboard moves the folder to .trash and leaves referenced media untouched", async (t) => {
    const { dir, storyboards } = await harness(t);
    const media = path.join(dir, "downloads", "images", "panel_keyframe_01.png");
    await fs.mkdir(path.dirname(media), { recursive: true });
    await fs.writeFile(media, "synthetic keyframe bytes", "utf8");

    const board = await storyboards.createStoryboard("Disposable Board", "production_lh_3");
    await storyboards.addShot(board.id, { id: UUID_A, intent: "Panel with keyframe", keyframeAssetId: "panel_keyframe_01" });
    const folder = path.join(dir, "library", "storyboards", "disposable-board");

    assert.equal(await storyboards.deleteStoryboard(board.id), true);
    assert.equal(await exists(folder), false, "storyboard folder is gone");
    assert.equal(await storyboards.readStoryboard(board.id), undefined);
    assert.deepEqual(plain(await storyboards.listStoryboards()), []);

    const trash = path.join(dir, "library", ".trash", "storyboards");
    const entries = await fs.readdir(trash);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^disposable-board-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    const trashed = JSON.parse(await fs.readFile(path.join(trash, entries[0], "storyboard.json"), "utf8"));
    assert.equal(trashed.id, board.id);
    assert.equal(trashed.productionId, "production_lh_3");
    assert.equal(trashed.shots[0].keyframeAssetId, "panel_keyframe_01");

    assert.equal(await fs.readFile(media, "utf8"), "synthetic keyframe bytes", "media bytes are never touched");
    assert.equal(await exists(media), true);
    assert.equal(await storyboards.deleteStoryboard(board.id), false, "deleting twice reports false");
    assert.equal(await storyboards.deleteStoryboard("../teaser"), false);
});

test("storyboard slugs collide safely and stay listable by name", async (t) => {
    const { storyboards } = await harness(t);
    const first = await storyboards.createStoryboard("Teaser Cut");
    const second = await storyboards.createStoryboard("Teaser Cut");
    assert.deepEqual([first.slug, second.slug], ["teaser-cut", "teaser-cut-2"]);
    const listed = await storyboards.listStoryboards();
    assert.deepEqual(plain(listed.map((item) => item.slug)), ["teaser-cut", "teaser-cut-2"]);
    assert.equal(listed.length, 2);
    await assert.rejects(storyboards.createStoryboard("Teaser Cut", ""), /ERR_LIBRARY_INVALID/);
    await assert.rejects(storyboards.createStoryboard("Teaser Cut", "p".repeat(129)), /ERR_LIBRARY_INVALID/);
    await assert.rejects(storyboards.createStoryboard(""), /ERR_LIBRARY_INVALID/);
    await assert.rejects(storyboards.createStoryboard("!!!"), /ERR_LIBRARY_INVALID/);
});

test("the shots route adds and reorders panels without duplicating generic CRUD", async (t) => {
    const { dir, storyboards, shotsRoute } = await harness(t);
    const board = await storyboards.createStoryboard("Route Board");
    const url = `/api/library/storyboard/${board.id}/shots`;

    const added = await shotsRoute.POST(apiRequest(url, "POST", { action: "add", shot: { id: UUID_A, intent: "Route panel", seconds: 5 } }), context(board.id));
    assert.equal(added.status, 201);
    const addedEntity = (await added.json()).entity;
    assert.equal(addedEntity.shots.length, 1);
    assert.equal(addedEntity.shots[0].intent, "Route panel");
    assert.equal(addedEntity.shots[0].seconds, 5);

    const generated = await shotsRoute.POST(apiRequest(url, "POST", { action: "add", shot: { intent: "Second route panel", order: 7 } }), context(board.id));
    assert.equal(generated.status, 201);
    const generatedEntity = (await generated.json()).entity;
    assert.match(generatedEntity.shots[1].id, UUID_PATTERN);
    assert.equal(generatedEntity.shots[1].order, 1);

    const blank = await shotsRoute.POST(apiRequest(url, "POST", { action: "add", shot: {} }), context(board.id));
    assert.equal(blank.status, 201);
    const blankEntity = (await blank.json()).entity;
    assert.equal(blankEntity.shots.length, 3);

    const secondId = generatedEntity.shots[1].id;
    const thirdId = blankEntity.shots[2].id;
    const reordered = await shotsRoute.POST(apiRequest(url, "POST", { action: "reorder", orderedIds: [secondId, thirdId, UUID_A] }), context(board.id));
    assert.equal(reordered.status, 200);
    const reorderedEntity = (await reordered.json()).entity;
    assert.deepEqual(reorderedEntity.shots.map((shot) => shot.id), [secondId, thirdId, UUID_A]);
    assert.deepEqual(reorderedEntity.shots.map((shot) => shot.order), [0, 1, 2]);
    assert.equal((await readDocument(dir, "route-board")).shots[0].id, secondId);

    const badAction = await shotsRoute.POST(apiRequest(url, "POST", { action: "explode" }), context(board.id));
    assert.equal(badAction.status, 400);
    assert.equal((await badAction.json()).error, "ERR_LIBRARY_INVALID");

    const badAsset = await shotsRoute.POST(apiRequest(url, "POST", { action: "add", shot: { keyframeAssetId: "no spaces" } }), context(board.id));
    assert.equal(badAsset.status, 400);
    assert.equal((await badAsset.json()).error, "ERR_LIBRARY_INVALID");

    const badReorder = await shotsRoute.POST(apiRequest(url, "POST", { action: "reorder", orderedIds: "nope" }), context(board.id));
    assert.equal(badReorder.status, 400);
    assert.equal((await badReorder.json()).error, "ERR_LIBRARY_INVALID");

    const arrayBody = await shotsRoute.POST(apiRequest(url, "POST", [{ action: "add" }]), context(board.id));
    assert.equal(arrayBody.status, 400);

    const missing = await shotsRoute.POST(apiRequest(`/api/library/storyboard/${UUID_UNKNOWN}/shots`, "POST", { action: "add", shot: {} }), context(UUID_UNKNOWN));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "ERR_LIBRARY_NOT_FOUND");

    const crossOrigin = await shotsRoute.POST(apiRequest(url, "POST", { action: "add", shot: {} }, "http://evil.example"), context(board.id));
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error, "ERR_ORIGIN_FORBIDDEN");

    const notJson = await shotsRoute.POST(new Request(`http://localhost:3120${url}`, {
        method: "POST",
        headers: { origin: "http://127.0.0.1:3120", host: "127.0.0.1:3120", "sec-fetch-site": "same-origin", "content-type": "text/plain" },
        body: "{}",
    }), context(board.id));
    assert.equal(notJson.status, 415);
    assert.equal((await notJson.json()).error, "ERR_CONTENT_TYPE");
    assert.equal((await storyboards.readStoryboard(board.id)).shots.length, 3, "rejected requests never mutate");
});
