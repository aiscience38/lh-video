import "server-only";

import { randomUUID } from "node:crypto";
import {
    LIBRARY_INVALID_ERROR,
    LIBRARY_KIND_ERROR,
    LIBRARY_NOT_FOUND_ERROR,
    shotSchema,
    type LibraryEntity,
    type Scene,
    type Shot,
} from "@/server/library/contract";
import { createEntity, deleteEntity, listEntities, readEntity, updateEntity } from "@/server/library/store";

/**
 * Scenes are ordinary library entities (`kind: "scene"`). This module only
 * adds the shot-level operations the library CRUD does not express: assigning
 * shot ids, normalizing `order` to the array index on every write, and
 * rejecting a reorder whose id list does not match the stored shots.
 */

/** A shot as accepted on input; the store owns `id` and `order`. */
export type SceneShotInput = {
    id?: string;
    prompt?: string;
    capabilityId?: string | null;
    params?: Record<string, unknown>;
    assetIds?: string[];
    taskIds?: string[];
};

function sceneError(code: string): Error {
    return new Error(code);
}

/** In-process per-scene queue; the library store still serializes writes per kind. */
const sceneQueues = new Map<string, Promise<unknown>>();

async function withSceneLock<T>(sceneId: string, operation: () => Promise<T>): Promise<T> {
    const key = typeof sceneId === "string" ? sceneId : "";
    const previous = sceneQueues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.catch(() => undefined);
    sceneQueues.set(key, settled);
    void settled.then(() => {
        if (sceneQueues.get(key) === settled) sceneQueues.delete(key);
    });
    return pending;
}

function asScene(entity: LibraryEntity): Scene {
    if (entity.kind !== "scene") throw sceneError(LIBRARY_KIND_ERROR);
    return entity;
}

/**
 * Validates every shot and rewrites `order` to its array index. Supplied ids
 * must be UUIDs and are reused; missing ids get a fresh UUID. Duplicate ids are
 * rejected so `reorderShots` always has one unambiguous target per id.
 */
function normalizeShots(shots: SceneShotInput[]): Shot[] {
    if (!Array.isArray(shots)) throw sceneError(LIBRARY_INVALID_ERROR);
    const seen = new Set<string>();
    return shots.map((shot, index) => {
        if (!shot || typeof shot !== "object" || Array.isArray(shot)) throw sceneError(LIBRARY_INVALID_ERROR);
        const id = shot.id ?? randomUUID();
        if (seen.has(id)) throw sceneError(LIBRARY_INVALID_ERROR);
        seen.add(id);
        const parsed = shotSchema.safeParse({ ...shot, id, order: index });
        if (!parsed.success) throw sceneError(LIBRARY_INVALID_ERROR);
        return parsed.data;
    });
}

export async function createScene(name: string, shots: SceneShotInput[] = []): Promise<Scene> {
    const normalized = normalizeShots(shots);
    return asScene(await createEntity("scene", { name, shots: normalized }));
}

export async function listScenes(): Promise<Scene[]> {
    return (await listEntities("scene")).map(asScene);
}

export async function readScene(id: string): Promise<Scene | undefined> {
    const entity = await readEntity("scene", id);
    return entity ? asScene(entity) : undefined;
}

/** Replaces the whole shot array; ids are preserved when supplied, order is normalized. */
export async function updateSceneShots(id: string, shots: SceneShotInput[]): Promise<Scene> {
    if (!Array.isArray(shots)) throw sceneError(LIBRARY_INVALID_ERROR);
    return withSceneLock(id, async () => {
        const current = await readScene(id);
        if (!current) throw sceneError(LIBRARY_NOT_FOUND_ERROR);
        const normalized = normalizeShots(shots);
        return asScene(await updateEntity("scene", id, { shots: normalized }));
    });
}

/** Appends one shot at the end; the shot id is generated unless a valid UUID is supplied. */
export async function addShot(sceneId: string, shot: SceneShotInput): Promise<Scene> {
    if (!shot || typeof shot !== "object" || Array.isArray(shot)) throw sceneError(LIBRARY_INVALID_ERROR);
    return withSceneLock(sceneId, async () => {
        const current = await readScene(sceneId);
        if (!current) throw sceneError(LIBRARY_NOT_FOUND_ERROR);
        const normalized = normalizeShots([...current.shots, shot]);
        return asScene(await updateEntity("scene", sceneId, { shots: normalized }));
    });
}

/**
 * `orderedIds` must list every stored shot id exactly once. Anything else is
 * rejected before the store writes, so a failed reorder leaves the document
 * byte-for-byte unchanged.
 */
export async function reorderShots(sceneId: string, orderedIds: string[]): Promise<Scene> {
    if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== "string")) {
        throw sceneError(LIBRARY_INVALID_ERROR);
    }
    return withSceneLock(sceneId, async () => {
        const current = await readScene(sceneId);
        if (!current) throw sceneError(LIBRARY_NOT_FOUND_ERROR);
        if (orderedIds.length !== current.shots.length) throw sceneError(LIBRARY_INVALID_ERROR);
        const byId = new Map(current.shots.map((shot) => [shot.id, shot]));
        const seen = new Set<string>();
        const ordered: Shot[] = [];
        for (const id of orderedIds) {
            const shot = byId.get(id);
            if (!shot || seen.has(id)) throw sceneError(LIBRARY_INVALID_ERROR);
            seen.add(id);
            ordered.push(shot);
        }
        return asScene(await updateEntity("scene", sceneId, {
            shots: ordered.map((shot, index) => ({ ...shot, order: index })),
        }));
    });
}

/** Moves the scene folder into `library/.trash/scenes`; false for an unknown id. */
export async function deleteScene(id: string): Promise<boolean> {
    return withSceneLock(id, () => deleteEntity("scene", id));
}
