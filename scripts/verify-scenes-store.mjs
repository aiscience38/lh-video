import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModuleLoader } from "./test-module-loader.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const UUID_ONE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const UUID_TWO = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function harness(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scenes-store-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const env = { OPEN_HIGGSFIELD_STORAGE_DIR: dir, NODE_ENV: "development" };
    const loader = createModuleLoader({ env, mocks: { "next/server": { NextResponse: Response } } });
    return {
        dir,
        env,
        loader,
        store: loader.load("@/server/scenes/store"),
        listRoute: loader.load("src/app/api/scenes/route.ts"),
        itemRoute: loader.load("src/app/api/scenes/[id]/route.ts"),
    };
}

function sceneFile(dir, slug) {
    return path.join(dir, "library", "scenes", slug, "scene.json");
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

function context(id) {
    return { params: Promise.resolve({ id }) };
}

test("createScene writes one library scene document and lists it", async (t) => {
    const { dir, store } = await harness(t);
    assert.deepEqual(plain(await store.listScenes()), []);
    const scene = await store.createScene("Opening");
    assert.equal(scene.kind, "scene");
    assert.equal(scene.name, "Opening");
    assert.equal(scene.slug, "opening");
    assert.match(scene.id, UUID_PATTERN);
    assert.deepEqual(plain(scene.shots), []);

    const raw = JSON.parse(await fs.readFile(sceneFile(dir, "opening"), "utf8"));
    assert.equal(raw.kind, "scene");
    assert.equal(raw.id, scene.id);
    assert.equal(raw.slug, "opening");
    assert.deepEqual(raw.shots, []);

    const listed = await store.listScenes();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, scene.id);
    assert.equal((await store.readScene(scene.id)).name, "Opening");
    assert.equal(await store.readScene(UUID_TWO), undefined);
    assert.equal(await store.readScene("../../etc"), undefined);

    await assert.rejects(store.createScene(""), /ERR_LIBRARY_INVALID/);
    await assert.rejects(store.createScene("!!!"), /ERR_LIBRARY_INVALID/);
    const second = await store.createScene("Opening");
    assert.equal(second.slug, "opening-2");
    assert.equal((await store.listScenes()).length, 2);
});

test("addShot appends uuid shots, applies defaults and normalizes order on disk", async (t) => {
    const { dir, store } = await harness(t);
    const scene = await store.createScene("Opening");
    const first = await store.addShot(scene.id, {
        prompt: "Wide establishing shot",
        capabilityId: "image.text-to-image",
        params: { seed: 7, aspect: "16:9" },
        assetIds: ["asset_reference_1"],
        taskIds: ["task_1"],
    });
    assert.equal(first.shots.length, 1);
    assert.match(first.shots[0].id, UUID_PATTERN);
    assert.equal(first.shots[0].order, 0);
    assert.equal(first.shots[0].prompt, "Wide establishing shot");
    assert.equal(first.shots[0].capabilityId, "image.text-to-image");
    assert.deepEqual(plain(first.shots[0].params), { seed: 7, aspect: "16:9" });
    assert.deepEqual(plain(first.shots[0].assetIds), ["asset_reference_1"]);
    assert.deepEqual(plain(first.shots[0].taskIds), ["task_1"]);

    const second = await store.addShot(scene.id, { prompt: "Close up" });
    assert.equal(second.shots.length, 2);
    assert.equal(second.shots[1].order, 1);
    assert.equal(second.shots[1].capabilityId, null);
    assert.deepEqual(plain(second.shots[1].params), {});
    assert.deepEqual(plain(second.shots[1].assetIds), []);
    assert.deepEqual(plain(second.shots[1].taskIds), []);
    assert.notEqual(second.shots[0].id, second.shots[1].id);
    assert.ok(Date.parse(second.updatedAt) > Date.parse(first.updatedAt));

    const raw = JSON.parse(await fs.readFile(sceneFile(dir, "opening"), "utf8"));
    assert.deepEqual(raw.shots.map((shot) => shot.order), [0, 1]);
    assert.deepEqual(raw.shots.map((shot) => shot.prompt), ["Wide establishing shot", "Close up"]);
    assert.deepEqual(raw.shots.map((shot) => shot.id), plain(second.shots.map((shot) => shot.id)));

    const before = await fs.readFile(sceneFile(dir, "opening"), "utf8");
    await assert.rejects(store.addShot(scene.id, { id: "not-a-uuid" }), /ERR_LIBRARY_INVALID/);
    await assert.rejects(store.addShot(scene.id, { capabilityId: 42 }), /ERR_LIBRARY_INVALID/);
    assert.equal(await fs.readFile(sceneFile(dir, "opening"), "utf8"), before);
    await assert.rejects(store.addShot(UUID_TWO, { prompt: "Orphan" }), /ERR_LIBRARY_NOT_FOUND/);
});

