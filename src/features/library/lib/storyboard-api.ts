import { formatTimecode } from "@/lib/timecode";
import { LibraryRequestError } from "./api";
import { libraryAssetUrl } from "./asset-url";

/** Typed client helpers for the storyboard editor, review notes and revision page. */

export interface StoryboardShotRecord {
    id: string;
    order: number;
    intent: string;
    seconds: number;
    keyframeAssetId: string | null;
    camera: string;
}

export interface StoryboardRecord {
    id: string;
    kind: "storyboard";
    name: string;
    slug: string;
    productionId: string | null;
    shots: StoryboardShotRecord[];
    createdAt: string;
    updatedAt: string;
}

export interface NoteRecord {
    id: string;
    subjectId: string;
    taskId: string | null;
    assetId: string | null;
    tSeconds: number;
    text: string;
    createdAt: string;
    decision: boolean;
}

export interface NoteInput {
    taskId?: string | null;
    assetId?: string | null;
    tSeconds: number;
    text: string;
    decision?: boolean;
}

const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DOWNLOAD_PATH = /^\/api\/download\/([A-Za-z0-9_-]{1,128})$/;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
        response = await fetch(url, { ...init, headers: { Accept: "application/json", ...init?.headers } });
    } catch {
        throw new LibraryRequestError("ERR_LIBRARY_UNAVAILABLE", 0);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const code = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : "ERR_REQUEST_INVALID";
        throw new LibraryRequestError(code, response.status);
    }
    return body as T;
}

export async function listStoryboards(): Promise<StoryboardRecord[]> {
    const body = await request<{ entities: StoryboardRecord[] }>("/api/library?kind=storyboard", { cache: "no-store" });
    return body.entities.filter((entity) => entity.kind === "storyboard");
}

export async function addStoryboardShot(storyboardId: string, draft: Partial<Pick<StoryboardShotRecord, "intent" | "seconds" | "camera" | "keyframeAssetId">> = {}): Promise<StoryboardRecord> {
    const body = await request<{ entity: StoryboardRecord }>(`/api/library/storyboard/${encodeURIComponent(storyboardId)}/shots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", shot: draft }),
    });
    return body.entity;
}

export async function reorderStoryboardShots(storyboardId: string, orderedIds: string[]): Promise<StoryboardRecord> {
    const body = await request<{ entity: StoryboardRecord }>(`/api/library/storyboard/${encodeURIComponent(storyboardId)}/shots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reorder", orderedIds }),
    });
    return body.entity;
}

export async function removeStoryboardShot(storyboardId: string, shotId: string): Promise<StoryboardRecord> {
    const body = await request<{ entity: StoryboardRecord }>(`/api/library/storyboard/${encodeURIComponent(storyboardId)}/shots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", shotId }),
    });
    return body.entity;
}

export async function setStoryboardKeyframe(storyboardId: string, shotId: string, assetId: string | null): Promise<StoryboardRecord> {
    const body = await request<{ entity: StoryboardRecord }>(`/api/library/storyboard/${encodeURIComponent(storyboardId)}/shots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "keyframe", shotId, assetId }),
    });
    return body.entity;
}

/** Field edits use the generic PATCH because the helper contract has no update-shot operation. */
export async function saveStoryboardShots(storyboardId: string, shots: StoryboardShotRecord[]): Promise<StoryboardRecord> {
    const body = await request<{ entity: StoryboardRecord }>(`/api/library/storyboard/${encodeURIComponent(storyboardId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shots }),
    });
    return body.entity;
}

export async function listNotes(subjectId: string): Promise<{ subjectId: string; notes: NoteRecord[]; count: number }> {
    return request(`/api/notes?subjectId=${encodeURIComponent(subjectId)}`, { cache: "no-store" });
}

export async function createNote(subjectId: string, input: NoteInput): Promise<NoteRecord> {
    const body = await request<{ note: NoteRecord }>("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId, ...input }),
    });
    return body.note;
}

export async function deleteNote(subjectId: string, noteId: string): Promise<void> {
    await request<{ ok: true }>(`/api/notes/${encodeURIComponent(noteId)}?subjectId=${encodeURIComponent(subjectId)}`, { method: "DELETE" });
}

/** Attachment URL for the server-rendered REVIEW.md. */
export function reviewMarkdownUrl(subjectId: string): string {
    return `/api/notes?subjectId=${encodeURIComponent(subjectId)}&format=markdown`;
}

export function isAssetId(value: string): boolean {
    return ASSET_ID.test(value);
}

/**
 * Resolves a query-param source to something a `<video>` can load. Accepts an
 * asset id, a same-origin absolute path or an http(s) URL; rejects everything
 * else so `javascript:` and protocol-relative URLs never reach the element.
 */
export function resolveVideoSource(raw: string | null | undefined): string | null {
    if (!raw) return null;
    if (ASSET_ID.test(raw)) return libraryAssetUrl(raw);
    if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
    try {
        const url = new URL(raw);
        if (url.protocol === "http:" || url.protocol === "https:") return raw;
    } catch {
        return null;
    }
    return null;
}

/** The task id embedded in `/api/download/<taskId>` when no explicit task is given. */
export function taskIdFromSource(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const match = DOWNLOAD_PATH.exec(raw.split("?")[0]);
    return match?.[1] ?? null;
}

/** The asset id when the source is a raw asset id; URLs do not become note references. */
export function assetIdFromSource(raw: string | null | undefined): string | null {
    return raw && ASSET_ID.test(raw) ? raw : null;
}

/** Shared display helper so notes and REVIEW.md agree on the timecode format. */
export function noteTimecode(seconds: number): string {
    return formatTimecode(seconds);
}

/** Video elements snap seeks to frames; notes use a stable timestamp at the requested precision. */
export function noteTimestamp(seconds: number, precision = 2): number {
    const factor = 10 ** precision;
    return Math.round(seconds * factor) / factor;
}
