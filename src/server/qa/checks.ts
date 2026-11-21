import "server-only";

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Automated QA for generated clips.
 *
 * Every check is ffmpeg/ffprobe based and reports one finding type per defect
 * class so a delivery gate can decide what blocks a render:
 *
 *  - `black`    blackdetect runs longer than `black.minSeconds`
 *  - `frozen`   runs of byte-identical sampled frames (framehash MD5)
 *  - `silence`  silencedetect dropouts longer than `silence.minSeconds`
 *  - `flash`    paired scene-change bursts above `flash.scoreThreshold`
 *  - `loudness` programme loudness away from `loudness.targetLufs`
 *  - `duration` decoded duration away from a supplied storyboard total
 *
 * A missing ffmpeg/ffprobe binary is reported as `ERR_QA_FFMPEG_MISSING`
 * instead of surfacing a raw ENOENT or a rejected promise from `spawn`.
 */

export const QA_FFMPEG_MISSING_ERROR = "ERR_QA_FFMPEG_MISSING";
export const QA_INPUT_MISSING_ERROR = "ERR_QA_INPUT_MISSING";
export const QA_FAILED_ERROR = "ERR_QA_FAILED";
export const QA_INVALID_ERROR = "ERR_QA_INVALID";

export type QaFindingType = "black" | "frozen" | "silence" | "flash" | "loudness" | "duration";
export type QaSeverity = "error" | "warning" | "info";

export interface QaFinding {
    type: QaFindingType;
    severity: QaSeverity;
    /** Start of the defect in decoded media seconds; 0 for whole-file findings. */
    tStart: number;
    /** End of the defect in decoded media seconds; `durationSeconds` for whole-file findings. */
    tEnd: number;
    /** Human-readable evidence, stable across runs of the same input. */
    detail: string;
}

export interface QaReport {
    inputPath: string;
    durationSeconds: number;
    hasVideo: boolean;
    hasAudio: boolean;
    /** Empty only when the input has no video stream; otherwise a PNG on disk. */
    contactSheetPath: string;
    findings: QaFinding[];
}

export interface QaBlackOptions {
    /** Shortest black run to report, in seconds. */
    minSeconds?: number;
    /** blackdetect `pix_th`: fraction of luma below which a pixel counts as black. */
    pixelThreshold?: number;
}

export interface QaFreezeOptions {
    /** Shortest run of identical frames to report, in seconds. */
    minSeconds?: number;
    /** Sampling rate for the frame-hash comparison. */
    sampleFps?: number;
}

export interface QaSilenceOptions {
    /** silencedetect `n`: level below which audio counts as silence. */
    noiseDb?: number;
    /** Shortest dropout to report, in seconds. */
    minSeconds?: number;
}

export interface QaFlashOptions {
    /** scdet score (0-100 mean absolute frame difference) that starts a burst. */
    scoreThreshold?: number;
    /** Two events are one burst when they are at most this far apart. */
    burstSeconds?: number;
}

export interface QaLoudnessOptions {
    targetLufs?: number;
    toleranceLu?: number;
}

export interface QaContactSheetOptions {
    columns?: number;
    rows?: number;
    width?: number;
    height?: number;
}

export interface QaOptions {
    ffmpegPath?: string;
    ffprobePath?: string;
    black?: QaBlackOptions;
    freeze?: QaFreezeOptions;
    silence?: QaSilenceOptions;
    flash?: QaFlashOptions;
    loudness?: QaLoudnessOptions;
    /** Sum of the storyboard panel durations; enables the `duration` check. */
    storyboardTotalSeconds?: number;
    durationToleranceSeconds?: number;
    contactSheetPath?: string;
    contactSheet?: QaContactSheetOptions;
    /** Per-command timeout in milliseconds. */
    commandTimeoutMs?: number;
}

const DEFAULTS = {
    black: { minSeconds: 0.5, pixelThreshold: 0.1 },
    freeze: { minSeconds: 0.5, sampleFps: 10 },
    silence: { noiseDb: -35, minSeconds: 0.4 },
    flash: { scoreThreshold: 25, burstSeconds: 0.5 },
    loudness: { targetLufs: -14, toleranceLu: 2 },
    contactSheet: { columns: 4, rows: 4, width: 320, height: 180 },
    durationToleranceSeconds: 0.5,
    commandTimeoutMs: 120_000,
} as const;

