import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createModuleLoader } from "./test-module-loader.mjs";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MOVING = "testsrc2=size=160x90:rate=25";
const TONE = (seconds) => `sine=frequency=440:sample_rate=48000:duration=${seconds}`;
const NORMAL_LEVEL = "volume=7.8dB"; // measures -14.0 LUFS, the default target

function binaryWorks(binary) {
    const result = spawnSync(binary, ["-hide_banner", "-version"], { encoding: "utf8" });
    return !result.error && result.status === 0;
}

const TOOLS_READY = binaryWorks(FFMPEG) && binaryWorks(FFPROBE);
const SKIP = TOOLS_READY ? false : `ffmpeg/ffprobe cannot be spawned from Node (${FFMPEG})`;
// Module exports cross the vm realm, so its arrays fail deepStrictEqual's prototype check.
const plain = (value) => JSON.parse(JSON.stringify(value));

const fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "qa-checks-"));
test.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));

function encode(name, args) {
    const target = path.join(fixtureRoot, name);
    const result = spawnSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args, target], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`ffmpeg failed for ${name}: ${result.stderr}`);
    return target;
}

/**
 * Fixtures are deliberately small (160x90, 3-3.5 s) and each carries exactly
 * one crafted defect, so a finding set can be asserted exactly instead of
 * "at least one of".
 */
function buildFixtures() {
    const still = (colour, enable) => `drawbox=x=0:y=0:w=iw:h=ih:color=${colour}:t=fill:enable='${enable}'`;
    return {
        clean: encode("clean.mp4", [
            "-f", "lavfi", "-i", `${MOVING}:duration=3`,
            "-f", "lavfi", "-i", TONE(3),
            "-af", NORMAL_LEVEL,
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "aac", "-shortest",
        ]),
        black: encode("black.mp4", [
            "-f", "lavfi", "-i", `${MOVING}:duration=3`,
            "-f", "lavfi", "-i", TONE(3),
            "-vf", still("black", "between(t,1,2)"),
            "-af", NORMAL_LEVEL,
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "aac", "-shortest",
        ]),
        frozen: encode("frozen.mp4", [
            "-f", "lavfi", "-i", `${MOVING}:duration=3`,
            "-f", "lavfi", "-i", TONE(3),
            "-vf", still("gray", "between(t,1,2)"),
            "-af", NORMAL_LEVEL,
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "aac", "-shortest",
        ]),
        flash: encode("flash.mp4", [
            "-f", "lavfi", "-i", `${MOVING}:duration=3`,
            "-f", "lavfi", "-i", TONE(3),
            "-vf", still("white", "between(t,2,2.2)"),
            "-af", NORMAL_LEVEL,
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "aac", "-shortest",
        ]),
        silent: encode("silent.mp4", [
            "-f", "lavfi", "-i", `${MOVING}:duration=3.5`,
            "-f", "lavfi", "-i", TONE(1),
            "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1.5",
            "-f", "lavfi", "-i", TONE(1),
            "-filter_complex", `[1:a]${NORMAL_LEVEL}[a1];[2:a]anull[a2];[3:a]${NORMAL_LEVEL}[a3];[a1][a2][a3]concat=n=3:v=0:a=1[a]`,
            "-map", "0:v", "-map", "[a]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "aac", "-shortest",
        ]),
        trailing: encode("trailing.mp4", [
            "-f", "lavfi", "-i", `${MOVING}:duration=3`,
            "-f", "lavfi", "-i", TONE(1),
            "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=2",
            "-filter_complex", `[1:a]${NORMAL_LEVEL}[a1];[a1][2:a]concat=n=2:v=0:a=1[a]`,
            "-map", "0:v", "-map", "[a]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "aac", "-shortest",
        ]),
        quiet: encode("quiet.mp4", [
            "-f", "lavfi", "-i", `${MOVING}:duration=3`,
            "-f", "lavfi", "-i", TONE(3),
            "-af", "volume=-5dB",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "aac", "-shortest",
        ]),
        audioOnly: encode("tone.m4a", [
            "-f", "lavfi", "-i", TONE(2),
            "-af", NORMAL_LEVEL,
            "-c:a", "aac",
        ]),
    };
}

const fixtures = TOOLS_READY ? buildFixtures() : undefined;

function harness() {
    const env = { ...process.env, OPEN_HIGGSFIELD_STORAGE_DIR: fixtureRoot, NODE_ENV: "development" };
    return createModuleLoader({ env }).load("@/server/qa/checks");
}

const qa = TOOLS_READY ? harness() : undefined;

function typesOf(report) {
    return plain(report.findings.map((finding) => finding.type));
}

