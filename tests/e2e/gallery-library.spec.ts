import type { Page } from "@playwright/test";
import { test, expect, mockWorkspace } from "./fixtures";
import en from "../../src/messages/en.json";

/**
 * Gallery to Library hand-offs and shot extension.
 *
 * The Library is mocked at the HTTP boundary: every PATCH is recorded and
 * applied to an in-memory entity, so "persisted" means the exact document the
 * next GET would return — not just a request that fired.
 */

const MODEL_ID = "toapis__qwen-image-3.0-pro";

interface CharacterEntity { id: string; kind: "character"; name: string; slug: string; notes: string; assetIds: string[]; createdAt: string; updatedAt: string }
interface StoryboardShot { id: string; order: number; intent: string; seconds: number; keyframeAssetId: string | null; camera: string }
interface StoryboardEntity { id: string; kind: "storyboard"; name: string; slug: string; productionId: string | null; shots: StoryboardShot[]; createdAt: string; updatedAt: string }
interface Recorded { method: string; path: string; body: Record<string, unknown> | null }

async function workspace(page: Page) {
    const state = await mockWorkspace(page);
    state.history = [
        { task_id: "gallery-video", media_type: "video", model_id: state.catalog.videos[0].id, status: "COMPLETED", prompt: "A slow dolly through the corridor", created_at: "2026-01-04T00:00:00Z", result_count: 1 },
        { task_id: "gallery-a", media_type: "image", model_id: MODEL_ID, status: "COMPLETED", prompt: "A quiet coast at sunrise", created_at: "2026-01-03T00:00:00Z", has_download: true, result_count: 2 },
        { task_id: "gallery-b", media_type: "image", model_id: MODEL_ID, status: "COMPLETED", prompt: "A modern house in the forest", created_at: "2026-01-02T00:00:00Z", has_download: true, result_count: 1 },
    ];
    await page.route("**/api/download/**", route => route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="640"><rect width="800" height="640" fill="#25403a"/></svg>` }));
    await page.route("**/api/uploaded/**", route => route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#4b3f27"/></svg>` }));

    const characters: CharacterEntity[] = [{
        id: "character-ana", kind: "character", name: "Ana", slug: "ana", notes: "Copper hair",
        assetIds: ["asset_seed"], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    }];
    const storyboards: StoryboardEntity[] = [{
        id: "storyboard-teaser", kind: "storyboard", name: "Teaser", slug: "teaser", productionId: null,
        shots: [
            { id: "shot-open", order: 0, intent: "Establishing shot", seconds: 3, keyframeAssetId: "asset_existing", camera: "24mm" },
            { id: "shot-close", order: 1, intent: "Close on hands", seconds: 2, keyframeAssetId: null, camera: "macro" },
        ],
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    }];
    const patches: Recorded[] = [];
    const frames: Recorded[] = [];
    await page.route("**/api/library**", async route => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
        if (method !== "GET") patches.push({ method, path: url.pathname + url.search, body });
        if (method === "GET" && url.pathname === "/api/library") {
            const kind = url.searchParams.get("kind");
            const entities = kind === "storyboard" ? storyboards : kind === "character" ? characters : [...characters, ...storyboards];
            return route.fulfill({ json: { entities, count: entities.length } });
        }
        const characterId = /^\/api\/library\/character\/([^/]+)$/.exec(url.pathname)?.[1];
        if (method === "PATCH" && characterId) {
            const character = characters.find(item => item.id === characterId);
            if (!character) return route.fulfill({ status: 404, json: { error: "ERR_LIBRARY_NOT_FOUND" } });
            character.assetIds = body?.assetIds as string[];
            character.updatedAt = "2026-02-01T00:00:00Z";
            return route.fulfill({ json: { entity: character } });
        }
        const storyboardId = /^\/api\/library\/storyboard\/([^/]+)$/.exec(url.pathname)?.[1];
        if (method === "PATCH" && storyboardId) {
            const storyboard = storyboards.find(item => item.id === storyboardId);
            if (!storyboard) return route.fulfill({ status: 404, json: { error: "ERR_LIBRARY_NOT_FOUND" } });
            storyboard.shots = body?.shots as StoryboardShot[];
            storyboard.updatedAt = "2026-02-01T00:00:00Z";
            return route.fulfill({ json: { entity: storyboard } });
        }
        return route.fulfill({ status: 400, json: { error: "ERR_SYNTHETIC_UNEXPECTED_REQUEST" } });
    });
    await page.route("**/api/media/last-frame", async route => {
        const request = route.request();
        const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
        frames.push({ method: request.method(), path: new URL(request.url()).pathname, body });
        const hash = "b".repeat(64);
        return route.fulfill({ status: 201, json: { assetId: `asset_${hash}`, url: `/api/uploaded/${hash}.jpg`, sourceTaskId: body?.taskId } });
    });
    return { state, characters, storyboards, patches, frames };
}

