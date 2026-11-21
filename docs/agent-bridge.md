# Agent bridge: MCP server and CLI

The agent bridge gives a local agent read access to the workspace and one
narrow write path. It is an MCP server over stdio plus a small CLI; both share
one HTTP client and speak only to the running app's loopback API.

```text
agent / MCP client ──stdio JSON-RPC──▶ scripts/lh-video-mcp.mjs
                                             │
                                             ▼
                                   src/lib/agent-bridge/bridge.ts
                                             │ HTTP + exact Origin
                                             ▼
                                   http://127.0.0.1:3000 (the app)
```

The bridge is not a second API. Every tool maps to an existing or planned
route on the local app, so the app keeps ownership of validation, storage and
provider calls.

## Security and authentication

The app is a single-operator workspace with no login. Its write routes call
`guardWorkspaceRequest`, which requires the exact `Origin` of the configured
`APP_ORIGIN` (or the request origin in loopback development). The bridge
inherits that model instead of inventing credentials:

- The client refuses any base URL that is not loopback (`localhost`,
  `127.0.0.1` or `[::1]`) with `ERR_BRIDGE_NOT_LOOPBACK`. There is no remote
  mode and no token to leak.
- Every non-GET request sends `Origin: <base URL>`, which is exactly what the
  guard compares. A missing or different origin is rejected by the app.
- The bridge stores no secrets and reads no provider configuration. It can
  only do what the app's own API allows.
- `APP_DEMO_MODE` still applies: a demo app rejects bridge writes with
  `ERR_DEMO_READ_ONLY`.

Run the app with `npm run dev` (binds `127.0.0.1:3000`) or through the desktop
launcher, which sets `APP_ORIGIN` and a local port. If `APP_ORIGIN` is set, use
that exact origin as `LH_VIDEO_BASE_URL`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LH_VIDEO_BASE_URL` | `http://127.0.0.1:3000` | Loopback origin of the running app. Paths, credentials and remote hosts are rejected. |
| `LH_VIDEO_TIMEOUT_MS` | `20000` | Per-request timeout, 1000-300000 ms. |

## MCP server

```bash
node scripts/lh-video-mcp.mjs
```

