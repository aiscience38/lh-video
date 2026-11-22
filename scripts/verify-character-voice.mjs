import assert from "node:assert/strict";
import test from "node:test";
import { createModuleLoader } from "./test-module-loader.mjs";

const CHARACTER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

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

const plain = value => JSON.parse(JSON.stringify(value));
const contract = createModuleLoader().load("@/server/library/contract");
const defaults = { provider: "none", voiceId: null, language: "en", settings: {}, previewAssetId: null };

test("characters without a voice field parse with the complete default profile", () => {
    const character = contract.characterSchema.parse(characterFixture);
    assert.deepEqual(plain(character.voice), defaults);
    assert.equal(character.notes, "Lead", "existing fields stay intact");
    assert.deepEqual(plain(character.assetIds), ["asset_reference_1"]);
    assert.equal(character.ingredientKind, "character", "existing ingredient default stays intact");
    assert.deepEqual(plain(contract.libraryEntitySchema.parse(characterFixture).voice), defaults);
});

test("create input defaults voice to none and accepts a partial voice object", () => {
    const created = contract.characterCreateSchema.parse({ name: "Ana" });
    assert.deepEqual(plain(created.voice), defaults);

    const partial = contract.characterCreateSchema.parse({ name: "Ana", voice: { provider: "elevenlabs" } });
    assert.deepEqual(plain(partial.voice), { ...defaults, provider: "elevenlabs" });

    const explicit = contract.characterCreateSchema.parse({
        name: "Ana",
        voice: { provider: "comfyui", voiceId: "voice_ana", language: "es", settings: { speed: 1.1 }, previewAssetId: "asset_preview_1" },
    });
    assert.deepEqual(plain(explicit.voice), {
        provider: "comfyui", voiceId: "voice_ana", language: "es", settings: { speed: 1.1 }, previewAssetId: "asset_preview_1",
    });
});

test("a stored voice profile round-trips every field", () => {
    const character = contract.characterSchema.parse({
        ...characterFixture,
        voice: { provider: "elevenlabs", voiceId: "voice_ana", language: "pt-BR", settings: { stability: 0.4 }, previewAssetId: "asset_preview_2" },
    });
    assert.deepEqual(plain(character.voice), {
        provider: "elevenlabs", voiceId: "voice_ana", language: "pt-BR", settings: { stability: 0.4 }, previewAssetId: "asset_preview_2",
    });
});

test("unknown providers and malformed voice fields are rejected", () => {
    const rejects = (schema, value) => assert.equal(schema.safeParse(value).success, false, JSON.stringify(value));
    for (const provider of ["azure", "ELEVENLABS", "", 42]) {
        rejects(contract.characterSchema, { ...characterFixture, voice: { provider } });
        rejects(contract.characterCreateSchema, { name: "Ana", voice: { provider } });
        rejects(contract.characterUpdateSchema, { voice: { provider, voiceId: null, language: "en", settings: {}, previewAssetId: null } });
    }
    rejects(contract.characterSchema, { ...characterFixture, voice: { provider: "none", language: "" } });
    rejects(contract.characterSchema, { ...characterFixture, voice: { provider: "none", language: "x".repeat(36) } });
    rejects(contract.characterSchema, { ...characterFixture, voice: { provider: "none", voiceId: "x".repeat(129) } });
    rejects(contract.characterSchema, { ...characterFixture, voice: { provider: "none", voiceId: "" } });
    rejects(contract.characterSchema, { ...characterFixture, voice: { provider: "none", settings: [] } });
    rejects(contract.characterSchema, { ...characterFixture, voice: { provider: "none", previewAssetId: "../escape" } });
    assert.equal(contract.voiceProfileSchema.safeParse({ provider: "elevenlabs" }).success, true);
    assert.equal(contract.characterSchema.safeParse({ ...characterFixture, voice: "none" }).success, false);
});

test("update replaces the whole profile without defaults and is optional", () => {
    const voice = { provider: "comfyui", voiceId: "voice_ana", language: "fr", settings: { speed: 1 }, previewAssetId: "asset_preview_3" };
    const update = contract.characterUpdateSchema.parse({ voice });
    assert.deepEqual(plain(update.voice), voice);

    assert.equal(contract.characterUpdateSchema.safeParse({ voice: { provider: "comfyui" } }).success, false, "update voice has no defaults");
    assert.equal(contract.characterUpdateSchema.parse({ name: "Ana" }).voice, undefined, "voice is optional");
    assert.equal(contract.characterUpdateSchema.safeParse({ voice: { ...voice, provider: "azure" } }).success, false);

    const withoutDefaults = contract.characterUpdateSchema.parse({ voice: { provider: "comfyui", voiceId: "v", language: "en", settings: {}, previewAssetId: null } });
    assert.deepEqual(plain(withoutDefaults.voice), { provider: "comfyui", voiceId: "v", language: "en", settings: {}, previewAssetId: null });
});
