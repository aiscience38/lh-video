import "server-only";

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
    DEFAULT_FRAME_COUNT,
    MAX_FRAME_COUNT,
    frameFile,
    frameUrl,
    framesDirectory,
    metadataFile,
    type FilmstripResult,
} from "@/server/media/frames-paths";

/**
 * Filmstrip generation for the rendered-video detail page.
 *
 * `ffprobe` supplies the duration and frame size; `ffmpeg` writes one JPEG per
 * evenly spaced midpoint, so even a one-second clip never shows the black first
 * frame. The strip is cached under `STORAGE_ROOT/frames/<taskId>` and keyed to
 * the source file's size and mtime: a replaced render regenerates the strip,
 * while a reload only reads existing JPEGs.
 */

const run = promisify(execFile);

export const QA_FFMPEG_MISSING = "ERR_QA_FFMPEG_MISSING";
export const QA_FRAME_FAILED = "ERR_QA_FRAME_FAILED";
export const QA_FRAME_INVALID = "ERR_QA_FRAME_INVALID";
export const QA_FRAME_COUNT = "ERR_QA_FRAME_COUNT";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const FALLBACK_FPS = 24;

export class FrameError extends Error {
    constructor(readonly code: string, detail: string) {
        super(`${code}: ${detail}`);
        this.name = "FrameError";
    }
}

export interface ProbeOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}

export interface FilmstripOptions extends ProbeOptions {
    count?: number;
}

interface StripMetadata {
    taskId: string;
    frameCount: number;
    durationSeconds: number;
    fps: number;
    width: number | null;
    height: number | null;
    sourceSize: number;
    sourceMtimeMs: number;
    createdAt: string;
}

/** A bundled binary wins over PATH so packaged desktop builds keep working. */
export function ffmpegExecutable(env: NodeJS.ProcessEnv = process.env): string {
    return env.FFMPEG_PATH?.trim() || "ffmpeg";
}

export function ffprobeExecutable(env: NodeJS.ProcessEnv = process.env): string {
    return env.FFPROBE_PATH?.trim() || "ffprobe";
}

function failureCode(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : "";
}

function diagnostic(error: unknown): string {
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim().split(/\r?\n/).at(-1)!;
    return String((error as Error | null)?.message ?? "");
}

function missingExecutable(executable: string, name: "ffmpeg" | "ffprobe"): FrameError {
    return new FrameError(QA_FFMPEG_MISSING,
        `${name} was not found at "${executable}". Install ${name} or set ${name.toUpperCase()}_PATH to the executable.`);
}

function parseRate(value: unknown): number {
    if (typeof value !== "string") return 0;
    const [numerator, denominator] = value.split("/").map(Number);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) return 0;
    return numerator / denominator;
}

/** Duration, size and nominal frame rate of the rendered video. */
export async function probeVideo(inputPath: string, options: ProbeOptions = {}): Promise<{ durationSeconds: number; fps: number; width: number | null; height: number | null }> {
    const executable = ffprobeExecutable(options.env);
    let stdout: string;
    try {
        const result = await run(executable, [
            "-v", "error", "-select_streams", "v:0",
            "-show_entries", "format=duration:stream=width,height,r_frame_rate,duration",
            "-of", "json", inputPath,
        ], {
            signal: options.signal,
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_DIAGNOSTIC_BYTES,
            windowsHide: true,
        });
        stdout = result.stdout;
    } catch (error) {
        if (failureCode(error) === "ENOENT") throw missingExecutable(executable, "ffprobe");
        throw new FrameError(QA_FRAME_FAILED, `ffprobe could not read the video (${diagnostic(error)})`);
    }
    let parsed: { streams?: Array<{ width?: unknown; height?: unknown; r_frame_rate?: unknown; duration?: unknown }>; format?: { duration?: unknown } };
    try {
        parsed = JSON.parse(stdout);
    } catch {
        throw new FrameError(QA_FRAME_FAILED, "ffprobe returned unreadable JSON");
    }
    const stream = parsed.streams?.[0];
    const duration = Number(parsed.format?.duration ?? stream?.duration);
    if (!stream || !Number.isFinite(duration) || duration <= 0) {
        throw new FrameError(QA_FRAME_INVALID, "the file has no finite video duration");
    }
    const width = Number(stream.width);
    const height = Number(stream.height);
    const fps = parseRate(stream.r_frame_rate) || FALLBACK_FPS;
    return { durationSeconds: duration, fps, width: Number.isFinite(width) && width > 0 ? width : null, height: Number.isFinite(height) && height > 0 ? height : null };
}

function parseMetadata(value: unknown, taskId: string): StripMetadata | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (record.taskId !== taskId || !Number.isInteger(record.frameCount) || !Number.isFinite(record.durationSeconds)
        || !Number.isFinite(record.fps) || !Number.isFinite(record.sourceSize) || !Number.isFinite(record.sourceMtimeMs)) return null;
    return {
        taskId,
        frameCount: record.frameCount as number,
        durationSeconds: record.durationSeconds as number,
        fps: record.fps as number,
        width: typeof record.width === "number" ? record.width : null,
        height: typeof record.height === "number" ? record.height : null,
        sourceSize: record.sourceSize as number,
        sourceMtimeMs: record.sourceMtimeMs as number,
        createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    };
}

