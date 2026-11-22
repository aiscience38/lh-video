import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, mockWorkspace } from "./fixtures";
import en from "../../src/messages/en.json";

/**
 * Edit-request composer honesty and persistence.
 *
 * No capability declares video-to-video editing today, so the model picker
 * must stay disabled with an explanation. The two real actions still work:
 * last-frame extraction opens the composer with a start frame, and a saved
 * request survives a reload through the notes API. No provider job is called.
 */

const TASK_ID = "media-edit";
const PROMPT = "A crane shot rising over a glass greenhouse";
const FRAME_HASH = "c".repeat(64);
const FRAME_URL = `/api/uploaded/${FRAME_HASH}.jpg`;

interface Note { id: string; subjectId: string; taskId: string | null; assetId: string | null; tSeconds: number; text: string; createdAt: string; decision: boolean }

async function composer(page: Page) {
    const state = await mockWorkspace(page);
    const model = state.catalog.videos[0];
    const task = {
        task_id: TASK_ID, media_type: "video", model_id: model.id, provider_id: model.provider,
        status: "COMPLETED", prompt: PROMPT, created_at: "2026-02-02T12:00:00Z",
        result_count: 1, has_download: true, video_urls: [], params: { seed: 7 }, _done: true,
    };
    await page.route(`**/api/tasks/${TASK_ID}`, route => route.fulfill({ json: task }));
    await page.route(`**/api/download/${TASK_ID}*`, route => route.fulfill({ status: 200, contentType: "video/mp4", path: "tests/e2e/assets/cut-b.mp4" }));
    await page.route(`**/api/media/${TASK_ID}/frames*`, route => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("index") !== null) return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#183b32"/></svg>` });
        return route.fulfill({ json: { taskId: TASK_ID, durationSeconds: 3, frameCount: 3, fps: 24, width: 1280, height: 720, cached: true,
            frames: Array.from({ length: 3 }, (_, index) => ({ index, timeSeconds: (index + 0.5) * 1, url: `/api/media/${TASK_ID}/frames?index=${index}` })) } });
    });
    await page.route("**/api/uploaded/**", route => route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="72"><rect width="128" height="72" fill="#25403a"/><circle cx="64" cy="36" r="16" fill="#fff" opacity=".25"/></svg>` }));
    const notes: Note[] = [];
    const calls: Array<{ method: string; path: string; body: string | null }> = [];
    await page.route("**/api/notes**", async route => {
        const request = route.request();
        const url = new URL(request.url());
        calls.push({ method: request.method(), path: url.pathname + url.search, body: request.postData() });
        if (request.method() === "GET") return route.fulfill({ json: { subjectId: TASK_ID, notes, count: notes.length } });
        if (request.method() === "POST") {
            const body = request.postDataJSON() as { taskId?: string; tSeconds?: number; text?: string };
            const note: Note = {
                id: `note-${notes.length + 1}`, subjectId: TASK_ID, taskId: body.taskId ?? null, assetId: null,
                tSeconds: body.tSeconds ?? 0, text: body.text ?? "", createdAt: "2026-02-02T12:01:00Z", decision: false,
            };
            notes.push(note);
            return route.fulfill({ status: 201, json: { note } });
        }
        return route.fulfill({ status: 400, json: { error: "ERR_NOTES_INVALID" } });
    });
    const frames: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
    await page.route("**/api/media/last-frame", async route => {
        const request = route.request();
        frames.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON() as Record<string, unknown> | null });
        return route.fulfill({ status: 201, json: { assetId: `asset_${FRAME_HASH}`, url: FRAME_URL, sourceTaskId: TASK_ID } });
    });
    return { state, notes, calls, frames };
}

test("the composer explains the missing v2v capability, extracts a start frame and persists an edit request", async ({ page }, info) => {
    const { notes, calls, frames } = await composer(page);
    await page.goto(`/en/media/${TASK_ID}`);
    await expect(page.getByTestId("media-player")).toBeVisible();

    const picker = page.getByTestId("media-edit-model");
    await expect(picker).toBeDisabled();
    await expect(page.getByTestId("media-edit-capability-hint")).toContainText(en.media.edit.noModelsExplanation);
    await expect(page.getByTestId("media-edit-extend")).toBeEnabled();
    await expect(page.getByTestId("media-edit-compare")).toHaveAttribute("href", new RegExp(`/library/revisions\\?a=.*&b=.*task=${TASK_ID}`));

    await page.getByTestId("media-edit-extend").click();
    await expect(page.locator(`img[src="${FRAME_URL}"]`)).toBeVisible();
    await expect(page.getByText(en.media.edit.extendReady)).toBeVisible();
    expect(frames).toEqual([{ method: "POST", path: "/api/media/last-frame", body: { taskId: TASK_ID } }]);

    const requestText = "Keep the greenhouse but replace the sky with a storm at dusk.";
    await page.getByTestId("media-edit-request").fill(requestText);
    await page.getByTestId("media-edit-submit").click();
    await expect(page.getByTestId("media-edit-note")).toHaveCount(1);
    await expect(page.getByTestId("media-edit-note")).toContainText(requestText);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe(requestText);
    expect(notes[0].taskId).toBe(TASK_ID);

    await page.reload();
    await expect(page.getByTestId("media-edit-note")).toContainText(requestText);
    await expect(page.getByTestId("media-edit-notes-empty")).toHaveCount(0);

    // Nothing on this page submits a provider generation job.
    expect(calls.concat(frames.map(frame => ({ method: frame.method, path: frame.path, body: null })))
        .some(call => /\/api\/(?:generate|generate-image|image-tasks)/.test(call.path))).toBe(false);

    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).disableRules(["video-caption"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath("media-edit-request.png"), fullPage: true });
});
