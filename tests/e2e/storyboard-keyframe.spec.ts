import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { test, expect } from "./fixtures";
import en from "../../src/messages/en.json";

const origin = "https://127.0.0.1:3110";

test("sets a keyframe on shot 2 from the picker and it survives a reload", async ({ page, browserErrors }) => {
    const stamp = Date.now();
    // Asset ids are content-addressed, so each run needs distinct bytes or the
    // picker dedupes against a previous project's identical upload.
    const png = await sharp({ create: { width: 8, height: 8, channels: 4,
        background: { r: stamp % 256, g: (stamp >> 8) % 256, b: (stamp >> 16) % 256, alpha: 1 } } })
        .png().toBuffer();

    const upload = await page.request.post("/api/library/assets", {
        headers: { Origin: origin },
        multipart: { file: { name: "keyframe.png", mimeType: "image/png", buffer: png } },
    });
    expect(upload.status()).toBe(201);
    const asset = await upload.json() as { assetId: string; url: string };

    const characterName = `Keyframe Source ${stamp}`;
    const character = await page.request.post("/api/library", {
        headers: { Origin: origin },
        data: { kind: "character", name: characterName, notes: "", assetIds: [asset.assetId] },
    });
    expect(character.status()).toBe(201);

    const storyboardName = `Keyframe Board ${stamp}`;
    const created = await page.request.post("/api/library", {
        headers: { Origin: origin },
        data: {
            kind: "storyboard",
            name: storyboardName,
            productionId: null,
            shots: [
                { id: randomUUID(), order: 0, intent: "Opening wide", seconds: 3, keyframeAssetId: null, camera: "24mm" },
                { id: randomUUID(), order: 1, intent: "Reveal", seconds: 4, keyframeAssetId: null, camera: "50mm" },
            ],
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    const storyboard = (await created.json()).entity as { id: string; slug: string };

    await page.goto(`/en/library/storyboards/${storyboard.slug}`);
    await expect(page.getByRole("heading", { name: storyboardName })).toBeVisible();

    const rows = page.getByTestId("storyboard-shot-row");
    await expect(rows).toHaveCount(2);
    const second = rows.nth(1);
    await expect(second.locator("img")).toHaveCount(0);

    // The trigger is a real button with an i18n label, reachable from the keyboard.
    const trigger = second.getByRole("button", { name: en.library.storyboardEditor.setKeyframe.replace("{index}", "2") });
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByTestId("storyboard-keyframe-picker");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: en.library.storyboardEditor.keyframePickerTitle })).toBeVisible();

    const option = dialog.locator(`[data-testid="storyboard-keyframe-option"][data-asset-id="${asset.assetId}"]`).filter({ hasText: characterName });
    await expect(option).toBeVisible();
    await expect(option).toHaveAccessibleName(en.library.storyboardEditor.keyframeOption
        .replace("{name}", characterName).replace("{id}", asset.assetId).replace("{index}", "2"));

    const patched = page.waitForResponse(response => response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/library/storyboard/${storyboard.id}/shots`);
    await option.click();
    expect((await patched).status()).toBe(200);

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("storyboard-keyframe-status"))
        .toContainText(en.library.storyboardEditor.keyframeSaved.replace("{index}", "2"));
    await expect(second.locator("img")).toHaveAttribute("src", asset.url);
    // Shot 1 keeps its empty keyframe.
    await expect(rows.nth(0).locator("img")).toHaveCount(0);

    await page.reload();
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1).locator("img")).toHaveAttribute("src", asset.url);
    await expect(rows.nth(0).locator("img")).toHaveCount(0);

    expect(browserErrors, "No console or page errors while picking a keyframe").toEqual([]);
});
