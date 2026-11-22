import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import type { AnyTask } from "@/types";
import { DOWNLOADS_DIR, openLocalMedia } from "@/server/media/storage";
import { reusableTaskAsset } from "@/server/media/asset-source";
import { fetchRemoteMedia, mediaByteLimit, type TransferOptions } from "@/server/media/transfer";

/**
 * A local file ffmpeg can seek in. Remote-only tasks are downloaded into the
 * caller's temporary directory first; `video_path` is checked through the same
 * containment rules as the download route before its path is handed to ffmpeg.
 */
export async function taskVideoFile(
    task: Extract<AnyTask, { media_type: "video" }>,
    directory: string,
    options: TransferOptions = {},
): Promise<string> {
    if (task.video_path) {
        const local = await openLocalMedia(task.video_path, DOWNLOADS_DIR, options);
        await local.handle.close();
        return task.video_path;
    }
    const asset = await reusableTaskAsset(task, 0, options);
    const data = "data" in asset
        ? asset.data
        : (await fetchRemoteMedia(asset.url, { maxBytes: mediaByteLimit("video/"), signal: options.signal })).data;
    const target = path.join(directory, "source.mp4");
    await fs.writeFile(target, data);
    return target;
}
