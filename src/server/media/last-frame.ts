import "server-only";

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Last-frame extraction for shot extension.
 *
 * One call seeks to roughly one second before the end of a video and asks
 * ffmpeg for exactly one frame, which becomes the start frame of the next
 * shot. The executable is configurable because the packaged desktop build
 * ships its own ffmpeg binary instead of relying on PATH.
 */

const run = promisify(execFile);

export const FFMPEG_MISSING_ERROR = "ERR_FFMPEG_MISSING";
export const LAST_FRAME_FAILED_ERROR = "ERR_LAST_FRAME_FAILED";
export const LAST_FRAME_INVALID_ERROR = "ERR_LAST_FRAME_INVALID";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;

/** A last-frame failure carries the stable code callers map to an HTTP status. */
export class LastFrameError extends Error {
    constructor(readonly code: string, detail: string) {
        super(`${code}: ${detail}`);
        this.name = "LastFrameError";
    }
}

/** `FFMPEG_PATH` wins over PATH so packaged builds can point at a bundled binary. */
export function ffmpegExecutable(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.FFMPEG_PATH?.trim();
    return configured || "ffmpeg";
}

export function hasPngSignature(data: Uint8Array): boolean {
    return data.length >= PNG_SIGNATURE.length && Buffer.from(data.subarray(0, PNG_SIGNATURE.length)).equals(PNG_SIGNATURE);
}

function failureCode(error: unknown): string {
    // Cross-realm safe: the module is also exercised outside Next's runtime, where
    // the thrown error is not an instance of this realm's Error.
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : "";
}

/**
 * Writes the final frame of `inputPath` to `outputPath` and returns the PNG
 * bytes after checking the file really is a PNG. A stale `outputPath` from an
 * earlier run is removed first so a failed extraction cannot look successful.
 */
export async function extractLastFrame(inputPath: string, outputPath: string, options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
} = {}): Promise<Buffer> {
    if (!inputPath || !outputPath) throw new LastFrameError(LAST_FRAME_INVALID_ERROR, "input and output paths are required");
    if (path.extname(outputPath).toLowerCase() !== ".png") {
        throw new LastFrameError(LAST_FRAME_INVALID_ERROR, "the output path must end in .png");
    }
    const executable = ffmpegExecutable(options.env);
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
    try {
        await run(executable, [
            "-hide_banner", "-loglevel", "error",
            "-sseof", "-1", "-i", inputPath,
            "-vframes", "1", "-y", outputPath,
        ], {
            signal: options.signal,
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_DIAGNOSTIC_BYTES,
            windowsHide: true,
        });
    } catch (error) {
        if (failureCode(error) === "ENOENT") {
            throw new LastFrameError(FFMPEG_MISSING_ERROR,
                `ffmpeg was not found at "${executable}". Install ffmpeg or set FFMPEG_PATH to the executable.`);
        }
        const diagnostic = (error as { stderr?: unknown }).stderr;
        const detail = typeof diagnostic === "string" && diagnostic.trim() ? diagnostic.trim().split("\n").at(-1)! : String((error as Error).message ?? "");
        throw new LastFrameError(LAST_FRAME_FAILED_ERROR, `ffmpeg could not extract the last frame (${detail})`);
    }
    let data: Buffer;
    try {
        data = await fs.readFile(outputPath);
    } catch {
        throw new LastFrameError(LAST_FRAME_FAILED_ERROR, "ffmpeg produced no output frame");
    }
    if (!hasPngSignature(data)) throw new LastFrameError(LAST_FRAME_INVALID_ERROR, "ffmpeg output is not a PNG");
    return data;
}
