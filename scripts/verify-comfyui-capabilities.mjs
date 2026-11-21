import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModuleLoader } from "./test-module-loader.mjs";

// LAM-21: the runtime catalog and the adapter declarations must agree. A model
// may not render a control that its adapter silently drops; the derived matrix
// is also compared with docs/providers/parity.md so the table cannot drift.
const ROW_PROVIDERS = {
    magnific: "magnific",
    google: "google-ai-studio",
    vertex: "google-vertex",
    "ai-gateway": "vercel-ai-gateway",
    toapis: "toapis",
    runware: "runware",
    comfyui: "comfyui",
};

function fixture() {
    const loader = createModuleLoader({
        env: { NODE_ENV: "development", PROVIDER_CONFIG_ENCRYPTION_KEY: "synthetic-provider-config-key-32-characters" },
        mocks: { "next/server": { NextResponse: Response } },
        globals: { fetch: async (url, init = {}) => { throw new Error(`unexpected fetch ${init.method ?? "GET"} ${url}`); } },
    });
    return { loader, load: loader.load };
}

async function storage(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "open-higgsfield-capabilities-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

function label(value) {
    return value.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

function verdict(cell) {
    const text = label(cell).toLowerCase();
    if (text.startsWith("model-dependent")) return "model-dependent";
    return text.split(/[ (—]/)[0];
}

function summarize(entries) {
    const videoCaps = entries.filter(entry => entry.mediaType === "video");
    const has = predicate => entries.some(predicate);
    const nativeAudio = videoCaps.filter(entry => entry.controls.some(control => control.id === "native_audio")).length;
    const multiShot = videoCaps.filter(entry => entry.controls.some(control => control.id === "multi_shot")).length;
    const coverage = count => count === 0 ? "no" : count === videoCaps.length && videoCaps.length > 0 ? "yes" : "model-dependent";
    return {
        image: has(entry => entry.mediaType === "image") ? "yes" : "no",
        video: videoCaps.length > 0 ? "yes" : "no",
        imageRefs: has(entry => entry.capability.media_slots.some(slot => slot.kind === "image")) ? "yes" : "no",
        videoRefs: has(entry => entry.capability.media_slots.some(slot => slot.kind === "video")) ? "yes" : "no",
        audioRefs: has(entry => entry.capability.media_slots.some(slot => slot.kind === "audio")) ? "yes" : "no",
        nativeAudio: coverage(nativeAudio),
        multiShot: coverage(multiShot),
        counts: { videoCaps: videoCaps.length, nativeAudio, multiShot },
    };
}

test("every runtime capability declares only controls its adapter translates (multi-shot and native audio included)", async t => {
    const directory = await storage(t);
    const f = fixture();
    Object.assign(f.loader.context.process.env, { OPEN_HIGGSFIELD_STORAGE_DIR: directory });
    const runtime = f.load("@/server/catalog/runtime");
    const support = f.load("@/server/catalog/adapter-support");
    const [images, videos] = await Promise.all([runtime.getAllRuntimeCapabilities("image"), runtime.getAllRuntimeCapabilities("video")]);
    const entries = [
        ...images.map(capability => ({ capability, mediaType: "image" })),
        ...videos.map(capability => ({ capability, mediaType: "video" })),
    ];
    assert.ok(entries.length > 300, "the complete runtime catalog must be loaded");

    const providers = new Set();
    const failures = [];
    const unclassified = [];
    for (const entry of entries) {
        const { capability } = entry;
        const adapter = support.ADAPTER_SUPPORT[capability.provider];
        assert.ok(adapter, `${capability.id}: no adapter support declaration for ${capability.provider}`);
        providers.add(capability.provider);
        const controls = support.declaredControls(capability);
        for (const control of controls) {
            if (control.id === "multi_shot" || control.id === "native_audio") continue;
            if (!adapter.controls.includes(control.id)) failures.push(`${capability.id} (${capability.provider}) declares ${control.id} via ${control.source}`);
        }
        if (controlNeeds(controls, "multi_shot") && !adapter.multiShot) failures.push(`${capability.id} declares multi-shot but the adapter does not`);
        if (controlNeeds(controls, "native_audio") && !adapter.nativeAudio) failures.push(`${capability.id} declares native audio but the adapter does not`);
        // A vendor field that looks like audio/multi-shot must be classified, so a
        // new contract field cannot quietly bypass the audit.
        for (const field of capability.custom_fields) {
            if (support.UNCLASSIFIED_AUDIO.test(field.id) && !support.NATIVE_AUDIO_FIELDS.has(field.id)) unclassified.push(`${capability.id}: audio field ${field.id}`);
            if (support.UNCLASSIFIED_MULTI_SHOT.test(field.id) && !support.MULTI_SHOT_FIELDS.has(field.id)) unclassified.push(`${capability.id}: multi-shot field ${field.id}`);
        }
    }
    assert.deepEqual(failures, [], `Controls declared without adapter support:\n${failures.join("\n")}`);
    assert.deepEqual(unclassified, [], `Unclassified audio/multi-shot fields:\n${unclassified.join("\n")}`);
    assert.deepEqual([...providers].sort(), Object.keys(support.ADAPTER_SUPPORT).sort(), "every provider in the runtime catalog has exactly one declaration");
    function controlNeeds(list, id) { return list.some(control => control.id === id); }

    // LAM-21 pins for the v1 target: the image-only ComfyUI adapter exposes no
    // multi-shot or native-audio control and no audio/video media slot.
    const comfy = entries.filter(entry => entry.capability.provider === "comfyui");
    assert.ok(comfy.length >= 1);
    for (const { capability } of comfy) {
        const ids = support.declaredControls(capability).map(control => control.id);
        assert.equal(ids.includes("multi_shot"), false, capability.id);
        assert.equal(ids.includes("native_audio"), false, capability.id);
        assert.equal(ids.includes("video_slot"), false, capability.id);
        assert.equal(ids.includes("audio_slot"), false, capability.id);
    }
});

test("docs/providers/parity.md matches the matrix derived from the runtime catalog", async t => {
    const directory = await storage(t);
    const f = fixture();
    Object.assign(f.loader.context.process.env, { OPEN_HIGGSFIELD_STORAGE_DIR: directory });
    const runtime = f.load("@/server/catalog/runtime");
    const support = f.load("@/server/catalog/adapter-support");
    const [images, videos] = await Promise.all([runtime.getAllRuntimeCapabilities("image"), runtime.getAllRuntimeCapabilities("video")]);
    const rows = new Map();
    for (const entry of [...images.map(capability => ({ capability, mediaType: "image" })), ...videos.map(capability => ({ capability, mediaType: "video" }))]) {
        const list = rows.get(entry.capability.provider) ?? [];
        list.push({ ...entry, controls: support.declaredControls(entry.capability) });
        rows.set(entry.capability.provider, list);
    }

    const markdown = await fs.readFile(new URL("../docs/providers/parity.md", import.meta.url), "utf8");
    const table = markdown.split("\n").map(line => line.trim()).filter(line => line.startsWith("|")).map(line => line.split("|").slice(1, -1).map(cell => cell.trim()));
    const header = table.findIndex(cells => cells[0] === "Provider");
    assert.ok(header >= 0, "parity.md must contain the provider table");
    assert.deepEqual(table[header].slice(1).map(label), ["Image", "Video", "Image refs", "Video refs", "Audio refs", "Native audio", "Multi-shot", "v1 validation"]);
    const data = table.slice(header + 2);
    const seen = new Set();
    const mismatches = [];
    for (const cells of data) {
        if (cells.length !== 9) continue;
        const matched = /^`([^`]+)`/.exec(label(cells[0]));
        if (!matched) continue;
        const providerId = ROW_PROVIDERS[matched[1]];
        assert.ok(providerId, `unexpected provider row ${matched[1]}`);
        assert.equal(seen.has(providerId), false, `duplicate row for ${providerId}`);
        seen.add(providerId);
        const entries = rows.get(providerId) ?? [];
        assert.ok(entries.length, `${providerId} is in parity.md but not in the runtime catalog`);
        const expected = summarize(entries);
        const actual = {
            image: verdict(cells[1]), video: verdict(cells[2]), imageRefs: verdict(cells[3]), videoRefs: verdict(cells[4]),
            audioRefs: verdict(cells[5]), nativeAudio: verdict(cells[6]), multiShot: verdict(cells[7]),
        };
        for (const key of Object.keys(actual)) {
            if (actual[key] !== expected[key]) mismatches.push(`${providerId}.${key}: parity.md says ${actual[key]}, catalog derives ${expected[key]}`);
        }
        if (providerId === "comfyui") {
            assert.equal(expected.video, "no");
            assert.equal(expected.nativeAudio, "no");
            assert.equal(expected.multiShot, "no");
        }
    }
    assert.deepEqual([...seen].sort(), [...rows.keys()].sort(), "every runtime provider has a parity.md row");
    assert.deepEqual(mismatches, [], `parity.md is stale:\n${mismatches.join("\n")}`);
});

test("a hypothetical capability that declares an unsupported control is rejected by the matrix", async () => {
    const f = fixture();
    const support = f.load("@/server/catalog/adapter-support");
    const base = {
        id: "synthetic:test", label: "Synthetic", family: "Synthetic", variant: "Synthetic", group: "Synthetic",
        provider: "comfyui", provider_model_id: "qwen-t2i", prompt_required: true, prompt_supported: true,
        duration: false, aspect_ratio: false, size: false, resolution_variant: false,
        negative_prompt: false, cfg_scale: false, style: false, shot_type: true, prompt_expansion: false, elements: false,
        media_slots: [], custom_fields: [], has_edit_variant: false,
    };
    const controls = support.declaredControls(base).map(control => control.id);
    assert.ok(controls.includes("shot_type"));
    assert.ok(controls.includes("multi_shot"));
    const adapter = support.ADAPTER_SUPPORT.comfyui;
    assert.equal(adapter.controls.includes("shot_type"), false);
    assert.equal(adapter.multiShot, false);

    const audio = { ...base, shot_type: false, custom_fields: [{ id: "generate_audio", label: "Audio", type: "checkbox" }] };
    assert.ok(support.declaredControls(audio).some(control => control.id === "native_audio"));
    assert.equal(adapter.nativeAudio, false);
});