function assertWindow(finding, start, end, tolerance = 0.2) {
    assert.ok(
        Math.abs(finding.tStart - start) <= tolerance,
        `${finding.type} tStart ${finding.tStart} is not ${start} ±${tolerance}`,
    );
    assert.ok(
        Math.abs(finding.tEnd - end) <= tolerance,
        `${finding.type} tEnd ${finding.tEnd} is not ${end} ±${tolerance}`,
    );
}

test("runQa reports nothing for a clean clip and writes a real PNG contact sheet", { skip: SKIP }, async () => {
    const report = await qa.runQa(fixtures.clean);
    assert.deepEqual(plain(report.findings), []);
    assert.equal(report.hasVideo, true);
    assert.equal(report.hasAudio, true);
    assert.ok(Math.abs(report.durationSeconds - 3) <= 0.1, `duration ${report.durationSeconds}`);
    assert.equal(report.contactSheetPath, path.join(fixtureRoot, "clean.contact-sheet.png"));

    const sheet = await fs.readFile(report.contactSheetPath);
    assert.deepEqual([...sheet.subarray(0, 8)], PNG_SIGNATURE, "contact sheet must be a PNG");
    assert.ok(sheet.length > 1000, "contact sheet must contain image data");
    const probe = spawnSync(FFPROBE, [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,codec_name", "-of", "csv=p=0", report.contactSheetPath,
    ], { encoding: "utf8" });
    assert.equal(probe.stdout.trim(), "png,1280,720");

    const second = await qa.runQa(fixtures.clean);
    assert.deepEqual(plain(second.findings), plain(report.findings), "repeated runs must report the same findings");
});

test("blackdetect flags the crafted black hold with its window", { skip: SKIP }, async () => {
    const report = await qa.runQa(fixtures.black);
    assert.deepEqual(typesOf(report), ["black"]);
    const [finding] = report.findings;
    assert.equal(finding.severity, "error");
    assertWindow(finding, 1, 2);
    assert.match(finding.detail, /black frames for 1\.0\d*s/);
});

test("frame-hash equality flags the crafted frozen hold and not the moving bars", { skip: SKIP }, async () => {
    const report = await qa.runQa(fixtures.frozen);
    assert.deepEqual(typesOf(report), ["frozen"]);
    const [finding] = report.findings;
    assert.equal(finding.severity, "error");
    assertWindow(finding, 1, 2);
    assert.match(finding.detail, /identical frame hash [0-9a-f]{8} repeated \d+ times at 10 fps/);
});

test("scene-delta pairing reports one flash burst and ignores ordinary cuts", { skip: SKIP }, async () => {
    const report = await qa.runQa(fixtures.flash);
    assert.deepEqual(typesOf(report), ["flash"]);
    const [finding] = report.findings;
    assert.equal(finding.severity, "warning");
    assertWindow(finding, 2, 2.24, 0.12);
    assert.match(finding.detail, /scene delta \d+\.\d-\d+\.\d over 0\.2\d*s/);
});

test("silencedetect flags the dropout and closes a run that reaches EOF", { skip: SKIP }, async () => {
    const middle = await qa.runQa(fixtures.silent);
    assert.deepEqual(typesOf(middle), ["silence"]);
    assert.equal(middle.findings[0].severity, "warning");
    assertWindow(middle.findings[0], 1, 2.5);
    assert.match(middle.findings[0].detail, /audio below -35dB for 1\.5\d*s/);

    const trailing = await qa.runQa(fixtures.trailing);
    assert.deepEqual(typesOf(trailing), ["silence"]);
    assertWindow(trailing.findings[0], 1, trailing.durationSeconds, 0.05);
    assert.equal(trailing.findings[0].tEnd, trailing.durationSeconds);
});

test("loudnorm flags a clip away from the -14 LUFS target and accepts an on-target one", { skip: SKIP }, async () => {
    const quiet = await qa.runQa(fixtures.quiet);
    assert.deepEqual(typesOf(quiet), ["loudness"]);
    assert.equal(quiet.findings[0].severity, "warning");
    assertWindow(quiet.findings[0], 0, quiet.durationSeconds, 0.05);
    const measured = /integrated (-?\d+\.\d) LUFS is (-?\d+\.\d) LU from -14\.0 LUFS/.exec(quiet.findings[0].detail);
    assert.ok(measured, quiet.findings[0].detail);
    assert.ok(Number(measured[1]) < -16, `quiet clip measures ${measured[1]} LUFS`);
    assert.ok(Number(measured[2]) < -2, `deviation ${measured[2]} LU must exceed the 2 LU tolerance`);

    const custom = await qa.runQa(fixtures.clean, { loudness: { targetLufs: -24, toleranceLu: 1 } });
    assert.deepEqual(typesOf(custom), ["loudness"], "the target is honoured rather than hard-coded");
    assert.match(custom.findings[0].detail, /from -24\.0 LUFS/);
});

