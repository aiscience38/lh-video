import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import en from "../../src/messages/en.json";

const origin = "https://127.0.0.1:3110";

test.describe.configure({ mode: "serial" });

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});

function crc32(bytes: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** Minimal RGB PNG so each fixture file has distinct bytes and a distinct asset id. */
function solidPng(width: number, height: number, [red, green, blue]: [number, number, number]): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const row = y * (width * 3 + 1);
        raw[row] = 0;
        for (let x = 0; x < width; x += 1) {
            raw[row + 1 + x * 3] = red;
            raw[row + 2 + x * 3] = green;
            raw[row + 3 + x * 3] = blue;
        }
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

interface CharacterRow {
    id: string;
    name: string;
    slug: string;
    assetIds: string[];
}

let folder = "";

test.beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "lh-folder-import-"));
    await fs.mkdir(path.join(folder, "Ana"));
    await fs.mkdir(path.join(folder, "Bo"));
    await fs.writeFile(path.join(folder, "Ana", "1.png"), solidPng(8, 8, [220, 40, 40]));
    await fs.writeFile(path.join(folder, "Ana", "2.png"), solidPng(8, 8, [40, 190, 60]));
    await fs.writeFile(path.join(folder, "Bo", "1.png"), solidPng(8, 8, [40, 90, 230]));
    await fs.writeFile(path.join(folder, "notes.txt"), "not an image\n");
});

test.afterAll(async () => {
    await fs.rm(folder, { recursive: true, force: true });
});

async function characters(request: APIRequestContext): Promise<CharacterRow[]> {
    const response = await request.get("/api/library?kind=character");
    expect(response.ok()).toBeTruthy();
    return ((await response.json()).entities as CharacterRow[]);
}

async function resetNamedCharacters(request: APIRequestContext, names: string[]): Promise<void> {
    for (const character of await characters(request)) {
        if (!names.includes(character.name)) continue;
        const response = await request.delete(`/api/library/character/${character.id}`, { headers: { Origin: origin } });
        expect(response.ok()).toBeTruthy();
    }
}

async function expectedAssetId(request: APIRequestContext, file: string): Promise<string> {
    const response = await request.post("/api/library/assets", {
        headers: { Origin: origin },
        multipart: { file: { name: path.basename(file), mimeType: "image/png", buffer: await fs.readFile(file) } },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).assetId as string;
}

async function openImport(page: Page) {
    await page.goto("/en/library/characters");
    await page.getByTestId("folder-import-trigger").click();
    const dialog = page.getByTestId("folder-import-dialog");
    await expect(dialog).toBeVisible();
    return dialog;
}

test("imports each first-level subfolder as a character, in filename order, skipping non-images once", async ({ page, request }) => {
    test.setTimeout(60_000);
    await resetNamedCharacters(request, ["Ana", "Bo"]);
    const anaFirst = await expectedAssetId(request, path.join(folder, "Ana", "1.png"));
    const anaSecond = await expectedAssetId(request, path.join(folder, "Ana", "2.png"));
    const boFirst = await expectedAssetId(request, path.join(folder, "Bo", "1.png"));

    const dialog = await openImport(page);
    await expect(dialog.getByRole("heading", { name: en.library.import.title })).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await dialog.getByTestId("folder-import-input").setInputFiles(folder);

    const summary = dialog.getByTestId("folder-import-summary");
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(summary).toHaveAttribute("data-created", "2");
    await expect(summary).toContainText("2 characters");
    await expect(summary).toContainText("3 references");

    const skipped = dialog.getByTestId("folder-import-skipped");
    await expect(skipped).toHaveCount(1);
    await expect(skipped.first()).toContainText("notes.txt");
    await expect(dialog.getByTestId("folder-import-failed")).toHaveCount(0);

    await dialog.getByRole("button", { name: en.library.import.close }).click();
    await expect(dialog).toBeHidden();

    const rows = await characters(request);
    const ana = rows.find(character => character.name === "Ana");
    const bo = rows.find(character => character.name === "Bo");
    if (!ana || !bo) throw new Error("Ana and Bo should exist after the import");
    expect(ana.assetIds).toEqual([anaFirst, anaSecond]);
    expect(bo.assetIds).toEqual([boFirst]);

    const anaCard = page.locator(`[data-testid="character-card"][data-slug="${ana.slug}"]`);
    const boCard = page.locator(`[data-testid="character-card"][data-slug="${bo.slug}"]`);
    await expect(anaCard).toBeVisible();
    await expect(anaCard.getByTestId("character-reference-count")).toHaveAttribute("data-count", "2");
    await expect(boCard.getByTestId("character-reference-count")).toHaveAttribute("data-count", "1");
});

test("re-importing the same folder appends nothing and never duplicates an asset id", async ({ page, request }) => {
    test.setTimeout(60_000);
    const before = (await characters(request)).filter(character => character.name === "Ana" || character.name === "Bo");
    expect(before).toHaveLength(2);

    const dialog = await openImport(page);
    await dialog.getByTestId("folder-import-input").setInputFiles(folder);

    const summary = dialog.getByTestId("folder-import-summary");
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(summary).toHaveAttribute("data-created", "0");
    await expect(summary).toHaveAttribute("data-added", "0");
    await expect(summary).toContainText("2 characters");
    await expect(summary).toContainText("3 references");
    await expect(dialog.getByTestId("folder-import-skipped")).toHaveCount(1);
    await expect(dialog.getByTestId("folder-import-skipped").first()).toContainText("notes.txt");

    await dialog.getByRole("button", { name: en.library.import.close }).click();
    await expect(dialog).toBeHidden();

    const after = (await characters(request)).filter(character => character.name === "Ana" || character.name === "Bo");
    expect(after).toHaveLength(2);
    for (const name of ["Ana", "Bo"]) {
        const previous = before.find(character => character.name === name);
        const current = after.find(character => character.name === name);
        if (!previous || !current) throw new Error(`${name} should still exist after re-import`);
        expect(current.id).toBe(previous.id);
        expect(current.assetIds).toEqual(previous.assetIds);
        expect(new Set(current.assetIds).size).toBe(current.assetIds.length);
    }
    expect(after.reduce((total, character) => total + character.assetIds.length, 0)).toBe(3);
});