test("reorderShots persists array order through a fresh store instance", async (t) => {
    const { dir, env, store } = await harness(t);
    const scene = await store.createScene("Opening");
    await store.addShot(scene.id, { prompt: "First" });
    const twoShots = await store.addShot(scene.id, { prompt: "Second" });
    const [firstShot, secondShot] = twoShots.shots;

    const reordered = await store.reorderShots(scene.id, [secondShot.id, firstShot.id]);
    assert.deepEqual(plain(reordered.shots.map((shot) => shot.id)), [secondShot.id, firstShot.id]);
    assert.deepEqual(reordered.shots.map((shot) => shot.order), [0, 1]);
    assert.deepEqual(reordered.shots.map((shot) => shot.prompt), ["Second", "First"]);
    assert.equal(reordered.id, scene.id);
    assert.equal(reordered.slug, "opening");

    const raw = JSON.parse(await fs.readFile(sceneFile(dir, "opening"), "utf8"));
    assert.deepEqual(raw.shots.map((shot) => shot.id), [secondShot.id, firstShot.id]);
    assert.deepEqual(raw.shots.map((shot) => shot.order), [0, 1]);

    const freshStore = createModuleLoader({ env }).load("@/server/scenes/store");
    const loaded = await freshStore.readScene(scene.id);
    assert.equal(loaded.kind, "scene");
    assert.deepEqual(plain(loaded.shots), plain(reordered.shots));
    assert.equal(loaded.shots[0].prompt, "Second");
    assert.equal(loaded.shots[1].order, 1);
});

test("reorderShots rejects incomplete, duplicate or unknown id lists without writing", async (t) => {
    const { dir, store } = await harness(t);
    const scene = await store.createScene("Opening");
    await store.addShot(scene.id, { prompt: "First" });
    const twoShots = await store.addShot(scene.id, { prompt: "Second" });
    const [firstShot, secondShot] = twoShots.shots;
    const file = sceneFile(dir, "opening");
    const before = await fs.readFile(file, "utf8");

    const attempts = [
        [firstShot.id],
        [],
        [firstShot.id, firstShot.id],
        [firstShot.id, UUID_ONE],
        [firstShot.id, secondShot.id, UUID_ONE],
        [firstShot.id, 42],
        "not-an-array",
    ];
    for (const orderedIds of attempts) {
        await assert.rejects(store.reorderShots(scene.id, orderedIds), /ERR_LIBRARY_INVALID/, JSON.stringify(orderedIds));
    }
    assert.equal(await fs.readFile(file, "utf8"), before, "a rejected reorder must not rewrite the document");
    const unchanged = await store.readScene(scene.id);
    assert.equal(unchanged.updatedAt, twoShots.updatedAt);
    assert.deepEqual(plain(unchanged.shots), plain(twoShots.shots));
    await assert.rejects(store.reorderShots(UUID_TWO, [firstShot.id]), /ERR_LIBRARY_NOT_FOUND/);
});

