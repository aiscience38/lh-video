import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
    ASSET_ID_PATTERN,
    LIBRARY_INVALID_ERROR,
    LIBRARY_NOT_FOUND_ERROR,
    storyboardShotSchema,
    type LibraryEntity,
    type Storyboard,
    type StoryboardShot,
} from "./contract";
import { createEntity, deleteEntity, listEntities, readEntity, updateEntity } from "./store";

/**
 * Storyboard helpers on top of the generic library store.
 *
 * Every mutation is exactly one `updateEntity` call so atomic replacement and
 * `updatedAt` bumping stay in the store; nothing here writes files. Shots are
 * always stored with `order` equal to their array index.
 *
 * Read-modify-write is not transactional: the store serializes writes per kind,
 * so two concurrent shot mutations on one storyboard can lose one update.
 */

const KIND = "storyboard" as const;

/** A panel to append. `order` is server-owned; `id` is generated unless supplied. */
export const storyboardShotDraftSchema = storyboardShotSchema.omit({ order: true }).partial();
export type StoryboardShotDraft = z.infer<typeof storyboardShotDraftSchema>;

function libraryError(code: string): Error {
    return new Error(code);
}

function assertAssetId(value: unknown): asserts value is string {
    if (typeof value !== "string" || !ASSET_ID_PATTERN.test(value)) throw libraryError(LIBRARY_INVALID_ERROR);
}

function expectStoryboard(entity: LibraryEntity): Storyboard {
    if (entity.kind !== "storyboard") throw libraryError(LIBRARY_INVALID_ERROR);
    return entity;
}

function maybeStoryboard(entity: LibraryEntity | undefined): Storyboard | undefined {
    return entity && entity.kind === "storyboard" ? entity : undefined;
}

/** Renormalizes `order` to the array index; the persisted order is the array order. */
function normalizeOrder(shots: readonly StoryboardShot[]): StoryboardShot[] {
    return shots.map((shot, order) => (shot.order === order ? shot : { ...shot, order }));
}

function buildShot(draft: StoryboardShotDraft, order: number): StoryboardShot {
    // Drop explicitly-undefined keys so schema defaults (seconds, camera, ...) apply.
    const defined = Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined));
    try {
        return storyboardShotSchema.parse({ ...defined, id: draft.id ?? randomUUID(), order });
    } catch {
        throw libraryError(LIBRARY_INVALID_ERROR);
    }
}

async function requireStoryboard(id: string): Promise<Storyboard> {
    const entity = await readStoryboard(id);
    if (!entity) throw libraryError(LIBRARY_NOT_FOUND_ERROR);
    return entity;
}

async function commitShots(storyboardId: string, shots: readonly StoryboardShot[]): Promise<Storyboard> {
    return expectStoryboard(await updateEntity(KIND, storyboardId, { shots: normalizeOrder(shots) }));
}

/** Creates an empty storyboard; `productionId` is optional and defaults to `null`. */
export async function createStoryboard(name: string, productionId?: string | null): Promise<Storyboard> {
    return expectStoryboard(await createEntity(KIND, { name, productionId: productionId ?? null }));
}

export async function readStoryboard(id: string): Promise<Storyboard | undefined> {
    return maybeStoryboard(await readEntity(KIND, id));
}

/** Storyboards sorted by name then slug, as the store sorts every kind. */
export async function listStoryboards(): Promise<Storyboard[]> {
    const entities = await listEntities(KIND);
    return entities.filter((entity): entity is Storyboard => entity.kind === "storyboard");
}

/** Appends one panel at the end of the storyboard and returns the updated document. */
export async function addShot(storyboardId: string, shot: StoryboardShotDraft): Promise<Storyboard> {
    const parsed = storyboardShotDraftSchema.safeParse(shot);
    if (!parsed.success) throw libraryError(LIBRARY_INVALID_ERROR);
    const draft = parsed.data;
    // The schema regex covers this too; checked here so the rule is explicit at the boundary.
    if (draft.keyframeAssetId !== undefined && draft.keyframeAssetId !== null) assertAssetId(draft.keyframeAssetId);
    const current = await requireStoryboard(storyboardId);
    if (draft.id !== undefined && current.shots.some((panel) => panel.id === draft.id)) {
        throw libraryError(LIBRARY_INVALID_ERROR);
    }
    return commitShots(storyboardId, [...current.shots, buildShot(draft, current.shots.length)]);
}

/** Reorders every panel; `orderedIds` must be a permutation of the current shot ids. */
export async function reorderShots(storyboardId: string, orderedIds: readonly string[]): Promise<Storyboard> {
    const current = await requireStoryboard(storyboardId);
    if (!Array.isArray(orderedIds) || orderedIds.length !== current.shots.length) {
        throw libraryError(LIBRARY_INVALID_ERROR);
    }
    const byId = new Map(current.shots.map((shot) => [shot.id, shot]));
    const seen = new Set<string>();
    const next: StoryboardShot[] = [];
    for (const id of orderedIds) {
        const shot = typeof id === "string" && !seen.has(id) ? byId.get(id) : undefined;
        if (!shot) throw libraryError(LIBRARY_INVALID_ERROR);
        seen.add(id);
        next.push(shot);
    }
    return commitShots(storyboardId, next);
}

/** Points one panel at an existing asset id; `null` clears the keyframe. */
export async function setKeyframe(storyboardId: string, shotId: string, assetId: string | null): Promise<Storyboard> {
    if (assetId !== null) assertAssetId(assetId);
    const current = await requireStoryboard(storyboardId);
    const index = current.shots.findIndex((shot) => shot.id === shotId);
    if (index < 0) throw libraryError(LIBRARY_INVALID_ERROR);
    const next = current.shots.map((shot, position) => (position === index ? { ...shot, keyframeAssetId: assetId } : shot));
    return commitShots(storyboardId, next);
}

/** Removes one panel and renormalizes the remaining order values. */
export async function removeShot(storyboardId: string, shotId: string): Promise<Storyboard> {
    const current = await requireStoryboard(storyboardId);
    const next = current.shots.filter((shot) => shot.id !== shotId);
    if (next.length === current.shots.length) throw libraryError(LIBRARY_INVALID_ERROR);
    return commitShots(storyboardId, next);
}

/** Moves the storyboard folder to `library/.trash/storyboards`; media is untouched. */
export async function deleteStoryboard(id: string): Promise<boolean> {
    return deleteEntity(KIND, id);
}
