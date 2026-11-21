export interface SceneShot {
    id: string;
    order: number;
    prompt: string;
    capabilityId: string | null;
    params: Record<string, unknown>;
    assetIds: string[];
    taskIds: string[];
}

export interface Scene {
    id: string;
    kind: "scene";
    name: string;
    slug: string;
    shots: SceneShot[];
    createdAt: string;
    updatedAt: string;
}

/** A shot as accepted by PATCH; the store owns `id` and `order`. */
export type SceneShotInput = Partial<Pick<SceneShot, "id" | "prompt" | "capabilityId" | "params" | "assetIds" | "taskIds">>;

export type ShotStatus = "idle" | "queued" | "running" | "done" | "failed";

export interface SceneListResponse {
    scenes: Scene[];
    count: number;
}

export function sortShots(shots: SceneShot[]): SceneShot[] {
    return [...shots].sort((left, right) => left.order - right.order);
}
