import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createModuleLoader } from "./test-module-loader.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const LEDGER_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function harness(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asset-ledger-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const env = { ...process.env, OPEN_HIGGSFIELD_STORAGE_DIR: dir, NODE_ENV: "development" };
    const loader = createModuleLoader({ env });
    return {
        dir,
        env,
        ledger: loader.load("@/server/ledger/store"),
        reload: () => createModuleLoader({ env }).load("@/server/ledger/store"),
        file: path.join(dir, "ledger", "assets.json"),
    };
}

/** A complete, valid draft for the paid provider path. */
function providerDraft(overrides = {}) {
    return {
        assetId: "asset_runware_1",
        source: "provider",
        provider: "runware",
        model: "flux-dev",
        promptHash: createHash("sha256").update("a lighthouse at dusk").digest("hex"),
        costUsd: 0.42,
        license: "commercial",
        estimated: false,
        ...overrides,
    };
}

async function exists(target) {
    return fs.access(target).then(() => true, () => false);
}

test("appendAsset writes one atomic ledger document and reloads it in append order", async (t) => {
    const { dir, file, ledger, reload } = await harness(t);
    assert.deepEqual(plain(await ledger.listAssets()), []);
    const empty = await ledger.ledgerSummary();
    assert.deepEqual(plain(empty), { count: 0, totalUsd: 0, exactUsd: 0, estimatedUsd: 0, byProvider: {} });

    const upload = await ledger.appendAsset({
        assetId: "asset_upload_1",
        source: "upload",
        provider: "local",
        model: "upload",
        promptHash: ledger.hashPrompt("reference still"),
        license: "CC0-1.0",
    });
    assert.equal(upload.assetId, "asset_upload_1");
    assert.equal(upload.costUsd, 0, "costUsd defaults to 0");
    assert.equal(upload.estimated, false, "estimated defaults to false");
    assert.equal(upload.license, "CC0-1.0");
    assert.match(upload.assetId, LEDGER_ID);
    assert.ok(Number.isFinite(Date.parse(upload.createdAt)), upload.createdAt);

    const provider = await ledger.appendAsset(providerDraft());
    assert.equal(provider.costUsd, 0.42);
    assert.equal(provider.provider, "runware");

    const document = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(document.version, 1);
    assert.deepEqual(document.records.map((record) => record.assetId), ["asset_upload_1", "asset_runware_1"]);
    assert.deepEqual(Object.keys(document.records[0]).sort(), [
        "assetId", "costUsd", "createdAt", "estimated", "license", "model", "promptHash", "provider", "source",
    ]);
    // The atomic writer must not leave temp files beside the ledger.
    assert.deepEqual((await fs.readdir(path.join(dir, "ledger"))).sort(), ["assets.json"]);

    const reloaded = await reload().listAssets();
    assert.deepEqual(plain(reloaded), plain([upload, provider]));
    assert.equal((await reload().readAsset("asset_runware_1")).model, "flux-dev");
    assert.equal(await reload().readAsset("asset_missing_1"), undefined);
    assert.equal(await reload().readAsset("../../etc/passwd"), undefined);
});

test("ledgerTotals separates settled spend from outstanding holds", async (t) => {
    const { ledger } = await harness(t);
    await ledger.appendAsset(providerDraft({ assetId: "asset_r1", costUsd: 0.42, provider: "runware" }));
    await ledger.appendAsset(providerDraft({ assetId: "asset_r2", costUsd: 0.08, provider: "runware" }));
    await ledger.appendAsset(providerDraft({ assetId: "asset_g1", costUsd: 1.5, provider: "google-ai-studio", estimated: true }));
    await ledger.appendAsset(providerDraft({ assetId: "asset_c1", costUsd: 0, provider: "comfyui", model: "local-flux" }));

    const summary = plain(await ledger.ledgerSummary());
    assert.deepEqual(summary, {
        count: 4,
        totalUsd: 2,
        exactUsd: 0.5,
        estimatedUsd: 1.5,
        byProvider: {
            comfyui: { count: 1, totalUsd: 0 },
            "google-ai-studio": { count: 1, totalUsd: 1.5 },
            runware: { count: 2, totalUsd: 0.5 },
        },
    });

    // The helper is pure and round-trips float sums without binary noise.
    const cents = ledger.ledgerTotals([
        { assetId: "asset_a", costUsd: 0.1, estimated: false, provider: "runware" },
        { assetId: "asset_b", costUsd: 0.2, estimated: false, provider: "runware" },
    ]);
    assert.equal(cents.totalUsd, 0.3, "0.1 + 0.2 must total 0.3");
    assert.equal(cents.exactUsd, 0.3);
    assert.equal(cents.estimatedUsd, 0);
});

