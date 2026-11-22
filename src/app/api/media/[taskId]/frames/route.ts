import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ASSET_ID_PATTERN } from "@/server/library/contract";
import { getTask, initStore } from "@/server/tasks/store";
import { taskVideoFile } from "@/server/media/task-video";
import { ensureFilmstrip, FrameError, readFilmstripFrame, QA_FFMPEG_MISSING, QA_FRAME_COUNT, QA_FRAME_INVALID } from "@/server/media/frames";
import { frameCountFrom } from "@/server/media/frames-paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ taskId: string }> };

function failure(code: string, status: number): Response {
    return NextResponse.json({ error: code }, { status });
}

function statusFor(error: FrameError): number {
    if (error.code === QA_FFMPEG_MISSING) return 503;
    if (error.code === QA_FRAME_COUNT || error.code === QA_FRAME_INVALID) return 400;
    return 500;
}

/**
 * GET /api/media/<taskId>/frames            → cached filmstrip metadata
 * GET /api/media/<taskId>/frames?index=<n>  → one cached JPEG
 *
 * A read-only route: no mutation guard, because it never changes task state.
 * Generated frames are cached below STORAGE_ROOT/frames/<taskId>; the second
 * call for the same render reads them instead of invoking ffmpeg again.
 */
export async function GET(request: Request, { params }: Context) {
    const { taskId } = await params;
    if (!ASSET_ID_PATTERN.test(taskId)) return failure("ERR_QA_FRAME_INVALID", 400);
    try {
        await initStore();
        const task = await getTask(taskId);
        if (!task || task.media_type !== "video") return failure("ERR_TASK_NOT_FOUND", 404);

        const url = new URL(request.url);
        const rawIndex = url.searchParams.get("index");
        if (rawIndex !== null) {
            if (!/^(?:[0-9]|1[0-9]|2[0-3])$/.test(rawIndex)) return failure(QA_FRAME_INVALID, 400);
            const frame = await readFilmstripFrame(taskId, Number(rawIndex));
            if (!frame) return failure("ERR_QA_FRAME_NOT_FOUND", 404);
            return new Response(new Uint8Array(frame), {
                status: 200,
                headers: {
                    "Content-Type": "image/jpeg",
                    "Content-Length": String(frame.length),
                    "Cache-Control": "private, max-age=3600",
                    "X-Content-Type-Options": "nosniff",
                },
            });
        }

        if ((task.status ?? task.freepik_status) !== "COMPLETED") return failure("ERR_QA_FRAME_NOT_READY", 409);
        const count = frameCountFrom(url.searchParams.get("count"));
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-filmstrip-"));
        try {
            const source = await taskVideoFile(task, directory, { signal: request.signal });
            const filmstrip = await ensureFilmstrip(source, taskId, { count, signal: request.signal });
            return NextResponse.json(filmstrip, { headers: { "Cache-Control": "no-store" } });
        } finally {
            await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
    } catch (error) {
        if (error instanceof FrameError) return failure(error.code, statusFor(error));
        const code = error instanceof Error && /^ERR_[A-Z0-9_]+$/.test(error.message) ? error.message : "ERR_QA_FRAME_FAILED";
        const status = (error as NodeJS.ErrnoException).code === "ENOENT" || code === "ERR_ASSET_NOT_FOUND" ? 404
            : code.startsWith("ERR_QA_FRAME") || code === "ERR_UNSAFE_ASSET_PATH" || code === "ERR_UNSUPPORTED_MEDIA_TYPE" ? 400 : 503;
        return failure(code, status);
    }
}
