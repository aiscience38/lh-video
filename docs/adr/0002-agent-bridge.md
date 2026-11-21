# ADR 0002: Agent bridge over local HTTP and stdio MCP

- Status: Accepted
- Date: 2026-11-20

## Context

M3 adds an agent-facing surface: list productions, inspect the creative
library and tasks, submit one video generation, read a production ledger, and
approve a production gate. The app is a single-operator, self-hosted workspace
with no login. Its write routes are protected by `guardWorkspaceRequest`, which
requires the exact `Origin` and only trusts loopback in development/desktop
mode. There is no user account, API key or OAuth scope to reuse.

Two integration styles were available: a new authenticated HTTP API, or a local
bridge that drives the existing HTTP API. A new API would duplicate validation,
storage and provider logic and would need its own credential story. A bridge
that reads files directly would bypass route validation and the origin guard.

Any gate approval must be safe by default: an agent should not be able to
advance a human review gate merely because it can reach the API.

## Decision

1. **Bridge over the app's own HTTP API.** The MCP server and CLI call the
   running app at `LH_VIDEO_BASE_URL` (default `http://127.0.0.1:3000`). They
   add no storage, provider or validation logic of their own.
2. **Loopback only.** The client rejects non-loopback URLs with
   `ERR_BRIDGE_NOT_LOOPBACK`. Mutations send `Origin: <base URL>` so the
   existing `guardWorkspaceRequest` remains the actual authorization boundary.
   No token, password or remote mode is introduced.
3. **stdio MCP without an SDK dependency.** `scripts/lh-video-mcp.mjs`
   implements newline-framed JSON-RPC 2.0 (`initialize`, `tools/list`,
   `tools/call`, `ping`) directly. Adding `@modelcontextprotocol/sdk` would
   change the dependency audit surface for six tools and a single transport;
   the protocol surface used here is small and tested.
4. **One shared transport-neutral module.** The client, gate rule, tool catalog
   and stdio dispatcher live in `src/lib/agent-bridge/bridge.ts`. The CLI and
   the stdio entry import it directly under Node's type stripping.
   `src/server/mcp/server.ts` is the `server-only` composition root for Next
   code and re-exports the same implementation. Putting the runtime code under
   `src/server` would make it unimportable by plain Node, which cannot resolve
   Next's `server-only` marker package.
5. **Gate approval is per-production opt-in.** `advance_production_stop`
   re-reads the production immediately before acting and proceeds only when
   `agentCanApprove === true` (literal boolean). Otherwise it throws
   `ERR_AGENT_APPROVAL_DENIED` and sends no write. There is no override flag.
   The server-side advance route must enforce the same rule.
6. **The CLI reuses the client.** `scripts/lh-video-cli.mjs` supports `status`,
   `productions`, `library`, `submit` and `ledger`, with `--json` for machines.
   It is a debugging and automation surface, not a second implementation.

## Consequences

Positive:

- The app remains the only writer and validator; the bridge cannot drift from
  route behavior.
- The trust model is unchanged: loopback plus exact Origin, no new secrets.
- Agents get structured tool errors it can reason about, and gate approval is
  denied by default.
- No new dependency, no build step, no UI change.

Negative and risks:

- The bridge depends on routes that the productions module owns
  (`/api/productions`, `/ledger`, `/stops/{id}/advance`). Those shapes are
  documented in `docs/agent-bridge.md` and must be kept in sync.
- Node 22.18+ is required for type stripping; this matches the project's
  `engines` (`>=22.23.4`).
- Hand-written JSON-RPC must track MCP revisions. Only the stdio transport and
  the tools capability are implemented; resources, prompts and sampling are
  out of scope.
- `status` degrades gracefully when productions are not deployed yet, so a
  green status does not prove the production routes exist.

## Alternatives considered

- **HTTP MCP route inside Next.** Would require a new authenticated surface,
  CSRF/origin handling for a non-browser client and a long-lived endpoint. The
  stdio process keeps the agent boundary outside the app.
- **Model Context Protocol SDK.** Rejected for now to avoid a new runtime
  dependency and audit review for a small protocol subset.
- **Direct filesystem access to `STORAGE_ROOT`.** Rejected: it bypasses route
  validation, slug/asset checks and the origin guard, and couples the bridge to
  storage layout.
- **Global `AGENT_CAN_APPROVE` environment variable.** Rejected: it would let
  one deployment-wide switch approve every production, defeating the
  per-production opt-in.
