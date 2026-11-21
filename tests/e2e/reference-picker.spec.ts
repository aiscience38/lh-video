import type { Page, Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, mockWorkspace } from "./fixtures";
import type { LibraryEntity } from "../../src/features/library/types";
import en from "../../src/messages/en.json";

// Minimal 8x8 PNG used by the reference previews.
const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWO4+t8dK2IYWhIAylSGwYMD4fAAAAAASUVORK5CYII=",
    "base64",
);
const imageId = "toapis__qwen-image-3.0-pro";
const videoId = "vercel-ai-gateway__google__veo-3.1-generate-001";
const composer = (page: Page) => page.locator("[data-studio-composer]");
const generate = (page: Page) => page.getByRole("button", { name: new RegExp(`^${en.common.generate}`) });

const timestamp = "2026-11-01T00:00:00.000Z";
function character(id: string, name: string, assetIds: string[]): LibraryEntity {
    return { id, kind: "character", ingredientKind: "character", name, slug: id, notes: "", assetIds, createdAt: timestamp, updatedAt: timestamp };
}

async function setup(page: Page) {
    const state = await mockWorkspace(page);
    state.catalog.images = [state.catalog.images.find(model => model.id === imageId)!];
    state.catalog.videos = [state.catalog.videos.find(model => model.id === videoId)!];
    state.library = [
        character("c1", "Ana Reference", ["task_ana_one", "task_ana_two"]),
        character("c2", "Ben Reference", ["task_ben_one", "task_ben_two"]),
        {
            id: "s1", kind: "scene", name: "Rooftop Scene", slug: "rooftop-scene",
            shots: [{ id: "shot1", order: 0, assetIds: ["task_scene_one"] }], createdAt: timestamp, updatedAt: timestamp,
        },
    ];
    await page.route("**/api/download/**", route => route.fulfill({ contentType: "image/png", body: png }));
    return state;
}

async function submittedForm(route: Route) {
    const request = route.request();
    return new Response(new Uint8Array(request.postDataBuffer()!), { headers: { "content-type": (await request.headerValue("content-type"))! } }).formData();
}

test("multi-selected characters attach their saved images and over-capacity assets are refused in plain language", async ({ page }) => {
    await setup(page);
    await page.goto("/en");

    const trigger = page.getByTestId("picker-open");
    await expect(trigger).toBeEnabled();
    await trigger.click();
    const dialog = page.getByTestId("reference-picker");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: en.picker.title })).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);

    // Search is immediate and scoped to the dialog.
    await dialog.getByLabel(en.picker.searchLabel).fill("ben");
    await expect(dialog.getByTestId("picker-card")).toHaveCount(1);
    await expect(dialog.getByTestId("picker-card")).toContainText("Ben Reference");
    await dialog.getByLabel(en.picker.searchLabel).fill("");
    await expect(dialog.getByTestId("picker-card")).toHaveCount(3);

    // Kind filters cover characters, scenes and storyboards.
    await dialog.getByTestId("picker-kind-scene").click();
    await expect(dialog.getByTestId("picker-card")).toHaveCount(1);
    await expect(dialog.getByTestId("picker-card")).toContainText("Rooftop Scene");
    await dialog.getByTestId("picker-kind-all").click();

    // Ana brings two saved images; the Qwen capability has room for exactly three references.
    await dialog.getByTestId("picker-card").filter({ hasText: "Ana Reference" }).click();
    await expect(dialog.getByTestId("picker-selection-summary")).toContainText("Selected: 1");
    await expect(dialog.getByTestId("picker-selection-summary")).toContainText("References ready: 2");
    await dialog.getByRole("button", { name: en.picker.attach }).click();
    await expect(dialog).toBeHidden();
    await expect(composer(page).getByRole("button", { name: /^Remove / })).toHaveCount(2);

    // Ben also brings two images; only one fits, so the other is refused instead of dropped silently.
    await page.getByTestId("picker-open").click();
    const second = page.getByTestId("reference-picker");
    await expect(second).toBeVisible();
    await second.getByTestId("picker-card").filter({ hasText: "Ben Reference" }).click();
    await expect(second.getByTestId("picker-capacity-note")).toContainText("1 of 2 references fit");
    await expect(second.getByTestId("picker-refusals")).toContainText(en.picker.refusalsTitle);
    await expect(second.getByTestId("picker-refusals")).toContainText("Ben Reference: qwen-image-3.0-pro - ToAPIs has no free image reference slots left.");
    await second.getByRole("button", { name: en.picker.attach }).click();
    await expect(second).toBeHidden();

    await expect(page.getByTestId("picker-refusals").filter({ visible: true })).toContainText("Ben Reference");
    await expect(page.getByTestId("picker-refusals").filter({ visible: true })).toContainText(/no free image reference slots left/);
    await expect(composer(page).getByRole("button", { name: /^Remove / })).toHaveCount(3);
});

test("camera motion pills appear for video families, preview the composed prompt and merge settings", async ({ page }) => {
    await setup(page);
    const pending: { route: Route; form: FormData }[] = [];
    await page.route("**/api/generate", async route => { pending.push({ route, form: await submittedForm(route) }); });
    await page.goto("/en");
    await page.getByRole("button", { name: en.common.video, exact: true }).click();

    const motionPill = page.getByRole("button", { name: en.motion.pillLabel });
    await expect(motionPill).toBeVisible();
    await motionPill.click();
    await page.getByTestId("motion-preset-dolly-in").click();
    await expect(page.getByTestId("motion-prompt-preview")).toContainText(en.motion.previewLabel);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("motion-preset-dolly-in")).toBeHidden();

    await composer(page).getByRole("textbox").fill("A fox in snow");
    await expect(page.getByTestId("motion-prompt-preview")).toContainText(
        "A fox in snow The camera dollies in slowly and steadily, keeping the subject centered.",
    );

    await generate(page).click();
    await expect.poll(() => pending.length).toBe(1);
    const form = pending[0].form;
    expect(form.get("prompt")).toBe("A fox in snow The camera dollies in slowly and steadily, keeping the subject centered.");
    expect(JSON.parse(String(form.get("settings"))).duration).toBe("6");
    await pending[0].route.fulfill({ status: 400, json: { error: "ERR_INVALID_FIELD_VALUES", accepted: false, recovery_required: false } });
    await expect(page.getByText(en.errors.ERR_INVALID_FIELD_VALUES)).toBeVisible();

    // Image capabilities have no camera motion family, so the pill disappears with the mode.
    await page.getByRole("button", { name: en.common.image, exact: true }).click();
    await expect(page.getByRole("button", { name: en.motion.pillLabel })).toHaveCount(0);
});
