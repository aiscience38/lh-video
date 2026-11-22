import type { VideoTask } from "@/types";
import type { Filmstrip, LastFrameAsset, MediaNote } from "../types";

/** Stable client errors: the detail page never treats a failed request as success. */
export class MediaRequestError extends Error {
    constructor(readonly code: string, readonly status: number) {
        super(code);
        this.name = "MediaRequestError";
    }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
        response = await fetch(url, { cache: "no-store", ...init });
    } catch {
        throw new MediaRequestError("ERR_MEDIA_UNAVAILABLE", 0);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const code = body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
            ? String((body as Record<string, unknown>).error)
            : "ERR_MEDIA_UNAVAILABLE";
        throw new MediaRequestError(code, response.status);
    }
    return body as T;
}

export function fetchMediaTask(taskId: string): Promise<VideoTask> {
    return request<VideoTask>(`/api/tasks/${encodeURIComponent(taskId)}`);
}

export function fetchFilmstrip(taskId: string): Promise<Filmstrip> {
    return request<Filmstrip>(`/api/media/${encodeURIComponent(taskId)}/frames`);
}

export async function listMediaNotes(taskId: string): Promise<MediaNote[]> {
    const body = await request<{ notes?: MediaNote[] }>(`/api/notes?subjectId=${encodeURIComponent(taskId)}`);
    return Array.isArray(body.notes) ? body.notes : [];
}

export async function createMediaNote(taskId: string, input: { tSeconds: number; text: string }): Promise<MediaNote> {
    const body = await request<{ note?: MediaNote }>("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId: taskId, taskId, tSeconds: input.tSeconds, text: input.text }),
    });
    if (!body.note || typeof body.note.id !== "string") throw new MediaRequestError("ERR_NOTES_UNAVAILABLE", 0);
    return body.note;
}

export function extractLastFrame(taskId: string): Promise<LastFrameAsset> {
    return request<LastFrameAsset>("/api/media/last-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
    });
}
