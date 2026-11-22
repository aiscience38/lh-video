import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createModuleLoader } from "./test-module-loader.mjs";

/**
 * Filmstrip generation: the detail timeline needs N evenly spaced JPEGs, a
 * probe duration, and a cache that survives a reload. ffmpeg/ffprobe are
 * required to build the fixture; the missing-binary path is exercised with an
 * intentionally invalid executable path and does not need a real binary.
 */

const FFMPEG = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH?.trim() || "ffprobe";
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const ffmpegAvailable = (() => {
    try {
        execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
        execFileSync(FFPROBE, ["-version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
})();
const withoutFfmpeg = ffmpegAvailable ? false : "ffmpeg/ffprobe are not available";

async function fixtureVideo(directory) {
    const file = path.join(directory, "fixture.mp4");
    execFileSync(FFMPEG, [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=64x48:rate=15",
        "-t", "2", "-c:v", "mpeg4", "-q:v", "5", "-y", file,
    ]);
    return file;
}

function environment(directory, overrides = {}) {
    return createModuleLoader({
        env: {
            OPEN_HIGGSFIELD_STORAGE_DIR: directory,
            NODE_ENV: "development",
            FFMPEG_PATH: FFMPEG,
            FFPROBE_PATH: FFPROBE,
            ...overrides,
        },
        // The loader executes the route outside Next, where NextResponse is Response.
        mocks: { "next/server": { NextResponse: Response } },
    });
}

function videoFixture(id, videoPath) {
    return {
        task_id: id, model_id: "synthetic", media_type: "video", created_at: "2026-01-01T00:00:00Z",
        status: "COMPLETED", lifecycle_phase: "terminal", video_path: videoPath, video_urls: [],
        next_poll_at: null, deadline_at: null, poll_failures: 0, lease_token: null, lease_expires_at: null, deleted_at: null,
    };
}

test("the timeline timecode is hh:mm:ss:ff", () => {
    const { formatFrameTimecode } = environment(os.tmpdir()).load("@/lib/timecode");
    assert.equal(formatFrameTimecode(0, 24), "00:00:00:00");
    assert.equal(formatFrameTimecode(3.5, 24), "00:00:03:12");
    assert.equal(formatFrameTimecode(3.5 + 1 / 24, 24), "00:00:03:13");
    assert.equal(formatFrameTimecode(3661.25, 24), "01:01:01:06");
    assert.equal(formatFrameTimecode(Number.NaN, 0), "00:00:00:00");
});

test("a filmstrip has the requested frame count, probed duration and JPEG bytes", { skip: withoutFfmpeg }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "media-frames-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = await fixtureVideo(directory);
    const { ensureFilmstrip } = environment(directory).load("@/server/media/frames");
    const strip = await ensureFilmstrip(source, "video-strip", { count: 6 });
    assert.equal(strip.frameCount, 6);
    assert.equal(strip.cached, false);
    assert.ok(Math.abs(strip.durationSeconds - 2) < 0.25, `duration ${strip.durationSeconds}`);
    assert.equal(strip.frames.length, 6);
    assert.deepEqual(Array.from(strip.frames, frame => frame.index), [0, 1, 2, 3, 4, 5]);
    for (const frame of strip.frames) {
        assert.equal(frame.url, `/api/media/video-strip/frames?index=${frame.index}`);
        const bytes = await fs.readFile(path.join(directory, "frames", "video-strip", `${frame.index}.jpg`));
        assert.ok(bytes.length > 0, `frame ${frame.index} is not empty`);
        assert.deepEqual(bytes.subarray(0, 3), JPEG_MAGIC, `frame ${frame.index} is a JPEG`);
    }
    const metadata = JSON.parse(await fs.readFile(path.join(directory, "frames", "video-strip", "meta.json"), "utf8"));
    assert.equal(metadata.frameCount, 6);
    assert.ok(metadata.durationSeconds > 0);
});

test("a second call reuses the cached JPEGs unchanged", { skip: withoutFfmpeg }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "media-frames-cache-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = await fixtureVideo(directory);
    const loader = environment(directory);
    const { ensureFilmstrip } = loader.load("@/server/media/frames");
    const first = await ensureFilmstrip(source, "video-cache", { count: 4 });
    const targets = Array.from({ length: 4 }, (_, index) => path.join(directory, "frames", "video-cache", `${index}.jpg`));
    const before = await Promise.all(targets.map(file => fs.readFile(file)));
    const stamps = await Promise.all(targets.map(async file => (await fs.stat(file)).mtimeMs));

    const second = await ensureFilmstrip(source, "video-cache", { count: 4 });
    assert.equal(second.cached, true, "the second call is served from cache");
    assert.equal(second.durationSeconds, first.durationSeconds);
    assert.equal(second.frameCount, 4);
    const after = await Promise.all(targets.map(file => fs.readFile(file)));
    for (let index = 0; index < after.length; index += 1) {
        assert.deepEqual(after[index], before[index], `frame ${index} bytes are unchanged`);
        assert.equal((await fs.stat(targets[index])).mtimeMs, stamps[index], `frame ${index} was not rewritten`);
    }
});

test("a missing ffmpeg or ffprobe reports ERR_QA_FFMPEG_MISSING", { skip: withoutFfmpeg }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "media-frames-missing-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = await fixtureVideo(directory);
    const bad = path.join(directory, "definitely-not-ffmpeg.exe");
    const loader = environment(directory, { FFMPEG_PATH: bad, FFPROBE_PATH: bad });
    const { ensureFilmstrip, probeVideo, QA_FFMPEG_MISSING } = loader.load("@/server/media/frames");
    await assert.rejects(probeVideo(source), error => {
        assert.equal(error.code, QA_FFMPEG_MISSING);
        assert.match(error.message, /FFPROBE_PATH/);
        return true;
    });
    await assert.rejects(ensureFilmstrip(source, "video-missing", { count: 2 }), error => {
        assert.equal(error.code, QA_FFMPEG_MISSING);
        return true;
    });
});

