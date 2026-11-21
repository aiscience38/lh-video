import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModuleLoader } from "./test-module-loader.mjs";

const CHARACTER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SCENE_ID = "9c5b94b1-35ad-49bb-b118-8e8fc24abf80";
const SHOT_ONE = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const SHOT_TWO = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const STORYBOARD_ID = "6ba7b811-9dad-41d1-80b4-00c04fd430c8";

const characterFixture = {
    id: CHARACTER_ID,
    kind: "character",
    name: "Ana",
    slug: "ana",
    notes: "Lead",
    assetIds: ["asset_reference_1"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
};

const sceneFixture = {
    id: SCENE_ID,
    kind: "scene",
    name: "Opening",
    slug: "opening",
    shots: [
        { id: SHOT_ONE, order: 0, prompt: "Wide establishing shot", capabilityId: "image:test", params: { seed: 1 }, assetIds: ["asset_1"], taskIds: ["task_1"] },
        { id: SHOT_TWO, order: 1, prompt: "Close up", capabilityId: null, params: {}, assetIds: [], taskIds: [] },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
};

const storyboardFixture = {
    id: STORYBOARD_ID,
    kind: "storyboard",
    name: "Teaser",
    slug: "teaser",
    productionId: "production_1",
    shots: [
        { id: SHOT_ONE, order: 0, intent: "Reveal", seconds: 4, keyframeAssetId: "asset_key", camera: "Dolly in" },
        { id: SHOT_TWO, order: 1, intent: "Cut", seconds: 2.5, keyframeAssetId: null, camera: "" },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
};

const plain = (value) => JSON.parse(JSON.stringify(value));

async function harness(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "library-contract-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const env = { OPEN_HIGGSFIELD_STORAGE_DIR: dir, NODE_ENV: "development" };
    const loader = createModuleLoader({ env });
    return {
        dir,
        env,
        loader,
        contract: loader.load("@/server/library/contract"),
        atomic: loader.load("@/server/library/atomic"),
    };
}

test("slug rules reject traversal, separators, reserved names, trailing dots and empty values", async (t) => {
    const { contract } = await harness(t);
    for (const value of ["../x", "a/b", "a\\b", "CON", "con", "nul", "com1", "ana.", "Ana", "", "-ana", "a", "x".repeat(50), " ana"]) {
        assert.equal(contract.isValidSlug(value), false, `expected invalid slug: ${JSON.stringify(value)}`);
        assert.equal(contract.slugSchema.safeParse(value).success, false, `schema must reject ${JSON.stringify(value)}`);
    }
    for (const value of ["ana", "ana-2", "scene-01", "a0"]) {
        assert.equal(contract.isValidSlug(value), true, `expected valid slug: ${value}`);
        assert.equal(contract.slugSchema.parse(value), value);
    }
    assert.equal(contract.slugify("Ana María"), "ana-maria");
    assert.equal(contract.slugify("  --Hello, World!!  "), "hello-world");
    assert.equal(contract.slugify("CON"), "con");
    assert.equal(contract.slugify("李"), "");
    const long = contract.slugify("A".repeat(80));
    assert.equal(long.length, contract.MAX_SLUG_LENGTH);
    assert.equal(contract.isValidSlug(long), true);
    assert.equal(contract.slugify("Ana"), "ana", "slugify itself does not resolve collisions");
});

test("one canonical fixture per kind parses and applies documented defaults", async (t) => {
    const { contract } = await harness(t);
    const character = contract.libraryEntitySchema.parse({ id: CHARACTER_ID, kind: "character", name: "Ana", slug: "ana",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
    assert.equal(character.kind, "character");
    assert.equal(character.notes, "");
    assert.deepEqual(plain(character.assetIds), []);
    assert.equal(contract.characterSchema.parse(characterFixture).notes, "Lead");

    const scene = contract.sceneSchema.parse({ ...sceneFixture, shots: undefined });
    assert.deepEqual(plain(scene.shots), [], "a scene without shots defaults to an empty array");
    const shot = contract.sceneSchema.parse({ ...sceneFixture, shots: [{ id: SHOT_ONE, order: 0 }] }).shots[0];
    assert.equal(shot.prompt, "");
    assert.equal(shot.capabilityId, null);
    assert.deepEqual(plain(shot.params), {});
    assert.deepEqual(plain(shot.assetIds), []);
    assert.deepEqual(plain(shot.taskIds), []);

    const storyboard = contract.storyboardSchema.parse({ id: STORYBOARD_ID, kind: "storyboard", name: "Teaser", slug: "teaser",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
    assert.equal(storyboard.productionId, null);
    assert.deepEqual(plain(storyboard.shots), []);
    const panel = contract.storyboardSchema.parse({ ...storyboardFixture, shots: [{ id: SHOT_ONE, order: 0 }] }).shots[0];
    assert.equal(panel.intent, "");
    assert.equal(panel.seconds, 3);
    assert.equal(panel.keyframeAssetId, null);
    assert.equal(panel.camera, "");
    assert.deepEqual(contract.libraryEntitySchema.parse(sceneFixture).shots.length, 2);
    assert.deepEqual(contract.libraryEntitySchema.parse(storyboardFixture).shots.length, 2);
});

test("character ingredient roles default to character and reject unknown values", async (t) => {
    const { contract } = await harness(t);
    assert.equal(contract.characterSchema.parse(characterFixture).ingredientKind, "character");
    assert.equal(contract.characterSchema.parse({ ...characterFixture, ingredientKind: "prop" }).ingredientKind, "prop");
    assert.equal(contract.characterSchema.parse({ ...characterFixture, ingredientKind: "style" }).ingredientKind, "style");
    assert.equal(contract.characterCreateSchema.parse({ name: "Ana" }).ingredientKind, "character");
    assert.equal(contract.characterSchema.safeParse({ ...characterFixture, ingredientKind: "vehicle" }).success, false);
});

test("schema validation rejects wrong kinds, identifiers, names, timestamps and shot ranges", async (t) => {
    const { contract } = await harness(t);
    const rejects = (schema, value) => assert.equal(schema.safeParse(value).success, false);
    rejects(contract.characterSchema, { ...characterFixture, kind: "scene" });
    rejects(contract.characterSchema, { ...characterFixture, name: "" });
    rejects(contract.characterSchema, { ...characterFixture, name: "x".repeat(121) });
    rejects(contract.characterSchema, { ...characterFixture, notes: "x".repeat(4001) });
    rejects(contract.characterSchema, { ...characterFixture, id: "not-a-uuid" });
    rejects(contract.characterSchema, { ...characterFixture, createdAt: "yesterday" });
    rejects(contract.characterSchema, { ...characterFixture, assetIds: ["../escape"] });
    rejects(contract.characterSchema, { ...characterFixture, slug: "../x" });
    rejects(contract.sceneSchema, { ...sceneFixture, shots: [{ id: SHOT_ONE, order: -1 }] });
    rejects(contract.sceneSchema, { ...sceneFixture, shots: [{ id: SHOT_ONE, order: 0, assetIds: ["a/b"] }] });
    rejects(contract.storyboardSchema, { ...storyboardFixture, shots: [{ id: SHOT_ONE, order: 0, seconds: 0 }] });
    rejects(contract.storyboardSchema, { ...storyboardFixture, productionId: 42 });
    rejects(contract.storyboardSchema, { ...storyboardFixture, productionId: "" });
    assert.equal(contract.isLibraryKind("character"), true);
    assert.equal(contract.isLibraryKind("Character"), false);
    assert.equal(contract.isLibraryKind(undefined), false);
    assert.throws(() => contract.schemaForKind("video"), /ERR_LIBRARY_KIND/);
    assert.throws(() => contract.createSchemaFor("video"), /ERR_LIBRARY_KIND/);
});

test("atomic writes reject paths outside storage and never create the escaped file", async (t) => {
    const { dir, atomic } = await harness(t);
    const outside = path.join(dir, "..", `library-escape-${process.pid}.json`);
    await fs.rm(outside, { force: true });
    await assert.rejects(atomic.writeJsonAtomic(outside, { escaped: true }), /ERR_LIBRARY_INVALID/);
    await assert.rejects(atomic.readJson(outside, { parse: (value) => value }), /ERR_LIBRARY_INVALID/);
    assert.equal(await fs.access(outside).then(() => true, () => false), false);
    await assert.rejects(atomic.writeJsonAtomic(path.join(dir, "..", "..", "outside.json"), {}), /ERR_LIBRARY_INVALID/);
});

test("atomic writes reject a symlinked directory that escapes storage", async (t) => {
    const { dir, atomic } = await harness(t);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "library-outside-"));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    const link = path.join(dir, "library", "characters", "escape");
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(atomic.writeJsonAtomic(path.join(link, "character.json"), characterFixture), /ERR_LIBRARY_INVALID/);
    assert.equal(await fs.access(path.join(outside, "character.json")).then(() => true, () => false), false);
    await fs.writeFile(path.join(outside, "character.json"), JSON.stringify(characterFixture), "utf8");
    await assert.rejects(atomic.readJson(path.join(link, "character.json"), { parse: (value) => value }), /ERR_LIBRARY_INVALID/);
});

test("a failed atomic write leaves the previous document intact and cleans its temp file", async (t) => {
    const { dir, env, atomic, contract } = await harness(t);
    const target = path.join(dir, "library", "characters", "ana", "character.json");
    await atomic.writeJsonAtomic(target, characterFixture);

    await assert.rejects(atomic.writeJsonAtomic(target, { big: 1n }), /ERR_LIBRARY_INVALID/);
    assert.equal((await atomic.readJson(target, contract.characterSchema)).name, "Ana");

    const failing = createModuleLoader({
        env,
        mocks: {
            "node:fs/promises": {
                ...fs,
                rename: async () => { throw Object.assign(new Error("synthetic rename failure"), { code: "EPERM" }); },
            },
        },
    });
    await assert.rejects(failing.load("@/server/library/atomic").writeJsonAtomic(target, { ...characterFixture, name: "Tampered" }),
        /synthetic rename failure/);
    assert.equal((await atomic.readJson(target, contract.characterSchema)).name, "Ana");
    const leftovers = (await fs.readdir(path.dirname(target))).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
});

test("readJson distinguishes a missing document from corrupt or schema-invalid JSON", async (t) => {
    const { dir, atomic, contract } = await harness(t);
    const target = path.join(dir, "library", "characters", "ana", "character.json");
    await assert.rejects(atomic.readJson(target, contract.characterSchema), /ERR_LIBRARY_NOT_FOUND/);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "{not json", "utf8");
    await assert.rejects(atomic.readJson(target, contract.characterSchema), /ERR_LIBRARY_INVALID/);
    await fs.writeFile(target, JSON.stringify({ ...characterFixture, name: "" }), "utf8");
    await assert.rejects(atomic.readJson(target, contract.characterSchema), /ERR_LIBRARY_INVALID/);
    await fs.writeFile(target, JSON.stringify(characterFixture), "utf8");
    assert.equal((await atomic.readJson(target, contract.characterSchema)).slug, "ana");
});
