import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModuleLoader } from "./test-module-loader.mjs";

// The ComfyUI adapter is image-only. `/api/models` is hard-wired to the video
// catalog in src/app/api/models/route.ts, so the ComfyUI capability assertion
// exercises the sibling `/api/image-models` route. The video route is still
// loaded and asserted below to prove ComfyUI cannot leak into it.
const BASE = "http://100.92.10.72:8188";
const key = "synthetic-comfyui-api-key-never-persist";
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ env = {} } = {}) {
    const loader = createModuleLoader({
        env: {
            NODE_ENV: "development",
            GENERATION_ENABLED: "true",
            PROVIDER_CONFIG_ENCRYPTION_KEY: "synthetic-provider-config-key-32-characters",
            ...env,
        },
        // Route tests only need Next's response adapter; the route logic,
        // workspace guard and catalog/runtime modules are the real source.
        mocks: { "next/server": { NextResponse: Response } },
        globals: { fetch: async (url, init = {}) => { throw new Error(`unexpected fetch ${init.method ?? "GET"} ${url}`); } },
    });
    return { loader, load: loader.load };
}

async function temporaryDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "open-higgsfield-comfyui-api-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test("the image-models route lists the ComfyUI FLUX capability with controls derived from the real template", async t => {
    const directory = await temporaryDirectory(t);
    const f = fixture({ env: { OPEN_HIGGSFIELD_STORAGE_DIR: directory, COMFYUI_BASE_URL: BASE, COMFYUI_API_KEY: key } });

    // Environment credentials are the documented keyless-on-LAN path: the
    // provider-store is not required for the runtime catalog to connect ComfyUI.
    const response = await f.load("src/app/api/image-models/route.ts").GET(new Request("http://localhost/api/image-models"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    const body = await response.json();
    assert.ok(Array.isArray(body.models));
    assert.deepEqual(body.groups, ["ComfyUI"]);
    assert.equal(body.models.length, 1, "only the configured ComfyUI provider is connected");
    const capability = body.models.find(model => model.id.startsWith("comfyui:"));
    assert.ok(capability, "the image catalog must expose a comfyui: capability");
    assert.equal(capability.id, "comfyui:flux-t2i");
    assert.equal(capability.provider, "comfyui");
    assert.equal(capability.provider_model_id, "flux-t2i");
    assert.equal(capability.provider_mode, "image-model");
    assert.equal(capability.prompt_required, true);
    assert.equal(capability.negative_prompt, true);
    assert.equal(capability.cfg_scale, true);
    assert.deepEqual(plain(capability.seed), { minimum: 0, maximum: 4294967295 });
    assert.deepEqual(plain(capability.media_slots), []);

    const template = f.load("@/server/catalog/comfyui").COMFYUI_TEMPLATES["flux-t2i"];
    assert.deepEqual(plain(template.mediaSlots), [], "the FLUX text-to-image template declares no media slot");
    const controls = Object.fromEntries(capability.custom_fields.map(field => [field.id, field]));
    assert.deepEqual(Object.keys(controls).sort(),
        ["cfg", "height", "negative_prompt", "seed", "steps", "width"]);
    // Every control is generated from the reviewed JSON template, never copied
    // by hand into the route or the capability.
    for (const id of Object.keys(controls)) {
        const source = template.params.find(param => param.id === id);
        assert.ok(source, `${id} must exist in the FLUX template`);
        assert.equal(controls[id].label, source.label, id);
        assert.equal(controls[id].default, source.default, id);
        assert.equal(controls[id].minimum, source.minimum, id);
        assert.equal(controls[id].maximum, source.maximum, id);
        assert.equal(controls[id].maxLength, source.maxLength, id);
    }
    assert.deepEqual([controls.width.minimum, controls.width.maximum, controls.width.default], [256, 2048, 1024]);
    assert.deepEqual([controls.height.minimum, controls.height.maximum, controls.height.default], [256, 2048, 1024]);
    assert.deepEqual([controls.steps.minimum, controls.steps.maximum, controls.steps.default], [1, 60, 28]);
    assert.deepEqual([controls.cfg.minimum, controls.cfg.maximum, controls.cfg.default], [0, 30, 1]);
    assert.deepEqual([controls.seed.minimum, controls.seed.maximum, controls.seed.default], [0, 4294967295, 0]);
    assert.equal(controls.negative_prompt.maxLength, 2048);

    // The video route is the other half of the catalog split: no ComfyUI video
    // template exists, so the capability must not appear there.
    const videoResponse = await f.load("src/app/api/models/route.ts").GET(new Request("http://localhost/api/models"));
    assert.equal(videoResponse.status, 200);
    const video = await videoResponse.json();
    assert.ok(Array.isArray(video.model_list));
    assert.deepEqual(Object.values(video.models), video.model_list);
    assert.equal(video.model_list.some(model => model.id.startsWith("comfyui:")), false);
    assert.equal(video.groups.includes("ComfyUI"), false);
});

