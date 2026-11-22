import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, mockWorkspace } from "./fixtures";
import en from "../../src/messages/en.json";

function accessibility(page: Page) {
    return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
}

test("sidebar links navigate and mark the active route", async ({ page }) => {
    await mockWorkspace(page);
    await page.goto("/en");
    const sidebar = page.getByTestId("sidebar");
    await expect(sidebar).toBeVisible();

    const links: Array<[string, string]> = [
        ["sidebar-allMedia", "/en"],
        ["sidebar-characters", "/en/library/characters"],
        ["sidebar-scenes", "/en/scenes"],
        ["sidebar-library", "/en/library"],
        ["sidebar-library-create", "/en/library/characters?create=1"],
        ["sidebar-tools", "/en/tools"],
        ["sidebar-createTool", "/en/tools?create=1"],
        ["sidebar-trash", "/en/library/trash"],
    ];
    for (const [testId, href] of links) await expect(sidebar.getByTestId(testId)).toHaveAttribute("href", href);

    await sidebar.getByTestId("sidebar-characters").click();
    await expect(page).toHaveURL(/\/en\/library\/characters$/);
    await expect(sidebar.getByTestId("sidebar-characters")).toHaveAttribute("aria-current", "page");
    await expect(sidebar.getByTestId("sidebar-library")).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: en.library.characters.title })).toBeVisible();

    await sidebar.getByTestId("sidebar-library").click();
    await expect(page).toHaveURL(/\/en\/library$/);
    await expect(sidebar.getByTestId("sidebar-library")).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: en.library.overview.title })).toBeVisible();

    await sidebar.getByTestId("sidebar-scenes").click();
    await expect(page).toHaveURL(/\/en\/scenes$/);
    await expect(sidebar.getByTestId("sidebar-scenes")).toHaveAttribute("aria-current", "page");

    await sidebar.getByTestId("sidebar-allMedia").click();
    await expect(page).toHaveURL(/\/en$/);
    await expect(sidebar.getByTestId("sidebar-allMedia")).toHaveAttribute("aria-current", "page");
});

test("sidebar library + opens the character create dialog from the query string", async ({ page }) => {
    await mockWorkspace(page);
    await page.goto("/en");
    await page.getByTestId("sidebar-library-create").click();
    await expect(page).toHaveURL(/\/en\/library\/characters\?create=1$/);
    await expect(page.getByRole("dialog").getByRole("heading", { name: en.library.characters.createTitle })).toBeVisible();
});

test("sidebar collapse is icons-only and persists across reload", async ({ page }) => {
    await mockWorkspace(page);
    await page.goto("/en");
    const sidebar = page.getByTestId("sidebar");
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    await expect(sidebar.getByTestId("sidebar-allMedia")).toContainText(en.sidebar.items.allMedia);

    await page.getByTestId("sidebar-collapse").click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect(await page.evaluate(() => window.localStorage.getItem("lh-video.sidebar.collapsed"))).toBe("true");
    await expect(sidebar.getByTestId("sidebar-allMedia")).not.toContainText(en.sidebar.items.allMedia);
    await expect(sidebar.getByTestId("sidebar-allMedia")).toHaveAttribute("title", en.sidebar.items.allMedia);
    await expect(sidebar.getByTestId("sidebar-library-create")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
});

test("tools link opens the workflow page and create tool opens the import dialog", async ({ page }) => {
    await mockWorkspace(page);
    await page.goto("/en");
    await page.getByTestId("sidebar-tools").click();
    await expect(page).toHaveURL(/\/en\/tools$/);
    await expect(page.getByRole("heading", { name: en.tools.title, level: 1 })).toBeVisible();
    await expect(page.getByTestId("tools-empty")).toContainText(en.tools.emptyHint);
    await expect(page.getByTestId("tools-empty").getByRole("link", { name: en.tools.emptyAction })).toHaveAttribute("href", "/en/settings");
    await expect(page.getByTestId("sidebar-tools")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("sidebar-createTool")).not.toHaveAttribute("aria-current", "page");
    expect((await accessibility(page)).violations).toEqual([]);

    await page.getByTestId("sidebar-createTool").click();
    await expect(page).toHaveURL(/\/en\/tools\?create=1$/);
    await expect(page.getByRole("dialog").getByRole("heading", { name: en.providers.importWorkflowTitle })).toBeVisible();
    await expect(page.getByTestId("sidebar-createTool")).toHaveAttribute("aria-current", "page");
});

test("trash page renders the empty state and links back to the library", async ({ page }) => {
    await mockWorkspace(page);
    await page.goto("/en/library/trash");
    await expect(page.getByRole("heading", { name: en.library.trash.title, level: 1 })).toBeVisible();
    await expect(page.getByTestId("trash-empty")).toBeVisible();
    await expect(page.getByTestId("trash-empty")).toContainText(en.library.trash.emptyHint);
    await expect(page.getByTestId("trash-empty").getByRole("link", { name: en.library.trash.emptyAction })).toHaveAttribute("href", "/en/library");
    await expect(page.getByTestId("sidebar-trash")).toHaveAttribute("aria-current", "page");
    expect((await accessibility(page)).violations).toEqual([]);
});

test("trash API returns a read-only listing", async ({ request }) => {
    const response = await request.get("/api/library/trash");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.count).toBe(body.entries.length);
});

test("workspace shell passes automated accessibility checks with the sidebar", async ({ page }) => {
    await mockWorkspace(page);
    await page.goto("/en");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    expect((await accessibility(page)).violations).toEqual([]);
});

test.describe("mobile", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the header toggle opens the sidebar overlay without hiding the existing header nav", async ({ page }) => {
        await mockWorkspace(page);
        await page.goto("/en");
        await expect(page.getByTestId("sidebar")).toBeHidden();
        await expect(page.getByRole("navigation", { name: en.workspace.navigation })).toBeVisible();
        const toggle = page.getByTestId("sidebar-toggle");
        await expect(toggle).toBeVisible();
        await toggle.click();

        const overlay = page.getByTestId("sidebar-overlay");
        await expect(overlay).toBeVisible();
        await expect(page.getByRole("dialog", { name: en.sidebar.navigation })).toBeVisible();
        await overlay.getByTestId("sidebar-scenes").click();
        await expect(page).toHaveURL(/\/en\/scenes$/);
        await expect(page.getByTestId("sidebar-overlay")).toHaveCount(0);
    });
});
