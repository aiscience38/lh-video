import assert from "node:assert/strict";
import test from "node:test";
import { createModuleLoader } from "./test-module-loader.mjs";

/**
 * Gallery-to-Library client helpers: the exact PATCH payloads the picker sends
 * must append without duplicating and must not drop storyboard panel fields.
 */

const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
    const calls = [];
    const responses = [];
    const loader = createModuleLoader({
        globals: {
            fetch: async (url, init) => {
                calls.push({ url, init });
                const next = responses.shift();
                assert.ok(next, `unexpected fetch ${url}`);
                return { ok: (next.status ?? 200) < 400, status: next.status ?? 200, json: async () => next.body };
            },
        },
    });
    return { actions: loader.load("src/features/tasks/lib/library-actions.ts"), calls, responses };
}

const shot = (id, order, extra = {}) => ({ id, order, intent: "", seconds: 3, keyframeAssetId: null, camera: "", ...extra });
const character = (id, name, assetIds) => ({ id, kind: "character", name, slug: name.toLowerCase(), notes: "", assetIds, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
const storyboard = (id, name, shots) => ({ id, kind: "storyboard", name, slug: name.toLowerCase(), productionId: null, shots, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });

test("appendAssetIds keeps the existing order and never duplicates an id", () => {
    const { actions } = harness();
    assert.deepEqual(plain(actions.appendAssetIds([], ["a"])), ["a"]);
    assert.deepEqual(plain(actions.appendAssetIds(["a"], ["a", "b", "b", "c"])), ["a", "b", "c"]);
    assert.deepEqual(plain(actions.appendAssetIds(["seed"], [])), ["seed"]);
});

test("replaceShotKeyframe touches only the chosen panel and rejects an out-of-range index", () => {
    const { actions } = harness();
    const shots = [shot("shot-a", 0, { intent: "Wide", camera: "24mm" }), shot("shot-b", 1, { seconds: 2 })];
    const next = actions.replaceShotKeyframe(shots, 1, "asset_new");
    assert.equal(next[1].keyframeAssetId, "asset_new");
    assert.deepEqual(plain(next[0]), shots[0]);
    assert.equal(shots[1].keyframeAssetId, null, "the input is not mutated");
    for (const index of [-1, 2, 1.5]) {
        assert.throws(() => actions.replaceShotKeyframe(shots, index, "asset_new"),
            error => error.code === "ERR_LIBRARY_INVALID");
    }
});

test("listing characters ignores other kinds and appending sends one ordered PATCH", async () => {
    const { actions, calls, responses } = harness();
    responses.push({ body: { entities: [
        character("character-1", "Ana", ["asset_seed"]),
        storyboard("storyboard-1", "Teaser", [shot("shot-a", 0)]),
    ], count: 2 } });
    const characters = await actions.listCharacterOptions();
    assert.deepEqual(plain(characters.map(item => item.id)), ["character-1"]);
    assert.match(calls[0].url, /\/api\/library\?kind=character$/);

    responses.push({ body: { entity: character("character-1", "Ana", ["asset_seed", "gallery-a", "gallery-b"]) } });
    const updated = await actions.addImagesToCharacter(characters[0], ["gallery-a", "gallery-b"]);
    assert.deepEqual(plain(updated.assetIds), ["asset_seed", "gallery-a", "gallery-b"]);
    assert.equal(calls[1].url, "/api/library/character/character-1");
    assert.equal(calls[1].init.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[1].init.body), { assetIds: ["asset_seed", "gallery-a", "gallery-b"] });
});

test("a keyframe PATCH rewrites the panel list without losing panel metadata", async () => {
    const { actions, calls, responses } = harness();
    responses.push({ body: { entities: [
        storyboard("storyboard-1", "Teaser", [shot("shot-a", 0, { intent: "Wide", camera: "24mm" }), shot("shot-b", 1, { intent: "Close", seconds: 2 }) ]),
        storyboard("storyboard-empty", "Empty", []),
    ], count: 2 } });
    const boards = await actions.listStoryboardOptions();
    assert.deepEqual(plain(boards.map(item => item.id)), ["storyboard-1", "storyboard-empty"]);

    responses.push({ body: { entity: storyboard("storyboard-1", "Teaser", [shot("shot-a", 0, { intent: "Wide", camera: "24mm" }), shot("shot-b", 1, { intent: "Close", seconds: 2, keyframeAssetId: "gallery-b" })]) } });
    await actions.setStoryboardKeyframe(boards[0], 1, "gallery-b");
    const body = JSON.parse(calls[1].init.body);
    assert.equal(calls[1].url, "/api/library/storyboard/storyboard-1");
    assert.deepEqual(body.shots.map(item => item.keyframeAssetId), [null, "gallery-b"]);
    assert.deepEqual(body.shots[0], shot("shot-a", 0, { intent: "Wide", camera: "24mm" }));
});

test("a refused PATCH surfaces the library error code", async () => {
    const { actions, responses } = harness();
    responses.push({ body: { entities: [character("character-1", "Ana", [])], count: 1 } });
    const [ana] = await actions.listCharacterOptions();
    responses.push({ status: 409, body: { error: "ERR_LIBRARY_CONFLICT" } });
    await assert.rejects(actions.addImagesToCharacter(ana, ["gallery-a"]),
        error => error.code === "ERR_LIBRARY_CONFLICT" && error.status === 409);
});
