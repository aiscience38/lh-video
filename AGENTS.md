# LH Video — agent router

Read this before changing code. It is the short version; `docs/` holds the long version.

## What this is

LH Video is a self-hosted, Flow/Higgsfield-style generation studio forked from
[TechBeme/open-higgsfield](https://github.com/TechBeme/open-higgsfield) (MIT, baseline
`7d06c70`, tag `baseline-upstream-7d06c70`). It runs a Next.js 16 app locally, drives a
ComfyUI backend on the GX10 plus the upstream providers, and adds a filesystem-backed
creative library (characters, scenes, storyboards) and an OVR-style production harness.

## Where things live

- `docs/architecture.md` — request lifecycle, provider registry, task model.
- `docs/library.md` — the on-disk creative library contract. Authoritative for entities.
- `docs/providers/comfyui.md` — the ComfyUI contract actually verified against the GX10.
- `docs/providers/parity.md` — provider × feature matrix and v1 validation status.
- `src/server/providers/` — one adapter per provider; registry is `registry.ts`.
- `src/server/library/` — contract, atomic writer, store; storyboards and scenes build on it.
- `src/server/productions/` — pipeline stops and human gates.
- `src/server/qa/` and `src/server/ledger/` — ffprobe checks and the asset ledger/budget guard.
- `packaging/` — WinForms launcher, NSIS installer, icons, build scripts.
- `tests/e2e/` — Playwright specs; `scripts/verify-*.mjs` — node:test regression scripts run by `npm test`.

## Hard rules

1. Never auto-resubmit a possibly-paid provider job. Submit once, persist the operation,
   and let an operator reconcile.
2. Never put secrets in `NEXT_PUBLIC_*`. Provider keys stay server-side, encrypted at rest.
3. Every provider adapter implements `GenerationProvider` from `src/providers/types.ts`.
4. Shared files (`registry.ts`, `definitions.ts`, catalog indexes, i18n dictionaries) get
   append-only edits so `git merge upstream/main` stays cheap. New code goes in new files.
5. TDD: write the failing `scripts/verify-*.mjs` or e2e spec first; run `npm test`,
   `npm run typecheck`, `npm run lint`, and `npm run check` before merging.
6. Preserve upstream `LICENSE`; credit upstream and OpenVideoHarness in `NOTICE.md`.
7. Merge `upstream/main` monthly; resolve conflicts by keeping our append-only additions.
8. Library entities reference media by asset id; never copy bytes into `library/`.
9. Paid providers require a budget check (`checkBudget`); ComfyUI is local and cost 0.

## Milestones

- M0 Foundation — fork, Node 22 pin, baseline green, ComfyUI connectivity. Done.
- M1 ComfyUI adapter — provider, catalog/templates, parity, live smoke. Nearly done.
- M2 Flow creative layer — library (characters/scenes/storyboards), reference picker,
  camera presets, gallery ↔ library actions, folder import.
- M3 Production harness — productions/stops, gates, notes + REVIEW.md, revision compare,
  QA checks, ledger/budget, MCP + CLI bridge.
- M4 Hardening — i18n, e2e/a11y sweep, Docker, docs, installer.

## Commands

```bash
npm ci                 # install (Node 22.23.5 — the repo pins .node-version)
npm run dev            # http://127.0.0.1:3000 (needs .env.local)
npm run build          # production build (standalone output)
npm test               # node:test regression scripts
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run test:e2e       # Playwright, 4 projects (needs a build; ports 3110/3111)
npm run check          # audit + lint + typecheck + test + build + e2e
```

Windows desktop build: `packaging/installer.nsi` via `makensis`; the launcher runs the
bundled Node 22 standalone server on a loopback port with `LH_VIDEO_LOCAL=true` and opens
the browser. Data lives in the folder chosen at first run (`%LOCALAPPDATA%/LH Video/config.ini`).
