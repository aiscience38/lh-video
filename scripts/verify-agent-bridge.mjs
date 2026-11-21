import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test, { after, before } from "node:test";
import {
    assertAgentApproval,
    createBridgeClient,
    createMcpServer,
    readBridgeConfig,
    TOOLS,
} from "../src/lib/agent-bridge/bridge.ts";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts", "lh-video-cli.mjs");

const requests = [];
let server;
let baseUrl;

function send(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(body);
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => resolve(Buffer.concat(chunks)));
        request.on("error", reject);
    });
}

before(async () => {
    server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, `http://${request.headers.host}`);
            const body = await readBody(request);
            requests.push({ method: request.method, path: url.pathname, search: url.search, headers: request.headers, body });
            const method = request.method ?? "GET";

            if (method === "GET" && url.pathname === "/api/health") return send(response, 200, { status: "alive" });
            if (method === "GET" && url.pathname === "/api/productions") {
                return send(response, 200, {
                    productions: [
                        { id: "prod-closed", name: "Closed picture", stage: "storyboard", agentCanApprove: false },
                        { id: "prod-open", name: "Open picture", stage: "images", agentCanApprove: true },
                    ],
                });
            }
            if (method === "GET" && url.pathname === "/api/productions/prod-closed") {
                return send(response, 200, { production: { id: "prod-closed", name: "Closed picture", agentCanApprove: false } });
            }
            if (method === "GET" && url.pathname === "/api/productions/prod-open") {
                return send(response, 200, { production: { id: "prod-open", name: "Open picture", agentCanApprove: true } });
            }
            if (method === "GET" && url.pathname === "/api/productions/prod-open/ledger") {
                return send(response, 200, {
                    productionId: "prod-open",
                    entries: [{ id: "entry-1", kind: "gate", message: "storyboard approved", createdAt: "2026-01-01T00:00:00.000Z" }],
                });
            }
            if (method === "POST" && url.pathname === "/api/productions/prod-open/stops/stop-1/advance") {
                return send(response, 200, { productionId: "prod-open", stopId: "stop-1", advanced: true });
            }
            if (method === "POST" && url.pathname === "/api/productions/prod-closed/stops/stop-1/advance") {
                return send(response, 200, { productionId: "prod-closed", stopId: "stop-1", advanced: true });
            }
            if (method === "GET" && url.pathname === "/api/library") {
                const kind = url.searchParams.get("kind");
                const query = (url.searchParams.get("q") ?? "").toLowerCase();
                const entities = [
                    { id: "char-1", kind: "character", slug: "ana", name: "Ana" },
                    { id: "scene-1", kind: "scene", slug: "opening", name: "Opening" },
                ].filter((entity) => (!kind || entity.kind === kind)
                    && (!query || entity.name.toLowerCase().includes(query) || entity.slug.includes(query)));
                return send(response, 200, { entities, count: entities.length });
            }
            if (method === "GET" && url.pathname === "/api/tasks/task-1") {
                return send(response, 200, { task_id: "task-1", media_type: "video", status: "completed" });
            }
            if (method === "GET" && url.pathname === "/api/tasks/missing-task") {
                return send(response, 404, { error: "ERR_TASK_NOT_FOUND" });
            }
            if (method === "POST" && url.pathname === "/api/generate") {
                const form = await new Response(body, { headers: { "content-type": request.headers["content-type"] } }).formData();
                return send(response, 202, {
                    task_id: "task-new",
                    accepted: true,
                    recovery_required: false,
                    echo: {
                        model_id: form.get("model_id"),
                        prompt: form.get("prompt"),
                        variant_id: form.get("variant_id"),
                        settings: form.get("settings"),
                        origin: request.headers.origin,
                    },
                });
            }
            return send(response, 404, { error: "ERR_NOT_FOUND" });
        } catch (error) {
            return send(response, 500, { error: "ERR_MOCK_FAILURE", message: error instanceof Error ? error.message : String(error) });
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

function clientFor(url = baseUrl) {
    return createBridgeClient({ config: readBridgeConfig({ LH_VIDEO_BASE_URL: url }) });
}

function advancePosts(productionId) {
    return requests.filter((entry) => entry.method === "POST"
        && entry.path === `/api/productions/${productionId}/stops/stop-1/advance`).length;
}

test("base URL defaults to the local app and refuses anything but loopback", () => {
    assert.equal(readBridgeConfig({}).baseUrl, "http://127.0.0.1:3000");
    assert.equal(readBridgeConfig({ LH_VIDEO_BASE_URL: "http://localhost:4100/" }).baseUrl, "http://localhost:4100");
    assert.throws(
        () => readBridgeConfig({ LH_VIDEO_BASE_URL: "https://studio.example.com" }),
        (error) => error.code === "ERR_BRIDGE_NOT_LOOPBACK",
    );
    assert.throws(
        () => readBridgeConfig({ LH_VIDEO_BASE_URL: "http://127.0.0.1:3000/api" }),
        (error) => error.code === "ERR_BRIDGE_BASE_URL",
    );
    assert.throws(
        () => readBridgeConfig({ LH_VIDEO_BASE_URL: "not a url" }),
        (error) => error.code === "ERR_BRIDGE_BASE_URL",
    );
});

test("gate rule accepts only the literal boolean true", () => {
    assert.throws(() => assertAgentApproval({ id: "p" }), (error) => error.code === "ERR_AGENT_APPROVAL_DENIED");
    assert.throws(() => assertAgentApproval({ id: "p", agentCanApprove: "true" }), (error) => error.code === "ERR_AGENT_APPROVAL_DENIED");
    assert.throws(() => assertAgentApproval({ id: "p", agentCanApprove: 1 }), (error) => error.code === "ERR_AGENT_APPROVAL_DENIED");
    assert.throws(() => assertAgentApproval(null), (error) => error.code === "ERR_AGENT_APPROVAL_DENIED");
    assert.doesNotThrow(() => assertAgentApproval({ id: "p", agentCanApprove: true }));
});

test("read tools call the app's library, task and ledger endpoints", async () => {
    const client = clientFor();
    const productions = await client.listProductions();
    assert.equal(productions.productions.length, 2);

    const library = await client.listLibrary({ kind: "character", q: "ana" });
    assert.equal(library.count, 1);
    assert.equal(library.entities[0].slug, "ana");
    assert.equal(requests.at(-1).search, "?kind=character&q=ana");

    const task = await client.getTask("task-1");
    assert.equal(task.task_id, "task-1");

    const ledger = await client.readLedger({ productionId: "prod-open" });
    assert.equal(ledger.entries[0].kind, "gate");
});

test("API failures keep the app's stable error code", async () => {
    const client = clientFor();
    await assert.rejects(
        () => client.getTask("missing-task"),
        (error) => error.code === "ERR_TASK_NOT_FOUND" && error.status === 404 && /HTTP 404/.test(error.message),
    );
});

test("create_generation_task posts multipart with the exact Origin header", async () => {
    const client = clientFor();
    const result = await client.createGenerationTask({
        modelId: "video-model",
        prompt: "a slow dolly through fog",
        settings: { duration: "5" },
        aspectRatio: "16:9",
    });
    assert.equal(result.task_id, "task-new");
    assert.equal(result.echo.model_id, "video-model");
    assert.equal(result.echo.prompt, "a slow dolly through fog");
    assert.equal(result.echo.origin, baseUrl);
    assert.deepEqual(JSON.parse(result.echo.settings), { duration: "5", aspectRatio: "16:9" });
    assert.equal(requests.at(-1).path, "/api/generate");
});

test("advance_production_stop refuses a production without agentCanApprove and sends no POST", async () => {
    const client = clientFor();
    const before = advancePosts("prod-closed");
    await assert.rejects(
        () => client.advanceProductionStop({ productionId: "prod-closed", stopId: "stop-1" }),
        (error) => {
            assert.equal(error.code, "ERR_AGENT_APPROVAL_DENIED");
            assert.equal(error.status, 403);
            assert.match(error.message, /agentCanApprove=true/);
            return true;
        },
    );
    assert.equal(advancePosts("prod-closed"), before, "the bridge must not POST an advance after refusing the gate");
});

test("advance_production_stop advances an opted-in production after re-reading its flag", async () => {
    const client = clientFor();
    const start = requests.length;
    const result = await client.advanceProductionStop({ productionId: "prod-open", stopId: "stop-1", note: "looks good" });
    assert.equal(result.advanced, true);
    const calls = requests.slice(start).map((entry) => `${entry.method} ${entry.path}`);
    assert.deepEqual(calls, [
        "GET /api/productions/prod-open",
        "POST /api/productions/prod-open/stops/stop-1/advance",
    ]);
    const post = requests.at(-1);
    assert.equal(post.headers.origin, baseUrl);
    assert.deepEqual(JSON.parse(post.body.toString()), { stopId: "stop-1", approvedBy: "agent", note: "looks good" });
});

test("MCP server lists all six tools and turns bridge refusals into tool errors", async () => {
    const serverUnderTest = createMcpServer(clientFor());
    assert.deepEqual(TOOLS.map((tool) => tool.name), [
        "list_productions",
        "list_library",
        "get_task",
        "create_generation_task",
        "read_ledger",
        "advance_production_stop",
    ]);

    const initialize = await serverUnderTest.handle({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.equal(initialize.result.protocolVersion, "2025-06-18");
    assert.equal(initialize.result.serverInfo.name, "lh-video-agent-bridge");

    assert.equal(await serverUnderTest.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);

    const listing = await serverUnderTest.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(listing.result.tools.length, 6);

    const library = await serverUnderTest.handle({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "list_library", arguments: { kind: "character" } },
    });
    assert.equal(library.result.isError, false);
    assert.equal(JSON.parse(library.result.content[0].text).count, 1);

    const before = advancePosts("prod-closed");
    const denied = await serverUnderTest.handle({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "advance_production_stop", arguments: { production_id: "prod-closed", stop_id: "stop-1" } },
    });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /^ERR_AGENT_APPROVAL_DENIED:/);
    assert.equal(advancePosts("prod-closed"), before);

    const unknown = await serverUnderTest.handle({
        jsonrpc: "2.0", id: 5, method: "tools/call",
        params: { name: "drop_database", arguments: {} },
    });
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.result.content[0].text, /ERR_UNKNOWN_TOOL/);

    const missing = await serverUnderTest.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: {} });
    assert.equal(missing.error.code, -32602);
});

function runCli(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
}

test("CLI status --json emits one valid JSON document", async () => {
    const result = await runCli(["--base-url", baseUrl, "--json", "status"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.baseUrl, baseUrl);
    assert.equal(payload.health.status, "alive");
    assert.equal(payload.productionsAvailable, true);
    assert.equal(payload.productionCount, 2);
});

test("CLI library --json reuses the same client and prints JSON", async () => {
    const result = await runCli(["--base-url", baseUrl, "--kind", "scene", "--json", "library"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.count, 1);
    assert.equal(payload.entities[0].slug, "opening");
});
