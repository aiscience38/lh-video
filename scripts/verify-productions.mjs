import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModuleLoader } from "./test-module-loader.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const UUID_UNKNOWN = "9d3e1c62-6a41-4f0e-8a37-5b9b0c9f2f11";

async function harness(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "productions-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const env = { OPEN_HIGGSFIELD_STORAGE_DIR: dir, NODE_ENV: "development" };
    const loader = createModuleLoader({ env, mocks: { "next/server": { NextResponse: Response } } });
    return {
        dir,
        env,
        loader,
        store: loader.load("@/server/productions/store"),
        contract: loader.load("@/server/productions/contract"),
        client: loader.load("@/features/productions/types"),
        listRoute: loader.load("src/app/api/productions/route.ts"),
        itemRoute: loader.load("src/app/api/productions/[id]/route.ts"),
        gatesRoute: loader.load("src/app/api/productions/[id]/gates/route.ts"),
        decideRoute: loader.load("src/app/api/productions/[id]/gates/[gateId]/decide/route.ts"),
    };
}

function apiRequest(url, method = "GET", body, origin = "http://127.0.0.1:3120") {
    const headers = { origin, host: "127.0.0.1:3120", "sec-fetch-site": "same-origin" };
    if (body !== undefined) headers["content-type"] = "application/json";
    return new Request(`http://localhost:3120${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const context = (params) => ({ params: Promise.resolve(params) });

function documentPath(dir, slug) {
    return path.join(dir, "productions", slug, "production.json");
}

async function readDocument(dir, slug) {
    return JSON.parse(await fs.readFile(documentPath(dir, slug), "utf8"));
}

async function exists(target) {
    return fs.access(target).then(() => true, () => false);
}

const ALL_WAITING = {
    concept: "waiting",
    outline: "waiting",
    storyboard: "waiting",
    sound: "waiting",
    cut: "waiting",
    delivery: "waiting",
};

test("createProduction writes productions/<slug>/production.json and lists it", async (t) => {
    const { dir, store, contract } = await harness(t);
    assert.deepEqual(plain(await store.listProductions()), []);

    const production = await store.createProduction({ title: "Night Shift Teaser", brief: "A 15s teaser", effort: "quick" });
    assert.equal(production.slug, "night-shift-teaser");
    assert.equal(production.title, "Night Shift Teaser");
    assert.equal(production.brief, "A 15s teaser");
    assert.equal(production.effort, "quick");
    assert.deepEqual(plain(production.stopStates), ALL_WAITING);
    assert.deepEqual(plain(production.gates), []);
    assert.ok(Date.parse(production.updatedAt) >= Date.parse(production.createdAt));

    const raw = await readDocument(dir, "night-shift-teaser");
    assert.equal(raw.id, production.id);
    assert.equal(raw.slug, "night-shift-teaser");
    assert.deepEqual(raw.stopStates, ALL_WAITING);
    assert.equal(contract.productionSchema.safeParse(raw).success, true);

    const second = await store.createProduction({ title: "Night Shift Teaser" });
    assert.equal(second.slug, "night-shift-teaser-2", "slug collisions get a suffix");
    assert.equal(second.effort, "standard", "effort defaults to standard");
    assert.equal(second.brief, "", "brief defaults to empty");

    const listed = await store.listProductions();
    assert.equal(listed.length, 2);
    assert.equal((await store.readProduction(production.id)).title, "Night Shift Teaser");
    assert.equal((await store.readProduction(UUID_UNKNOWN)), undefined);
    assert.equal(await store.readProduction("../escape"), undefined);
    assert.equal((await store.findProductionBySlug("night-shift-teaser")).id, production.id);

    for (const input of [{}, { title: "" }, { title: "   " }, { title: "x".repeat(121) }, { title: "ok", effort: "epic" }, null, "nope"]) {
        await assert.rejects(store.createProduction(input), /ERR_PRODUCTION_INVALID/, JSON.stringify(input));
    }
});

test("advance moves one stop at a time and never skips a locked stop", async (t) => {
    const { store } = await harness(t);
    const created = await store.createProduction({ title: "Pipeline Walk" });

    const first = await store.advanceProduction(created.id);
    assert.deepEqual(plain(first.stopStates), { ...ALL_WAITING, concept: "done", outline: "working" });
    assert.ok(Date.parse(first.updatedAt) > Date.parse(created.updatedAt), "advance bumps updatedAt");

    // Only the active stop may change, and done is unreachable outside advance.
    await assert.rejects(store.setStopState(created.id, { stop: "storyboard", state: "working" }), /ERR_PRODUCTION_STOP_LOCKED/);
    await assert.rejects(store.setStopState(created.id, { stop: "concept", state: "blocked" }), /ERR_PRODUCTION_STOP_LOCKED/);
    await assert.rejects(store.setStopState(created.id, { stop: "outline", state: "done" }), /ERR_PRODUCTION_INVALID/);
    await assert.rejects(store.setStopState(created.id, { stop: "outline" }), /ERR_PRODUCTION_INVALID/);
    await assert.rejects(store.setStopState(created.id, { stop: "nope", state: "working" }), /ERR_PRODUCTION_INVALID/);

    const working = await store.setStopState(created.id, { stop: "outline", state: "working" });
    assert.equal(working.stopStates.outline, "working", "a waiting stop can start working");

    for (const stop of ["outline", "storyboard", "sound", "cut", "delivery"]) {
        const advanced = await store.advanceProduction(created.id);
        assert.equal(advanced.stopStates[stop], "done", `${stop} advanced in order`);
    }
    const complete = await store.readProduction(created.id);
    assert.deepEqual(plain(complete.stopStates), {
        concept: "done", outline: "done", storyboard: "done", sound: "done", cut: "done", delivery: "done",
    });
    await assert.rejects(store.advanceProduction(created.id), /ERR_PRODUCTION_COMPLETE/);
    await assert.rejects(store.setStopState(created.id, { stop: "delivery", state: "working" }), /ERR_PRODUCTION_STOP_LOCKED/);
    await assert.rejects(store.advanceProduction(UUID_UNKNOWN), /ERR_PRODUCTION_NOT_FOUND/);
});

test("a blocked stop refuses to advance until it is working again", async (t) => {
    const { store } = await harness(t);
    const created = await store.createProduction({ title: "Blocked Cut" });

    const blocked = await store.setStopState(created.id, { stop: "concept", state: "blocked" });
    assert.equal(blocked.stopStates.concept, "blocked");
    await assert.rejects(store.advanceProduction(created.id), /ERR_PRODUCTION_BLOCKED/);
    await assert.rejects(store.requestGate(created.id, {
        stop: "concept", options: [{ label: "Ship it" }],
    }), /ERR_PRODUCTION_BLOCKED/);
    await assert.rejects(store.setStopState(created.id, { stop: "delivery", state: "blocked" }), /ERR_PRODUCTION_STOP_LOCKED/);

    const resumed = await store.setStopState(created.id, { stop: "concept", state: "working" });
    assert.equal(resumed.stopStates.concept, "working");
    const advanced = await store.advanceProduction(created.id);
    assert.equal(advanced.stopStates.concept, "done");
    assert.equal(advanced.stopStates.outline, "working");
});

test("a pending gate blocks advance and only one gate can be pending", async (t) => {
    const { dir, store } = await harness(t);
    const created = await store.createProduction({ title: "Gated Concept" });

    await assert.rejects(store.requestGate(created.id, {
        stop: "concept", options: [{ label: "A", recommended: true }, { label: "B", recommended: true }],
    }), /ERR_GATE_INVALID/, "two recommended options are rejected");
    await assert.rejects(store.requestGate(created.id, {
        stop: "concept", options: [],
    }), /ERR_GATE_INVALID/);
    await assert.rejects(store.requestGate(created.id, {
        stop: "outline", options: [{ label: "A" }],
    }), /ERR_PRODUCTION_STOP_LOCKED/, "a gate cannot target a future stop");

    const { production, gate } = await store.requestGate(created.id, {
        stop: "concept",
        note: "Pick the visual direction",
        options: [{ label: "Warm filmic" }, { label: "Cold clinical", detail: "Blue cast", recommended: true }],
    });
    assert.equal(gate.state, "pending");
    assert.equal(gate.productionId, created.id);
    assert.equal(gate.stop, "concept");
    assert.equal(gate.selected, null);
    assert.equal(gate.decidedAt, null);
    assert.equal(gate.note, "Pick the visual direction");
    assert.deepEqual(plain(gate.options.map((option) => option.id)), ["opt-1", "opt-2"]);
    assert.deepEqual(plain(gate.options.map((option) => option.recommended)), [false, true], "exactly one recommended option");
    assert.equal(production.gates.length, 1);

    await assert.rejects(store.advanceProduction(created.id), /ERR_PRODUCTION_GATE_PENDING/);
    await assert.rejects(store.requestGate(created.id, {
        stop: "concept", options: [{ label: "Another" }],
    }), /ERR_PRODUCTION_GATE_PENDING/);
    await assert.rejects(store.setStopState(created.id, { stop: "concept", state: "working" }), /ERR_PRODUCTION_GATE_PENDING/);

    const raw = await readDocument(dir, "gated-concept");
    assert.equal(raw.gates.length, 1);
    assert.equal(raw.gates[0].state, "pending");
    assert.deepEqual(raw.gates[0].options.map((option) => option.label), ["Warm filmic", "Cold clinical"]);
});

test("approving a gate records the decision and advances the stop", async (t) => {
    const { dir, store } = await harness(t);
    const created = await store.createProduction({ title: "Approved Outline" });
    const { gate } = await store.requestGate(created.id, {
        stop: "concept",
        options: [{ label: "Warm filmic", recommended: true }, { label: "Cold clinical" }],
    });

    const { production, gate: decided } = await store.decideGate(created.id, gate.id, {
        decision: "approved",
        selected: "opt-1",
        note: "Warm matches the brief",
    });
    assert.equal(decided.state, "approved");
    assert.equal(decided.selected, "opt-1");
    assert.equal(decided.note, "Warm matches the brief");
    assert.ok(decided.decidedAt, "decidedAt is stamped");
    assert.equal(decided.id, gate.id);
    assert.deepEqual(plain(production.stopStates), { ...ALL_WAITING, concept: "done", outline: "working" });

    const raw = await readDocument(dir, "approved-outline");
    assert.equal(raw.gates[0].state, "approved");
    assert.equal(raw.gates[0].selected, "opt-1");
    assert.equal(raw.stopStates.outline, "working");
    assert.equal((await store.readProduction(created.id)).gates[0].note, "Warm matches the brief");
});

test("rejecting a gate keeps the stop and the decision note", async (t) => {
    const { dir, store } = await harness(t);
    const created = await store.createProduction({ title: "Rejected Cut" });
    const advanced = await store.advanceProduction(created.id);
    assert.equal(advanced.stopStates.outline, "working");

    const requested = await store.requestGate(created.id, {
        stop: "outline",
        options: [{ label: "Approve outline" }, { label: "Rewrite the middle", recommended: true }],
    });
    const { production, gate } = await store.decideGate(created.id, requested.gate.id, {
        decision: "rejected",
        selected: "opt-2",
        note: "The middle act needs a real turn",
    });

    assert.equal(gate.state, "rejected");
    assert.equal(gate.selected, "opt-2");
    assert.equal(gate.note, "The middle act needs a real turn");
    assert.deepEqual(plain(production.stopStates), plain(advanced.stopStates), "rejection leaves every stop where it was");
    assert.equal(production.stopStates.outline, "working");
    assert.equal((await readDocument(dir, "rejected-cut")).gates[0].note, "The middle act needs a real turn");

    // A new decision is a new gate: the same stop accepts another pending gate.
    const reopened = await store.requestGate(created.id, {
        stop: "outline",
        options: [{ label: "Second pass", recommended: true }],
    });
    assert.notEqual(reopened.gate.id, requested.gate.id);
    assert.equal(reopened.production.gates.length, 2);
    assert.equal(reopened.gate.state, "pending");
    assert.deepEqual(plain(reopened.production.gates.map((entry) => entry.state)), ["rejected", "pending"]);
});

test("decided gates are immutable and cannot be decided twice", async (t) => {
    const { dir, store } = await harness(t);
    const created = await store.createProduction({ title: "Immutable Gate" });
    const requested = await store.requestGate(created.id, {
        stop: "concept",
        options: [{ label: "Ship", recommended: true }, { label: "Rework" }],
    });
    const decided = await store.decideGate(created.id, requested.gate.id, {
        decision: "approved", selected: "opt-1", note: "Good enough",
    });
    const before = await readDocument(dir, "immutable-gate");

    await assert.rejects(store.decideGate(created.id, requested.gate.id, {
        decision: "rejected", selected: "opt-2", note: "Changed my mind",
    }), /ERR_GATE_DECIDED/);
    await assert.rejects(store.decideGate(created.id, requested.gate.id, {
        decision: "approved", selected: "opt-1",
    }), /ERR_GATE_DECIDED/);
    assert.deepEqual(await readDocument(dir, "immutable-gate"), before, "a failed second decision never writes");

    const after = await store.readProduction(created.id);
    assert.equal(after.gates.length, 1);
    assert.equal(after.gates[0].state, "approved");
    assert.equal(after.gates[0].note, "Good enough");
    assert.equal(after.gates[0].decidedAt, decided.gate.decidedAt);
    assert.deepEqual(plain(after.stopStates), { ...ALL_WAITING, concept: "done", outline: "working" });

    await assert.rejects(store.decideGate(created.id, requested.gate.id, {
        decision: "approved", selected: "opt-9",
    }), /ERR_GATE_DECIDED/, "the immutability check runs before option validation");

    // Unknown gates and invalid options on a still pending gate.
    await assert.rejects(store.decideGate(created.id, UUID_UNKNOWN, {
        decision: "approved", selected: "opt-1",
    }), /ERR_GATE_NOT_FOUND/);
    const second = await store.requestGate(created.id, {
        stop: "outline", options: [{ label: "Only one", recommended: true }],
    });
    await assert.rejects(store.decideGate(created.id, second.gate.id, {
        decision: "approved", selected: "opt-2",
    }), /ERR_GATE_INVALID/);
    await assert.rejects(store.decideGate(UUID_UNKNOWN, second.gate.id, {
        decision: "approved", selected: "opt-1",
    }), /ERR_PRODUCTION_NOT_FOUND/);
    const other = await store.createProduction({ title: "Other Production" });
    await assert.rejects(store.decideGate(other.id, second.gate.id, {
        decision: "approved", selected: "opt-1",
    }), /ERR_GATE_NOT_FOUND/, "gates are scoped to their production");
});

test("updateProduction edits only descriptive fields and bumps updatedAt", async (t) => {
    const { dir, store } = await harness(t);
    const created = await store.createProduction({ title: "Editable Film", effort: "studio" });
    const updated = await store.updateProduction(created.id, { title: "Editable Film II", brief: "Longer cut", effort: "quick" });
    assert.equal(updated.title, "Editable Film II");
    assert.equal(updated.brief, "Longer cut");
    assert.equal(updated.effort, "quick");
    assert.equal(updated.id, created.id);
    assert.equal(updated.slug, "editable-film", "slug is stable across renames");
    assert.ok(Date.parse(updated.updatedAt) > Date.parse(created.updatedAt));
    assert.equal((await readDocument(dir, "editable-film")).title, "Editable Film II");

    for (const patch of [{}, { stopStates: ALL_WAITING }, { gates: [] }, { slug: "other" }, { id: created.id }, { title: "" }, { effort: "epic" }]) {
        await assert.rejects(store.updateProduction(created.id, patch), /ERR_PRODUCTION_INVALID/, JSON.stringify(patch));
    }
    await assert.rejects(store.updateProduction(UUID_UNKNOWN, { title: "Missing" }), /ERR_PRODUCTION_NOT_FOUND/);
});

test("the board lists waiting work before in-flight work", async (t) => {
    const { store } = await harness(t);
    const waiting = await store.createProduction({ title: "Waiting Room" });
    const moving = await store.createProduction({ title: "In Motion" });
    await store.advanceProduction(moving.id);
    await store.advanceProduction(moving.id);

    const listed = await store.listProductions();
    assert.deepEqual(plain(listed.map((production) => production.title)), ["Waiting Room", "In Motion"]);
    assert.equal(listed[0].id, waiting.id);
    assert.equal(listed[1].stopStates.storyboard, "working");
});

test("deleteProduction moves the folder to productions/.trash", async (t) => {
    const { dir, store } = await harness(t);
    const production = await store.createProduction({ title: "Trash Me" });
    const folder = path.join(dir, "productions", "trash-me");
    assert.equal(await store.deleteProduction(production.id), true);
    assert.equal(await exists(folder), false);
    const entries = await fs.readdir(path.join(dir, "productions", ".trash"));
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^trash-me-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    assert.equal(await exists(path.join(dir, "productions", ".trash", entries[0], "production.json")), true);
    assert.deepEqual(plain(await store.listProductions()), []);
    assert.equal(await store.deleteProduction(production.id), false);
});

test("production routes return stable status codes for every transition", async (t) => {
    const { dir, env, store, listRoute, itemRoute, gatesRoute, decideRoute } = await harness(t);

    const created = await listRoute.POST(apiRequest("/api/productions", "POST", { title: "Route Film", brief: "b", effort: "studio" }));
    assert.equal(created.status, 201);
    const production = (await created.json()).production;
    assert.equal(production.title, "Route Film");

    const invalid = await listRoute.POST(apiRequest("/api/productions", "POST", { title: "" }));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "ERR_PRODUCTION_INVALID");

    const wrongType = await listRoute.POST(new Request("http://localhost:3120/api/productions", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:3120", host: "127.0.0.1:3120", "sec-fetch-site": "same-origin", "content-type": "text/plain" },
        body: "{}",
    }));
    assert.equal(wrongType.status, 415);
    assert.equal((await wrongType.json()).error, "ERR_CONTENT_TYPE");

    const crossOrigin = await listRoute.POST(apiRequest("/api/productions", "POST", { title: "Hostile" }, "http://evil.example"));
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error, "ERR_ORIGIN_FORBIDDEN");

    const list = await listRoute.GET(apiRequest("/api/productions"));
    assert.equal(list.status, 200);
    const listed = await list.json();
    assert.equal(listed.count, 1);
    assert.equal(listed.productions[0].id, production.id);

    const one = await itemRoute.GET(apiRequest(`/api/productions/${production.id}`), context({ id: production.id }));
    assert.equal(one.status, 200);
    assert.equal((await one.json()).production.id, production.id);
    const missing = await itemRoute.GET(apiRequest(`/api/productions/${UUID_UNKNOWN}`), context({ id: UUID_UNKNOWN }));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "ERR_PRODUCTION_NOT_FOUND");

    const renamed = await itemRoute.PATCH(
        apiRequest(`/api/productions/${production.id}`, "PATCH", { title: "Route Film II" }),
        context({ id: production.id }),
    );
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).production.title, "Route Film II");

    const advanced = await itemRoute.PATCH(
        apiRequest(`/api/productions/${production.id}`, "PATCH", { advance: true }),
        context({ id: production.id }),
    );
    assert.equal(advanced.status, 200);
    assert.equal((await advanced.json()).production.stopStates.concept, "done");

    const skipped = await itemRoute.PATCH(
        apiRequest(`/api/productions/${production.id}`, "PATCH", { stop: "delivery", state: "working" }),
        context({ id: production.id }),
    );
    assert.equal(skipped.status, 409);
    assert.equal((await skipped.json()).error, "ERR_PRODUCTION_STOP_LOCKED");

    const blocked = await itemRoute.PATCH(
        apiRequest(`/api/productions/${production.id}`, "PATCH", { stop: "outline", state: "blocked" }),
        context({ id: production.id }),
    );
    assert.equal(blocked.status, 200);
    const blockedAdvance = await itemRoute.PATCH(
        apiRequest(`/api/productions/${production.id}`, "PATCH", { advance: true }),
        context({ id: production.id }),
    );
    assert.equal(blockedAdvance.status, 409);
    assert.equal((await blockedAdvance.json()).error, "ERR_PRODUCTION_BLOCKED");

    const resumed = await itemRoute.PATCH(
        apiRequest(`/api/productions/${production.id}`, "PATCH", { stop: "outline", state: "working" }),
        context({ id: production.id }),
    );
    assert.equal(resumed.status, 200);

    const gateResponse = await gatesRoute.POST(
        apiRequest(`/api/productions/${production.id}/gates`, "POST", {
            stop: "outline",
            note: "Need a call",
            options: [{ label: "Keep outline", recommended: true }, { label: "Retool act two" }],
        }),
        context({ id: production.id }),
    );
    assert.equal(gateResponse.status, 201);
    const gate = (await gateResponse.json()).gate;
    assert.equal(gate.state, "pending");

    const pendingAdvance = await itemRoute.PATCH(
        apiRequest(`/api/productions/${production.id}`, "PATCH", { advance: true }),
        context({ id: production.id }),
    );
    assert.equal(pendingAdvance.status, 409);
    assert.equal((await pendingAdvance.json()).error, "ERR_PRODUCTION_GATE_PENDING");

    const secondGate = await gatesRoute.POST(
        apiRequest(`/api/productions/${production.id}/gates`, "POST", { stop: "outline", options: [{ label: "Another" }] }),
        context({ id: production.id }),
    );
    assert.equal(secondGate.status, 409);
    assert.equal((await secondGate.json()).error, "ERR_PRODUCTION_GATE_PENDING");

    const badGate = await gatesRoute.POST(
        apiRequest(`/api/productions/${production.id}/gates`, "POST", { stop: "outline", options: [] }),
        context({ id: production.id }),
    );
    assert.equal(badGate.status, 400);
    assert.equal((await badGate.json()).error, "ERR_GATE_INVALID");

    const noProduction = await gatesRoute.POST(
        apiRequest(`/api/productions/${UUID_UNKNOWN}/gates`, "POST", { stop: "concept", options: [{ label: "A" }] }),
        context({ id: UUID_UNKNOWN }),
    );
    assert.equal(noProduction.status, 404);
    assert.equal((await noProduction.json()).error, "ERR_PRODUCTION_NOT_FOUND");

    const decision = await decideRoute.POST(
        apiRequest(`/api/productions/${production.id}/gates/${gate.id}/decide`, "POST", {
            decision: "approved", selected: "opt-1", note: "Ship it",
        }),
        context({ id: production.id, gateId: gate.id }),
    );
    assert.equal(decision.status, 200);
    const decidedBody = await decision.json();
    assert.equal(decidedBody.gate.state, "approved");
    assert.equal(decidedBody.production.stopStates.outline, "done");
    assert.equal(decidedBody.production.stopStates.storyboard, "working");

    const again = await decideRoute.POST(
        apiRequest(`/api/productions/${production.id}/gates/${gate.id}/decide`, "POST", { decision: "rejected", selected: "opt-2" }),
        context({ id: production.id, gateId: gate.id }),
    );
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, "ERR_GATE_DECIDED");

    const nextGateResponse = await gatesRoute.POST(
        apiRequest(`/api/productions/${production.id}/gates`, "POST", { stop: "storyboard", options: [{ label: "Approve board", recommended: true }] }),
        context({ id: production.id }),
    );
    assert.equal(nextGateResponse.status, 201);
    const nextGate = (await nextGateResponse.json()).gate;

    const badOption = await decideRoute.POST(
        apiRequest(`/api/productions/${production.id}/gates/${nextGate.id}/decide`, "POST", { decision: "approved", selected: "opt-9" }),
        context({ id: production.id, gateId: nextGate.id }),
    );
    assert.equal(badOption.status, 400);
    assert.equal((await badOption.json()).error, "ERR_GATE_INVALID");

    const unknownGate = await decideRoute.POST(
        apiRequest(`/api/productions/${production.id}/gates/${UUID_UNKNOWN}/decide`, "POST", { decision: "approved", selected: "opt-1" }),
        context({ id: production.id, gateId: UUID_UNKNOWN }),
    );
    assert.equal(unknownGate.status, 404);
    assert.equal((await unknownGate.json()).error, "ERR_GATE_NOT_FOUND");

    const rejected = await decideRoute.POST(
        apiRequest(`/api/productions/${production.id}/gates/${nextGate.id}/decide`, "POST", {
            decision: "rejected", selected: "opt-1", note: "Board needs another pass",
        }),
        context({ id: production.id, gateId: nextGate.id }),
    );
    assert.equal(rejected.status, 200);
    const rejectedBody = await rejected.json();
    assert.equal(rejectedBody.gate.state, "rejected");
    assert.equal(rejectedBody.gate.note, "Board needs another pass");
    assert.equal(rejectedBody.production.stopStates.storyboard, "working", "rejection keeps the stop");

    const raw = await readDocument(dir, "route-film");
    assert.deepEqual(plain(raw.gates.map((entry) => entry.state)), ["approved", "rejected"]);
    assert.deepEqual(plain((await store.readProduction(production.id)).gates.map((entry) => entry.note)), ["Ship it", "Board needs another pass"]);

    // Demo deployments are read-only even for same-origin writes.
    const demoLoader = createModuleLoader({
        env: { ...env, APP_DEMO_MODE: "true", GENERATION_ENABLED: "false" },
        mocks: { "next/server": { NextResponse: Response } },
    });
    const demoRoute = demoLoader.load("src/app/api/productions/route.ts");
    const demoPost = await demoRoute.POST(apiRequest("/api/productions", "POST", { title: "Demo" }));
    assert.equal(demoPost.status, 403);
    assert.equal((await demoPost.json()).error, "ERR_DEMO_READ_ONLY");
    assert.equal((await demoRoute.GET(apiRequest("/api/productions"))).status, 200);
});

test("board helpers sort waiting first and colour every stop", async (t) => {
    const { client } = await harness(t);
    assert.equal(client.stopTone("waiting"), "amber");
    assert.equal(client.stopTone("working"), "violet");
    assert.equal(client.stopTone("done"), "green");
    assert.equal(client.stopTone("blocked"), "red");

    const base = (overrides) => ({
        id: overrides.id,
        slug: overrides.id,
        title: overrides.id,
        brief: "",
        effort: "standard",
        stopStates: { ...ALL_WAITING, ...overrides.stopStates },
        gates: overrides.gates ?? [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    });
    const waiting = base({ id: "waiting", updatedAt: "2026-03-02T00:00:00.000Z" });
    const gated = base({
        id: "gated",
        updatedAt: "2026-03-01T00:00:00.000Z",
        gates: [{ id: "g1", productionId: "gated", stop: "concept", state: "pending", options: [], selected: null, note: "", decidedAt: null }],
    });
    const blocked = base({ id: "blocked", stopStates: { concept: "blocked" } });
    const working = base({ id: "working", stopStates: { concept: "done", outline: "working" } });
    const delivered = base({
        id: "delivered",
        stopStates: { concept: "done", outline: "done", storyboard: "done", sound: "done", cut: "done", delivery: "done" },
    });

    assert.deepEqual(
        plain(client.sortedForBoard([delivered, working, blocked, gated, waiting]).map((production) => production.id)),
        ["waiting", "gated", "blocked", "working", "delivered"],
    );
    assert.equal(client.activeStop(waiting.stopStates), "concept");
    assert.equal(client.activeStop(delivered.stopStates), null);
    assert.equal(client.isComplete(delivered), true);
    assert.equal(client.pendingGate(gated).id, "g1");
    assert.equal(client.pendingGate(waiting), undefined);

    const gate = {
        options: [
            { id: "opt-1", label: "One", detail: "", recommended: false },
            { id: "opt-2", label: "Two", detail: "", recommended: true },
        ],
    };
    assert.equal(client.recommendedOption(gate).id, "opt-2");
    assert.equal(client.recommendedOption({ options: [{ id: "opt-1", label: "One", detail: "", recommended: false }] }).id, "opt-1");
    assert.equal(client.optionLabel(gate, "opt-2"), "Two");
    assert.equal(client.optionLabel(gate, null), undefined);
});