The entry uses Node's built-in type stripping, so no build or SDK dependency is
needed (Node 22.18+, matching the project's `engines`). stdout carries only
newline-delimited JSON-RPC 2.0 messages; diagnostics go to stderr. Protocol
version: `2025-06-18`.

Example client configuration:

```json
{
  "mcpServers": {
    "lh-video": {
      "command": "node",
      "args": ["C:/Users/me/projects/lh-video/scripts/lh-video-mcp.mjs"],
      "env": { "LH_VIDEO_BASE_URL": "http://127.0.0.1:3000" }
    }
  }
}
```

`src/server/mcp/server.ts` is the server-only composition root for Next code.
It re-exports the same transport-neutral implementation and adds
`createServerFromEnvironment()` / `runStdioServer()`. The implementation lives
in `src/lib/agent-bridge/bridge.ts` because plain Node cannot resolve Next's
`server-only` marker package.

### Tools

| Tool | Arguments | Kind | Behavior |
| --- | --- | --- | --- |
| `list_productions` | none | read | `GET /api/productions`; stages, active stops and the `agentCanApprove` flag. |
| `list_library` | `kind?` (`character`, `scene`, `storyboard`), `q?` | read | `GET /api/library`; name/slug filter is case-insensitive. |
| `get_task` | `task_id` | read | `GET /api/tasks/{task_id}`; status, model, prompt and output. |
| `create_generation_task` | `model_id`, `prompt?`, `variant_id?`, `settings?`, `duration?`, `aspect_ratio?`, `resolution?`, `client_submission_id?` | write | `POST /api/generate` as multipart; submits a billable provider request. Never retried. |
| `read_ledger` | `production_id` | read | `GET /api/productions/{id}/ledger`; append-only decisions and approvals. |
| `advance_production_stop` | `production_id`, `stop_id`, `note?` | write | Approves and advances one production stop. See the gate rule below. |

`create_generation_task` maps `duration` and `aspect_ratio` into the model
`settings` object and uses `resolution` as the variant when `variant_id` is
absent. The app still validates the model and its fields, so its error codes
(`ERR_UNKNOWN_MODEL`, `ERR_PROMPT_REQUIRED`, ...) reach the agent unchanged.

### Gate approval rule

`advance_production_stop` is an approval action, not a bookkeeping edit. The
bridge enforces a per-production opt-in in code:

1. It fetches `GET /api/productions/{production_id}` immediately before acting.
2. It reads `agentCanApprove` from that production. Only the literal boolean
   `true` passes; a missing flag, the string `"true"`, `1` or any other value
   is a denial.
3. If the flag is not `true`, it throws `ERR_AGENT_APPROVAL_DENIED` (HTTP 403
   semantics) and **sends no POST**. It does not retry, fall back to another
   route or mutate the production directly.
4. Only then does it send `POST /api/productions/{id}/stops/{stopId}/advance`
   with `{ stopId, approvedBy: "agent", note? }`.

There is no environment variable, CLI flag or tool argument that overrides the
rule. A production grants it in its own stored document. The test suite asserts
both the refusal code and that zero advance POSTs reach the mock server while
the flag is absent or false.

### Production API contract

The bridge expects these routes, owned by the productions module (read-only for
this work). All response bodies are JSON and all failures use the app's
`{ "error": "ERR_..." }` shape.

| Method and path | Response |
| --- | --- |
| `GET /api/productions` | `{ "productions": [{ "id", "name", "stage", "agentCanApprove": boolean, ... }] }` |
| `GET /api/productions/{id}` | `{ "production": { ..., "agentCanApprove": boolean } }` |
| `GET /api/productions/{id}/ledger` | `{ "productionId", "entries": [{ "id", "kind", "message", "createdAt", ... }] }` |
| `POST /api/productions/{id}/stops/{stopId}/advance` | `{ "productionId", "stopId", "advanced": true }` |

The advance route must also enforce the gate server-side; the bridge check is
the first line of defence, not the only one.

## CLI

The CLI reuses `src/lib/agent-bridge/bridge.ts`; it is not a separate client.

```bash
node scripts/lh-video-cli.mjs status
node scripts/lh-video-cli.mjs productions
node scripts/lh-video-cli.mjs library --kind character --q ana
node scripts/lh-video-cli.mjs submit --model <model-id> --prompt "a foggy dolly"
node scripts/lh-video-cli.mjs ledger --production <production-id>
```

Add `--json` to any command to print one JSON document on stdout:

```bash
node scripts/lh-video-cli.mjs --json status
```

```json
{
  "ok": true,
  "baseUrl": "http://127.0.0.1:3000",
  "health": { "status": "alive" },
  "productionsAvailable": true,
  "productionCount": 2
}
```

`status` reports app health even when the productions routes are not deployed
yet; in that case it returns `productionsAvailable: false` and a
`productionsError` code instead of failing.

Global options: `--json`, `--base-url <url>`, `--help`. `submit` accepts
`--model`, `--prompt`, `--variant`, `--settings <json>`, `--duration`,
`--aspect-ratio`, `--resolution` and `--client-submission-id`.

## Errors

| Code | Source | Meaning |
| --- | --- | --- |
| `ERR_BRIDGE_BASE_URL` | bridge | Base URL is not a bare http(s) origin. |
| `ERR_BRIDGE_NOT_LOOPBACK` | bridge | Base URL is not local; remote access is unsupported. |
| `ERR_BRIDGE_TIMEOUT` | bridge | `LH_VIDEO_TIMEOUT_MS` outside 1000-300000. |
| `ERR_BRIDGE_UNREACHABLE` | bridge | The app did not answer; includes the connection detail. |
| `ERR_BRIDGE_INVALID_RESPONSE` | bridge | Non-JSON or empty response; wrong server or wrong port. |
| `ERR_BRIDGE_INVALID_ARGUMENT` | bridge | Missing or malformed tool/CLI input. |
| `ERR_AGENT_APPROVAL_DENIED` | bridge | Production did not opt in with `agentCanApprove: true`. |
| `ERR_UNKNOWN_TOOL` | bridge | Tool name is not in `tools/list`. |
| `ERR_ORIGIN_FORBIDDEN`, `ERR_DEMO_READ_ONLY`, `ERR_TASK_NOT_FOUND`, ... | app | Forwarded unchanged from the local API. |

MCP tool failures are returned as `isError: true` with `CODE: message` text,
not as protocol errors, so an agent can read the refusal. JSON-RPC protocol
errors use `-32600` (invalid request), `-32601` (unknown method), `-32602`
(invalid params) and `-32700` (parse error).

## Validation

```bash
node --test scripts/verify-agent-bridge.mjs
```

The suite runs the client against a local mock HTTP server and covers the
loopback config rule, the strict gate rule, multipart submission with the
`Origin` header, forwarded error codes, all six MCP tools, refusal without a
POST, and `status --json` from the real CLI process.
