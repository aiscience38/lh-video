import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * QA panel specs. The report and its contact sheet are seeded through the
 * production QA route with the pinned workspace Origin, so the page reads the
 * same document a real QA run would have saved beside the production.
 */

const ORIGIN = "https://127.0.0.1:3110";
/** 1x1 opaque PNG: enough for the browser to decode and paint a thumbnail. */
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface SeededProduction {
    id: string;
    slug: string;
    title: string;
}

async function createProduction(page: Page, title: string, effort: "quick" | "standard" | "studio" = "standard"): Promise<SeededProduction> {
    const response = await page.request.post("/api/productions", {
        headers: { Origin: ORIGIN },
        data: { title, brief: "Seeded by the production QA e2e suite", effort },
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()).production as SeededProduction;
}

test("the QA panel groups a black-run finding and shows its contact sheet", async ({ page }) => {
    const production = await createProduction(page, "QA Film", "studio");
    const seeded = await page.request.post(`/api/productions/${production.id}/qa`, {
        headers: { Origin: ORIGIN },
        data: {
            report: {
                durationSeconds: 4,
                hasVideo: true,
                hasAudio: true,
                findings: [{
                    type: "black",
                    severity: "error",
                    tStart: 0.5,
                    tEnd: 1.25,
                    detail: "black frames for 0.750s (pix_th 0.1)",
                }],
            },
            contactSheetPng: ONE_PIXEL_PNG,
        },
    });
    expect(seeded.status(), await seeded.text()).toBe(201);
    const body = await seeded.json();
    expect(body.report.contactSheetUrl).toBe(`/api/productions/${production.id}/qa/contact-sheet`);

    await page.goto(`/en/productions/${production.id}`);
    const panel = page.getByTestId("qa-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("qa-findings-count")).toHaveText("1 finding");

    const group = panel.locator('[data-testid="qa-group"][data-type="black"]');
    await expect(group).toBeVisible();
    await expect(group).toHaveAttribute("data-count", "1");
    await expect(group.getByTestId("qa-finding")).toHaveCount(1);
    await expect(group.getByTestId("qa-finding")).toContainText("black frames for 0.750s");
    await expect(group.getByTestId("qa-timecode")).toContainText("0.500s");
    await expect(group.getByTestId("qa-timecode")).toContainText("1.250s");

    const sheet = panel.getByTestId("qa-contact-sheet");
    await expect(sheet).toBeVisible();
    await expect.poll(() => sheet.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBeTruthy();
});

test("the QA panel shows an empty state when no report exists", async ({ page }) => {
    const production = await createProduction(page, "QA Empty", "quick");

    await page.goto(`/en/productions/${production.id}`);
    const panel = page.getByTestId("qa-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("qa-empty")).toBeVisible();
    await expect(panel.getByTestId("qa-contact-sheet")).toHaveCount(0);
    await expect(panel.getByTestId("qa-group")).toHaveCount(0);
});
