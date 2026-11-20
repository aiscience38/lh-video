import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createModuleLoader } from "./test-module-loader.mjs";

const BASE = "http://100.92.10.72:8188";
const key = "synthetic-comfyui-key-never-persist";
const promptId = "5f2a0d1c-8b3e-4c7a-9d61-2e4b8c0a7f13";
const image = "https://fixtures.example.test/frame.png";
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const plain = value => JSON.parse(JSON.stringify(value));
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const connection = { id: "env:comfyui", providerId: "comfyui", secret: key, metadata: { baseUrl: BASE } };

function fixture({ env = { COMFYUI_BASE_URL: BASE, COMFYUI_API_KEY: key }, handler } = {}) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        const call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body, init };
        calls.push(call);
        if (handler) return handler(call, calls.length);
        throw new Error(`unexpected request ${call.method} ${call.url}`);
    };
    const modules = createModuleLoader({ env, globals: { fetch } });
    const providerModule = modules.load("@/server/providers/comfyui");
    return { modules, calls, load: modules.load, providerModule, ComfyuiProvider: providerModule.ComfyuiProvider,
        provider: new providerModule.ComfyuiProvider() };
}

function model(f) {
    return f.load("@/server/catalog/image").IMAGE_CAPABILITIES["comfyui:flux-t2i"];
}

function request(f, overrides = {}) {
    const capabilities = model(f);
    return { mediaType: "image", modelId: capabilities.id, providerModelId: capabilities.provider_model_id,
        capabilities, params: { model_id: capabilities.id, prompt: "A paper boat on a still blue lake at sunrise", ...overrides.params },
        media: overrides.media ?? {}, ...(overrides.connection ? { connection: overrides.connection } : {}) };
}

const completed = {
    status: { status_str: "success", completed: true, messages: [] },
    outputs: { "7": { images: [{ filename: "lh-video_00001_.png", subfolder: "lh-video", type: "output" }] } },
};

function assertError(error, fields) {
    assert.match(error.code, /^ERR_[A-Z0-9_]+$/);
    assert.equal(error.message, error.code);
    for (const [name, value] of Object.entries(fields)) assert.equal(error[name], value, name);
    assert.equal(error.message.includes(key), false);
    return true;
}

test("ComfyUI registers documented environment metadata, one reviewed FLUX template and derived capability controls", () => {
    const f = fixture();
    const definitions = f.load("@/providers/definitions");
    const definition = definitions.getProviderDefinition("comfyui");
    assert.deepEqual(plain(definition.envKeys), ["COMFYUI_BASE_URL", "COMFYUI_API_KEY"]);
    assert.deepEqual(plain(definition.mediaTypes), ["image"]);
    assert.equal(definition.discovery, "manual");
    assert.equal(definitions.isProviderId("comfyui"), true);
    assert.equal(f.load("@/server/providers/registry").getProvider("comfyui").id, "comfyui");
    assert.match(readFileSync(new URL("../.env.example", import.meta.url), "utf8"), /COMFYUI_BASE_URL=http:\/\/100\.92\.10\.72:8188/);

    assert.deepEqual(Object.keys(f.load("@/server/catalog/comfyui").COMFYUI_TEMPLATES), ["flux-t2i"]);
    // An LTX image-to-video graph is not shipped: docs/providers/comfyui.md lists
    // only LTX audio/upsample/merge classes and says a full graph is unverified.
    assert.equal(f.load("@/server/catalog/comfyui").getComfyuiTemplate("ltx-i2v"), undefined);

    const template = f.load("@/server/catalog/comfyui").COMFYUI_TEMPLATES["flux-t2i"];
    assert.equal(template.mode, "image");
    assert.deepEqual([...new Set(Object.values(template.graph).map(node => node.class_type))].sort(),
        ["CLIPTextEncode", "CheckpointLoaderSimple", "EmptyLatentImage", "KSampler", "SaveImage", "VAEDecode"]);
    assert.deepEqual(plain(template.outputs), [{ node: "7", kind: "image", mimeType: "image/png" }]);

    const capability = model(f);
    assert.equal(capability.label, "FLUX Text to Image");
    assert.equal(capability.group, "ComfyUI");
    assert.equal(capability.provider_mode, "image-model");
    assert.equal(capability.prompt_required, true);
    assert.equal(capability.negative_prompt, true);
    assert.equal(capability.cfg_scale, true);
    assert.deepEqual(plain(capability.seed), { minimum: 0, maximum: 4294967295 });
    assert.deepEqual(plain(capability.custom_fields.map(field => field.id)), ["negative_prompt", "width", "height", "steps", "cfg", "seed"]);
    const controls = Object.fromEntries(capability.custom_fields.map(field => [field.id, field]));
    assert.deepEqual([controls.width.minimum, controls.width.maximum, controls.width.default], [256, 2048, 1024]);
    assert.deepEqual([controls.height.minimum, controls.height.maximum, controls.height.default], [256, 2048, 1024]);
    assert.deepEqual([controls.steps.minimum, controls.steps.maximum, controls.steps.default], [1, 60, 28]);
    assert.deepEqual([controls.cfg.minimum, controls.cfg.maximum, controls.cfg.default], [0, 30, 1]);
    assert.deepEqual([controls.seed.minimum, controls.seed.maximum, controls.seed.default], [0, 4294967295, 0]);
    assert.equal(controls.negative_prompt.maxLength, 2048);
    // The UI controls are generated from the JSON templates, never hand-copied.
    for (const field of capability.custom_fields) {
        const source = template.params.find(param => param.id === field.id);
        assert.ok(source, field.id);
        assert.equal(field.label, source.label);
        assert.equal(field.default, source.default);
    }
});

