import type { Scene, SceneListResponse, SceneShotInput } from "../types";

export class SceneRequestError extends Error {
    constructor(public readonly code: string, public readonly status: number) {
        super(code);
        this.name = "SceneRequestError";
    }
}

async function sceneRequest<T>(url: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
        response = await fetch(url, { ...init, headers: { Accept: "application/json", ...init?.headers } });
    } catch {
        throw new SceneRequestError("ERR_LIBRARY_UNAVAILABLE", 0);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const code = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : "ERR_REQUEST_INVALID";
        throw new SceneRequestError(code, response.status);
    }
    return body as T;
}

export function listScenes(query = ""): Promise<SceneListResponse> {
    const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
    return sceneRequest<SceneListResponse>(`/api/scenes${suffix}`, { cache: "no-store" });
}

export async function createScene(name: string): Promise<Scene> {
    const body = await sceneRequest<{ scene: Scene }>("/api/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
    return body.scene;
}

export async function getScene(id: string): Promise<Scene> {
    const body = await sceneRequest<{ scene: Scene }>(`/api/scenes/${encodeURIComponent(id)}`, { cache: "no-store" });
    return body.scene;
}

/** Replaces the whole shot array; ids and order are normalized by the store. */
export async function updateSceneShots(id: string, shots: SceneShotInput[]): Promise<Scene> {
    const body = await sceneRequest<{ scene: Scene }>(`/api/scenes/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shots }),
    });
    return body.scene;
}

export async function deleteScene(id: string): Promise<void> {
    await sceneRequest<{ ok: true }>(`/api/scenes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function sceneErrorKey(error: unknown): string {
    return error instanceof SceneRequestError ? `errors.${error.code}` : "errors.generic";
}
