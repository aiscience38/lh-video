import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createModuleLoader } from "./test-module-loader.mjs";

/**
 * Shot extension: the last frame of a video must become a real PNG that the
 * composer and the Library can consume.
 *
 * The fixture is a two-second testsrc clip so `-sseof -1` has somewhere to
 * seek; ffmpeg itself is required, so the media tests skip when it is missing
 * while the pure contract checks always run.
 */

const FFMPEG = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const ffmpegAvailable = (() => {
    try {
        execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
})();
const withoutFfmpeg = ffmpegAvailable ? false : "ffmpeg is not available on PATH";

async function fixtureVideo(dir) {
    const file = path.join(dir, "fixture.mp4");
    execFileSync(FFMPEG, [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=64x48:rate=15",
        "-t", "2", "-c:v", "mpeg4", "-q:v", "5", "-y", file,
    ]);
    return file;
}

function environment(dir) {
    return createModuleLoader({
        env: { OPEN_HIGGSFIELD_STORAGE_DIR: dir, NODE_ENV: "development", FFMPEG_PATH: FFMPEG },
        // The loader executes the route outside Next, where NextResponse is Response.
        mocks: { "next/server": { NextResponse: Response } },
    });
}

function apiRequest(body) {
    return new Request("http://localhost:3120/api/media/last-frame", {
        method: "POST",
        headers: {
            origin: "http://127.0.0.1:3120", host: "127.0.0.1:3120",
            "sec-fetch-site": "same-origin", "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

function videoFixture(id, videoPath) {
    return {
        task_id: id, model_id: "synthetic", media_type: "video", created_at: "2026-01-01T00:00:00Z",
        status: "COMPLETED", lifecycle_phase: "terminal", video_path: videoPath, video_urls: [],
        next_poll_at: null, deadline_at: null, poll_failures: 0, lease_token: null, lease_expires_at: null, deleted_at: null,
    };
}

test("the extractor writes the final frame as a PNG", { skip: withoutFfmpeg }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "last-frame-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const input = await fixtureVideo(dir);
    const { extractLastFrame, hasPngSignature } = environment(dir).load("@/server/media/last-frame");
    const frame = await extractLastFrame(input, path.join(dir, "frame.png"));
    assert.ok(frame.length > 0, "the frame is not empty");
    assert.ok(hasPngSignature(frame), "the extracted frame starts with the PNG signature");
    assert.deepEqual(Buffer.from(frame.subarray(0, 8)), PNG_MAGIC);
    assert.deepEqual(await fs.readFile(path.join(dir, "frame.png")), frame, "the returned bytes are the written file");
});

test("a missing ffmpeg fails with a clear, actionable error", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "last-frame-missing-"));
    try {
        const { extractLastFrame, FFMPEG_MISSING_ERROR } = createModuleLoader({
            env: { FFMPEG_PATH: path.join(dir, "definitely-not-ffmpeg.exe") },
        }).load("@/server/media/last-frame");
        await assert.rejects(
            extractLastFrame(path.join(dir, "input.mp4"), path.join(dir, "frame.png")),
            error => {
                assert.equal(error.code, FFMPEG_MISSING_ERROR);
                assert.match(error.message, /FFMPEG_PATH/);
                return true;
            },
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("PNG validation and the output contract reject wrong inputs without shelling out", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "last-frame-contract-"));
    try {
        const { extractLastFrame, hasPngSignature, LAST_FRAME_INVALID_ERROR } = environment(dir).load("@/server/media/last-frame");
        assert.equal(hasPngSignature(Buffer.from("not a png")), false);
        assert.equal(hasPngSignature(JPEG_MAGIC), false);
        assert.equal(hasPngSignature(Buffer.concat([PNG_MAGIC, Buffer.from("body")])), true);
        await assert.rejects(extractLastFrame(path.join(dir, "input.mp4"), path.join(dir, "frame.jpg")),
            error => error.code === LAST_FRAME_INVALID_ERROR);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("the last-frame route stores a JPEG asset for a completed video", { skip: withoutFfmpeg }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "last-frame-route-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = await fixtureVideo(dir);
    const container = path.join(dir, "downloads", "videos");
    await fs.mkdir(container, { recursive: true });
    const videoPath = path.join(container, "generated.mp4");
    await fs.copyFile(source, videoPath);

    const loader = environment(dir);
    const store = loader.load("@/server/tasks/store");
    const route = loader.load("src/app/api/media/last-frame/route.ts");
    await store.createTask(videoFixture("video-done", videoPath));

    const response = await route.POST(apiRequest({ taskId: "video-done" }));
    assert.equal(response.status, 201, await response.clone().text());
    const body = await response.json();
    assert.match(body.assetId, /^asset_[a-f0-9]{64}$/);
    assert.match(body.url, /^\/api\/uploaded\/[a-f0-9]{64}\.jpg$/);
    assert.equal(body.sourceTaskId, "video-done");
    const stored = await fs.readFile(path.join(dir, "uploads", body.url.split("/").at(-1)));
    assert.deepEqual(stored.subarray(0, 3), JPEG_MAGIC, "the Library asset is a JPEG served by /api/uploaded");
});

test("the last-frame route rejects unknown, image and unfinished videos", { skip: withoutFfmpeg }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "last-frame-errors-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = await fixtureVideo(dir);
    const container = path.join(dir, "downloads", "videos");
    await fs.mkdir(container, { recursive: true });
    const videoPath = path.join(container, "generated.mp4");
    await fs.copyFile(source, videoPath);

    const loader = environment(dir);
    const store = loader.load("@/server/tasks/store");
    const route = loader.load("src/app/api/media/last-frame/route.ts");
    await store.createTask({ ...videoFixture("video-pending", videoPath), status: "IN_PROGRESS" });
    await store.createTask({
        ...videoFixture("image-task", undefined), media_type: "image", video_path: undefined,
        result_urls: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="],
    });

    const unknown = await route.POST(apiRequest({ taskId: "missing-task" }));
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, "ERR_TASK_NOT_FOUND");

    const image = await route.POST(apiRequest({ taskId: "image-task" }));
    assert.equal(image.status, 400);
    assert.equal((await image.json()).error, "ERR_LAST_FRAME_NOT_VIDEO");

    const pending = await route.POST(apiRequest({ taskId: "video-pending" }));
    assert.equal(pending.status, 409);
    assert.equal((await pending.json()).error, "ERR_LAST_FRAME_NOT_READY");

    const malformed = await route.POST(apiRequest({ taskId: "../escape" }));
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, "ERR_LAST_FRAME_INVALID_REQUEST");
});