test("submit posts the API-format graph once with a stable client_id, then observe downloads the completed bytes", async () => {
    const f = fixture({ handler: call => {
        if (call.url === `${BASE}/prompt`) return json({ prompt_id: promptId, node_errors: {} });
        if (call.url === `${BASE}/history/${promptId}`) return json({ [promptId]: completed });
        if (call.url.startsWith(`${BASE}/view?`)) return new Response(bytes, { headers: { "content-type": "image/png", "content-length": String(bytes.length) } });
        throw new Error(`unexpected request ${call.method} ${call.url}`);
    } });
    const req = request(f, { connection, params: { prompt: "A paper boat on a still blue lake at sunrise", field_values: { width: 768, height: 512, steps: 30, cfg: 3.5, seed: 42 } } });
    const provider = new f.ComfyuiProvider();
    const submitted = await provider.submit(req);
    assert.equal(submitted.status, "CREATED");
    assert.equal(submitted.providerTaskId, promptId);
    assert.deepEqual(plain(submitted.operation), { version: 1, promptId, baseUrl: BASE, templateId: "flux-t2i", mediaType: "image" });

    const post = f.calls[0];
    assert.equal(post.method, "POST");
    assert.equal(post.headers.Authorization, `Bearer ${key}`);
    const body = JSON.parse(String(post.body));
    assert.match(body.client_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(body.prompt, plain(f.load("@/server/providers/comfyui").buildComfyuiRequest(req).graph));

    // A second submission from another instance reuses the per-process client_id.
    const second = new f.ComfyuiProvider();
    await second.submit(req);
    const bodies = f.calls.filter(call => call.url === `${BASE}/prompt`).map(call => JSON.parse(String(call.body)));
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].client_id, bodies[0].client_id);

    const observed = await provider.observe({ mediaType: "image", providerModelId: "flux-t2i", operation: submitted.operation, connection });
    assert.equal(observed.status, "COMPLETED");
    assert.equal(observed.assets.length, 1);
    assert.equal(observed.assets[0].mimeType, "image/png");
    assert.deepEqual([...observed.assets[0].data], [...bytes]);
    const view = f.calls.find(call => call.url.startsWith(`${BASE}/view?`));
    const viewUrl = new URL(view.url);
    assert.equal(viewUrl.pathname, "/view");
    assert.equal(viewUrl.searchParams.get("filename"), "lh-video_00001_.png");
    assert.equal(viewUrl.searchParams.get("subfolder"), "lh-video");
    assert.equal(viewUrl.searchParams.get("type"), "output");
    assert.equal(f.calls.filter(call => call.url === `${BASE}/prompt`).length, 2, "no submission retry");
    assert.ok(f.calls.every(call => new URL(call.url).origin === BASE));
});

test("observe keeps a missing history entry pending and normalizes the later completed entry", async () => {
    const responses = [{}, { [promptId]: completed }];
    const f = fixture({ handler: call => call.url.startsWith(`${BASE}/view?`)
        ? new Response(bytes, { headers: { "content-type": "image/png" } })
        : json(responses.shift()) });
    const provider = new f.ComfyuiProvider();
    const poll = () => provider.poll({ mediaType: "image", providerModelId: "flux-t2i",
        operation: { version: 1, promptId, baseUrl: BASE, templateId: "flux-t2i", mediaType: "image" } });
    const pending = await poll();
    assert.equal(pending.status, "IN_PROGRESS");
    assert.deepEqual(plain(pending.operation), { version: 1, promptId, baseUrl: BASE, templateId: "flux-t2i", mediaType: "image" });
    const done = await poll();
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.assets.length, 1);
    assert.equal(f.calls.length, 3, "two history polls and one view download");
});

