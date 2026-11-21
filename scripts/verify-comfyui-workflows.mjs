import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModuleLoader } from "./test-module-loader.mjs";

// LAM-14: the import route validates an API-format graph against a cached
// /object_info allowlist, saves the template disabled, and derives a hidden
// catalog model. /object_info and the generation endpoints are mocked; no GPU
// or live GX10 call is made.
const BASE = "http://127.0.0.1:8188";
const WORKFLOW = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-dev.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
    "3": { class_type: "EmptyLatentImage", inputs: { width: 768, height: 768, batch_size: 1 } },
    "4": { class_type: "KSampler", inputs: { seed: 0, steps: 20, cfg: 1, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["1", 0], positive: ["2", 0], latent_image: ["3", 0] } },
    "5": { class_type: "VAEDecode", inputs: { samples: ["4", 0], vae: ["1", 2] } },
    "6": { class_type: "SaveImage", inputs: { filename_prefix: "lh-video-import", images: ["5", 0] } },
};
const NODES = ["CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage"];
const IMPORT = { id: "imported-flow", label: "Imported FLOW", family: "FLUX", json: JSON.stringify(WORKFLOW),
    mapping: { prompt: ["2", "text"], width: ["3", "width"], height: ["3", "height"], seed: ["4", "seed"] }, output: "6" };

function fixture({ storage, handler } = {}) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        const call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {} };
        calls.push(call);
        if (handler) return handler(call, calls.length);
        throw new Error(`unexpected fetch ${call.method} ${call.url}`);
    };
    const loader = createModuleLoader({
        env: { NODE_ENV: "development", OPEN_HIGGSFIELD_STORAGE_DIR: storage, COMFYUI_BASE_URL: BASE,
            PROVIDER_CONFIG_ENCRYPTION_KEY: "synthetic-provider-config-key-32-characters" },
        mocks: { "next/server": { NextResponse: Response } },
        globals: { fetch },
    });
    return { loader, calls, load: loader.load };
}

function objectInfo(call) {
    assert.equal(call.url, `${BASE}/object_info`);
    assert.equal(call.method, "GET");
    return Response.json(Object.fromEntries(NODES.map(name => [name, { input: {}, output: [] }])));
}

async function temporaryDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "open-higgsfield-comfyui-workflows-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

