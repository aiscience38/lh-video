import type { CharacterEntity, CharacterVoice, IngredientKind, LibraryAssetUpload, LibraryEntity, LibraryKind, LibraryListResponse, VoiceProvider } from "../types";

export class LibraryRequestError extends Error {
    constructor(public readonly code: string, public readonly status: number) {
        super(code);
        this.name = "LibraryRequestError";
    }
}

async function libraryRequest<T>(url: string, init?: RequestInit): Promise<T> {
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

export function listLibrary(kind?: LibraryKind, query = ""): Promise<LibraryListResponse> {
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (query.trim()) params.set("q", query.trim());
    const suffix = params.size ? `?${params}` : "";
    return libraryRequest<LibraryListResponse>(`/api/library${suffix}`, { cache: "no-store" });
}

export interface CharacterInput {
    name: string;
    notes: string;
    assetIds: string[];
    ingredientKind?: IngredientKind;
    voice?: CharacterVoice;
}

export async function createCharacter(input: CharacterInput): Promise<CharacterEntity> {
    const body = await libraryRequest<{ entity: CharacterEntity }>("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "character", ...input }),
    });
    return body.entity;
}

export async function updateCharacter(id: string, input: Partial<CharacterInput>): Promise<CharacterEntity> {
    const body = await libraryRequest<{ entity: CharacterEntity }>(`/api/library/character/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
    return body.entity;
}

export async function deleteCharacter(id: string): Promise<void> {
    await libraryRequest<{ ok: true }>(`/api/library/character/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** TTS availability as reported by the server half (sibling branch). */
export interface TtsProviderStatus {
    provider: string;
    configured: boolean;
    reachable: boolean;
    reason: string | null;
}

export interface TtsVoice {
    id: string;
    name: string;
    language?: string | null;
}

export interface TtsPreview {
    assetId: string;
    url: string;
    mimeType: string;
}

export interface TtsPreviewInput {
    provider: VoiceProvider;
    voiceId: string;
    text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Normalizes `{ providers: [...] }` (or a bare array) so the UI keeps working
 * while the server half evolves. Only `configured && reachable` is usable.
 */
export async function listTtsProviders(): Promise<TtsProviderStatus[]> {
    const body = await libraryRequest<unknown>("/api/tts/providers", { cache: "no-store" });
    const raw = Array.isArray(body) ? body : asRecord(body)?.providers;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap(item => {
        const record = asRecord(item);
        if (!record || typeof record.provider !== "string") return [];
        const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason : null;
        return [{
            provider: record.provider,
            configured: record.configured === true,
            reachable: record.reachable === true,
            reason,
        }];
    });
}

/** Normalizes `{ voices: [{ id, name }] }` or a bare array of voice objects. */
export async function listTtsVoices(provider: VoiceProvider): Promise<TtsVoice[]> {
    const params = new URLSearchParams({ provider });
    const body = await libraryRequest<unknown>(`/api/tts/voices?${params}`, { cache: "no-store" });
    const raw = Array.isArray(body) ? body : asRecord(body)?.voices;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap(item => {
        const record = asRecord(item);
        if (!record) return [];
        const id = typeof record.id === "string" ? record.id : typeof record.voiceId === "string" ? record.voiceId : null;
        if (!id) return [];
        const name = typeof record.name === "string" && record.name.trim() ? record.name
            : typeof record.label === "string" && record.label.trim() ? record.label : id;
        const language = typeof record.language === "string" ? record.language : null;
        return [{ id, name, language }];
    });
}

export function previewTtsVoice(input: TtsPreviewInput): Promise<TtsPreview> {
    return libraryRequest<TtsPreview>("/api/tts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

export async function uploadReference(file: File): Promise<LibraryAssetUpload> {
    const form = new FormData();
    form.append("file", file, file.name || "reference");
    return libraryRequest<LibraryAssetUpload>("/api/library/assets", { method: "POST", body: form });
}

export interface LibraryTrashEntry {
    kind: LibraryKind;
    folder: string;
    trashedAt: string | null;
    name: string | null;
}

export interface LibraryTrashResponse {
    entries: LibraryTrashEntry[];
    count: number;
}

export function listLibraryTrash(): Promise<LibraryTrashResponse> {
    return libraryRequest<LibraryTrashResponse>("/api/library/trash", { cache: "no-store" });
}

export interface LibraryBackupResult {
    ok: true;
    mode: "tar" | "manifest";
    path: string;
    directory: string;
    count: number;
    bytes?: number;
    note?: string;
    createdAt: string;
}

/** Archives library/ into EXPORTS/ on the server; the response carries the absolute path. */
export function createLibraryBackup(): Promise<LibraryBackupResult> {
    return libraryRequest<LibraryBackupResult>("/api/library/export", { method: "POST" });
}

export function findCharacter(entities: LibraryEntity[], slug: string): CharacterEntity | undefined {
    return entities.find((entity): entity is CharacterEntity => entity.kind === "character" && entity.slug === slug);
}

export function libraryErrorKey(error: unknown): string {
    return error instanceof LibraryRequestError ? `errors.${error.code}` : "errors.generic";
}