test("node_errors are failures: history execution errors and a rejected prompt never report success", async () => {
    const historyFailure = fixture({ handler: () => json({ [promptId]: {
        status: { status_str: "error", completed: false, messages: [["execution_error", { node_id: "3", node_errors: { "3": { errors: [{ message: "clip input is invalid" }] } } }]] },
        outputs: {},
    } }) });
    const failure = await new historyFailure.ComfyuiProvider().observe({ mediaType: "image", providerModelId: "flux-t2i",
        operation: { version: 1, promptId, baseUrl: BASE, templateId: "flux-t2i", mediaType: "image" } });
    assert.equal(failure.status, "FAILED");
    assert.equal(failure.error, "ERR_COMFYUI_NODE_ERRORS");

    const plainError = fixture({ handler: () => json({ [promptId]: { status: { status_str: "error", completed: false, messages: [["execution_error", { node_id: "5" }]] }, outputs: {} } }) });
    const executed = await new plainError.ComfyuiProvider().observe({ mediaType: "image", providerModelId: "flux-t2i",
        operation: { version: 1, promptId, baseUrl: BASE, templateId: "flux-t2i", mediaType: "image" } });
    assert.equal(executed.error, "ERR_COMFYUI_EXECUTION_FAILED");

    const rejected = fixture({ handler: () => json({ prompt_id: promptId, node_errors: { "7": { errors: [{ message: "images input missing" }] } } }) });
    const provider = new rejected.ComfyuiProvider();
    await assert.rejects(provider.submit(request(rejected)), error => assertError(error, { submissionUncertain: true, retryable: false }));
    assert.equal(rejected.calls.length, 1, "a rejected graph is not resubmitted");
});

test("an unreachable base URL fails the single submission attempt without a retry", async () => {
    const unreachable = fixture({ handler: () => { throw new TypeError("fetch failed"); } });
    const provider = new unreachable.ComfyuiProvider();
    await assert.rejects(provider.submit(request(unreachable)), error => assertError(error, { code: "ERR_COMFYUI_REQUEST_FAILED", submissionUncertain: true, retryable: false }));
    assert.equal(unreachable.calls.length, 1);

    const unavailable = fixture({ handler: () => json({ error: "not ready" }, 503) });
    await assert.rejects(new unavailable.ComfyuiProvider().submit(request(unavailable)),
        error => assertError(error, { code: "ERR_COMFYUI_HTTP_503", submissionUncertain: true, retryable: false }));
    assert.equal(unavailable.calls.length, 1);
});

test("exact param-to-node-input mapping fixture", () => {
    const f = fixture();
    const req = request(f, { params: { prompt: "A lighthouse at dusk", negative_prompt: "blurry, low contrast",
        field_values: { width: 768, height: 512, steps: 30, cfg: 3.5, seed: 42 } } });
    const { graph } = f.load("@/server/providers/comfyui").buildComfyuiRequest(req);
    assert.deepEqual(plain(graph), {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-dev.safetensors" } },
        "2": { class_type: "CLIPTextEncode", inputs: { text: "A lighthouse at dusk", clip: ["1", 1] } },
        "3": { class_type: "CLIPTextEncode", inputs: { text: "blurry, low contrast", clip: ["1", 1] } },
        "4": { class_type: "EmptyLatentImage", inputs: { width: 768, height: 512, batch_size: 1 } },
        "5": { class_type: "KSampler", inputs: { seed: 42, steps: 30, cfg: 3.5, sampler_name: "euler", scheduler: "normal", denoise: 1,
            model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] } },
        "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
        "7": { class_type: "SaveImage", inputs: { filename_prefix: "lh-video", images: ["6", 0] } },
    });

    // Canonical parameters and field values resolve to the same inputs; conflicts,
    // unknown fields and out-of-range values are rejected before any request.
    const providerModule = f.load("@/server/providers/comfyui");
    const canonical = { ...req, params: { ...req.params, prompt: "A lighthouse at dusk", width: 768, height: 512, seed: 42, cfg_scale: 3.5 } };
    assert.deepEqual(plain(providerModule.buildComfyuiRequest(canonical).graph), plain(graph));
    assert.throws(() => providerModule.buildComfyuiRequest({ ...req, params: { ...req.params, width: 768, field_values: { ...req.params.field_values, width: 1024 } } }), /ERR_COMFYUI_PARAMETER/);
    assert.throws(() => providerModule.buildComfyuiRequest({ ...req, params: { prompt: "A lighthouse at dusk", field_values: { unknown_knob: 1 } } }), /ERR_COMFYUI_PARAMETER/);
    assert.throws(() => providerModule.buildComfyuiRequest({ ...req, params: { prompt: "A lighthouse at dusk", field_values: { width: 4096 } } }), /ERR_COMFYUI_PARAMETER/);
    assert.throws(() => providerModule.buildComfyuiRequest({ ...req, params: { prompt: "   " } }), /ERR_COMFYUI_PROMPT/);
    assert.throws(() => providerModule.buildComfyuiRequest({ ...req, media: { slots: { first_frame: [image] } } }), /ERR_COMFYUI_UNSUPPORTED_MEDIA/);
});

