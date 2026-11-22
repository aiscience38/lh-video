import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readBoundedJson, requestFailure } from "@/server/http/request-limits";
import { ASSET_ID_PATTERN } from "@/server/library/contract";
import { getTask, initStore } from "@/server/tasks/store";
import { saveInputLocally } from "@/server/media/storage";
import { toJpeg } from "@/server/media/input-upload";
import { extractLastFrame, FFMPEG_MISSING_ERROR, LastFrameError } from "@/server/media/last-frame";
import { taskVideoFile } from "@/server/media/task-video";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_MAX_BYTES = 8 * 1024;
const UPLOADED_JPEG = /^\/api\/uploaded\/([a-f0-9]{64})\.jpg$/;

function failure(code: string, status: number): Response {
    return applyWorkspaceHeaders(NextResponse.json({ error: code }, { status }));
}

/**
 * Extracts the final frame of a completed video and stores it as a normal
 * workspace upload. The frame is converted to JPEG because every library asset
 * id of the form `asset_<sha256>` resolves to the `.jpg` upload route; the PNG
 * check still happens on the raw ffmpeg output inside `extractLastFrame`.
 */
export async function POST(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    let body: unknown;
    try {
        body = await readBoundedJson(request, BODY_MAX_BYTES);
    } catch (error) {
        return requestFailure(error);
    }
    const taskId = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).taskId : undefined;
    if (typeof taskId !== "string" || !ASSET_ID_PATTERN.test(taskId)) return failure("ERR_LAST_FRAME_INVALID_REQUEST", 400);
    await initStore();
    const task = await getTask(taskId);
    if (!task) return failure("ERR_TASK_NOT_FOUND", 404);
    if (task.media_type !== "video") return failure("ERR_LAST_FRAME_NOT_VIDEO", 400);
    if ((task.status ?? task.freepik_status) !== "COMPLETED") return failure("ERR_LAST_FRAME_NOT_READY", 409);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-last-frame-"));
    try {
        const source = await taskVideoFile(task, directory, { signal: request.signal });
        const frame = await extractLastFrame(source, path.join(directory, "last-frame.png"), { signal: request.signal });
        const url = await saveInputLocally(await toJpeg(frame), ".jpg");
        const match = UPLOADED_JPEG.exec(url);
        if (!match) return failure("ERR_LAST_FRAME_FAILED", 500);
        return applyWorkspaceHeaders(NextResponse.json({ assetId: `asset_${match[1]}`, url, sourceTaskId: taskId }, { status: 201 }));
    } catch (error) {
        if (error instanceof LastFrameError) {
            const status = error.code === FFMPEG_MISSING_ERROR ? 503 : error.code === "ERR_TASK_NOT_FOUND" ? 404 : 500;
            return failure(error.code, status);
        }
        const code = error instanceof Error && /^ERR_[A-Z0-9_]+$/.test(error.message) ? error.message : "ERR_LAST_FRAME_FAILED";
        const status = (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : code === "ERR_ASSET_NOT_FOUND" ? 404 : code === "ERR_UNSUPPORTED_MEDIA_TYPE" ? 415 : 500;
        return failure(code, status);
    } finally {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
}
