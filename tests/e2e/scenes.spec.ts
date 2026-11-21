import { test, expect } from "./fixtures";
import en from "../../src/messages/en.json";

const origin = "https://127.0.0.1:3110";

test.describe.configure({ mode: "serial" });

const uniqueName = (prefix: string) => `${prefix} ${Date.now()}`;

test("creates a scene, adds two shots and keeps the reordered shots after a reload", async ({ page }) => {
    const name = uniqueName("Opening Scene");
    const first = `First shot ${Date.now()}`;
    const second = `Second shot ${Date.now()}`;

    await page.goto("/en/scenes");
    await expect(page.getByRole("heading", { name: en.scenes.title, exact: true })).toBeVisible();
    await expect(page.getByTestId("scenes-nav-link")).toHaveAttribute("href", "/en/scenes");

    await page.getByRole("button", { name: en.scenes.new }).click();
    const createDialog = page.getByRole("dialog");
    await expect(createDialog.getByRole("heading", { name: en.scenes.createTitle })).toBeVisible();
    await createDialog.getByLabel(en.scenes.nameLabel).fill(name);
    await createDialog.getByRole("button", { name: en.scenes.create }).click();

    const card = page.getByTestId("scene-card").filter({ hasText: name });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("scene-shot-count")).toHaveAttribute("data-count", "0");

    await card.getByRole("link", { name: en.scenes.openBoard }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    const sceneId = page.url().split("/").pop() ?? "";
    expect(sceneId).toMatch(/^[0-9a-f-]{36}$/);

    for (const prompt of [first, second]) {
        await page.getByRole("button", { name: en.scenes.addShot }).first().click();
        const addDialog = page.getByRole("dialog");
        await expect(addDialog.getByRole("heading", { name: en.scenes.addShotTitle })).toBeVisible();
        await addDialog.getByLabel(en.scenes.promptLabel).fill(prompt);
        await addDialog.getByRole("button", { name: en.scenes.add, exact: true }).click();
        await expect(page.getByTestId("shot-card").filter({ hasText: prompt })).toBeVisible();
    }

    await expect(page.getByTestId("shot-card")).toHaveCount(2);
    await expect.poll(() => page.getByTestId("shot-prompt").allTextContents()).toEqual([first, second]);
    await expect(page.getByTestId("shot-status").first()).toHaveAttribute("data-status", "idle");
    await expect(page.getByTestId("shot-generate").first()).toBeDisabled();

    const patched = page.waitForResponse(response => response.request().method() === "PATCH"
        && new URL(response.url()).pathname === `/api/scenes/${sceneId}`);
    await page.getByTestId("shot-card").nth(0).getByTestId("shot-menu").click();
    await page.getByRole("menuitem", { name: en.scenes.moveLater }).click();
    const response = await patched;
    expect(response.status()).toBe(200);
    const payload = JSON.parse(response.request().postData() ?? "{}") as { shots?: Array<{ prompt?: string }> };
    expect(payload.shots?.map(shot => shot.prompt)).toEqual([second, first]);
    await expect.poll(() => page.getByTestId("shot-prompt").allTextContents()).toEqual([second, first]);

    await page.reload();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect.poll(() => page.getByTestId("shot-prompt").allTextContents()).toEqual([second, first]);

    const cleanup = await page.request.delete(`/api/scenes/${sceneId}`, { headers: { Origin: origin } });
    expect(cleanup.ok()).toBeTruthy();
});

test("deletes a shot, then the remaining shot and its order survive a reload", async ({ page }) => {
    const name = uniqueName("Shot Delete Scene");
    const keep = `Keep this shot ${Date.now()}`;
    const remove = `Remove this shot ${Date.now()}`;
    const created = await page.request.post("/api/scenes", {
        headers: { Origin: origin },
        data: { name, shots: [{ prompt: keep }, { prompt: remove }] },
    });
    expect(created.status()).toBe(201);
    const scene = (await created.json()).scene as { id: string };

    await page.goto(`/en/scenes/${scene.id}`);
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.getByTestId("shot-card")).toHaveCount(2);

    const patched = page.waitForResponse(response => response.request().method() === "PATCH"
        && new URL(response.url()).pathname === `/api/scenes/${scene.id}`);
    const second = page.getByTestId("shot-card").nth(1);
    await second.getByRole("button", { name: en.scenes.deleteShot }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: en.scenes.deleteShotTitle })).toBeVisible();
    await dialog.getByRole("button", { name: en.scenes.deleteShotConfirm }).click();
    const response = await patched;
    expect(response.status()).toBe(200);
    const payload = JSON.parse(response.request().postData() ?? "{}") as { shots?: Array<{ prompt?: string }> };
    expect(payload.shots?.map(shot => shot.prompt)).toEqual([keep]);

    await expect(page.getByTestId("shot-card")).toHaveCount(1);
    await page.reload();
    await expect(page.getByTestId("shot-card")).toHaveCount(1);
    await expect(page.getByTestId("shot-prompt")).toHaveText(keep);

    const cleanup = await page.request.delete(`/api/scenes/${scene.id}`, { headers: { Origin: origin } });
    expect(cleanup.ok()).toBeTruthy();
});

test("deletes a scene after confirmation and the card stays gone after a reload", async ({ page }) => {
    const name = uniqueName("Delete Scene");
    const created = await page.request.post("/api/scenes", { headers: { Origin: origin }, data: { name } });
    expect(created.status()).toBe(201);
    const scene = (await created.json()).scene as { id: string; slug: string };

    await page.goto("/en/scenes");
    const card = page.getByTestId("scene-card").filter({ hasText: name });
    await expect(card).toBeVisible();
    await card.getByRole("link", { name: en.scenes.openBoard }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();

    await page.getByRole("button", { name: en.scenes.deleteScene }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("library/.trash");
    await dialog.getByRole("button", { name: en.scenes.deleteSceneConfirm }).click();

    await expect(page).toHaveURL(/\/en\/scenes$/);
    await expect(page.getByTestId("scene-card").filter({ hasText: name })).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("scene-card").filter({ hasText: name })).toHaveCount(0);

    const list = await page.request.get("/api/scenes");
    const body = await list.json() as { scenes: Array<{ id: string }> };
    expect(body.scenes.some(candidate => candidate.id === scene.id)).toBeFalsy();
});