test("cancel posts the documented queue delete array and health reads system_stats", async () => {
    const f = fixture({ handler: call => {
        if (call.url === `${BASE}/queue`) return json({});
        if (call.url === `${BASE}/system_stats`) return json({ system: { comfyui_version: "0.46.0", os: "posix" }, devices: [{ name: "cuda:0", vram_total: 1 }] });
        throw new Error(`unexpected request ${call.method} ${call.url}`);
    } });
    const provider = new f.ComfyuiProvider();
    await provider.cancel(promptId, connection);
    assert.equal(f.calls[0].method, "POST");
    assert.equal(f.calls[0].url, `${BASE}/queue`);
    assert.deepEqual(plain(JSON.parse(String(f.calls[0].body))), { delete: [promptId] });
    assert.equal(f.calls[0].headers.Authorization, `Bearer ${key}`);

    const health = await provider.health(connection);
    assert.deepEqual(plain(health), { comfyuiVersion: "0.46.0", devices: 1 });
    assert.equal(f.calls[1].url, `${BASE}/system_stats`);
    await assert.rejects(provider.cancel("not-a-prompt-id", connection), /ERR_COMFYUI_OPERATION/);
    assert.equal(f.calls.length, 2);
});

test("template media slots become reference uploads for the documented /upload/image endpoint", () => {
    const f = fixture();
    const template = f.load("@/server/catalog/comfyui").COMFYUI_TEMPLATES["flux-t2i"];
    const withSlot = { ...plain(template), mediaSlots: [{ id: "first_frame", label: "First frame", kind: "image", target: ["1", "ckpt_name"], required: true }] };
    const request_ = request(f, { media: { slots: { first_frame: [image] } } });
    const { uploads, graph } = f.providerModule.buildComfyuiRequest(request_, withSlot);
    assert.deepEqual(plain(uploads), [{ url: image, node: "1", input: "ckpt_name", filename: "first_frame.png" }]);
    assert.equal(graph["1"].inputs.ckpt_name, "flux1-dev.safetensors", "the uploaded name replaces this input before POST /prompt");
    assert.throws(() => f.providerModule.buildComfyuiRequest(request(f), withSlot), /ERR_COMFYUI_MEDIA_REQUIRED/);
    assert.throws(() => f.providerModule.buildComfyuiRequest(request(f, { media: { slots: { reference_images: [image] } } }), withSlot), /ERR_COMFYUI_UNSUPPORTED_MEDIA/);
});

test("only local http(s) origins are accepted, and operations are pinned to their template", async () => {
    const f = fixture();
    const providerModule = f.load("@/server/providers/comfyui");
    assert.equal(providerModule.comfyuiBaseUrl(`${BASE}/`), BASE);
    assert.equal(providerModule.comfyuiBaseUrl("http://gx10.local:8188"), "http://gx10.local:8188");
    assert.equal(providerModule.comfyuiBaseUrl("http://localhost:8188/"), "http://localhost:8188");
    for (const value of ["https://comfy.example.test:8188", "https://8.8.8.8:8188", "http://[2001:db8::1]:8188",
        "https://comfy.example.test/path", "http://user:pass@comfy.example.test", "ftp://comfy.example.test",
        "http://comfy.example.test/?x=1", "", "not a url"]) {
        assert.throws(() => providerModule.comfyuiBaseUrl(value), /ERR_COMFYUI_BASE_URL/, value);
    }
    const provider = new providerModule.ComfyuiProvider();
    for (const operation of [
        { version: 1, promptId, baseUrl: BASE, templateId: "ltx-i2v", mediaType: "image" },
        { version: 2, promptId, baseUrl: BASE, templateId: "flux-t2i", mediaType: "image" },
        { version: 1, promptId: "arbitrary", baseUrl: BASE, templateId: "flux-t2i", mediaType: "image" },
        { version: 1, promptId, baseUrl: `${BASE}/sub`, templateId: "flux-t2i", mediaType: "image" },
    ]) {
        await assert.rejects(provider.observe({ mediaType: "image", providerModelId: "flux-t2i", operation }), /ERR_COMFYUI_OPERATION|ERR_COMFYUI_BASE_URL/);
    }
    assert.equal(f.calls.length, 0, "invalid operations never touch the network");
});