const MAX_CAPTURE_CHARS = 16 * 1024 * 1024;
const EVIDENCE_EPSILON = 1e-9;

interface CommandResult {
    stdout: string;
    stderr: string;
}

interface MediaInfo {
    durationSeconds: number;
    hasVideo: boolean;
    hasAudio: boolean;
}

function qaError(code: string, detail?: string): Error {
    const error = new Error(detail ? `${code}: ${detail}` : code);
    (error as Error & { code?: string }).code = code;
    return error;
}

function seconds(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function fixed(value: number, digits = 3): string {
    return Number.isFinite(value) ? value.toFixed(digits) : String(value);
}

function numberOption(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        throw qaError(QA_INVALID_ERROR, `${name} must be a number between ${min} and ${max}`);
    }
    return value;
}

function integerOption(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
    const resolved = numberOption(value, fallback, name, min, max);
    if (!Number.isInteger(resolved)) throw qaError(QA_INVALID_ERROR, `${name} must be an integer`);
    return resolved;
}

interface ResolvedOptions {
    ffmpegPath: string;
    ffprobePath: string;
    black: { minSeconds: number; pixelThreshold: number };
    freeze: { minSeconds: number; sampleFps: number };
    silence: { noiseDb: number; minSeconds: number };
    flash: { scoreThreshold: number; burstSeconds: number };
    loudness: { targetLufs: number; toleranceLu: number };
    contactSheet: { columns: number; rows: number; width: number; height: number };
    durationToleranceSeconds: number;
    commandTimeoutMs: number;
    storyboardTotalSeconds: number | undefined;
    contactSheetPath: string | undefined;
}

function resolveOptions(options: QaOptions): ResolvedOptions {
    if (!options || typeof options !== "object") throw qaError(QA_INVALID_ERROR, "options must be an object");
    const storyboardTotalSeconds = options.storyboardTotalSeconds === undefined
        ? undefined
        : numberOption(options.storyboardTotalSeconds, 0, "storyboardTotalSeconds", EVIDENCE_EPSILON, 86_400);
    if (options.contactSheetPath !== undefined && (typeof options.contactSheetPath !== "string" || !options.contactSheetPath)) {
        throw qaError(QA_INVALID_ERROR, "contactSheetPath must be a non-empty string");
    }
    if (options.ffmpegPath !== undefined && (typeof options.ffmpegPath !== "string" || !options.ffmpegPath)) {
        throw qaError(QA_INVALID_ERROR, "ffmpegPath must be a non-empty string");
    }
    if (options.ffprobePath !== undefined && (typeof options.ffprobePath !== "string" || !options.ffprobePath)) {
        throw qaError(QA_INVALID_ERROR, "ffprobePath must be a non-empty string");
    }
    return {
        ffmpegPath: options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg",
        ffprobePath: options.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe",
        black: {
            minSeconds: numberOption(options.black?.minSeconds, DEFAULTS.black.minSeconds, "black.minSeconds", 0, 600),
            pixelThreshold: numberOption(options.black?.pixelThreshold, DEFAULTS.black.pixelThreshold, "black.pixelThreshold", 0.01, 1),
        },
        freeze: {
            minSeconds: numberOption(options.freeze?.minSeconds, DEFAULTS.freeze.minSeconds, "freeze.minSeconds", EVIDENCE_EPSILON, 600),
            sampleFps: integerOption(options.freeze?.sampleFps, DEFAULTS.freeze.sampleFps, "freeze.sampleFps", 1, 60),
        },
        silence: {
            noiseDb: numberOption(options.silence?.noiseDb, DEFAULTS.silence.noiseDb, "silence.noiseDb", -120, 0),
            minSeconds: numberOption(options.silence?.minSeconds, DEFAULTS.silence.minSeconds, "silence.minSeconds", 0, 600),
        },
        flash: {
            scoreThreshold: numberOption(options.flash?.scoreThreshold, DEFAULTS.flash.scoreThreshold, "flash.scoreThreshold", 0, 100),
            burstSeconds: numberOption(options.flash?.burstSeconds, DEFAULTS.flash.burstSeconds, "flash.burstSeconds", EVIDENCE_EPSILON, 60),
        },
        loudness: {
            targetLufs: numberOption(options.loudness?.targetLufs, DEFAULTS.loudness.targetLufs, "loudness.targetLufs", -70, 0),
            toleranceLu: numberOption(options.loudness?.toleranceLu, DEFAULTS.loudness.toleranceLu, "loudness.toleranceLu", 0.1, 60),
        },
        contactSheet: {
            columns: integerOption(options.contactSheet?.columns, DEFAULTS.contactSheet.columns, "contactSheet.columns", 1, 10),
            rows: integerOption(options.contactSheet?.rows, DEFAULTS.contactSheet.rows, "contactSheet.rows", 1, 10),
            width: integerOption(options.contactSheet?.width, DEFAULTS.contactSheet.width, "contactSheet.width", 16, 1920),
            height: integerOption(options.contactSheet?.height, DEFAULTS.contactSheet.height, "contactSheet.height", 16, 1920),
        },
        durationToleranceSeconds: numberOption(
            options.durationToleranceSeconds,
            DEFAULTS.durationToleranceSeconds,
            "durationToleranceSeconds",
            0,
            600,
        ),
        commandTimeoutMs: integerOption(options.commandTimeoutMs, DEFAULTS.commandTimeoutMs, "commandTimeoutMs", 1000, 1_800_000),
        storyboardTotalSeconds,
        contactSheetPath: options.contactSheetPath,
    };
}

