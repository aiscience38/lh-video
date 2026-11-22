import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModuleLoader } from "./test-module-loader.mjs";

const BASE = "http://100.92.10.72:8188";
const PROMPT_ID = "11111111-1111-4111-8111-111111111111";
const MP3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x12, 0x34, 0x56, 0x78]);
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ env = {}, fetchImpl, mocks = {} } = {}) {
    const calls = [];
    const loader = createModuleLoader({
        env: { NODE_ENV: "development", ...env },
        mocks,
        globals: {
            fetch: async (url, init = {}) => {
                calls.push({ url: String(url), init });
                if (!fetchImpl) throw new Error(`unexpected fetch ${init.method ?? "GET"} ${url}`);
                return fetchImpl(String(url), init);
            },
        },
    });
    return { calls, load: relative => loader.load(relative) };
}

function jsonResponse(value, init = {}) {
    return new Response(JSON.stringify(value), {
        status: 200,
        ...init,
        headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
}

function audioResponse(bytes) {
    return new Response(bytes, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg", "Content-Length": String(bytes.byteLength) },
    });
}

async function temporaryDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "open-higgsfield-tts-comfyui-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test("ComfyUI availability reports no_base_url without any network call", async () => {
    const f = fixture();
    assert.deepEqual(plain(await f.load("@/server/tts/comfyui").comfyuiAvailability()), {
        configured: false, reachable: false, reason: "no_base_url",
    });
    assert.equal(f.calls.length, 0);
});

