import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import en from "../../src/messages/en.json";

/**
 * Production harness specs.
 *
 * These pages read the real store, so every test seeds its state through the
 * HTTP API. Unsafe requests carry the workspace Origin the e2e server pins in
 * APP_ORIGIN; localStorage is never used because the server owns the state.
 */

const ORIGIN = "https://127.0.0.1:3110";

interface SeededProduction {
    id: string;
    slug: string;
    title: string;
}

async function createProduction(page: Page, title: string, effort: "quick" | "standard" | "studio" = "standard"): Promise<SeededProduction> {
    const response = await page.request.post("/api/productions", {
        headers: { Origin: ORIGIN },
        data: { title, brief: "Seeded by the production e2e suite", effort },
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()).production as SeededProduction;
}

async function patchProduction(page: Page, id: string, data: unknown) {
    return page.request.patch(`/api/productions/${id}`, { headers: { Origin: ORIGIN }, data });
}

function boardCard(page: Page, production: SeededProduction) {
    return page.getByTestId(`production-card-${production.id}`);
}

test("the board renders cards with stop-tone data attributes", async ({ page }) => {
    const working = await createProduction(page, "Board Alpha", "quick");
    const waiting = await createProduction(page, "Board Beta", "studio");

    // Alpha: concept done, outline blocked. Beta stays waiting but asks for a decision.
    expect((await patchProduction(page, working.id, { advance: true })).status()).toBe(200);
    expect((await patchProduction(page, working.id, { stop: "outline", state: "blocked" })).status()).toBe(200);
    const gate = await page.request.post(`/api/productions/${waiting.id}/gates`, {
        headers: { Origin: ORIGIN },
        data: { stop: "concept", note: "Pick the opening", options: [{ label: "Warm filmic" }, { label: "Cold clinical" }] },
    });
    expect(gate.status()).toBe(201);

    await page.goto("/en/productions");
    await expect(page.getByTestId("productions-board")).toBeVisible();

    const workingCard = boardCard(page, working);
    await expect(workingCard).toBeVisible();
    await expect(workingCard.locator('li[data-stop="concept"]')).toHaveAttribute("data-tone", "green");
    await expect(workingCard.locator('li[data-stop="outline"]')).toHaveAttribute("data-tone", "red");
    await expect(workingCard.locator('li[data-stop="outline"]')).toHaveAttribute("data-state", "blocked");
    await expect(workingCard.locator('li[data-stop="storyboard"]')).toHaveAttribute("data-tone", "amber");
    await expect(workingCard.locator('li[data-stop="storyboard"]')).toHaveAttribute("data-state", "waiting");

    const waitingCard = boardCard(page, waiting);
    await expect(waitingCard).toBeVisible();
    await expect(waitingCard.locator('li[data-stop="concept"]')).toHaveAttribute("data-tone", "amber");
    await expect(waitingCard.getByTestId("production-status")).toHaveText(en.productions.board.pendingGate);
});

test("a pending gate blocks advance and approving it advances the rail", async ({ page }) => {
    const production = await createProduction(page, "Gate Flow", "standard");
    const gate = await page.request.post(`/api/productions/${production.id}/gates`, {
        headers: { Origin: ORIGIN },
        data: {
            stop: "concept",
            note: "Choose the opening",
            options: [{ label: "Warm filmic", recommended: true }, { label: "Cold clinical" }],
        },
    });
    expect(gate.status()).toBe(201);

    // The server refuses to skip a pending decision...
    const blocked = await patchProduction(page, production.id, { advance: true });
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).error).toBe("ERR_PRODUCTION_GATE_PENDING");

    // ...and the page shows the decision card instead of an advance button.
    await page.goto(`/en/productions/${production.id}`);
    const cards = page.getByTestId("decision-cards");
    await expect(cards).toBeVisible();
    await expect(page.getByRole("button", { name: en.productions.detail.advance, exact: true })).toHaveCount(0);

    const rail = page.getByTestId("stops-rail");
    await expect(rail.locator('li[data-stop="concept"]')).toHaveAttribute("data-state", "waiting");
    await expect(rail.locator('li[data-stop="concept"]')).toHaveAttribute("data-tone", "amber");

    await page.getByRole("button", { name: en.productions.gate.approve, exact: true }).click();

    await expect(cards).toHaveCount(0);
    await expect(rail.locator('li[data-stop="concept"]')).toHaveAttribute("data-state", "done");
    await expect(rail.locator('li[data-stop="concept"]')).toHaveAttribute("data-tone", "green");
    await expect(rail.locator('li[data-stop="outline"]')).toHaveAttribute("data-state", "working");
    await expect(rail.locator('li[data-stop="outline"]')).toHaveAttribute("data-tone", "violet");
    await expect(page.getByText(en.productions.gate.decidedApproved, { exact: true })).toBeVisible();
});

test("the ledger panel shows a seeded record and its total", async ({ page }) => {
    const production = await createProduction(page, "Ledger Film", "standard");
    const assetId = `asset_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const seeded = await page.request.post(`/api/productions/${production.id}/ledger`, {
        headers: { Origin: ORIGIN },
        data: {
            assetId,
            source: "provider",
            provider: "runware",
            model: "flux-dev",
            promptHash: "a".repeat(64),
            costUsd: 1.25,
            license: "commercial",
            estimated: false,
        },
    });
    expect(seeded.status(), await seeded.text()).toBe(201);

    await page.goto(`/en/productions/${production.id}`);
    const panel = page.getByTestId("ledger-panel");
    await expect(panel).toBeVisible();

    const row = panel.locator(`[data-testid="ledger-row"][data-asset-id="${assetId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-provider", "runware");
    await expect(row.getByTestId("ledger-row-cost")).toHaveText("$1.25");

    // Standard plan budget is $25.00, so one $1.25 charge leaves $23.75 and 5%.
    await expect(panel.getByTestId("ledger-total")).toHaveText("Total $1.25");
    await expect(panel.getByTestId("ledger-spent")).toHaveText("Spent $1.25 of $25.00");
    await expect(panel.getByTestId("ledger-remaining")).toHaveText("$23.75 remaining");
    await expect(panel.getByTestId("ledger-budget-bar")).toHaveAttribute("aria-valuenow", "5");
    await expect(panel.getByTestId("ledger-count")).toHaveText("1 asset");
});