test("a duplicate asset id is rejected without rewriting the document", async (t) => {
    const { file, ledger } = await harness(t);
    await ledger.appendAsset(providerDraft());
    const before = await fs.readFile(file, "utf8");
    await assert.rejects(ledger.appendAsset(providerDraft({ costUsd: 0.99 })), /ERR_LEDGER_CONFLICT/);
    assert.equal(await fs.readFile(file, "utf8"), before, "a rejected append must not touch the ledger");
    assert.equal((await ledger.listAssets()).length, 1);
});

test("invalid records are rejected and leave the ledger untouched", async (t) => {
    const { dir, file, ledger } = await harness(t);
    const attempts = [
        providerDraft({ assetId: "asset bad" }),
        providerDraft({ assetId: "" }),
        providerDraft({ source: "scrape" }),
        providerDraft({ promptHash: "not-a-hash" }),
        providerDraft({ promptHash: "A".repeat(64) }),
        providerDraft({ costUsd: -1 }),
        providerDraft({ costUsd: Number.NaN }),
        providerDraft({ model: "" }),
        providerDraft({ license: "" }),
        providerDraft({ provider: "comfyui", costUsd: 0.5 }),
        null,
        "not-an-object",
    ];
    for (const attempt of attempts) {
        await assert.rejects(ledger.appendAsset(attempt), /ERR_LEDGER_INVALID/, JSON.stringify(attempt));
    }
    assert.equal(await exists(file), false, "nothing may be written for rejected records");
    assert.equal(await exists(path.join(dir, "ledger")), false);

    await ledger.appendAsset(providerDraft());
    const before = await fs.readFile(file, "utf8");
    await assert.rejects(ledger.appendAsset(providerDraft({ assetId: "asset_runware_2", costUsd: 2_000_000 })), /ERR_LEDGER_INVALID/);
    assert.equal(await fs.readFile(file, "utf8"), before);
});

test("concurrent appends are serialized and none are lost", async (t) => {
    const { ledger } = await harness(t);
    const ids = Array.from({ length: 8 }, (_, index) => `asset_concurrent_${index}`);
    const results = await Promise.all(ids.map((assetId) => ledger.appendAsset(providerDraft({
        assetId,
        costUsd: 0.01,
        provider: "runware",
    }))));
    assert.deepEqual(plain(results.map((record) => record.assetId)), ids);
    const records = await ledger.listAssets();
    assert.equal(records.length, 8);
    assert.deepEqual(plain(records.map((record) => record.assetId)), ids);
    const summary = plain(await ledger.ledgerSummary());
    assert.equal(summary.totalUsd, 0.08);
    assert.equal(summary.byProvider.runware.count, 8);
});

test("a malformed ledger is reported as corrupt instead of being silently reset", async (t) => {
    const { dir, file, ledger } = await harness(t);
    await fs.mkdir(path.dirname(file), { recursive: true });

    await fs.writeFile(file, "{ this is not json", "utf8");
    await assert.rejects(ledger.listAssets(), /ERR_LEDGER_CORRUPT/);
    await assert.rejects(ledger.appendAsset(providerDraft()), /ERR_LEDGER_CORRUPT/);
    assert.equal(await fs.readFile(file, "utf8"), "{ this is not json", "a corrupt ledger must not be replaced");

    await fs.writeFile(file, JSON.stringify({ version: 2, records: [] }), "utf8");
    await assert.rejects(ledger.listAssets(), /ERR_LEDGER_CORRUPT/, "an unknown version is corrupt");

    await fs.writeFile(file, JSON.stringify({ version: 1, records: [{ assetId: "asset_partial" }] }), "utf8");
    await assert.rejects(ledger.ledgerSummary(), /ERR_LEDGER_CORRUPT/, "a record missing fields is corrupt");
    assert.deepEqual(await fs.readdir(path.join(dir, "ledger")), ["assets.json"]);
});

