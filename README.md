<div align="center">
  <img src="public/icon.svg" alt="LH Video icon" width="112" />

  # LH Video

  **A local-first, self-hosted studio for AI image and video generation.**

  One capability-driven workspace over a ComfyUI backend on the GX10, with the
  inherited multi-provider catalog for everything else.

  <p>
    <a href="docs/architecture.md">Architecture</a>
    |
    <a href="#features">Features</a>
    |
    <a href="#providers">Providers</a>
    |
    <a href="#quick-start">Quick Start</a>
    |
    <a href="#windows-installer">Windows Installer</a>
  </p>

  <p>
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-d9d9e2" /></a>
    <a href="https://nextjs.org"><img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16.4.6-black?logo=next.js" /></a>
    <a href="https://www.typescriptlang.org"><img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" /></a>
  </p>
</div>

LH Video is a fork of [open-higgsfield](https://github.com/TechBeme/open-higgsfield)
(MIT), rebranded and extended for a local production pipeline. Generations run
on a ComfyUI instance you control; the studio adds a creative library of
characters, scenes and storyboards on top of the upstream task, gallery and
provider layers.

Each deployment is one operator-owned workspace. There is no built-in login:
anyone who can reach the URL shares its history, settings and provider quota
unless generation is disabled.

## Features

- **ComfyUI first**: Qwen-Image text-to-image through a reviewed API-format
  template on the GX10 (split loaders — the host has no checkpoint), with the
  same normalized task, progress and gallery flow as hosted providers.
- **Capability-driven studio**: aspect ratio, resolution, seed, CFG, style and
  reference controls come from model descriptors, not hardcoded per-provider UI.
- **Creative Library**: characters, scenes and storyboards stored as plain JSON
  on the same persistent disk as media — no database table, no opaque format.
- **Background generation**: submit and keep working; task progress and errors
  are tracked per task, and observation survives a page reload.
- **Encrypted connections**: multiple connections per provider, priorities and
  model visibility, encrypted with `PROVIDER_CONFIG_ENCRYPTION_KEY` on the server.
- **Bring your own keys**: provider credentials stay server-side; nothing secret
  is exposed through `NEXT_PUBLIC_*`.
- **Three interfaces**: English, Brazilian Portuguese and Spanish, with a
  persistent language selector.
- **Self-hosted anywhere**: Windows desktop installer, Docker Compose, plain
  Node.js, or Vercel for the distributed profile.
- **MIT licensed**, with upstream attribution preserved in [NOTICE.md](NOTICE.md).

## Providers

ComfyUI is the v1 target. The six providers below it are inherited from upstream,
intentionally left untouched, and not live-validated in v1 — their rows describe
what the adapters declare.

| Provider | Images | Videos | Credentials |
| --- | ---: | ---: | --- |
| **ComfyUI (GX10)** | Qwen-Image template | not yet — no reviewed LTX template | `COMFYUI_BASE_URL`, optional `COMFYUI_API_KEY` |
| Magnific | yes | yes | `MAGNIFIC_API_KEY` |
| Google AI Studio | yes | yes (Veo) | `GEMINI_API_KEY` |
| Google Vertex AI | yes | yes | Google Cloud credentials |
| Vercel AI Gateway | yes | yes | `AI_GATEWAY_API_KEY` |
| ToAPIs | yes | yes | `TOAPIS_API_KEY` |
| Runware | yes | yes | `RUNWARE_API_KEY` |

The full capability matrix — image/video support, reference slots, native audio,
multi-shot and validation status — is in [provider parity](docs/providers/parity.md).
ComfyUI's endpoint, template and GX10 inventory are documented in
[ComfyUI provider](docs/providers/comfyui.md). ComfyUI tests are mocked; the live
still through the Qwen-Image template was verified on 2026-11-20 (512×512, 16
steps, 16.4 s).

Model availability, pricing, quotas and preview access are controlled by each
upstream provider.

## Requirements

- **Node.js 22.23.5** (pinned in `.node-version`; the Windows desktop build
  bundles the same runtime). Node 24 is not supported by the pinned engine range.
- **npm 10+**.
- **ffmpeg** on `PATH` for shot extension and QA checks.
- **Playwright browsers** for the browser suite:
  `npx playwright install --with-deps chromium firefox webkit`.
- A reachable ComfyUI endpoint for local generation, or credentials for one of
  the hosted providers.
- For distributed deployments: Vercel Blob or S3 credentials for durable media,
  and PostgreSQL for task history. See [production](docs/production.md).

## Quick start

```bash
git clone https://github.com/aiscience38/lh-video.git
cd lh-video
npm ci
cp .env.example .env.local
```

Generate a connection-encryption key and put it in `.env.local`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

```dotenv
PROVIDER_CONFIG_ENCRYPTION_KEY=<paste-the-generated-value>
```

This key encrypts provider credentials saved through the interface. Keep it
stable across restarts and back it up separately from the data folder. Replacing
it makes existing saved connections undecryptable.

Point the app at ComfyUI (the value below is the GX10 on Tailscale):

```dotenv
COMFYUI_BASE_URL=http://100.92.10.72:8188
# COMFYUI_API_KEY=            # optional; sent as a bearer token
```

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), choose a locale, then enable a
ComfyUI model in **Providers**. Development binds to `127.0.0.1`; credential-free
development must stay local.

Never put provider credentials in `NEXT_PUBLIC_*` variables. Saved connections
take precedence over environment credentials, and disabling every connection for
a provider removes its models from the Studio.

## Windows installer

The desktop build ships as a per-user NSIS installer:

```text
dist\LH Video Setup 0.1.0.exe
```