/**
 * Runs one ffmpeg/ffprobe command and captures both pipes.
 * A binary that cannot be launched at all (ENOENT/EACCES on Windows) is
 * reported as ERR_QA_FFMPEG_MISSING so callers can distinguish "QA tooling
 * is not installed" from "this clip failed a check".
 */
async function runCommand(binary: string, args: readonly string[], options: { timeoutMs: number; cwd?: string }): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
        let child: ChildProcess;
        try {
            child = spawn(binary, [...args], {
                cwd: options.cwd,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error) {
            reject(qaError(QA_FFMPEG_MISSING_ERROR, `${path.basename(binary)} could not be started (${(error as Error).message})`));
            return;
        }
        let stdout = "";
        let stderr = "";
        let settled = false;
        const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
        const finish = (operation: () => void): void => {
            if (settled) return;
            settled = true;
            if (deadline.timer !== undefined) clearTimeout(deadline.timer);
            operation();
        };
        deadline.timer = setTimeout(() => {
            finish(() => {
                child.kill();
                reject(qaError(QA_FAILED_ERROR, `${path.basename(binary)} timed out after ${options.timeoutMs}ms`));
            });
        }, options.timeoutMs);
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
            if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk;
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
            finish(() => {
                const detail = `${path.basename(binary)} at "${binary}"`;
                // Windows reports a blocked executable (for example one installed
                // under WindowsApps) as EPERM, not EACCES, so both mean "cannot launch".
                reject(error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM"
                    ? qaError(QA_FFMPEG_MISSING_ERROR, `${detail} is not installed or not executable`)
                    : qaError(QA_FAILED_ERROR, `${detail} failed: ${error.message}`));
            });
        });
        child.on("close", (code) => {
            finish(() => {
                if (code === 0) resolve({ stdout, stderr });
                else reject(qaError(QA_FAILED_ERROR, `${path.basename(binary)} exited with ${code ?? "no"} status: ${stderr.trim().split(/\r?\n/).slice(-3).join(" | ")}`));
            });
        });
    });
}