test("duration is compared with a supplied storyboard total inside a tolerance", { skip: SKIP }, async () => {
    const mismatch = await qa.runQa(fixtures.clean, { storyboardTotalSeconds: 5 });
    assert.deepEqual(typesOf(mismatch), ["duration"]);
    assert.equal(mismatch.findings[0].severity, "error");
    assert.equal(mismatch.findings[0].tStart, 0);
    assert.match(mismatch.findings[0].detail, /storyboard total of 5\.000s \(-2\.000s\)/);

    const inside = await qa.runQa(fixtures.clean, { storyboardTotalSeconds: 3.2 });
    assert.deepEqual(plain(inside.findings), [], "a 0.2 s difference is inside the 0.5 s tolerance");
    const tightened = await qa.runQa(fixtures.clean, { storyboardTotalSeconds: 3.2, durationToleranceSeconds: 0.05 });
    assert.deepEqual(typesOf(tightened), ["duration"]);
});

test("threshold options are wired, not decorative", { skip: SKIP }, async () => {
    const lenient = await qa.runQa(fixtures.black, { black: { minSeconds: 3 } });
    assert.deepEqual(plain(lenient.findings), []);
    const strictFreeze = await qa.runQa(fixtures.frozen, { freeze: { minSeconds: 3 } });
    assert.deepEqual(plain(strictFreeze.findings), []);
    const noFlash = await qa.runQa(fixtures.flash, { flash: { scoreThreshold: 100 } });
    assert.deepEqual(plain(noFlash.findings), []);
    const loud = await qa.runQa(fixtures.silent, { silence: { minSeconds: 2 } });
    assert.deepEqual(plain(loud.findings), [], "a 1.5 s dropout must not clear a 2 s floor");
});

test("contact sheet honours a custom path and grid", { skip: SKIP }, async () => {
    const target = path.join(fixtureRoot, "nested", "sheet.png");
    const report = await qa.runQa(fixtures.frozen, {
        contactSheetPath: target,
        contactSheet: { columns: 2, rows: 1, width: 64, height: 36 },
    });
    assert.equal(report.contactSheetPath, target);
    const sheet = await fs.readFile(target);
    assert.deepEqual([...sheet.subarray(0, 8)], PNG_SIGNATURE);
    const probe = spawnSync(FFPROBE, [
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", target,
    ], { encoding: "utf8" });
    assert.equal(probe.stdout.trim(), "128,36", "two 64-wide tiles in one row");
});

test("an audio-only asset skips visual checks without failing", { skip: SKIP }, async () => {
    const report = await qa.runQa(fixtures.audioOnly);
    assert.equal(report.hasVideo, false);
    assert.equal(report.hasAudio, true);
    assert.equal(report.contactSheetPath, "");
    assert.deepEqual(plain(report.findings), []);
    assert.ok(Math.abs(report.durationSeconds - 2) <= 0.1);
});

test("a missing binary surfaces ERR_QA_FFMPEG_MISSING instead of crashing", { skip: SKIP }, async () => {
    await assert.rejects(
        qa.runQa(fixtures.clean, { ffprobePath: "hermes-ffprobe-not-installed" }),
        /ERR_QA_FFMPEG_MISSING/,
    );
    // ffprobe succeeds here, so this exercises the ffmpeg launch path itself.
    await assert.rejects(
        qa.runQa(fixtures.clean, { ffmpegPath: "hermes-ffmpeg-not-installed" }),
        (error) => error.code === "ERR_QA_FFMPEG_MISSING" && /ffmpeg/.test(error.message),
    );
});

test("missing inputs and invalid options are rejected before any media work", { skip: SKIP }, async () => {
    await assert.rejects(
        qa.runQa(path.join(fixtureRoot, "absent.mp4")),
        (error) => error.code === "ERR_QA_INPUT_MISSING",
    );
    await assert.rejects(qa.runQa(fixtureRoot), (error) => error.code === "ERR_QA_INPUT_MISSING");
    await assert.rejects(
        qa.runQa(fixtures.clean, { storyboardTotalSeconds: -1 }),
        (error) => error.code === "ERR_QA_INVALID",
    );
    await assert.rejects(
        qa.runQa(fixtures.clean, { contactSheetPath: "" }),
        (error) => error.code === "ERR_QA_INVALID",
    );
});
