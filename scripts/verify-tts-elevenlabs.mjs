import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModuleLoader } from "./test-module-loader.mjs";

// ID3v2 header + an MPEG-1 Layer III frame sync. Both magic forms are accepted
// by the adapter; tests alternate between them.
const MP3_ID3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00]);
const MP3_FRAME = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);
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
    return { calls, load: relative => loader.load(relative), loader };
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
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "open-higgsfield-tts-eleven-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test("ElevenLabs availability reports no_api_key without any network call", async () => {
    const f = fixture();
    const tts = f.load("@/server/tts/elevenlabs");
    assert.deepEqual(plain(await tts.elevenLabsAvailability()), {
        configured: false, reachable: false, reason: "no_api_key",
    });
    assert.equal(f.calls.length, 0);
});

test("listVoices maps the account library and caches it for 60 seconds", async () => {
    const f = fixture({
        env: { ELEVENLABS_API_KEY: "synthetic-elevenlabs-key" },
        fetchImpl: async (url, init) => {
            assert.equal(url, "https://api.elevenlabs.io/v1/voices");
            assert.equal(init.method, "GET");
            assert.equal(init.headers["xi-api-key"], "synthetic-elevenlabs-key");
            return jsonResponse({ voices: [
                { voice_id: "v1", name: "Ada", labels: { language: "en" }, preview_url: "https://cdn.example.test/ada.mp3" },
                { voice_id: "v2", name: "Ben", labels: {} },
                { voice_id: "bad id", name: "Ignored" },
            ] });
        },
    });
    const tts = f.load("@/server/tts/elevenlabs");
    const first = await tts.listElevenLabsVoices();
    const second = await tts.listElevenLabsVoices();
    assert.equal(f.calls.length, 1, "the 60 s cache must answer the second call without a fetch");
    assert.deepEqual(plain(first), [
        { id: "v1", name: "Ada", language: "en", previewUrl: "https://cdn.example.test/ada.mp3" },
        { id: "v2", name: "Ben", language: "unknown" },
    ]);
    assert.deepEqual(plain(second), plain(first));
});

test("synthesize rejects oversized text before any billable fetch", async () => {
    const f = fixture({ env: { ELEVENLABS_API_KEY: "synthetic-elevenlabs-key" } });
    const tts = f.load("@/server/tts/elevenlabs");
    await assert.rejects(
        tts.synthesizeElevenLabs("v1", "a".repeat(2001)),
        error => error.code === "invalid_request" && error.message === "ERR_TTS_TEXT_TOO_LONG",
    );
    assert.equal(f.calls.length, 0);
});

test("a 401 synthesis maps to auth", async () => {
    const f = fixture({
        env: { ELEVENLABS_API_KEY: "synthetic-elevenlabs-key" },
        fetchImpl: async () => new Response("no", { status: 401 }),
    });
    const tts = f.load("@/server/tts/elevenlabs");
    await assert.rejects(tts.synthesizeElevenLabs("v1", "Hello"), error => error.code === "auth" && error.status === 401);
    assert.equal(f.calls.length, 1);
});

test("a 429 maps to quota, surfaces retry-after and is never retried", async () => {
    const f = fixture({
        env: { ELEVENLABS_API_KEY: "synthetic-elevenlabs-key" },
        fetchImpl: async () => new Response("slow down", { status: 429, headers: { "Retry-After": "7" } }),
    });
    const tts = f.load("@/server/tts/elevenlabs");
    await assert.rejects(tts.synthesizeElevenLabs("v1", "Hello"), error => error.code === "quota"
        && error.status === 429 && error.retryAfterSeconds === 7);
    assert.equal(f.calls.length, 1, "a possibly-billed synthesis is submitted exactly once");
});

