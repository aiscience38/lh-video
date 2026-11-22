import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, mockWorkspace } from "./fixtures";
import en from "../../src/messages/en.json";

/**
 * Rendered-video detail page.
 *
 * The task, filmstrip and media bytes are mocked at the HTTP boundary; the
 * player, timeline and timecode are the real components, so a thumbnail click
 * must move the actual video element's clock.
 */

const TASK_ID = "media-video";
const PROMPT = "A slow dolly through a rain-slicked corridor";

async function detail(page: Page) {
    const state = await mockWorkspace(page);
    const model = state.catalog.videos[0];
    const task = {
        task_id: TASK_ID, media_type: "video" as const, model_id: model.id, provider_id: model.provider,
        status: "COMPLETED", prompt: PROMPT, created_at: "2026-02-01T09:30:00Z",
        result_count: 1, has_download: true, video_urls: [], params: { seed: 424242, motion: 3 }, _done: true,
    };
    state.history = [task];
    await page.route(`**/api/tasks/${TASK_ID}`, route => route.fulfill({ json: task }));
    await page.route(`**/api/download/${TASK_ID}*`, route => route.fulfill({
        status: 200, contentType: "video/mp4", path: "tests/e2e/assets/cut-a.mp4",
    }));
    const frames = Array.from({ length: 4 }, (_, index) => ({
        index, timeSeconds: (index + 0.5) * 1, url: `/api/media/${TASK_ID}/frames?index=${index}`,
    }));
    await page.route(`**/api/media/${TASK_ID}/frames*`, route => {
        const url = new URL(route.request().url());
        const index = url.searchParams.get("index");
        if (index !== null) {
            return route.fulfill({
                contentType: "image/svg+xml",
                body: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#${index === "3" ? "a45c41" : "183b32"}"/><circle cx="80" cy="45" r="18" fill="#fff" opacity=".25"/></svg>`,
            });
        }
        return route.fulfill({
            json: { taskId: TASK_ID, durationSeconds: 4, frameCount: 4, fps: 24, width: 1280, height: 720, cached: true, frames },
        });
    });
    await page.route("**/api/notes**", route => route.fulfill({ json: { subjectId: TASK_ID, notes: [], count: 0 } }));
    return state;
}

test("a completed video opens its detail page from the gallery with a player, readable metadata and a scrubbing timeline", async ({ page }, info) => {
    await detail(page);
    await page.goto("/en");
    const tile = page.locator(`[data-gallery-key="${TASK_ID}:0"]`);
    await expect(tile).toBeVisible();
    await tile.getByRole("link", { name: new RegExp(en.tasks.openVideo) }).click();
    await page.waitForURL(`**/en/media/${TASK_ID}`);

    const player = page.getByTestId("media-player");
    await expect(player).toBeVisible();
    await expect(player).toHaveAttribute("src", `/api/download/${TASK_ID}?inline=1`);
    await expect.poll(() => player.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThan(0);

    await expect(page.getByTestId("media-model")).not.toHaveText("");
    await expect(page.getByTestId("media-provider")).not.toHaveText("");
    await expect(page.getByTestId("media-seed")).toHaveText("424242");
    await expect(page.getByText(PROMPT).first()).toBeVisible();

    const current = page.getByTestId("media-current-timecode");
    await expect(current).toHaveText("00:00:00:00");
    await page.getByTestId("media-filmstrip-frame-3").click();
    await expect.poll(() => player.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(2.5);
    await expect(current).not.toHaveText("00:00:00:00");
    await expect(current).toHaveText(/^\d{2}:\d{2}:\d{2}:\d{2}$/);
    await expect(page.getByTestId("media-total-timecode")).toHaveText("00:00:04:00");

    const beforeStep = await player.evaluate(node => (node as HTMLVideoElement).currentTime);
    await page.getByTestId("media-next-frame").click();
    await expect.poll(() => player.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(beforeStep + 0.02);

    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).disableRules(["video-caption"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath("media-detail.png"), fullPage: true });

    await page.getByRole("link", { name: en.media.detail.backToGallery }).click();
    await page.waitForURL("**/en");
    await expect(page.locator("[data-gallery-grid]")).toBeVisible();
});

test("a video opened in a scene shot links to the same detail page", async ({ page }) => {
    await detail(page);
    await page.route("**/api/scenes**", route => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/scenes") return route.fulfill({ json: { scenes: [{ id: "scene-1", kind: "scene", name: "Corridor", slug: "corridor", shots: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], count: 1 } });
        return route.fulfill({ json: { scene: { id: "scene-1", kind: "scene", name: "Corridor", slug: "corridor", shots: [
            { id: "shot-1", order: 0, prompt: "Corridor dolly", capabilityId: null, params: {}, assetIds: [], taskIds: [TASK_ID] },
        ], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } } });
    });
    await page.goto("/en/scenes/scene-1");
    const link = page.getByTestId("shot-video-link");
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(`**/en/media/${TASK_ID}`);
    await expect(page.getByTestId("media-player")).toBeVisible();
});
