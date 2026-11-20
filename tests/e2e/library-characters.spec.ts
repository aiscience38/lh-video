import { test, expect } from "./fixtures";
import en from "../../src/messages/en.json";

// Minimal 8x8 PNG used by the upload/reference tests.
const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWO4+t8dK2IYWhIAylSGwYMD4fAAAAAASUVORK5CYII=",
    "base64",
);
const origin = "https://127.0.0.1:3110";

test.describe.configure({ mode: "serial" });

test("overview shows live counts for all three kinds and the on-disk layout", async ({ page }) => {
    await page.goto("/en/library");
    await expect(page.getByRole("heading", { name: en.library.overview.title })).toBeVisible();
    const counts: number[] = [];
    for (const kind of ["characters", "scenes", "storyboards"]) {
        await expect(page.getByTestId(`library-card-${kind}`)).toBeVisible();
        const count = page.getByTestId(`library-count-${kind}`);
        await expect(count).toHaveText(/^\d+$/);
        counts.push(Number(await count.textContent()));
    }
    // Projects share one e2e server, so earlier projects may already have created characters.
    if (counts.every(value => value === 0)) await expect(page.getByTestId("library-overview-empty")).toBeVisible();
    await expect(page.getByTestId("library-layout")).toContainText("characters/");
    await expect(page.getByTestId("library-layout")).toContainText("character.json");
    await expect(page.getByTestId("library-layout")).toContainText(".trash");
    await expect(page.getByTestId("library-overview-empty")).toBeVisible();
});

test("upload endpoint accepts a reference image and returns a library asset id", async ({ request }) => {
    const response = await request.post("/api/library/assets", {
        headers: { Origin: origin },
        multipart: { file: { name: "ana.png", mimeType: "image/png", buffer: png } },
    });
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.assetId).toMatch(/^asset_[a-f0-9]{64}$/);
    expect(body.url).toMatch(/^\/api\/uploaded\/[a-f0-9]{64}\.jpg$/);
    expect((await request.get(body.url)).ok()).toBeTruthy();
});

test("creates a character with one uploaded reference and persists after reload", async ({ page }) => {
    const name = `Ana Reference ${Date.now()}`;
    await page.goto("/en/library/characters");
    await expect(page.getByRole("heading", { name: en.library.characters.title })).toBeVisible();

    await page.getByRole("button", { name: en.library.characters.new }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: en.library.characters.createTitle })).toBeVisible();
    await dialog.getByLabel(en.library.characters.nameLabel).fill(name);
    await dialog.getByLabel(en.library.characters.notesLabel).fill("Lead character");
    await dialog.locator('input[type="file"]').setInputFiles({ name: "ana.png", mimeType: "image/png", buffer: png });
    await dialog.getByRole("button", { name: en.library.characters.create }).click();

    const card = page.getByTestId("character-card").filter({ hasText: name });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("character-reference-count")).toHaveAttribute("data-count", "1");
    const image = card.locator("img");
    await expect(image).toHaveAttribute("src", /\/api\/uploaded\/[a-f0-9]{64}\.jpg$/);
    await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    await page.reload();
    await expect(page.getByTestId("character-card").filter({ hasText: name })).toBeVisible();
});

test("renames a character through PATCH and persists after reload", async ({ page }) => {
    const name = `Rename Me ${Date.now()}`;
    const renamed = `Renamed Character ${Date.now()}`;
    const created = await page.request.post("/api/library", {
        headers: { Origin: origin },
        data: { kind: "character", name, notes: "Before rename", assetIds: [] },
    });
    expect(created.status()).toBe(201);

    await page.goto("/en/library/characters");
    const card = page.getByTestId("character-card").filter({ hasText: name });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: en.library.characters.rename }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: en.library.characters.renameTitle })).toBeVisible();
    await dialog.getByLabel(en.library.characters.nameLabel).fill(renamed);
    await dialog.getByRole("button", { name: en.library.characters.save }).click();
    await expect(page.getByTestId("character-card").filter({ hasText: renamed })).toBeVisible();
    await expect(page.getByTestId("character-card").filter({ hasText: name })).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("character-card").filter({ hasText: renamed })).toBeVisible();
});

test("deletes a character after confirmation and removes the card", async ({ page }) => {
    const name = `Delete Me ${Date.now()}`;
    const created = await page.request.post("/api/library", {
        headers: { Origin: origin },
        data: { kind: "character", name, notes: "Delete me", assetIds: [] },
    });
    expect(created.status()).toBe(201);

    await page.goto("/en/library/characters");
    const card = page.getByTestId("character-card").filter({ hasText: name });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: en.library.characters.delete }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(".trash");
    await dialog.getByRole("button", { name: en.library.characters.deleteConfirm }).click();
    await expect(page.getByTestId("character-card").filter({ hasText: name })).toHaveCount(0);

    const list = await page.request.get("/api/library?kind=character");
    const body = await list.json();
    expect((body.entities as Array<{ name: string }>).some(entity => entity.name === name)).toBeFalsy();
});

test("deep link /library/characters/SLUG opens the card detail", async ({ page }) => {
    const name = `Deep Link ${Date.now()}`;
    const notes = "Visible on the detail page";
    const created = await page.request.post("/api/library", {
        headers: { Origin: origin },
        data: { kind: "character", name, notes, assetIds: [] },
    });
    expect(created.status()).toBe(201);
    const entity = (await created.json()).entity as { slug: string };

    await page.goto(`/en/library/characters/${encodeURIComponent(entity.slug)}`);
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.getByText(notes)).toBeVisible();
    await expect(page.getByRole("link", { name: en.library.characters.detail.back })).toHaveAttribute("href", "/en/library/characters");
});
