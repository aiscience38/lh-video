import assert from "node:assert/strict";
import test from "node:test";
import { createModuleLoader } from "./test-module-loader.mjs";

const modules = createModuleLoader();
const selection = modules.load("src/models/reference-selection.ts");
const referenceAssets = modules.load("src/features/library/lib/reference-assets.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const SLOTS = [
    { id: "start_image", label: "Start frame", kind: "image", max_count: 1 },
    { id: "reference_images", label: "Reference images", kind: "image", multiple: true, max_count: 3 },
    { id: "input_video", label: "Reference video", kind: "video", max_count: 1 },
];
const ana = (assetIds) => ({ entityId: "c1", entityName: "Ana", libraryKind: "character", assetIds });

test("slot capacity uses max_count first and honours single/multiple slots", () => {
    assert.equal(selection.slotCapacity({ id: "a", label: "A", kind: "image" }), 1);
    assert.equal(selection.slotCapacity({ id: "a", label: "A", kind: "image", multiple: true }), 256);
    assert.equal(selection.slotCapacity({ id: "a", label: "A", kind: "image", multiple: true, max_count: 30 }), 30);
    assert.equal(selection.slotCapacity({ id: "a", label: "A", kind: "image", max_count: 0 }), 0);
});

test("library images fill ordinary reference slots before frame slots", () => {
    const result = selection.resolveReferenceAssets([ana(["asset_a", "asset_b"])], SLOTS);
    assert.deepEqual(plain(result.assignments), [
        { slotId: "reference_images", slotLabel: "Reference images", assetId: "asset_a", entityId: "c1", entityName: "Ana" },
        { slotId: "reference_images", slotLabel: "Reference images", assetId: "asset_b", entityId: "c1", entityName: "Ana" },
    ]);
    assert.deepEqual(plain(result.refused), []);
    // Frame slots stay available for explicit start/end frames.
    const framesOnly = selection.resolveReferenceAssets([ana(["asset_c"])], [SLOTS[0]]);
    assert.equal(framesOnly.assignments[0].slotId, "start_image");
    // Video slots never receive library images.
    const videoOnly = selection.resolveReferenceAssets([ana(["asset_a"])], [SLOTS[2]]);
    assert.deepEqual(plain(videoOnly.assignments), []);
    assert.deepEqual(plain(videoOnly.refused), [
        { assetId: "asset_a", entityId: "c1", entityName: "Ana", reason: "unsupported" },
    ]);
});

test("occupancy is subtracted and overflow is refused with a capacity reason", () => {
    const referenceOnly = [{ id: "reference_images", label: "Reference images", kind: "image", multiple: true, max_count: 3 }];
    const result = selection.resolveReferenceAssets(
        [ana(["asset_a", "asset_b", "asset_c", "asset_d"])],
        referenceOnly,
        { reference_images: 2 },
    );
    assert.deepEqual(plain(result.assignments.map((item) => item.assetId)), ["asset_a"]);
    assert.deepEqual(plain(result.refused.map((item) => item.reason)), ["capacity", "capacity", "capacity"]);
    assert.equal(result.refused.length, 3);

    const full = selection.resolveReferenceAssets([ana(["asset_a"])], referenceOnly, { reference_images: 3 });
    assert.deepEqual(plain(full.assignments), []);
    assert.equal(full.refused[0].reason, "capacity");
    // A free frame slot still takes overflow before it is refused.
    const withFrame = selection.resolveReferenceAssets([ana(["asset_a", "asset_b"])], SLOTS, { reference_images: 3 });
    assert.deepEqual(plain(withFrame.assignments.map((item) => item.slotId)), ["start_image"]);
});