const card = (page: Page, key: string) => page.locator(`[data-gallery-key="${key}"]`);
async function openMenu(page: Page, key: string) {
    await card(page, key).hover();
    await card(page, key).getByRole("button", { name: en.tasks.moreActions, exact: true }).click();
}

test("a gallery image is appended to the character and the Library keeps it across a reload", async ({ page }) => {
    const { characters, patches } = await workspace(page);
    await page.goto("/en");
    await openMenu(page, "gallery-a:1");
    await page.getByRole("menuitem", { name: en.tasks.addToCharacter, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: en.tasks.characterLabel })).toHaveValue("character-ana");
    await dialog.getByRole("button", { name: en.tasks.pickerConfirm, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("1 image added to Ana.")).toBeVisible();
    expect(patches).toEqual([{ method: "PATCH", path: "/api/library/character/character-ana", body: { assetIds: ["asset_seed", "gallery-a"] } }]);
    expect(characters[0].assetIds).toEqual(["asset_seed", "gallery-a"]);

    // Reopening after a reload starts from the persisted document, and re-adding the same image is idempotent.
    await page.reload();
    await openMenu(page, "gallery-a:1");
    await page.getByRole("menuitem", { name: en.tasks.addToCharacter, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: en.tasks.pickerConfirm, exact: true }).click();
    await expect(page.getByText("1 image added to Ana.")).toBeVisible();
    expect(characters[0].assetIds, "the same asset id is never duplicated").toEqual(["asset_seed", "gallery-a"]);
});

test("bulk selection adds every selected image to one character in a single write", async ({ page }) => {
    const { characters, patches } = await workspace(page);
    await page.goto("/en");
    await card(page, "gallery-a:0").getByRole("checkbox").click();
    await card(page, "gallery-b:0").getByRole("checkbox").click();
    await page.getByRole("button", { name: en.tasks.addToCharacter, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: en.tasks.pickerConfirm, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("2 images added to Ana.")).toBeVisible();
    expect(patches).toEqual([{ method: "PATCH", path: "/api/library/character/character-ana", body: { assetIds: ["asset_seed", "gallery-a", "gallery-b"] } }]);
    expect(characters[0].assetIds).toEqual(["asset_seed", "gallery-a", "gallery-b"]);
});

test("an image becomes a storyboard keyframe on the chosen panel without clearing other panels", async ({ page }) => {
    const { storyboards, patches } = await workspace(page);
    await page.goto("/en");
    await openMenu(page, "gallery-b:0");
    await page.getByRole("menuitem", { name: en.tasks.setAsKeyframe, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: en.tasks.shotLabel }).selectOption("1");
    await dialog.getByRole("button", { name: en.tasks.pickerConfirm, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(en.tasks.keyframeSaved)).toBeVisible();
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe("/api/library/storyboard/storyboard-teaser");
    expect((patches[0].body?.shots as StoryboardShot[]).map(shot => shot.keyframeAssetId)).toEqual(["asset_existing", "gallery-b"]);
    expect((patches[0].body?.shots as StoryboardShot[])[0], "untouched panels keep their intent, duration and camera")
        .toMatchObject({ id: "shot-open", intent: "Establishing shot", seconds: 3, camera: "24mm", keyframeAssetId: "asset_existing" });
    expect(storyboards[0].shots[1].keyframeAssetId).toBe("gallery-b");
});

test("a completed video extends by extracting its last frame into the composer's start frame", async ({ page }) => {
    const { frames } = await workspace(page);
    const frameUrl = `/api/uploaded/${"b".repeat(64)}.jpg`;
    await page.goto("/en");
    await openMenu(page, "gallery-video:0");
    await page.getByRole("menuitem", { name: en.tasks.extend, exact: true }).click();
    // The composer switches to video mode and attaches the returned still, so the start frame is ready to generate from.
    await expect(page.locator(`img[src="${frameUrl}"]`)).toBeVisible();
    expect(frames).toEqual([{ method: "POST", path: "/api/media/last-frame", body: { taskId: "gallery-video" } }]);
});

test("image tiles never offer shot extension", async ({ page }) => {
    await workspace(page);
    await page.goto("/en");
    await openMenu(page, "gallery-a:0");
    await expect(page.getByRole("menuitem", { name: en.tasks.extend, exact: true })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: en.tasks.addToCharacter, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
});
