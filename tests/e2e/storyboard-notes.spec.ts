import fs from "node:fs";
import { test, expect } from "./fixtures";
import { startFixtureServer, type FixtureServer } from "./fixture-server";

const origin = "https://127.0.0.1:3110";

let fixtures: FixtureServer;
test.beforeAll(async () => {
    fixtures = await startFixtureServer();
});
test.afterAll(async () => {
    await fixtures.close();
});

test("a note at 3.2 seconds persists and appears in the downloaded REVIEW.md", async ({ page, browserName }) => {
    const name = `Notes Board ${Date.now()}`;
    const created = await page.request.post("/api/library", {
        headers: { Origin: origin },
        data: {
            kind: "storyboard",
            name,
            productionId: null,
            shots: [],
        },
    });
    expect(created.status()).toBe(201);
    const storyboard = (await created.json()).entity as { id: string; slug: string };

    const base = browserName === "webkit" ? fixtures.baseUrl : "/e2e-fixtures";
    const videoSource = `${base}/storyboard-preview.mp4`;
    await page.goto(`/en/library/storyboards/${storyboard.slug}?video=${encodeURIComponent(videoSource)}&task=task_notes_e2e`);
    await expect(page.getByRole("heading", { name })).toBeVisible();

    const video = page.getByTestId("storyboard-video");
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThan(0);
    await video.evaluate((node) => {
        (node as HTMLVideoElement).currentTime = 3.2;
    });
    await expect.poll(() => page.getByTestId("storyboard-note-time").textContent()).toBe("00:03.200");

    await page.getByTestId("storyboard-note-text").fill("Hero enters late");
    await page.getByTestId("storyboard-note-add").click();

    const note = page.getByTestId("storyboard-note").filter({ hasText: "Hero enters late" });
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute("data-t-seconds", "3.2");
    await expect(note).toContainText("00:03.200");

    await page.reload();
    await expect(page.getByTestId("storyboard-note").filter({ hasText: "Hero enters late" })).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("storyboard-download-review").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("REVIEW.md");
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const markdown = fs.readFileSync(downloadPath as string, "utf8");
    expect(markdown).toContain("# REVIEW");
    expect(markdown).toContain("00:03.200");
    expect(markdown).toContain("Hero enters late");
});

test("adds, edits, reorders and deletes shots through the storyboard editor", async ({ page }) => {
    const name = `Editor Board ${Date.now()}`;
    const created = await page.request.post("/api/library", {
        headers: { Origin: origin },
        data: { kind: "storyboard", name, productionId: null, shots: [] },
    });
    expect(created.status()).toBe(201);
    const storyboard = (await created.json()).entity as { id: string; slug: string };

    await page.goto(`/en/library/storyboards/${storyboard.slug}`);
    await expect(page.getByRole("heading", { name })).toBeVisible();

    const addShot = page.getByRole("button", { name: "Add shot" });
    await addShot.click();
    await expect(page.getByTestId("storyboard-shot-row")).toHaveCount(1);
    await addShot.click();
    await expect(page.getByTestId("storyboard-shot-row")).toHaveCount(2);

    const rows = page.getByTestId("storyboard-shot-row");
    const first = rows.nth(0);
    await first.getByLabel("Intent for shot 1").fill("Opening wide");
    await first.getByLabel("Seconds for shot 1").fill("4.5");
    await first.getByLabel("Camera for shot 1").fill("24mm");
    const saveResponse = page.waitForResponse((response) =>
        response.request().method() === "PATCH" && response.url().includes(`/api/library/storyboard/${storyboard.id}`));
    await first.getByTestId("storyboard-shot-save").click();
    expect((await saveResponse).status()).toBe(200);
    await expect(first.getByTestId("storyboard-shot-save")).toBeDisabled();

    await page.reload();
    await expect(rows.nth(0).getByLabel("Intent for shot 1")).toHaveValue("Opening wide");
    await expect(rows.nth(0).getByLabel("Seconds for shot 1")).toHaveValue("4.5");
    await expect(rows.nth(0).getByLabel("Camera for shot 1")).toHaveValue("24mm");

    const secondId = await rows.nth(1).getAttribute("data-shot-id");
    await rows.nth(0).getByRole("button", { name: "Move shot 1 down" }).click();
    await expect.poll(() => rows.nth(0).getAttribute("data-shot-id")).toBe(secondId);

    await rows.nth(0).getByRole("button", { name: "Delete shot 1" }).click();
    await expect(rows).toHaveCount(1);
});
