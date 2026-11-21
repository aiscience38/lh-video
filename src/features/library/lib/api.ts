import type { CharacterEntity, LibraryAssetUpload, LibraryEntity, LibraryKind, LibraryListResponse } from "../types";

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

export async function uploadReference(file: File): Promise<LibraryAssetUpload> {
    const form = new FormData();
    form.append("file", file, file.name || "reference");
    return libraryRequest<LibraryAssetUpload>("/api/library/assets", { method: "POST", body: form });
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
