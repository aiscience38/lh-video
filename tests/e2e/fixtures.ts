import { test as base, expect, type Page } from "@playwright/test";
import type { ProviderConnectionRecord } from "../../src/providers/config-types";
import type { ProviderDefinition } from "../../src/providers/definitions";
import type { CatalogResponse } from "../../src/features/providers/types";
import type { LibraryEntity } from "../../src/features/library/types";
import type { MotionPreset } from "../../src/models/motion-params";
import type { AnyTask } from "../../src/types";

export const test = base.extend<{ browserErrors: string[] }>({
    browserErrors: [async ({ page }, use) => {
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => {
            // Intentional HTTP failures are asserted by each test; React errors must still fail.
            if (message.type() !== "error" || message.text().startsWith("Failed to load resource:")) return;
            // WebKit blocks Next.js speculative RSC prefetches against the self-signed e2e origin.
            // Navigation itself succeeds and is asserted by the test, so this is not a render error.
            if (message.text().includes("due to access control checks") && message.text().includes("_rsc=")) return;
            errors.push(message.text());
        });
        await use(errors);
        expect(errors, "No hydration, render or unhandled-promise errors").toEqual([]);
    }, { auto: true }],
});

export { expect };

export interface MockWorkspace {
    providers: ProviderDefinition[];
    catalog: CatalogResponse;
    connectedProviderIds: string[];
    connections: ProviderConnectionRecord[];
    modelsError: boolean;
    providersError: boolean;
    catalogError: boolean;
    historyError: boolean;
    history: AnyTask[];
    nextCursor: string | null;
    library: LibraryEntity[];
    motionPresets: MotionPreset[];
    requests: Array<{ method: string; path: string; body: string | null }>;
}

export async function mockWorkspace(page: Page, { connected = true }: { connected?: boolean } = {}): Promise<MockWorkspace> {
    const [providersResponse, catalogResponse, motionResponse] = await Promise.all([
        page.request.get("/api/providers"), page.request.get("/api/catalog"), page.request.get("/api/motion-presets"),
    ]);
    expect(providersResponse.ok()).toBeTruthy();
    expect(catalogResponse.ok()).toBeTruthy();
    expect(motionResponse.ok()).toBeTruthy();
    const providers = (await providersResponse.json()).providers as ProviderDefinition[];
    const catalog = await catalogResponse.json() as CatalogResponse;
    const motionPresets = (await motionResponse.json()).presets as MotionPreset[];
    const state: MockWorkspace = {
        providers, catalog: { ...catalog, overrides: [], discovered: [] },
        connectedProviderIds: connected ? providers.map(provider => provider.id) : [],
        connections: [], modelsError: false, providersError: false, catalogError: false,
        historyError: false, history: [], nextCursor: null, library: [], motionPresets, requests: [],
    };
    await page.route("**/api/**", async route => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        state.requests.push({ method, path: url.pathname + url.search, body: request.postData() });
        const unavailable = () => route.fulfill({ status: 503, json: { error: "ERR_PROVIDER_CONFIG_UNAVAILABLE" } });
        if (method !== "GET") return route.fulfill({ status: 400, json: { error: "ERR_INVALID_FIELD_VALUES", accepted: false, recovery_required: false } });
        switch (url.pathname) {
            case "/api/providers":
                return state.providersError ? unavailable() : route.fulfill({ json: { providers: state.providers, connections: state.connections, connectedProviderIds: state.connectedProviderIds, environmentProviderIds: [] } });
            case "/api/catalog":
                return state.catalogError ? unavailable() : route.fulfill({ json: state.catalog });
            case "/api/image-models":
                return state.modelsError ? unavailable() : route.fulfill({ json: { models: state.catalog.images.filter(model => state.connectedProviderIds.includes(model.provider)), groups: [] } });
            case "/api/models":
                return state.modelsError ? unavailable() : route.fulfill({ json: { models: {}, model_list: state.catalog.videos.filter(model => state.connectedProviderIds.includes(model.provider)), groups: [] } });
            case "/api/tasks":
            case "/api/image-tasks":
                return state.historyError ? unavailable() : route.fulfill({ json: { tasks: state.history, nextCursor: state.nextCursor } });
            case "/api/library": {
                const kind = url.searchParams.get("kind");
                const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
                const entities = state.library.filter(entity => (!kind || entity.kind === kind)
                    && (!query || entity.name.toLowerCase().includes(query) || entity.slug.includes(query)));
                return route.fulfill({ json: { entities, count: entities.length } });
            }
            case "/api/scenes":
                return route.fulfill({ json: { scenes: [], count: 0 } });
            case "/api/library/trash":
                return route.fulfill({ json: { entries: [], count: 0 } });
            case "/api/providers/comfyui/workflows":
                return route.fulfill({ json: { nodes: [], fetchedAt: new Date(0).toISOString(), cached: true, templates: [] } });
            case "/api/motion-presets":
                return route.fulfill({ json: { presets: state.motionPresets } });
            default:
                return route.fulfill({ status: 400, json: { error: "ERR_SYNTHETIC_UNEXPECTED_REQUEST" } });
        }
    });
    return state;
}

export async function expectWithinViewport(page: Page) {
    await expect.poll(() => page.evaluate(() => {
        const panels = Array.from(document.querySelectorAll('[data-slot="dialog-content"], [data-slot="popover-content"]'));
        return document.documentElement.scrollWidth <= innerWidth + 1 && panels.every(panel => {
            const rect = panel.getBoundingClientRect();
            return !rect.height || (rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1);
        });
    })).toBeTruthy();
}
