import type { Page, Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";
import en from "../../src/messages/en.json";

interface ProviderStatus {
    provider: string;
    configured: boolean;
    reachable: boolean;
    reason: string | null;
}

interface PreviewRequest {
    provider: string;
    voiceId: string;
    text: string;
}

/** A valid 100 ms silent WAV so every engine can decode the preview source. */
function silentWav(): string {
    const sampleRate = 8000;
    const samples = 800;
    const buffer = Buffer.alloc(44 + samples * 2);
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + samples * 2, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(samples * 2, 40);
    return `data:audio/wav;base64,${buffer.toString("base64")}`;
}

const previewAudio = silentWav();
const availableProviders: ProviderStatus[] = [
    { provider: "elevenlabs", configured: true, reachable: true, reason: null },
    { provider: "comfyui", configured: true, reachable: false, reason: "upstream_down" },
];
const unavailableProviders: ProviderStatus[] = [
    { provider: "elevenlabs", configured: false, reachable: false, reason: "no_api_key" },
    { provider: "comfyui", configured: true, reachable: false, reason: "no_base_url" },
];

async function mockTts(page: Page, providers: ProviderStatus[], previews: PreviewRequest[]) {
    await page.route("**/api/tts/**", async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/api/tts/providers") return route.fulfill({ json: { providers } });
        if (url.pathname === "/api/tts/voices") {
            expect(url.searchParams.get("provider")).toBe("elevenlabs");
            return route.fulfill({ json: { voices: [
                { id: "voice_ana", name: "Ana", language: "es" },
                { id: "voice_leo", name: "Leo", language: "en" },
            ] } });
        }
        if (url.pathname === "/api/tts/preview") {
            expect(request.method()).toBe("POST");
            previews.push(request.postDataJSON() as PreviewRequest);
            return route.fulfill({ json: { assetId: "asset_preview_e2e", url: previewAudio, mimeType: "audio/wav" } });
        }
        return route.fulfill({ status: 404, json: { error: "ERR_NOT_FOUND" } });
    });
}

async function findCharacter(page: Page, name: string) {
    const response = await page.request.get("/api/library?kind=character");
    expect(response.ok()).toBeTruthy();
    const body = await response.json() as { entities: Array<{ name: string; voice: Record<string, unknown> }> };
    return body.entities.find(entity => entity.name === name);
}

test.describe.configure({ mode: "serial" });

test("saves provider, voice, language and preview asset, then persists after reload", async ({ page }) => {
    const previews: PreviewRequest[] = [];
    await mockTts(page, availableProviders, previews);
    const name = `Voice Persist ${Date.now()}`;

    await page.goto("/en/library/characters");
    await expect(page.getByRole("heading", { name: en.library.characters.title })).toBeVisible();
    await page.getByRole("button", { name: en.library.characters.new }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: en.library.characters.createTitle })).toBeVisible();
    await dialog.getByLabel(en.library.characters.nameLabel).fill(name);

    // The unreachable provider is shown disabled with its reason.
    const provider = dialog.getByLabel(en.library.voice.providerLabel);
    await expect(provider.locator('option[value="comfyui"]')).toBeDisabled();
    await expect(dialog.getByTestId("voice-unavailable-comfyui")).toContainText(en.library.voice.reasons.upstream_down);

    await provider.selectOption("elevenlabs");
    const voice = dialog.getByLabel(en.library.voice.voiceLabel);
    await expect(voice.locator('option[value="voice_ana"]')).toHaveCount(1);
    await voice.selectOption("voice_ana");
    await dialog.getByLabel(en.library.voice.languageLabel).selectOption("es");
    await dialog.getByLabel(en.library.voice.sampleLabel).fill("Hola, soy Ana.");

    await dialog.getByRole("button", { name: en.library.voice.preview }).click();
    await expect(dialog.getByTestId("voice-preview-audio")).toHaveAttribute("src", /^data:audio\/wav;base64,/);
    await expect(dialog.getByText(en.library.voice.previewReady)).toBeVisible();
    expect(previews).toEqual([{ provider: "elevenlabs", voiceId: "voice_ana", text: "Hola, soy Ana." }]);

    await dialog.getByRole("button", { name: en.library.characters.create }).click();
    const card = page.getByTestId("character-card").filter({ hasText: name });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("character-voice")).toHaveAttribute("data-provider", "elevenlabs");
    await expect(card.getByTestId("character-voice")).toHaveAttribute("data-voice-id", "voice_ana");

    const created = await findCharacter(page, name);
    expect(created?.voice).toEqual({
        provider: "elevenlabs", voiceId: "voice_ana", language: "es", settings: {}, previewAssetId: "asset_preview_e2e",
    });

    await page.reload();
    const reloaded = page.getByTestId("character-card").filter({ hasText: name });
    await expect(reloaded).toBeVisible();
    await expect(reloaded.getByTestId("character-voice")).toHaveAttribute("data-provider", "elevenlabs");
    await reloaded.getByRole("button", { name: en.library.characters.editVoice }).click();
    const edit = page.getByRole("dialog");
    await expect(edit.getByRole("heading", { name: en.library.voice.editTitle })).toBeVisible();
    await expect(edit.getByLabel(en.library.voice.providerLabel)).toHaveValue("elevenlabs");
    await expect(edit.getByLabel(en.library.voice.voiceLabel)).toHaveValue("voice_ana");
    await expect(edit.getByLabel(en.library.voice.languageLabel)).toHaveValue("es");
    await expect(edit.getByText(en.library.voice.previewSaved)).toBeVisible();

    await edit.getByRole("button", { name: en.library.voice.save }).click();
    await expect(edit).toHaveCount(0);
    const saved = await findCharacter(page, name);
    expect(saved?.voice).toMatchObject({ provider: "elevenlabs", voiceId: "voice_ana", language: "es", previewAssetId: "asset_preview_e2e" });
});