/** Decoded duration plus stream presence; ffprobe reads containers Next also accepts. */
async function probeMedia(resolved: ResolvedOptions, inputPath: string): Promise<MediaInfo> {
    const result = await runCommand(resolved.ffprobePath, [
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        inputPath,
    ], { timeoutMs: resolved.commandTimeoutMs });
    let parsed: {
        format?: { duration?: string };
        streams?: Array<{ codec_type?: string; duration?: string }>;
    };
    try {
        parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
        throw qaError(QA_FAILED_ERROR, "ffprobe returned unreadable JSON");
    }
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const hasVideo = streams.some((stream) => stream.codec_type === "video");
    const hasAudio = streams.some((stream) => stream.codec_type === "audio");
    const candidates = [
        Number(parsed.format?.duration),
        ...streams.map((stream) => Number(stream.duration)),
    ].filter((value) => Number.isFinite(value) && value > 0);
    const durationSeconds = candidates.length > 0 ? Math.max(...candidates) : 0;
    if (durationSeconds <= 0) throw qaError(QA_FAILED_ERROR, "ffprobe reported no usable duration");
    return { durationSeconds, hasVideo, hasAudio };
}

interface BlackInterval {
    tStart: number;
    tEnd: number;
}

function parseBlackIntervals(stderr: string, durationSeconds: number): BlackInterval[] {
    const intervals: BlackInterval[] = [];
    let pendingStart: number | undefined;
    for (const line of stderr.split(/\r?\n/)) {
        const start = /black_start:\s*([0-9.]+)/.exec(line);
        if (start) pendingStart = Number(start[1]);
        const end = /black_end:\s*([0-9.]+)/.exec(line);
        if (end && pendingStart !== undefined) {
            intervals.push({ tStart: pendingStart, tEnd: Number(end[1]) });
            pendingStart = undefined;
        }
    }
    // blackdetect prints only the start when the clip ends while still black.
    if (pendingStart !== undefined) intervals.push({ tStart: pendingStart, tEnd: durationSeconds });
    return intervals
        .filter((interval) => Number.isFinite(interval.tStart) && Number.isFinite(interval.tEnd) && interval.tEnd > interval.tStart)
        .map((interval) => ({ tStart: seconds(interval.tStart), tEnd: seconds(interval.tEnd) }));
}

interface SilenceInterval {
    tStart: number;
    tEnd: number;
}

function parseSilenceIntervals(stderr: string, durationSeconds: number): SilenceInterval[] {
    const intervals: SilenceInterval[] = [];
    let pendingStart: number | undefined;
    for (const line of stderr.split(/\r?\n/)) {
        const start = /silence_start:\s*(-?[0-9.]+)/.exec(line);
        if (start) pendingStart = Number(start[1]);
        const end = /silence_end:\s*(-?[0-9.]+)/.exec(line);
        if (end && pendingStart !== undefined) {
            intervals.push({ tStart: pendingStart, tEnd: Number(end[1]) });
            pendingStart = undefined;
        }
    }
    // Silence that reaches EOF is reported with a start and no end.
    if (pendingStart !== undefined) intervals.push({ tStart: pendingStart, tEnd: durationSeconds });
    return intervals
        .filter((interval) => Number.isFinite(interval.tStart) && Number.isFinite(interval.tEnd) && interval.tEnd > interval.tStart)
        .map((interval) => ({
            tStart: seconds(Math.max(0, interval.tStart)),
            tEnd: seconds(Math.min(durationSeconds, interval.tEnd)),
        }));
}

interface SceneEvent {
    t: number;
    score: number;
}

function parseSceneEvents(stderr: string): SceneEvent[] {
    const events: SceneEvent[] = [];
    const pattern = /lavfi\.scd\.score:\s*([0-9.]+),\s*lavfi\.scd\.time:\s*(-?[0-9.]+)/;
    for (const line of stderr.split(/\r?\n/)) {
        const match = pattern.exec(line);
        if (!match) continue;
        const score = Number(match[1]);
        const t = Number(match[2]);
        if (Number.isFinite(score) && Number.isFinite(t)) events.push({ t, score });
    }
    return events.sort((a, b) => a.t - b.t);
}

/**
 * A hard cut produces one high-score frame; a flash produces two (into the
 * bright frame and back out). Only the paired form is reported, so ordinary
 * edits inside a clip do not read as camera flashes.
 */