function request(method, body) {
    return new Request("http://localhost/api/providers/comfyui/workflows", {
        method, headers: { origin: "http://localhost", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

async function exists(file) {
    try { await fs.access(file); return true; } catch { return false; }
}

const configFile = storage => path.join(storage, "provider-runtime-config.json");

test("GET reads /object_info once, caches only class names and reuses the cache", async t => {
    const storage = await temporaryDirectory(t);
    const f = fixture({ storage, handler: objectInfo });
    const route = f.load("src/app/api/providers/comfyui/workflows/route.ts");
    const first = await route.GET(request("GET"));
    assert.equal(first.status, 200);
    assert.deepEqual((await first.json()).nodes, [...NODES].sort());
    assert.equal(f.calls.length, 1);

    const second = await route.GET(request("GET"));
    const body = await second.json();
    assert.equal(body.cached, true);
    assert.deepEqual(body.nodes, [...NODES].sort());
    assert.equal(f.calls.length, 1, "a cached allowlist must not refetch /object_info");

    const cache = JSON.parse(await fs.readFile(path.join(storage, "comfyui-object-info.json"), "utf8"));
    assert.deepEqual(cache.classes, [...NODES].sort());
    assert.deepEqual(Object.keys(cache).sort(), ["classes", "fetchedAt", "version"]);

    const refreshed = await route.GET(new Request("http://localhost/api/providers/comfyui/workflows?refresh=1"));
    assert.equal(refreshed.status, 200);
    assert.equal(f.calls.length, 2, "refresh explicitly refetches");
});

test("invalid JSON and unknown node classes are rejected before anything is persisted", async t => {
    const storage = await temporaryDirectory(t);
    const f = fixture({ storage, handler: objectInfo });
    const route = f.load("src/app/api/providers/comfyui/workflows/route.ts");

    const invalid = await route.POST(request("POST", { ...IMPORT, json: "{not json" }));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "ERR_COMFYUI_WORKFLOW_JSON");
    assert.equal(await exists(configFile(storage)), false, "invalid JSON must not create provider config");

    const unknown = JSON.parse(JSON.stringify(WORKFLOW));
    unknown["4"].class_type = "KSamplerAdvanced";
    const unknownResponse = await route.POST(request("POST", { ...IMPORT, json: JSON.stringify(unknown) }));
    assert.equal(unknownResponse.status, 400);
    assert.equal((await unknownResponse.json()).error, "ERR_COMFYUI_WORKFLOW_NODE");
    assert.equal(await exists(configFile(storage)), false, "unknown node classes must not be persisted");

    const missingTarget = await route.POST(request("POST", { ...IMPORT, mapping: { prompt: ["2", "seed"] } }));
    assert.equal(missingTarget.status, 400);
    assert.equal((await missingTarget.json()).error, "ERR_COMFYUI_WORKFLOW_MAPPING");

    const linkedTarget = await route.POST(request("POST", { ...IMPORT, mapping: { prompt: ["2", "clip"] } }));
    assert.equal(linkedTarget.status, 400);
    assert.equal((await linkedTarget.json()).error, "ERR_COMFYUI_WORKFLOW_MAPPING");

    const badOutput = await route.POST(request("POST", { ...IMPORT, output: "5" }));
    assert.equal(badOutput.status, 400);
    assert.equal((await badOutput.json()).error, "ERR_COMFYUI_WORKFLOW_OUTPUT");

    const noPrompt = await route.POST(request("POST", { ...IMPORT, mapping: { width: ["3", "width"] } }));
    assert.equal(noPrompt.status, 400);
    assert.equal((await noPrompt.json()).error, "ERR_COMFYUI_WORKFLOW_MAPPING");
    assert.equal(await exists(configFile(storage)), false);
});

test("a valid workflow is saved disabled and unverified, then enabled through the catalog", async t => {
    const storage = await temporaryDirectory(t);
    const f = fixture({ storage, handler: objectInfo });
    const route = f.load("src/app/api/providers/comfyui/workflows/route.ts");
    const response = await route.POST(request("POST", IMPORT));
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.template.id, "imported-flow");
    assert.equal(created.model.modelId, "comfyui:imported-flow");
    assert.equal(created.model.enabled, false);
    assert.equal(created.model.status, "unverified");
    assert.equal(created.model.capabilities.catalog_status, "unverified");

    const stored = JSON.parse(await fs.readFile(configFile(storage), "utf8"));
    assert.equal(stored.comfyuiTemplates.length, 1);
    assert.equal(stored.comfyuiTemplates[0].id, "imported-flow");
    assert.deepEqual(stored.comfyuiTemplates[0].mediaSlots, [], "imported image templates expose no media slot");
    assert.deepEqual(stored.modelOverrides.map(entry => [entry.modelId, entry.enabled, entry.status]), [["comfyui:imported-flow", false, "unverified"]]);
    assert.equal(JSON.stringify(stored).includes("Authorization"), false);

    const catalog = f.load("src/app/api/catalog/route.ts");
    const listed = await (await catalog.GET(new Request("http://localhost/api/catalog"))).json();
    const capability = listed.images.find(model => model.id === "comfyui:imported-flow");
    assert.ok(capability);
    assert.equal(capability.catalog_source, "custom");
    assert.equal(capability.catalog_status, "disabled");
    assert.equal(capability.prompt_required, true);
    assert.equal(capability.negative_prompt, false);
    assert.equal(capability.cfg_scale, false);
    assert.deepEqual(capability.seed, { minimum: 0, maximum: 4294967295 });
    assert.deepEqual(capability.custom_fields.map(field => field.id), ["width", "height", "seed"]);

    // The Studio list filters disabled models; enabling the override exposes it.
    const imageModels = f.load("src/app/api/image-models/route.ts");
    assert.equal((await (await imageModels.GET(new Request("http://localhost/api/image-models"))).json()).models.some(model => model.id === "comfyui:imported-flow"), false);
    const enabled = await catalog.PATCH(new Request("http://localhost/api/catalog", { method: "PATCH", headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ modelId: "comfyui:imported-flow", mediaType: "image", enabled: true }) }));
    assert.equal(enabled.status, 200);
    const models = await (await imageModels.GET(new Request("http://localhost/api/image-models"))).json();
    const visible = models.models.find(model => model.id === "comfyui:imported-flow");
    assert.ok(visible);
    assert.equal(visible.catalog_status, "unverified");
    assert.deepEqual(models.groups, ["ComfyUI"]);

    // The adapter builds the imported graph with the mapped canonical values.
    const provider = f.load("@/server/providers/comfyui");
    const built = provider.buildComfyuiRequest({ mediaType: "image", modelId: visible.id, providerModelId: visible.provider_model_id,
        capabilities: visible, params: { model_id: visible.id, prompt: "A paper boat", field_values: { width: 512, height: 640, seed: 7 } }, media: {} });
    assert.equal(built.graph["2"].inputs.text, "A paper boat");
    assert.equal(built.graph["3"].inputs.width, 512);
    assert.equal(built.graph["3"].inputs.height, 640);
    assert.equal(built.graph["4"].inputs.seed, 7);

    const duplicate = await route.POST(request("POST", IMPORT));
    assert.equal(duplicate.status, 400);
    assert.equal((await duplicate.json()).error, "ERR_COMFYUI_WORKFLOW_DUPLICATE");

    // A fresh module graph (restart) rehydrates the imported template before
    // validating the persisted custom capability.
    const restarted = fixture({ storage, handler: () => { throw new Error("restart must not refetch /object_info"); } });
    const templates = await restarted.load("@/server/config/provider-store").listComfyuiTemplates();
    assert.deepEqual(templates.map(template => template.id), ["imported-flow"]);
    const runtime = restarted.load("@/server/catalog/runtime");
    const reloaded = await runtime.getRuntimeCapability("image", "comfyui:imported-flow");
    assert.ok(reloaded, "the saved capability must validate against its rehydrated template");
    assert.equal(reloaded.catalog_status, "unverified");
    assert.deepEqual(restarted.calls, []);
});

test("DELETE removes the imported template and its catalog model", async t => {
    const storage = await temporaryDirectory(t);
    const f = fixture({ storage, handler: objectInfo });
    const route = f.load("src/app/api/providers/comfyui/workflows/route.ts");
    assert.equal((await route.POST(request("POST", IMPORT))).status, 201);

    const deleted = await route.DELETE(request("DELETE", { id: "imported-flow" }));
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true, modelDeleted: true });
    const stored = JSON.parse(await fs.readFile(configFile(storage), "utf8"));
    assert.deepEqual(stored.comfyuiTemplates, []);
    assert.deepEqual(stored.modelOverrides, []);
    assert.equal((await route.DELETE(request("DELETE", { id: "imported-flow" }))).status, 200);
});