async function existingStrip(taskId: string, count: number, sourceSize: number, sourceMtimeMs: number): Promise<StripMetadata | null> {
    let metadata: StripMetadata | null;
    try {
        metadata = parseMetadata(JSON.parse(await fs.readFile(metadataFile(taskId), "utf8")), taskId);
    } catch {
        return null;
    }
    if (!metadata || metadata.frameCount !== count || metadata.sourceSize !== sourceSize || Math.abs(metadata.sourceMtimeMs - sourceMtimeMs) > 1) return null;
    for (let index = 0; index < count; index += 1) {
        try {
            const stat = await fs.stat(frameFile(taskId, index));
            if (!stat.isFile() || stat.size === 0) return null;
        } catch {
            return null;
        }
    }
    return metadata;
}

function stripFrom(taskId: string, metadata: StripMetadata, cached: boolean): FilmstripResult {
    return {
        taskId,
        durationSeconds: metadata.durationSeconds,
        frameCount: metadata.frameCount,
        fps: metadata.fps,
        width: metadata.width,
        height: metadata.height,
        cached,
        frames: Array.from({ length: metadata.frameCount }, (_, index) => ({
            index,
            timeSeconds: Math.min(metadata.durationSeconds, metadata.durationSeconds * (index + 0.5) / metadata.frameCount),
            url: frameUrl(taskId, index),
        })),
    };
}

async function writeMetadata(taskId: string, metadata: StripMetadata): Promise<void> {
    const target = metadataFile(taskId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(metadata), "utf8");
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
}

async function runFrames(inputPath: string, taskId: string, count: number, metadata: StripMetadata, options: FilmstripOptions): Promise<void> {
    const executable = ffmpegExecutable(options.env);
    const directory = framesDirectory(taskId);
    await fs.mkdir(directory, { recursive: true });
    // A previous strip with a larger count must not leave extra JPEGs behind.
    for (let index = count; index < MAX_FRAME_COUNT; index += 1) {
        await fs.rm(frameFile(taskId, index), { force: true }).catch(() => undefined);
    }
    for (let index = 0; index < count; index += 1) {
        const timeSeconds = Math.min(metadata.durationSeconds - 0.001, metadata.durationSeconds * (index + 0.5) / count);
        const target = frameFile(taskId, index);
        const temporary = `${directory}/${index}.tmp.jpg`;
        try {
            await run(executable, [
                "-hide_banner", "-loglevel", "error",
                "-ss", Math.max(0, timeSeconds).toFixed(3), "-i", inputPath,
                "-an", "-sn", "-frames:v", "1", "-q:v", "4", "-y", temporary,
            ], {
                signal: options.signal,
                timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                maxBuffer: MAX_DIAGNOSTIC_BYTES,
                windowsHide: true,
            });
        } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => undefined);
            if (failureCode(error) === "ENOENT") throw missingExecutable(executable, "ffmpeg");
            throw new FrameError(QA_FRAME_FAILED, `ffmpeg could not render frame ${index} (${diagnostic(error)})`);
        }
        let data: Buffer;
        try {
            data = await fs.readFile(temporary);
        } catch {
            throw new FrameError(QA_FRAME_FAILED, `ffmpeg produced no frame ${index}`);
        }
        if (data.length < JPEG_SIGNATURE.length || !data.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
            throw new FrameError(QA_FRAME_FAILED, `frame ${index} is not a JPEG`);
        }
        await fs.rm(target, { force: true });
        await fs.rename(temporary, target);
    }
    await writeMetadata(taskId, metadata);
}

const queues = new Map<string, Promise<unknown>>();

/** Serializes generation per task; cache reads still race safely with atomic renames. */
async function withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(taskId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    queues.set(taskId, pending.catch(() => undefined));
    return pending;
}

/**
 * Builds or reuses the cached filmstrip. `count` is clamped to 1..24; invalid
 * values are rejected so a request cannot fill the disk.
 */
export async function ensureFilmstrip(inputPath: string, taskId: string, options: FilmstripOptions = {}): Promise<FilmstripResult> {
    const count = options.count ?? DEFAULT_FRAME_COUNT;
    if (!Number.isInteger(count) || count < 1 || count > MAX_FRAME_COUNT) throw new FrameError(QA_FRAME_COUNT, `frame count must be an integer between 1 and ${MAX_FRAME_COUNT}`);
    const stat = await fs.stat(inputPath).catch(() => null);
    if (!stat?.isFile()) throw new FrameError(QA_FRAME_INVALID, "the video source does not exist");
    return withTaskLock(taskId, async () => {
        const cached = await existingStrip(taskId, count, stat.size, stat.mtimeMs);
        if (cached) return stripFrom(taskId, cached, true);
        const probe = await probeVideo(inputPath, options);
        const metadata: StripMetadata = {
            taskId, frameCount: count, durationSeconds: probe.durationSeconds, fps: probe.fps,
            width: probe.width, height: probe.height, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs,
            createdAt: new Date().toISOString(),
        };
        await runFrames(inputPath, taskId, count, metadata, options);
        return stripFrom(taskId, metadata, false);
    });
}

/** Reads one cached JPEG, or null when the strip does not contain that index. */
export async function readFilmstripFrame(taskId: string, index: number): Promise<Buffer | null> {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_FRAME_COUNT) return null;
    let metadata: StripMetadata | null;
    try {
        metadata = parseMetadata(JSON.parse(await fs.readFile(metadataFile(taskId), "utf8")), taskId);
    } catch {
        return null;
    }
    if (!metadata || index >= metadata.frameCount) return null;
    try {
        return await fs.readFile(frameFile(taskId, index));
    } catch {
        return null;
    }
}