test("a successful synthesis returns exactly the MP3 bytes once with the documented body", async () => {
    const f = fixture({
        env: { ELEVENLABS_API_KEY: "synthetic-elevenlabs-key" },
        fetchImpl: async (url, init) => {
            assert.equal(url, "https://api.elevenlabs.io/v1/text-to-speech/v1");
            assert.equal(init.method, "POST");
            assert.equal(init.headers["xi-api-key"], "synthetic-elevenlabs-key");
            assert.equal(init.headers.Accept, "audio/mpeg");
            const body = JSON.parse(init.body);
            assert.equal(body.text, "Hello");
            assert.equal(body.model_id, "eleven_multilingual_v2");
            return audioResponse(MP3_ID3);
        },
    });
    const tts = f.load("@/server/tts/elevenlabs");
    const result = await tts.synthesizeElevenLabs("v1", "Hello");
    assert.equal(result.mimeType, "audio/mpeg");
    assert.deepEqual([...result.bytes], [...MP3_ID3]);
    assert.equal(f.calls.length, 1);
});

test("a 200 response without MP3 magic maps to malformed_result", async () => {
    const f = fixture({
        env: { ELEVENLABS_API_KEY: "synthetic-elevenlabs-key" },
        fetchImpl: async () => new Response("<html>not audio</html>", { status: 200 }),
    });
    const tts = f.load("@/server/tts/elevenlabs");
    await assert.rejects(tts.synthesizeElevenLabs("v1", "Hello"), error => error.code === "malformed_result");
});

test("availability distinguishes an unauthorized key from an unreachable upstream", async () => {
    const unauthorized = fixture({
        env: { ELEVENLABS_API_KEY: "synthetic-elevenlabs-key" },
        fetchImpl: async () => new Response("no", { status: 403 }),
    });
    const tts = unauthorized.load("@/server/tts/elevenlabs");
    assert.deepEqual(plain(await tts.elevenLabsAvailability()), {
        configured: true, reachable: true, reason: "unauthorized",
    });

    const offline = fixture({
        env: { ELEVENLABS_API_KEY: "synthetic-elevenlabs-key" },
        fetchImpl: async () => { throw new Error("network down"); },
    });
    assert.deepEqual(plain(await offline.load("@/server/tts/elevenlabs").elevenLabsAvailability()), {
        configured: true, reachable: false, reason: "upstream_down",
    });
});