test("ComfyUI availability never throws: network, 5xx and 401 are reported as rows", async () => {
    const offline = fixture({
        env: { COMFYUI_BASE_URL: BASE },
        fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    assert.deepEqual(plain(await offline.load("@/server/tts/comfyui").comfyuiAvailability()), {
        configured: true, reachable: false, reason: "upstream_down",
    });
    assert.equal(offline.calls.length, 1);
    assert.equal(offline.calls[0].url, `${BASE}/system_stats`);

    const broken = fixture({
        env: { COMFYUI_BASE_URL: BASE },
        fetchImpl: async () => new Response("no", { status: 503 }),
    });
    assert.deepEqual(plain(await broken.load("@/server/tts/comfyui").comfyuiAvailability()), {
        configured: true, reachable: false, reason: "upstream_down",
    });

    const unauthorized = fixture({
        env: { COMFYUI_BASE_URL: BASE },
        fetchImpl: async () => new Response("no", { status: 401 }),
    });
    assert.deepEqual(plain(await unauthorized.load("@/server/tts/comfyui").comfyuiAvailability()), {
        configured: true, reachable: true, reason: "unauthorized",
    });
});

test("synthesize submits once, polls history until complete and returns the /view MP3", async () => {
    let submitted;
    let historyCalls = 0;
    let viewUrl;
    const f = fixture({
        env: { COMFYUI_BASE_URL: BASE },
        fetchImpl: async (url, init) => {
            if (url === `${BASE}/prompt`) {
                submitted = JSON.parse(init.body);
                return jsonResponse({ prompt_id: PROMPT_ID, node_errors: {} });
            }
            if (url === `${BASE}/history/${PROMPT_ID}`) {
                historyCalls += 1;
                if (historyCalls === 1) return jsonResponse({});
                return jsonResponse({
                    [PROMPT_ID]: {
                        status: { completed: true, status_str: "success" },
                        outputs: { "2": { audio: [{ filename: "lh_voice_00001_.mp3", subfolder: "audio", type: "output" }] } },
                    },
                });
            }
            if (url.startsWith(`${BASE}/view?`)) {
                viewUrl = url;
                return audioResponse(MP3);
            }
            throw new Error(`unexpected fetch ${url}`);
        },
    });
    const tts = f.load("@/server/tts/comfyui");
    const result = await tts.synthesizeComfyui("Hello", {
        speaker: "warm-narrator", language: "English", speed: 1.25,
    }, { pollIntervalMs: 1 });
    assert.equal(result.mimeType, "audio/mpeg");
    assert.deepEqual([...result.bytes], [...MP3]);
    assert.equal(historyCalls, 2, "an empty history entry is polled again");
    assert.equal(viewUrl, `${BASE}/view?filename=lh_voice_00001_.mp3&subfolder=audio&type=output`);
    assert.equal(f.calls.length, 4);

    assert.equal(submitted.prompt["1"].class_type, "FB_Qwen3TTSVoiceDesign");
    assert.equal(submitted.prompt["1"].inputs.text, "Hello");
    assert.equal(submitted.prompt["1"].inputs.language, "English");
    assert.match(submitted.prompt["1"].inputs.instruct, /warm, grounded adult voice/i);
    assert.match(submitted.prompt["1"].inputs.instruct, /1\.25x/);
    assert.equal(submitted.prompt["2"].class_type, "SaveAudioMP3");
    assert.deepEqual(submitted.prompt["2"].inputs.audio, ["1", 0]);
    assert.match(submitted.client_id, /^[0-9a-f-]{36}$/);
});

test("node_errors on /prompt reject the submission before polling", async () => {
    const f = fixture({
        env: { COMFYUI_BASE_URL: BASE },
        fetchImpl: async url => {
            assert.equal(url, `${BASE}/prompt`);
            return jsonResponse({ prompt_id: PROMPT_ID, node_errors: { "1": { errors: [{ message: "bad text" }] } } });
        },
    });
    await assert.rejects(
        f.load("@/server/tts/comfyui").synthesizeComfyui("Hello", { speaker: "warm-narrator" }, { pollIntervalMs: 1 }),
        error => error.code === "invalid_request" && error.message === "ERR_TTS_NODE_ERRORS",
    );
    assert.equal(f.calls.length, 1);
});

test("oversized text is rejected before /prompt", async () => {
    const f = fixture({ env: { COMFYUI_BASE_URL: BASE } });
    await assert.rejects(
        f.load("@/server/tts/comfyui").synthesizeComfyui("a".repeat(2001), { speaker: "warm-narrator" }),
        error => error.code === "invalid_request" && error.message === "ERR_TTS_TEXT_TOO_LONG",
    );
    assert.equal(f.calls.length, 0);
});

test("object_info discovery gates the shipped voice presets and is cached", async () => {
    const f = fixture({
        env: { COMFYUI_BASE_URL: BASE },
        fetchImpl: async url => {
            assert.equal(url, `${BASE}/object_info`);
            return jsonResponse({
                FB_Qwen3TTSVoiceDesign: { input: {} },
                SaveAudioMP3: { input: {} },
                SaveImage: { input: {} },
            });
        },
    });
    const tts = f.load("@/server/tts/comfyui");
    const voices = await tts.listComfyuiTtsVoices();
    assert.equal(f.calls.length, 1);
    assert.equal(voices.length, 5);
    assert.equal(voices[0].id, "warm-narrator");
    assert.equal(voices[0].language, "English");
    assert.deepEqual(plain(await tts.listComfyuiTtsVoices()), plain(voices));
    assert.equal(f.calls.length, 1, "the 60 s discovery cache answers the second call");

    const missing = fixture({
        env: { COMFYUI_BASE_URL: BASE },
        fetchImpl: async () => jsonResponse({ SaveAudioMP3: { input: {} } }),
    });
    assert.deepEqual(plain(await missing.load("@/server/tts/comfyui").listComfyuiTtsVoices()), [],
        "a host without the VoiceDesign node advertises no presets");
});

test("the preview route records a zero-cost, non-estimated ComfyUI ledger row", async t => {
    const directory = await temporaryDirectory(t);
    const synthesised = [];
    const f = fixture({
        env: { OPEN_HIGGSFIELD_STORAGE_DIR: directory },
        mocks: {
            "next/server": { NextResponse: Response },
            "@/server/tts/comfyui": {
                synthesizeComfyui: async (text, settings) => {
                    synthesised.push({ text, settings });
                    return { bytes: MP3, mimeType: "audio/mpeg" };
                },
                listComfyuiTtsVoices: async () => [],
                comfyuiAvailability: async () => ({ configured: true, reachable: true }),
            },
            "@/server/tts/elevenlabs": {
                synthesizeElevenLabs: async () => { throw new Error("not used"); },
                listElevenLabsVoices: async () => [],
                elevenLabsAvailability: async () => ({ configured: false, reachable: false, reason: "no_api_key" }),
            },
        },
    });
    const response = await f.load("src/app/api/tts/preview/route.ts").POST(new Request("http://localhost/api/tts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ provider: "comfyui", voiceId: "warm-narrator", text: "Hello", language: "English" }),
    }));
    assert.equal(response.status, 200);
    const asset = await response.json();
    assert.match(asset.assetId, /^[a-f0-9]{64}$/);
    assert.deepEqual(plain(synthesised), [{ text: "Hello", settings: { language: "English", speaker: "warm-narrator" } }]);

    const ledger = JSON.parse(await fs.readFile(path.join(directory, "ledger", "assets.json"), "utf8"));
    assert.equal(ledger.records.length, 1);
    assert.equal(ledger.records[0].provider, "comfyui");
    assert.equal(ledger.records[0].model, "qwen3-tts");
    assert.equal(ledger.records[0].costUsd, 0);
    assert.equal(ledger.records[0].estimated, false);
    await fs.access(path.join(directory, "tts", "audio", `${asset.assetId}.mp3`));
});

test("the voices route exposes the ComfyUI presets from the adapter", async () => {
    const f = fixture({
        mocks: {
            "next/server": { NextResponse: Response },
            "@/server/tts/comfyui": {
                listComfyuiTtsVoices: async () => [{ id: "warm-narrator", name: "Warm Narrator", language: "English" }],
                comfyuiAvailability: async () => ({ configured: true, reachable: true }),
                synthesizeComfyui: async () => { throw new Error("not used"); },
            },
            "@/server/tts/elevenlabs": {
                listElevenLabsVoices: async () => [],
                elevenLabsAvailability: async () => ({ configured: false, reachable: false, reason: "no_api_key" }),
                synthesizeElevenLabs: async () => { throw new Error("not used"); },
            },
        },
    });
    const response = await f.load("src/app/api/tts/voices/route.ts").GET(new Request("http://localhost/api/tts/voices?provider=comfyui"));
    assert.equal(response.status, 200);
    assert.deepEqual(plain(await response.json()), {
        provider: "comfyui",
        voices: [{ id: "warm-narrator", name: "Warm Narrator", language: "English" }],
    });
});