test("invalid ids and repeated assets are refused instead of silently dropped", () => {
    const result = selection.resolveReferenceAssets([ana(["not a valid id", "asset_ok", "asset_ok"])], SLOTS);
    assert.deepEqual(plain(result.assignments.map((item) => item.assetId)), ["asset_ok"]);
    assert.deepEqual(plain(result.refused.map((item) => item.reason)), ["invalid", "duplicate"]);
    assert.equal(result.refused[1].assetId, "asset_ok");

    const empty = selection.resolveReferenceAssets([ana([""])], SLOTS);
    assert.equal(empty.refused[0].reason, "invalid");
    assert.equal(selection.countSourceAssets([ana(["a", "b"])]), 2);
});

test("multiple entities keep their attribution in every assignment and refusal", () => {
    const referenceOnly = [{ id: "reference_images", label: "Reference images", kind: "image", multiple: true, max_count: 3 }];
    const result = selection.resolveReferenceAssets([
        { entityId: "c1", entityName: "Ana", libraryKind: "character", assetIds: ["asset_a", "asset_b"] },
        { entityId: "s1", entityName: "Rooftop", libraryKind: "scene", assetIds: ["asset_c", "asset_d"] },
    ], referenceOnly, {});
    assert.deepEqual(plain(result.assignments.map((item) => [item.entityName, item.assetId])), [
        ["Ana", "asset_a"], ["Ana", "asset_b"], ["Rooftop", "asset_c"],
    ]);
    assert.deepEqual(plain(result.refused.map((item) => [item.entityName, item.reason])), [
        ["Rooftop", "capacity"],
    ]);
});

test("library entries contribute their saved images, shots and keyframes once each", () => {
    const stamp = "2026-11-01T00:00:00.000Z";
    assert.deepEqual(plain(referenceAssets.libraryAssetIds({
        id: "c1", kind: "character", name: "Ana", slug: "ana", notes: "", assetIds: ["asset_a", "asset_a", "asset_b"], createdAt: stamp, updatedAt: stamp,
    })), ["asset_a", "asset_b"]);
    assert.deepEqual(plain(referenceAssets.libraryAssetIds({
        id: "s1", kind: "scene", name: "Rooftop", slug: "rooftop",
        shots: [{ assetIds: ["asset_c", "asset_d"] }, { assetIds: ["asset_d"] }, { assetIds: [] }, null, "ignored"],
        createdAt: stamp, updatedAt: stamp,
    })), ["asset_c", "asset_d"]);
    assert.deepEqual(plain(referenceAssets.libraryAssetIds({
        id: "b1", kind: "storyboard", name: "Board", slug: "board", productionId: null,
        shots: [{ keyframeAssetId: "asset_e" }, { keyframeAssetId: null }, { keyframeAssetId: "asset_e" }],
        createdAt: stamp, updatedAt: stamp,
    })), ["asset_e"]);
    assert.deepEqual(plain(referenceAssets.libraryAssetIds({
        id: "b2", kind: "storyboard", name: "Empty", slug: "empty", productionId: null, shots: [], createdAt: stamp, updatedAt: stamp,
    })), []);
});

test("refusal copy points at picker messages with plain-language arguments", () => {
    const cases = [
        [{ assetId: "a", entityId: "c1", entityName: "Ana", reason: "unsupported" }, { key: "refusalUnsupported", values: { capability: "Seedance 2.5" } }],
        [{ assetId: "a", entityId: "c1", entityName: "Ana", reason: "capacity" }, { key: "refusalCapacity", values: { name: "Ana", capability: "Seedance 2.5" } }],
        [{ assetId: "a", entityId: "c1", entityName: "Ana", reason: "invalid" }, { key: "refusalInvalid", values: { name: "Ana", asset: "a" } }],
        [{ assetId: "a", entityId: "c1", entityName: "Ana", reason: "duplicate" }, { key: "refusalDuplicate", values: { name: "Ana" } }],
    ];
    for (const [refusal, expected] of cases) {
        assert.deepEqual(plain(selection.referenceRefusalCopy(refusal, "Seedance 2.5")), expected);
    }
});