test("the frames route returns the filmstrip JSON and then serves a cached JPEG", { skip: withoutFfmpeg }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "media-frames-route-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = await fixtureVideo(directory);
    const container = path.join(directory, "downloads", "videos");
    await fs.mkdir(container, { recursive: true });
    const videoPath = path.join(container, "generated.mp4");
    await fs.copyFile(source, videoPath);

    const loader = environment(directory);
    const store = loader.load("@/server/tasks/store");
    const route = loader.load("src/app/api/media/[taskId]/frames/route.ts");
    await store.createTask(videoFixture("video-route", videoPath));

    const context = { params: Promise.resolve({ taskId: "video-route" }) };
    const response = await route.GET(new Request("http://localhost:3120/api/media/video-route/frames?count=5"), context);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.frameCount, 5);
    assert.ok(body.durationSeconds > 0);
    assert.equal(body.frames.length, 5);

    const second = await route.GET(new Request("http://localhost:3120/api/media/video-route/frames?count=5"), context);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).cached, true, "the route reuses the cached strip");

    const image = await route.GET(new Request("http://localhost:3120/api/media/video-route/frames?index=2"), context);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()).subarray(0, 3), JPEG_MAGIC);

    const missing = await route.GET(new Request("http://localhost:3120/api/media/video-route/frames?index=23"), context);
    assert.equal(missing.status, 404);
});

test("the frames route returns ERR_QA_FFMPEG_MISSING when the binaries are absent", { skip: withoutFfmpeg }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "media-frames-route-missing-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = await fixtureVideo(directory);
    const container = path.join(directory, "downloads", "videos");
    await fs.mkdir(container, { recursive: true });
    const videoPath = path.join(container, "generated.mp4");
    await fs.copyFile(source, videoPath);

    const bad = path.join(directory, "definitely-not-ffmpeg.exe");
    const loader = environment(directory, { FFMPEG_PATH: bad, FFPROBE_PATH: bad });
    const store = loader.load("@/server/tasks/store");
    const route = loader.load("src/app/api/media/[taskId]/frames/route.ts");
    await store.createTask(videoFixture("video-route-missing", videoPath));

    const response = await route.GET(new Request("http://localhost:3120/api/media/video-route-missing/frames"),
        { params: Promise.resolve({ taskId: "video-route-missing" }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "ERR_QA_FFMPEG_MISSING");
});