test("checkBudget blocks a paid provider when the remaining budget is short", async (t) => {
    const { ledger } = await harness(t);

    const blocked = plain(ledger.checkBudget(5, 4, 2, "runware"));
    assert.deepEqual(blocked, {
        ok: false,
        reason: "ERR_BUDGET_EXCEEDED",
        providerId: "runware",
        estimateUsd: 2,
        chargedUsd: 0,
        remainingUsd: 1,
        shortfallUsd: 1,
    });

    const exact = plain(ledger.checkBudget(5, 4, 1, "runware"));
    assert.deepEqual(exact, {
        ok: true,
        providerId: "runware",
        estimateUsd: 1,
        chargedUsd: 1,
        remainingUsd: 0,
    }, "a quote that exactly consumes the remainder is allowed");

    const refused = plain(ledger.checkBudget(5, 4, 1.01, "google-ai-studio"));
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "ERR_BUDGET_EXCEEDED");
    assert.equal(refused.shortfallUsd, 0.01);

    const spent = plain(ledger.checkBudget(2, 3, 0.25, "toapis"));
    assert.equal(spent.ok, false);
    assert.equal(spent.remainingUsd, -1);
    assert.equal(spent.shortfallUsd, 1.25);
});

test("checkBudget treats comfyui as free and never blocks on budget", async (t) => {
    const { ledger } = await harness(t);
    const free = plain(ledger.checkBudget(1, 1, 5, "comfyui"));
    assert.deepEqual(free, {
        ok: true,
        providerId: "comfyui",
        estimateUsd: 5,
        chargedUsd: 0,
        remainingUsd: 0,
    });

    const overspent = plain(ledger.checkBudget(1, 3, 99, "ComfyUI"));
    assert.equal(overspent.ok, true, "local generations add no spend even past the budget");
    assert.equal(overspent.providerId, "comfyui", "provider ids are normalised");
    assert.equal(overspent.chargedUsd, 0);
    assert.equal(overspent.remainingUsd, -2);

    const zero = plain(ledger.checkBudget(0, 0, 0, "runware"));
    assert.equal(zero.ok, true, "a zero-cost quote needs no remaining budget");
    assert.equal(zero.remainingUsd, 0);
});

test("checkBudget rejects nonsensical money and provider ids", async (t) => {
    const { ledger } = await harness(t);
    const cases = [
        [Number.NaN, 0, 1, "runware"],
        [Number.POSITIVE_INFINITY, 0, 1, "runware"],
        [-1, 0, 1, "runware"],
        [5, -0.01, 1, "runware"],
        [5, 0, Number.NaN, "runware"],
        [5, 0, 2_000_000, "runware"],
        [5, 0, 1, ""],
        [5, 0, 1, "run ware"],
        [5, 0, 1, null],
        ["5", 0, 1, "runware"],
    ];
    for (const args of cases) {
        assert.throws(() => ledger.checkBudget(...args), /ERR_BUDGET_INVALID/, JSON.stringify(args));
    }
});

test("hashPrompt is a stable lowercase sha256 of the exact prompt", async (t) => {
    const { ledger } = await harness(t);
    const prompt = "a lighthouse at dusk, 35mm";
    const digest = ledger.hashPrompt(prompt);
    assert.equal(digest, createHash("sha256").update(prompt, "utf8").digest("hex"));
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(ledger.hashPrompt(prompt), digest);
    assert.notEqual(ledger.hashPrompt(`${prompt} `), digest, "surrounding whitespace is part of the hash");
    assert.throws(() => ledger.hashPrompt(42), /ERR_LEDGER_INVALID/);
});

test("ledger totals feed the budget guard end to end", async (t) => {
    const { ledger } = await harness(t);
    await ledger.appendAsset(providerDraft({ assetId: "asset_e1", costUsd: 1.2, provider: "runware" }));
    await ledger.appendAsset(providerDraft({ assetId: "asset_e2", costUsd: 0.9, provider: "google-ai-studio", estimated: true }));
    const summary = plain(await ledger.ledgerSummary());
    assert.equal(summary.totalUsd, 2.1);

    const blocked = plain(ledger.checkBudget(3.5, summary.totalUsd, 1.5, "runware"));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "ERR_BUDGET_EXCEEDED");
    assert.equal(blocked.remainingUsd, 1.4);
    assert.equal(blocked.shortfallUsd, 0.1);

    const local = plain(ledger.checkBudget(3.5, summary.totalUsd, 1.5, "comfyui"));
    assert.equal(local.ok, true);
    assert.equal(local.chargedUsd, 0);
});