function flashBursts(events: readonly SceneEvent[], threshold: number, burstSeconds: number): Array<{ tStart: number; tEnd: number; high: number; low: number }> {
    const hot = events.filter((event) => event.score >= threshold);
    const bursts: Array<{ tStart: number; tEnd: number; high: number; low: number }> = [];
    for (let index = 0; index < hot.length; index += 1) {
        const opening = hot[index];
        const closing = hot[index + 1];
        if (!closing) break;
        if (closing.t - opening.t <= burstSeconds + EVIDENCE_EPSILON) {
            const pair = [opening.score, closing.score];
            bursts.push({
                tStart: seconds(opening.t),
                tEnd: seconds(closing.t),
                high: Math.max(...pair),
                low: Math.min(...pair),
            });
            index += 1;
        }
    }
    return bursts;
}

interface FrameSample {
    t: number;
    hash: string;
}

function parseFrameHashes(stdout: string): { frameSeconds: number; samples: FrameSample[] } {
    let timebase = 0;
    const samples: FrameSample[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith("#tb ")) {
            const match = /^#tb\s+0:\s*(\d+)\/(\d+)/.exec(line);
            if (match) timebase = Number(match[1]) / Number(match[2]);
            continue;
        }
        if (!line || line.startsWith("#")) continue;
        const cells = line.split(",").map((cell) => cell.trim());
        if (cells.length < 6) continue;
        const pts = Number(cells[2]);
        const hash = cells[5];
        if (!Number.isFinite(pts) || !hash) continue;
        samples.push({ t: pts * (timebase || 1), hash });
    }
    return { frameSeconds: timebase || 0, samples };
}

function overlaps(start: number, end: number, interval: BlackInterval): boolean {
    return start < interval.tEnd - EVIDENCE_EPSILON && end > interval.tStart + EVIDENCE_EPSILON;
}

/**
 * Reports runs of identical sampled frames. Runs that sit inside a black
 * interval are dropped: blackdetect already names that defect, and a black
 * hold otherwise reads as both "black" and "frozen" for the same seconds.
 */
function frozenRuns(
    samples: readonly FrameSample[],
    frameSeconds: number,
    minSeconds: number,
    blacks: readonly BlackInterval[],
): Array<{ tStart: number; tEnd: number; hash: string; length: number }> {
    if (samples.length === 0 || frameSeconds <= 0) return [];
    const runs: Array<{ tStart: number; tEnd: number; hash: string; length: number }> = [];
    let start = 0;
    for (let index = 1; index <= samples.length; index += 1) {
        if (index < samples.length && samples[index].hash === samples[start].hash) continue;
        const length = index - start;
        const tStart = samples[start].t;
        const tEnd = samples[index - 1].t + frameSeconds;
        if (length * frameSeconds + EVIDENCE_EPSILON >= minSeconds && tEnd - tStart > 0) {
            if (!blacks.some((interval) => overlaps(tStart, tEnd, interval))) {
                runs.push({ tStart: seconds(tStart), tEnd: seconds(tEnd), hash: samples[start].hash, length });
            }
        }
        start = index;
    }
    return runs;
}

function parseLoudnorm(stderr: string): { inputI: number; inputTp: number; inputLra: number } | undefined {
    const blocks = stderr.match(/\{[\s\S]*?\}/g);
    if (!blocks) return undefined;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        try {
            const parsed = JSON.parse(blocks[index]) as { input_i?: string; input_tp?: string; input_lra?: string };
            if (parsed.input_i === undefined) continue;
            return {
                inputI: Number(parsed.input_i),
                inputTp: Number(parsed.input_tp ?? NaN),
                inputLra: Number(parsed.input_lra ?? NaN),
            };
        } catch {
            continue;
        }
    }
    return undefined;
}

function contactSheetRate(durationSeconds: number, frames: number): number {
    // One sample per tile: 16 tiles over a 4 s clip is 4 fps, over 90 s is 0.18 fps.
    return Math.max(frames / Math.max(durationSeconds, EVIDENCE_EPSILON), 0.01);
}