test("the providers route reports both availability rows without throwing", async () => {
    const f = fixture({
        mocks: {
            "next/server": { NextResponse: Response },
            "@/server/tts/elevenlabs": {
                elevenLabsAvailability: async () => ({ configured: false, reachable: false, reason: "no_api_key" }),
                listElevenLabsVoices: async () => [],
                synthesizeElevenLabs: async () => { throw new Error("not used"); },
            },
            "@/server/tts/comfyui": {
                comfyuiAvailability: async () => ({ configured: true, reachable: true }),
                listComfyuiTtsVoices: async () => [],
                synthesizeComfyui: async () => { throw new Error("not used"); },
            },
        },
    });
    const response = await f.load("src/app/api/tts/providers/route.ts").GET(new Request("http://localhost/api/tts/providers"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(plain(await response.json()), { providers: {
        elevenlabs: { configured: false, reachable: false, reason: "no_api_key" },
        comfyui: { configured: true, reachable: true },
    } });
});

test("the voices route rejects an unknown provider and returns the provider list", async () => {
    const f = fixture({
        mocks: {
            "next/server": { NextResponse: Response },
            "@/server/tts/elevenlabs": {
                listElevenLabsVoices: async () => [{ id: "v1", name: "Ada", language: "en" }],
                elevenLabsAvailability: async () => ({ configured: true, reachable: true }),
                synthesizeElevenLabs: async () => { throw new Error("not used"); },
            },
            "@/server/tts/comfyui": {
                listComfyuiTtsVoices: async () => [],
                comfyuiAvailability: async () => ({ configured: false, reachable: false, reason: "no_base_url" }),
                synthesizeComfyui: async () => { throw new Error("not used"); },
            },
        },
    });
    const route = f.load("src/app/api/tts/voices/route.ts");
    const invalid = await route.GET(new Request("http://localhost/api/tts/voices?provider=other"));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "ERR_TTS_PROVIDER");
    const response = await route.GET(new Request("http://localhost/api/tts/voices?provider=elevenlabs"));
    assert.equal(response.status, 200);
    assert.deepEqual(plain(await response.json()), { provider: "elevenlabs", voices: [{ id: "v1", name: "Ada", language: "en" }] });
});

test("the preview route materializes one MP3, serves it, and records an estimated ledger row", async t => {
    const directory = await temporaryDirectory(t);
    const synthesised = [];
    const f = fixture({
        env: { OPEN_HIGGSFIELD_STORAGE_DIR: directory },
        mocks: {
            "next/server": { NextResponse: Response },
            "@/server/tts/elevenlabs": {
                synthesizeElevenLabs: async (voiceId, text) => {
                    synthesised.push({ voiceId, text });
                    return { bytes: MP3_ID3, mimeType: "audio/mpeg" };
                },
                listElevenLabsVoices: async () => [],
                elevenLabsAvailability: async () => ({ configured: true, reachable: true }),
            },
            "@/server/tts/comfyui": {
                synthesizeComfyui: async () => { throw new Error("not used"); },
                listComfyuiTtsVoices: async () => [],
                comfyuiAvailability: async () => ({ configured: false, reachable: false, reason: "no_base_url" }),
            },
        },
    });
    const route = f.load("src/app/api/tts/preview/route.ts");
    const request = () => new Request("http://localhost/api/tts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ provider: "elevenlabs", voiceId: "v1", text: "Hello" }),
    });
    const response = await route.POST(request());
    assert.equal(response.status, 200);
    const asset = await response.json();
    assert.match(asset.assetId, /^[a-f0-9]{64}$/);
    assert.equal(asset.url, `/api/tts/audio/${asset.assetId}`);
    assert.equal(asset.mimeType, "audio/mpeg");
    assert.deepEqual(synthesised, [{ voiceId: "v1", text: "Hello" }]);

    const file = await fs.readFile(path.join(directory, "tts", "audio", `${asset.assetId}.mp3`));
    assert.deepEqual([...file], [...MP3_ID3], "the asset is the content-addressed MP3");

    const ledger = JSON.parse(await fs.readFile(path.join(directory, "ledger", "assets.json"), "utf8"));
    assert.equal(ledger.records.length, 1);
    assert.equal(ledger.records[0].assetId, asset.assetId);
    assert.equal(ledger.records[0].provider, "elevenlabs");
    assert.equal(ledger.records[0].estimated, true);
    assert.equal(ledger.records[0].source, "provider");
    assert.ok(Math.abs(ledger.records[0].costUsd - 0.0009) < 1e-9, String(ledger.records[0].costUsd));

    const audio = await f.load("src/app/api/tts/audio/[assetId]/route.ts")
        .GET(new Request(`http://localhost/api/tts/audio/${asset.assetId}`), { params: Promise.resolve({ assetId: asset.assetId }) });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("Content-Type"), "audio/mpeg");
    assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [...MP3_ID3]);

    // A repeated identical preview reuses the content address and ledger row.
    const repeated = await route.POST(request());
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).assetId, asset.assetId);
    const after = JSON.parse(await fs.readFile(path.join(directory, "ledger", "assets.json"), "utf8"));
    assert.equal(after.records.length, 1);
});

test("the preview route rejects oversized text before calling the provider", async () => {
    let calls = 0;
    const f = fixture({
        mocks: {
            "next/server": { NextResponse: Response },
            "@/server/tts/elevenlabs": {
                synthesizeElevenLabs: async () => { calls += 1; return { bytes: MP3_FRAME, mimeType: "audio/mpeg" }; },
                listElevenLabsVoices: async () => [],
                elevenLabsAvailability: async () => ({ configured: true, reachable: true }),
            },
            "@/server/tts/comfyui": {
                synthesizeComfyui: async () => { throw new Error("not used"); },
                listComfyuiTtsVoices: async () => [],
                comfyuiAvailability: async () => ({ configured: false, reachable: false, reason: "no_base_url" }),
            },
        },
    });
    const response = await f.load("src/app/api/tts/preview/route.ts").POST(new Request("http://localhost/api/tts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ provider: "elevenlabs", voiceId: "v1", text: "a".repeat(2001) }),
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "ERR_TTS_TEXT_TOO_LONG");
    assert.equal(calls, 0);
});