test("no available provider shows fallback copy, disables options and still saves", async ({ page }) => {
    const previews: PreviewRequest[] = [];
    await mockTts(page, unavailableProviders, previews);
    const name = `Voice Fallback ${Date.now()}`;

    await page.goto("/en/library/characters");
    await page.getByRole("button", { name: en.library.characters.new }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(en.library.characters.nameLabel).fill(name);

    const fallback = dialog.getByTestId("voice-fallback");
    await expect(fallback).toBeVisible();
    await expect(fallback).toContainText(en.library.voice.noProvidersTitle);
    await expect(fallback).toContainText(en.library.voice.noProviders);
    const provider = dialog.getByLabel(en.library.voice.providerLabel);
    await expect(provider.locator('option[value="elevenlabs"]')).toBeDisabled();
    await expect(provider.locator('option[value="comfyui"]')).toBeDisabled();
    await expect(dialog.getByTestId("voice-unavailable-elevenlabs")).toContainText(en.library.voice.reasons.no_api_key);
    await expect(dialog.getByTestId("voice-unavailable-comfyui")).toContainText(en.library.voice.reasons.no_base_url);
    await expect(dialog.getByLabel(en.library.voice.voiceLabel)).toHaveCount(0);

    await dialog.getByRole("button", { name: en.library.characters.create }).click();
    const card = page.getByTestId("character-card").filter({ hasText: name });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("character-voice")).toHaveCount(0);
    const created = await findCharacter(page, name);
    expect(created?.voice).toEqual({ provider: "none", voiceId: null, language: "en", settings: {}, previewAssetId: null });

    // Editing an existing character without a usable provider is still possible.
    await card.getByRole("button", { name: en.library.characters.editVoice }).click();
    const edit = page.getByRole("dialog");
    await expect(edit.getByTestId("voice-fallback")).toBeVisible();
    await edit.getByRole("button", { name: en.library.voice.save }).click();
    await expect(edit).toHaveCount(0);
    expect((await findCharacter(page, name))?.voice).toMatchObject({ provider: "none", voiceId: null });
    expect(previews).toEqual([]);
});

test("create dialog with the voice section has no axe violations", async ({ page }) => {
    const previews: PreviewRequest[] = [];
    await mockTts(page, availableProviders, previews);

    await page.goto("/en/library/characters");
    await page.getByRole("button", { name: en.library.characters.new }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(en.library.voice.providerLabel).selectOption("elevenlabs");
    await expect(dialog.getByLabel(en.library.voice.voiceLabel)).toBeVisible();

    const results = await new AxeBuilder({ page })
        .include('[data-slot="dialog-content"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
    expect(results.violations).toEqual([]);
});