`dist/` is build output and is not committed. The installer writes the
application, the bundled Node 22.23.5 runtime and the WinForms launcher to
`%LOCALAPPDATA%\LH Video`, creates Start Menu and desktop shortcuts, and requires
no administrator rights.

Data folder behaviour:

- On first launch the launcher asks for a data folder, defaulting to
  `Documents\LH Video Data`. The choice is stored in
  `%LOCALAPPDATA%\LH Video\config.ini` together with a generated
  `encryptionKey`; **Open data folder** in the launcher opens it in Explorer.
- The launcher sets `OPEN_HIGGSFIELD_STORAGE_DIR` to that folder,
  `LH_VIDEO_LOCAL=true` (permits the loopback HTTP origin), the single-process
  profile, and `GENERATION_ENABLED=true`, then serves the app on a free
  `127.0.0.1` port and opens the browser.
- Task history, `uploads/`, `downloads/` and `library/` all live in the data
  folder. Back it up together with `config.ini`.
- Uninstalling removes `%LOCALAPPDATA%\LH Video` — including `config.ini` and
  therefore the encryption key — but leaves the chosen data folder in place.
  Copy `config.ini` somewhere safe before uninstalling if you need to decrypt
  saved connections later.

See [production: backup and restore](docs/production.md#backup-and-restore) for
the full procedure, including the Docker volume equivalent.

## Docker

Reuse the `.env.local` configured above, then:

```bash
docker compose up --build -d
```

Compose builds the standalone image, publishes `127.0.0.1:3000`, and keeps
history and media in the `lh-video-data` volume mounted at `/app/data`
(`OPEN_HIGGSFIELD_STORAGE_DIR`). Put an HTTPS reverse proxy in front of it and
review the [single-process profile](docs/production.md#persistent-single-process)
before enabling real work. Windows-specific steps, container networking to
ComfyUI, and backup/restore commands are in
[production: Docker on Windows](docs/production.md#docker-on-windows).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server on `127.0.0.1` |
| `npm run build` | Create a production build |
| `npm start` | Serve the production build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run strict TypeScript checks |
| `npm test` | Run `scripts/verify-*.mjs` unit and integration regressions |
| `npm run test:e2e` | Run the Playwright suite (4 projects) |
| `npm run check` | Audit, lint, typecheck, tests, build and browser tests |
| `npm run audit:dependencies` | Dependency policy and advisory audit |

The browser suite starts its own HTTPS workspace on loopback ports 3110 and 3111
with temporary storage, synthetic credentials and generation disabled. It must
never be pointed at a deployed workspace. See
[verification](docs/architecture.md#verification).

## Merging upstream

The fork tracks `TechBeme/open-higgsfield` as `upstream` and merges monthly, so
security and provider fixes keep flowing in. Never push to `upstream`.

```bash
git fetch upstream
git merge upstream/main
```

Conflict policy:

- **Upstream wins for inherited behavior**: shared route handlers, the six
  upstream provider adapters, migrations, and upstream documentation. Take
  upstream's version, then re-apply fork changes on top.
- **Fork keeps ownership of**: `packaging/`, brand assets and the steel palette,
  the ComfyUI provider and catalog templates, the library and storyboard modules,
  the `LH_VIDEO_LOCAL` loopback flag in `workspace-access.ts`, and the fork
  sections of `README.md`, `NOTICE.md`, `CHANGELOG.md`, `AGENTS.md` and
  `CLAUDE.md`.
- **Additive modules stay additive.** Prefer new files over edits to shared ones.
  Where upstream and the fork both touch a registry or catalog file, keep both
  registrations in upstream order and re-run the provider/architecture tests.
- **Never hand-merge `package-lock.json`.** Take one side, run `npm install` to
  regenerate, review the lockfile diff, and commit it separately.
- **Locale dictionaries are a union.** Keep every upstream key, add fork keys to
  all three dictionaries, then run `scripts/verify-i18n.mjs` (part of `npm test`).
- After resolving conflicts: `npm ci && npm run check`. If packaging or brand
  assets changed, smoke the installer build before release.

## Documentation

- [Architecture](docs/architecture.md): layers, request lifecycle and verification
- [Creative Library](docs/library.md): characters, scenes, storyboards and slugs
- [Providers](docs/providers.md): credentials, behavior and extension points
- [Provider parity](docs/providers/parity.md): capability matrix by provider
- [ComfyUI](docs/providers/comfyui.md): GX10 endpoint, templates and inventory
- [Production](docs/production.md): HTTPS, profiles, Docker, backup and recovery
- [Deployment](docs/deployment.md): Vercel, Docker and Node.js
- [Background execution](docs/background-execution.md): Workflows, observation and costs

## Contributing

1. Read [CONTRIBUTING.md](CONTRIBUTING.md).
2. Create a worktree and a focused branch.
3. Write the failing regression first, then the change.
4. Run `npm run check` before opening a pull request.

## Security

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md)
and never include provider credentials, private generated media or personal data
in a report.

## Disclaimer

LH Video is an independent open-source project. It is not affiliated with,
endorsed by or sponsored by Higgsfield AI, Magnific, Google, Vercel, ComfyUI or
any model provider. Product and model names belong to their respective owners.
Availability, pricing, quotas, APIs and capabilities may change upstream.

You are responsible for provider costs, generated content, deployment security
and compliance with provider terms and applicable law.

## License

Released under the [MIT License](LICENSE). Upstream attribution and fork
modifications are recorded in [NOTICE.md](NOTICE.md); changes are listed in
[CHANGELOG.md](CHANGELOG.md).