test("a template without a media slot rejects image inputs with a normalized 400 before any task or fetch", async t => {
    const directory = await temporaryDirectory(t);
    const f = fixture({ env: { OPEN_HIGGSFIELD_STORAGE_DIR: directory, COMFYUI_BASE_URL: BASE, COMFYUI_API_KEY: key } });
    const catalog = f.load("@/server/catalog/runtime");
    const capability = await catalog.getRuntimeCapability("image", "comfyui:flux-t2i");
    assert.ok(capability);
    assert.deepEqual(plain(capability.media_slots), []);

    // The adapter's real catalog validation (buildComfyuiRequest against the
    // reviewed JSON template) rejects the same input with the catalog code.
    const provider = f.load("@/server/providers/comfyui");
    const request = {
        mediaType: "image",
        modelId: capability.id,
        providerModelId: capability.provider_model_id,
        capabilities: capability,
        params: { model_id: capability.id, prompt: "A paper boat on a still blue lake" },
        media: { slots: { reference_images: ["https://fixtures.example.test/reference.png"] } },
    };
    assert.throws(() => provider.buildComfyuiRequest(request), error => {
        assert.equal(error.code, "ERR_COMFYUI_UNSUPPORTED_MEDIA");
        assert.equal(error.message, "ERR_COMFYUI_UNSUPPORTED_MEDIA");
        return true;
    });

    // The real image route must normalize that catalog rejection to HTTP 400
    // during preprocessing, not accept the request and silently drop the image.
    // Before the media guard this returned 202 and POSTed /prompt with no media.
    const route = f.load("src/app/api/generate-image/route.ts");
    for (const [field, value] of [
        ["slot_reference_images", new File(["synthetic"], "reference.png", { type: "image/png" })],
        ["url_reference_images", "https://fixtures.example.test/reference.png"],
    ]) {
        const form = new FormData();
        form.set("model_id", capability.id);
        form.set("prompt", "A paper boat on a still blue lake");
        form.set(field, value);
        const response = await route.POST(new Request("http://localhost/api/generate-image", {
            method: "POST", headers: { origin: "http://localhost" }, body: form,
        }));
        assert.equal(response.status, 400, field);
        assert.deepEqual(await response.json(), {
            error: "ERR_COMFYUI_UNSUPPORTED_MEDIA", accepted: false, recovery_required: false,
        }, field);
    }
    // No provider call and no task record: rejection happens before submission.
    await assert.rejects(fs.readFile(path.join(directory, "tasks_history.json")), /ENOENT/);
});

test("the keyless local ComfyUI environment connection needs only COMFYUI_BASE_URL", async t => {
    const directory = await temporaryDirectory(t);
    const keyless = fixture({ env: { OPEN_HIGGSFIELD_STORAGE_DIR: directory, COMFYUI_BASE_URL: BASE } });
    const store = keyless.load("@/server/config/provider-store");
    assert.deepEqual(plain(store.connectionFromEnv("comfyui")),
        { id: "env:comfyui", providerId: "comfyui", metadata: { baseUrl: BASE } });
    assert.equal((await store.getConnectedProviderIds()).has("comfyui"), true);

    const response = await keyless.load("src/app/api/image-models/route.ts").GET(new Request("http://localhost/api/image-models"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).models.some(model => model.id === "comfyui:flux-t2i"), true,
        "COMFYUI_BASE_URL alone must connect the keyless LAN provider");

    // Without either a saved connection or the base URL the same route must not
    // expose a model it cannot reach.
    const absent = fixture({ env: { OPEN_HIGGSFIELD_STORAGE_DIR: directory } });
    assert.equal((await absent.load("@/server/config/provider-store").getConnectedProviderIds()).size, 0);
    const empty = await absent.load("src/app/api/image-models/route.ts").GET(new Request("http://localhost/api/image-models"));
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).models, []);
});
