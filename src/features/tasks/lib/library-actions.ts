"use client";

/**
 * Gallery-to-Library actions.
 *
 * The gallery knows a generated image by task id; the library stores the same
 * value as an asset id and serves it from the download route. Everything here
 * is plain fetch so the picker can live in the client component graph.
 */

export interface CharacterOption { id: string; name: string; slug: string; assetIds: string[] }
export interface StoryboardShotOption { id: string; order: number; intent: string; seconds: number; keyframeAssetId: string | null; camera: string }
export interface StoryboardOption { id: string; name: string; slug: string; shots: StoryboardShotOption[] }

export class LibraryActionError extends Error {
    constructor(readonly code: string, readonly status: number) {
        super(code);
        this.name = "LibraryActionError";
    }
}

/** Appends only ids the entity does not reference yet, keeping the existing order. */
export function appendAssetIds(existing: readonly string[], additions: readonly string[]): string[] {
    const seen = new Set(existing);
    const next = [...existing];
    for (const assetId of additions) {
        if (!assetId || seen.has(assetId)) continue;
        seen.add(assetId);
        next.push(assetId);
    }
    return next;
}

/** Points one storyboard panel at an asset id; other panels keep their keyframes. */
export function replaceShotKeyframe<T extends StoryboardShotOption>(shots: readonly T[], index: number, assetId: string): T[] {
    if (!Number.isInteger(index) || index < 0 || index >= shots.length) throw new LibraryActionError("ERR_LIBRARY_INVALID", 400);
    return shots.map((shot, position) => (position === index ? { ...shot, keyframeAssetId: assetId } : shot));
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
        response = await fetch(url, { ...init, headers: { Accept: "application/json", ...init?.headers } });
    } catch {
        throw new LibraryActionError("ERR_LIBRARY_UNAVAILABLE", 0);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const code = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : "ERR_LIBRARY_UNAVAILABLE";
        throw new LibraryActionError(code, response.status);
    }
    return body as T;
}

async function list(kind: "character" | "storyboard"): Promise<unknown[]> {
    const body = await request<{ entities?: unknown[] }>(`/api/library?kind=${kind}`, { cache: "no-store" });
    return Array.isArray(body.entities) ? body.entities : [];
}

function asCharacter(value: unknown): CharacterOption | undefined {
    if (!value || typeof value !== "object") return undefined;
    const entity = value as Record<string, unknown>;
    if (entity.kind !== "character" || typeof entity.id !== "string" || typeof entity.name !== "string") return undefined;
    const assetIds = Array.isArray(entity.assetIds) ? entity.assetIds.filter((id): id is string => typeof id === "string") : [];
    return { id: entity.id, name: entity.name, slug: String(entity.slug ?? ""), assetIds };
}

function asStoryboard(value: unknown): StoryboardOption | undefined {
    if (!value || typeof value !== "object") return undefined;
    const entity = value as Record<string, unknown>;
    if (entity.kind !== "storyboard" || typeof entity.id !== "string" || typeof entity.name !== "string") return undefined;
    // Every field the store validates is carried through: a keyframe PATCH rewrites the panel list.
    const shots = Array.isArray(entity.shots)
        ? entity.shots.flatMap((value, position) => {
            if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") return [];
            const shot = value as Record<string, unknown>;
            return [{
                id: shot.id as string,
                order: position,
                intent: typeof shot.intent === "string" ? shot.intent : "",
                seconds: typeof shot.seconds === "number" && shot.seconds > 0 ? shot.seconds : 3,
                keyframeAssetId: typeof shot.keyframeAssetId === "string" ? shot.keyframeAssetId : null,
                camera: typeof shot.camera === "string" ? shot.camera : "",
            }];
        })
        : [];
    return { id: entity.id, name: entity.name, slug: String(entity.slug ?? ""), shots };
}

export async function listCharacterOptions(): Promise<CharacterOption[]> {
    return (await list("character")).map(asCharacter).filter((entity): entity is CharacterOption => Boolean(entity));
}

export async function listStoryboardOptions(): Promise<StoryboardOption[]> {
    return (await list("storyboard")).map(asStoryboard).filter((entity): entity is StoryboardOption => Boolean(entity));
}

/** PATCH that appends every image to the character's references in one write. */
export async function addImagesToCharacter(character: CharacterOption, assetIds: readonly string[]): Promise<CharacterOption> {
    const body = await request<{ entity?: unknown }>(`/api/library/character/${encodeURIComponent(character.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetIds: appendAssetIds(character.assetIds, assetIds) }),
    });
    const entity = asCharacter(body.entity);
    if (!entity) throw new LibraryActionError("ERR_LIBRARY_UNAVAILABLE", 503);
    return entity;
}

/** PATCH the whole panel list because the library updates one document at a time. */
export async function setStoryboardKeyframe(storyboard: StoryboardOption, index: number, assetId: string): Promise<StoryboardOption> {
    const body = await request<{ entity?: unknown }>(`/api/library/storyboard/${encodeURIComponent(storyboard.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shots: replaceShotKeyframe(storyboard.shots, index, assetId) }),
    });
    const entity = asStoryboard(body.entity);
    if (!entity) throw new LibraryActionError("ERR_LIBRARY_UNAVAILABLE", 503);
    return entity;
}
