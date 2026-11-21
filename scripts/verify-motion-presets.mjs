import assert from "node:assert/strict";
import test from "node:test";
import { createModuleLoader } from "./test-module-loader.mjs";

const modules = createModuleLoader();
const catalog = modules.load("src/server/catalog/motion-presets.ts");
const motion = modules.load("src/models/motion-params.ts");

const REQUIRED_IDS = ["bullet-time", "crash-zoom", "dolly-in", "handheld", "orbit", "whip-pan"];
/** Module code runs in a vm context, so its objects are not realm-equal to host literals. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const BASE_CANONICAL = Object.freeze({
    model_id: "google-vertex__veo-3.1-generate-001",
    prompt: "A lighthouse on a cliff at dusk",
    duration: "8",
    aspect_ratio: "16:9",
    resolution: "1080p",
    seed: 42,
    expand_prompt: true,
    field_values: { generate_audio: true },
});
const EXPECTED_DURATION = Object.freeze({
    "bullet-time": "5",
    "crash-zoom": "4",
    "dolly-in": "6",
    handheld: "8",
    orbit: "6",
    "whip-pan": "4",
});

test("catalog exposes exactly the six camera presets with sorted ids and shared families", () => {
    assert.deepEqual(plain(catalog.MOTION_PRESETS_LIST.map((preset) => preset.id).sort()), REQUIRED_IDS);
    assert.deepEqual(plain(Object.keys(catalog.MOTION_PRESETS)).sort(), REQUIRED_IDS);
    for (const preset of catalog.MOTION_PRESETS_LIST) {
        assert.equal(preset.label.trim().length > 0, true, `${preset.id} label`);
        assert.equal(preset.promptFragment.trim().length > 0, true, `${preset.id} fragment`);
        assert.deepEqual(plain(preset.appliesTo), [...catalog.MOTION_FAMILY_TOKENS], `${preset.id} families`);
        assert.deepEqual(plain(Object.keys(preset.paramOverrides)), ["duration"], `${preset.id} overrides`);
        assert.equal(EXPECTED_DURATION[preset.id], preset.paramOverrides.duration);
        assert.equal(catalog.getMotionPreset(preset.id)?.id, preset.id);
    }
    assert.equal(catalog.getMotionPreset("does-not-exist"), undefined);
    // The API list is ordered by label so responses are stable across processes.
    assert.deepEqual(plain(catalog.MOTION_PRESETS_LIST.map((preset) => preset.label)), [
        "Bullet time", "Crash zoom", "Dolly in", "Handheld", "Orbit", "Whip pan",
    ]);
});

test("every preset merges into the exact canonical payload snapshot", () => {
    for (const preset of catalog.MOTION_PRESETS_LIST) {
        const merged = motion.applyMotionPreset(preset, BASE_CANONICAL);
        assert.deepEqual(plain(merged), { ...BASE_CANONICAL, duration: EXPECTED_DURATION[preset.id] });
        assert.equal(JSON.stringify(merged), JSON.stringify({ ...BASE_CANONICAL, duration: EXPECTED_DURATION[preset.id] }));
        // The caller's canonical payload is never mutated in place.
        assert.equal(BASE_CANONICAL.duration, "8");
    }
    assert.equal(
        JSON.stringify(motion.applyMotionPreset(catalog.getMotionPreset("dolly-in"), BASE_CANONICAL)),
        '{"model_id":"google-vertex__veo-3.1-generate-001","prompt":"A lighthouse on a cliff at dusk","duration":"6","aspect_ratio":"16:9","resolution":"1080p","seed":42,"expand_prompt":true,"field_values":{"generate_audio":true}}',
    );
    const withoutPreset = motion.applyMotionPreset(null, BASE_CANONICAL);
    assert.deepEqual(plain(withoutPreset), BASE_CANONICAL);
    assert.notEqual(withoutPreset, BASE_CANONICAL);
});

test("prompt composition appends the fragment with exactly one separating space", () => {
    for (const preset of catalog.MOTION_PRESETS_LIST) {
        assert.equal(motion.composeMotionPrompt(preset, "  A fox in snow  "), `A fox in snow ${preset.promptFragment}`);
        assert.equal(motion.composeMotionPrompt(preset, "   "), preset.promptFragment);
        assert.equal(motion.composeMotionPrompt(preset, ""), preset.promptFragment);
    }
    assert.equal(motion.composeMotionPrompt(null, "A fox"), "A fox");
    assert.equal(motion.composeMotionPrompt(undefined, "A fox"), "A fox");
});

test("family matching ignores case and separators and covers every catalog family shape", () => {
    assert.equal(motion.compactFamily("Seedance-2-5-Pro-480p"), "seedance25pro480p");
    for (const family of [
        "Veo", "Veo 3.1", "Veo-3-1-Fast", "Seedance", "Seedance-2-5-Pro-480p", "Kling", "Kling-V3-Pro",
        "KlingAI 2.5 Turbo Pro", "Wan", "Wan2.6", "Wan-V2-6-720p", "MiniMax Hailuo 2.3", "Hailuo-02-768p",
        "PixVerse V5", "Pixverse-V6-Transition", "Runway Gen-4.5", "Runway-Act-Two", "Vidu Q3", "Sora",
        "Grok Imagine Video 1.5", "LTX-2.5 Pro", "Ray3.2", "Midjourney", "P-Video-2-Pro", "SkyReels V4",
        "HappyHorse-1.0", "Gemini Omni", "google", "bytedance", "bfl", "alibaba", "minimax",
    ]) {
        assert.equal(motion.familySupportsMotion(catalog.MOTION_PRESETS_LIST, family), true, `${family} should support motion`);
    }
    for (const family of ["FLUX.2 [pro]", "Qwen-Image-3.0-Pro", "BiRefNet General", "Topaz Labs Proteus", "Bria Image Increase Resolution", "", "   "]) {
        assert.equal(motion.familySupportsMotion(catalog.MOTION_PRESETS_LIST, family), false, `${family} must not support motion`);
        assert.deepEqual(plain(catalog.getMotionPresetsForFamily(family)), []);
    }
    assert.deepEqual(
        plain(catalog.getMotionPresetsForFamily("Veo 3.1").map((preset) => preset.id).sort()),
        REQUIRED_IDS,
    );
    assert.equal(motion.motionPresetAppliesToFamily(catalog.MOTION_PRESETS.orbit, "Veo"), true);
    assert.equal(motion.motionPresetAppliesToFamily(catalog.MOTION_PRESETS.orbit, "Qwen"), false);
});