test("updateSceneShots replaces shots, assigns missing ids and rejects duplicates", async (t) => {
    const { dir, store } = await harness(t);
    const scene = await store.createScene("Opening");
    const updated = await store.updateSceneShots(scene.id, [
        { prompt: "B", order: 9 },
        { prompt: "A", order: 4, capabilityId: "video.text-to-video", params: { duration: 5 } },
    ]);
    assert.equal(updated.shots.length, 2);
    assert.deepEqual(updated.shots.map((shot) => shot.order), [0, 1]);
    assert.deepEqual(updated.shots.map((shot) => shot.prompt), ["B", "A"]);
    for (const shot of updated.shots) assert.match(shot.id, UUID_PATTERN);
    assert.equal(updated.shots[1].capabilityId, "video.text-to-video");
    assert.deepEqual(plain(updated.shots[1].params), { duration: 5 });

    const [firstShot, secondShot] = updated.shots;
    const replaced = await store.updateSceneShots(scene.id, [
        { id: secondShot.id, prompt: "A2" },
        { id: firstShot.id, prompt: "B2" },
    ]);
    assert.deepEqual(plain(replaced.shots.map((shot) => shot.id)), [secondShot.id, firstShot.id]);
    assert.deepEqual(replaced.shots.map((shot) => shot.order), [0, 1]);
    assert.deepEqual(replaced.shots.map((shot) => shot.prompt), ["A2", "B2"]);

    const before = await fs.readFile(sceneFile(dir, "opening"), "utf8");
    await assert.rejects(store.updateSceneShots(scene.id, [{ id: firstShot.id }, { id: firstShot.id }]), /ERR_LIBRARY_INVALID/);
    await assert.rejects(store.updateSceneShots(scene.id, [{ id: "bad-id" }]), /ERR_LIBRARY_INVALID/);
    assert.equal(await fs.readFile(sceneFile(dir, "opening"), "utf8"), before);
    await assert.rejects(store.updateSceneShots(UUID_TWO, []), /ERR_LIBRARY_NOT_FOUND/);
});

test("deleteScene moves the folder into library trash and reports unknown ids", async (t) => {
    const { dir, store } = await harness(t);
    const media = path.join(dir, "uploads", "asset_reference_1.png");
    await fs.mkdir(path.dirname(media), { recursive: true });
    await fs.writeFile(media, "synthetic media bytes", "utf8");
    const scene = await store.createScene("Opening");
    await store.addShot(scene.id, { prompt: "First", assetIds: ["asset_reference_1"] });

    assert.equal(await store.deleteScene(scene.id), true);
    assert.equal(await fs.access(path.join(dir, "library", "scenes", "opening")).then(() => true, () => false), false);
    const trash = path.join(dir, "library", ".trash", "scenes");
    const entries = await fs.readdir(trash);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^opening-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    const trashed = JSON.parse(await fs.readFile(path.join(trash, entries[0], "scene.json"), "utf8"));
    assert.equal(trashed.id, scene.id);
    assert.equal(trashed.shots.length, 1);
    assert.equal(await fs.readFile(media, "utf8"), "synthetic media bytes");

    assert.equal(await store.readScene(scene.id), undefined);
    assert.deepEqual(plain(await store.listScenes()), []);
    assert.equal(await store.deleteScene(scene.id), false);
    assert.equal(await store.deleteScene(UUID_TWO), false);
});

