import "server-only";

import path from "node:path";
import { STORAGE_ROOT } from "@/server/config/storage-paths";
import { ASSET_ID_PATTERN } from "@/server/library/contract";

/**
 * Filmstrip frames are derived artifacts of a rendered video. They live under
 * `STORAGE_ROOT/frames/<taskId>/<index>.jpg` so a second visit reuses the same
 * JPEGs instead of shelling out to ffmpeg again. The metadata file records the
 * source revision (size and mtime) so a replaced output regenerates the strip.
 */

export const FRAMES_DIRECTORY = "frames";
export const DEFAULT_FRAME_COUNT = 12;
export const MAX_FRAME_COUNT = 24;

export interface FilmstripFrame {
    index: number;
    timeSeconds: number;
    url: string;
}

export interface FilmstripResult {
    taskId: string;
    durationSeconds: number;
    frameCount: number;
    fps: number;
    width: number | null;
    height: number | null;
    cached: boolean;
    frames: FilmstripFrame[];
}

export interface VideoProbe {
    durationSeconds: number;
    fps: number;
    width: number | null;
    height: number | null;
}

export function framesDirectory(taskId: string): string {
    if (!ASSET_ID_PATTERN.test(taskId)) throw new Error("ERR_QA_FRAME_INVALID");
    return path.join(STORAGE_ROOT, FRAMES_DIRECTORY, taskId);
}

export function frameUrl(taskId: string, index: number): string {
    return `/api/media/${encodeURIComponent(taskId)}/frames?index=${index}`;
}

export function frameFile(taskId: string, index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_FRAME_COUNT) throw new Error("ERR_QA_FRAME_INVALID");
    return path.join(framesDirectory(taskId), `${index}.jpg`);
}

export function metadataFile(taskId: string): string {
    return path.join(framesDirectory(taskId), "meta.json");
}

export function frameCountFrom(value: string | null | undefined): number {
    if (value === null || value === undefined || value === "") return DEFAULT_FRAME_COUNT;
    if (!/^(?:[1-9]|1[0-9]|2[0-4])$/.test(value)) throw new Error("ERR_QA_FRAME_COUNT");
    return Number(value);
}
