import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { startFixtureServer, type FixtureServer } from "./fixture-server";

const SUBJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let fixtures: FixtureServer;
test.beforeAll(async () => {
    fixtures = await startFixtureServer();
});
test.afterAll(async () => {
    await fixtures.close();
});

async function currentTime(page: Page, testId: string): Promise<number> {
    return Number(await page.getByTestId(testId).getAttribute("data-current-time"));
}

test("two cuts share one playhead, step frames and switch the audio source", async ({ page, browserName }) => {
    const base = browserName === "webkit" ? fixtures.baseUrl : "/e2e-fixtures";
    const cutA = encodeURIComponent(`${base}/cut-a.mp4`);
    const cutB = encodeURIComponent(`${base}/cut-b.mp4`);
    await page.goto(`/en/library/revisions?a=${cutA}&b=${cutB}&task=task_revision_e2e&subject=${SUBJECT}`);

    const videoA = page.getByTestId("revision-video-a");
    const videoB = page.getByTestId("revision-video-b");
    await expect.poll(() => videoA.evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThan(0);
    await expect.poll(() => videoB.evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThan(0);

    await videoA.evaluate((node) => {
        (node as HTMLVideoElement).currentTime = 2.5;
    });
    await expect.poll(async () => Math.abs(await currentTime(page, "revision-video-a") - 2.5)).toBeLessThan(0.08);
    await expect.poll(async () => Math.abs(await currentTime(page, "revision-video-a") - await currentTime(page, "revision-video-b"))).toBeLessThan(0.12);

    const before = await currentTime(page, "revision-video-a");
    await page.getByTestId("revision-frame-forward").click();
    await expect.poll(async () => (await currentTime(page, "revision-video-a")) - before).toBeGreaterThan(0.02);
    await expect.poll(async () => Math.abs(await currentTime(page, "revision-video-a") - await currentTime(page, "revision-video-b"))).toBeLessThan(0.12);

    await page.getByTestId("revision-audio-b").check();
    await expect.poll(() => videoA.evaluate((node) => (node as HTMLVideoElement).muted)).toBe(true);
    await expect.poll(() => videoB.evaluate((node) => (node as HTMLVideoElement).muted)).toBe(false);

    await page.getByTestId("revision-accept").click();
    await expect(page.getByTestId("revision-status")).toContainText("Revision B accepted");

    const response = await page.request.get(`/api/notes?subjectId=${SUBJECT}`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json() as { notes: Array<{ text: string; decision: boolean; taskId: string | null }> };
    expect(body.notes.some((note) => note.decision && note.text === "Accepted revision B over A." && note.taskId === "task_revision_e2e")).toBeTruthy();
});