test("scene routes list, create, read, patch and delete with library error codes", async (t) => {
    const { listRoute, itemRoute } = await harness(t);

    const empty = await listRoute.GET(apiRequest("/api/scenes"));
    assert.equal(empty.status, 200);
    assert.deepEqual(plain(await empty.json()), { scenes: [], count: 0 });

    const created = await listRoute.POST(apiRequest("/api/scenes", "POST", { name: "Opening" }));
    assert.equal(created.status, 201);
    const { scene } = await created.json();
    assert.equal(scene.slug, "opening");
    assert.equal(scene.name, "Opening");
    assert.deepEqual(scene.shots, []);

    const withShots = await listRoute.POST(apiRequest("/api/scenes", "POST", {
        name: "Opening Two",
        shots: [{ prompt: "First" }, { id: UUID_ONE, prompt: "Second", params: { seed: 3 } }],
    }));
    assert.equal(withShots.status, 201);
    const shotScene = (await withShots.json()).scene;
    assert.equal(shotScene.shots.length, 2);
    assert.deepEqual(shotScene.shots.map((shot) => shot.order), [0, 1]);
    assert.equal(shotScene.shots[1].id, UUID_ONE);

    const invalidBody = await listRoute.POST(apiRequest("/api/scenes", "POST", { name: "" }));
    assert.equal(invalidBody.status, 400);
    assert.equal((await invalidBody.json()).error, "ERR_LIBRARY_INVALID");
    const invalidShots = await listRoute.POST(apiRequest("/api/scenes", "POST", { name: "Bad", shots: "nope" }));
    assert.equal(invalidShots.status, 400);
    assert.equal((await invalidShots.json()).error, "ERR_LIBRARY_INVALID");
    const noContentType = await listRoute.POST(new Request("http://localhost:3120/api/scenes", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:3120", host: "127.0.0.1:3120", "sec-fetch-site": "same-origin" },
    }));
    assert.equal(noContentType.status, 415);
    assert.equal((await noContentType.json()).error, "ERR_CONTENT_TYPE");
    const forbidden = await listRoute.POST(new Request("http://localhost:3120/api/scenes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Cross Site" }),
    }));
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error, "ERR_ORIGIN_FORBIDDEN");

    const filtered = await listRoute.GET(apiRequest("/api/scenes?q=opening"));
    assert.equal(filtered.status, 200);
    const filteredPayload = await filtered.json();
    assert.equal(filteredPayload.count, 2);
    const tooLong = await listRoute.GET(apiRequest(`/api/scenes?q=${"x".repeat(121)}`));
    assert.equal(tooLong.status, 400);
    assert.equal((await tooLong.json()).error, "ERR_LIBRARY_INVALID");

    const read = await itemRoute.GET(apiRequest(`/api/scenes/${scene.id}`), context(scene.id));
    assert.equal(read.status, 200);
    assert.equal((await read.json()).scene.id, scene.id);

    const patched = await itemRoute.PATCH(apiRequest(`/api/scenes/${scene.id}`, "PATCH", {
        shots: [{ prompt: "Second", order: 12 }, { prompt: "First", order: 2 }],
    }), context(scene.id));
    assert.equal(patched.status, 200);
    const patchedScene = (await patched.json()).scene;
    assert.deepEqual(patchedScene.shots.map((shot) => shot.order), [0, 1]);
    assert.deepEqual(patchedScene.shots.map((shot) => shot.prompt), ["Second", "First"]);

    const patchWithoutShots = await itemRoute.PATCH(apiRequest(`/api/scenes/${scene.id}`, "PATCH", { name: "Nope" }), context(scene.id));
    assert.equal(patchWithoutShots.status, 400);
    assert.equal((await patchWithoutShots.json()).error, "ERR_LIBRARY_INVALID");

    const missing = await itemRoute.GET(apiRequest(`/api/scenes/${UUID_TWO}`), context(UUID_TWO));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "ERR_LIBRARY_NOT_FOUND");
    const patchMissing = await itemRoute.PATCH(apiRequest(`/api/scenes/${UUID_TWO}`, "PATCH", { shots: [] }), context(UUID_TWO));
    assert.equal(patchMissing.status, 404);
    assert.equal((await patchMissing.json()).error, "ERR_LIBRARY_NOT_FOUND");

    const deleted = await itemRoute.DELETE(apiRequest(`/api/scenes/${scene.id}`, "DELETE"), context(scene.id));
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).ok, true);
    const deleteMissing = await itemRoute.DELETE(apiRequest(`/api/scenes/${UUID_TWO}`, "DELETE"), context(UUID_TWO));
    assert.equal(deleteMissing.status, 404);
    assert.equal((await deleteMissing.json()).error, "ERR_LIBRARY_NOT_FOUND");
    const gone = await itemRoute.GET(apiRequest(`/api/scenes/${scene.id}`), context(scene.id));
    assert.equal(gone.status, 404);
});