async function buildContactSheet(resolved: ResolvedOptions, inputPath: string, durationSeconds: number, target: string): Promise<string> {
    const { columns, rows, width, height } = resolved.contactSheet;
    const frames = columns * rows;
    const rate = contactSheetRate(durationSeconds, frames);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await runCommand(resolved.ffmpegPath, [
        "-hide_banner", "-nostats", "-v", "error", "-y",
        "-i", inputPath,
        "-an",
        "-vf", `fps=${rate.toFixed(6)},scale=${width}:${height},tile=${columns}x${rows}`,
        "-frames:v", "1",
        target,
    ], { timeoutMs: resolved.commandTimeoutMs });
    return target;
}

/**
 * Runs every check against one media file.
 *
 * `inputPath` is read, never written; the contact sheet is the only output and
 * defaults to `<input basename>.contact-sheet.png` beside the input.
 */
export async function runQa(inputPath: string, options: QaOptions = {}): Promise<QaReport> {
    if (typeof inputPath !== "string" || !inputPath) throw qaError(QA_INVALID_ERROR, "inputPath must be a non-empty string");
    const resolved = resolveOptions(options);
    const absoluteInput = path.resolve(inputPath);
    let stats;
    try {
        stats = await fs.stat(absoluteInput);
    } catch (error) {
        throw (error as NodeJS.ErrnoException).code === "ENOENT"
            ? qaError(QA_INPUT_MISSING_ERROR, absoluteInput)
            : qaError(QA_FAILED_ERROR, `cannot read ${absoluteInput}`);
    }
    if (!stats.isFile()) throw qaError(QA_INPUT_MISSING_ERROR, `${absoluteInput} is not a file`);

    // ffprobe first: it proves the toolchain exists before any filter runs.
    const media = await probeMedia(resolved, absoluteInput);
    const findings: QaFinding[] = [];

    const videoPass = media.hasVideo
        ? runCommand(resolved.ffmpegPath, [
            "-hide_banner", "-nostats", "-v", "info",
            "-i", absoluteInput,
            "-an",
            // Detection stays at a fixed floor; `black.minSeconds` only filters
            // reporting. Otherwise raising the black threshold would also stop
            // suppressing the same hold as a frozen run.
            `-vf`, `blackdetect=d=${Math.min(0.1, resolved.black.minSeconds)}:pix_th=${resolved.black.pixelThreshold},scdet=s=1:t=0`,
            "-f", "null", "-",
        ], { timeoutMs: resolved.commandTimeoutMs })
        : undefined;

    const audioPass = media.hasAudio
        ? runCommand(resolved.ffmpegPath, [
            "-hide_banner", "-nostats", "-v", "info",
            "-i", absoluteInput,
            "-vn",
            "-af", `silencedetect=n=${resolved.silence.noiseDb}dB:d=${resolved.silence.minSeconds}`,
            "-f", "null", "-",
        ], { timeoutMs: resolved.commandTimeoutMs })
        : undefined;

    const loudnessPass = media.hasAudio
        ? runCommand(resolved.ffmpegPath, [
            "-hide_banner", "-nostats", "-v", "info",
            "-i", absoluteInput,
            "-vn",
            "-af", "loudnorm=print_format=json",
            "-f", "null", "-",
        ], { timeoutMs: resolved.commandTimeoutMs })
        : undefined;

    const hashPass = media.hasVideo
        ? runCommand(resolved.ffmpegPath, [
            "-hide_banner", "-nostats", "-v", "error",
            "-i", absoluteInput,
            "-an",
            "-vf", `fps=${resolved.freeze.sampleFps},scale=32:18,format=gray`,
            "-f", "framehash", "-hash", "md5", "-",
        ], { timeoutMs: resolved.commandTimeoutMs })
        : undefined;

    const [videoResult, audioResult, loudnessResult, hashResult] = await Promise.all([
        videoPass, audioPass, loudnessPass, hashPass,
    ]);

    const blacks = videoResult ? parseBlackIntervals(videoResult.stderr, media.durationSeconds) : [];
    for (const interval of blacks) {
        const duration = interval.tEnd - interval.tStart;
        if (duration + EVIDENCE_EPSILON >= resolved.black.minSeconds) {
            findings.push({
                type: "black",
                severity: "error",
                tStart: interval.tStart,
                tEnd: interval.tEnd,
                detail: `black frames for ${fixed(duration)}s (pix_th ${resolved.black.pixelThreshold})`,
            });
        }
    }

    if (hashResult) {
        const { frameSeconds, samples } = parseFrameHashes(hashResult.stdout);
        for (const run of frozenRuns(samples, frameSeconds, resolved.freeze.minSeconds, blacks)) {
            findings.push({
                type: "frozen",
                severity: "error",
                tStart: run.tStart,
                tEnd: run.tEnd,
                detail: `identical frame hash ${run.hash.slice(0, 8)} repeated ${run.length} times at ${resolved.freeze.sampleFps} fps`,
            });
        }
    }

    if (videoResult) {
        for (const burst of flashBursts(parseSceneEvents(videoResult.stderr), resolved.flash.scoreThreshold, resolved.flash.burstSeconds)) {
            findings.push({
                type: "flash",
                severity: "warning",
                tStart: burst.tStart,
                tEnd: burst.tEnd,
                detail: `scene delta ${fixed(burst.low, 1)}-${fixed(burst.high, 1)} over ${fixed(burst.tEnd - burst.tStart)}s`,
            });
        }
    }

    if (audioResult) {
        for (const interval of parseSilenceIntervals(audioResult.stderr, media.durationSeconds)) {
            const duration = interval.tEnd - interval.tStart;
            if (duration + EVIDENCE_EPSILON >= resolved.silence.minSeconds) {
                findings.push({
                    type: "silence",
                    severity: "warning",
                    tStart: interval.tStart,
                    tEnd: interval.tEnd,
                    detail: `audio below ${resolved.silence.noiseDb}dB for ${fixed(duration)}s`,
                });
            }
        }
    }

    if (loudnessResult) {
        const loudness = parseLoudnorm(loudnessResult.stderr);
        if (!loudness) throw qaError(QA_FAILED_ERROR, "loudnorm printed no measurable loudness block");
        const deviation = loudness.inputI - resolved.loudness.targetLufs;
        if (!Number.isFinite(loudness.inputI)) {
            findings.push({
                type: "loudness",
                severity: "warning",
                tStart: 0,
                tEnd: seconds(media.durationSeconds),
                detail: `programme loudness is unmeasurable (input_i ${String(loudness.inputI)}) against ${fixed(resolved.loudness.targetLufs, 1)} LUFS`,
            });
        } else if (Math.abs(deviation) > resolved.loudness.toleranceLu + EVIDENCE_EPSILON) {
            findings.push({
                type: "loudness",
                severity: "warning",
                tStart: 0,
                tEnd: seconds(media.durationSeconds),
                detail: `integrated ${fixed(loudness.inputI, 1)} LUFS is ${fixed(deviation, 1)} LU from ${fixed(resolved.loudness.targetLufs, 1)} LUFS`,
            });
        }
    }

    if (resolved.storyboardTotalSeconds !== undefined) {
        const delta = media.durationSeconds - resolved.storyboardTotalSeconds;
        if (Math.abs(delta) > resolved.durationToleranceSeconds + EVIDENCE_EPSILON) {
            findings.push({
                type: "duration",
                severity: "error",
                tStart: 0,
                tEnd: seconds(media.durationSeconds),
                detail: `clip is ${fixed(media.durationSeconds)}s against a storyboard total of ${fixed(resolved.storyboardTotalSeconds)}s (${fixed(delta)}s)`,
            });
        }
    }

    findings.sort((a, b) => (a.tStart - b.tStart) || a.type.localeCompare(b.type));

    const sheetPath = media.hasVideo
        ? await buildContactSheet(
            resolved,
            absoluteInput,
            media.durationSeconds,
            resolved.contactSheetPath ?? path.join(
                path.dirname(absoluteInput),
                `${path.basename(absoluteInput, path.extname(absoluteInput))}.contact-sheet.png`,
            ),
        )
        : "";

    return {
        inputPath: absoluteInput,
        durationSeconds: seconds(media.durationSeconds),
        hasVideo: media.hasVideo,
        hasAudio: media.hasAudio,
        contactSheetPath: sheetPath,
        findings,
    };
}
