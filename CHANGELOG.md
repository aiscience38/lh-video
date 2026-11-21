# Changelog

Notable changes to LH Video. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
Semantic Versioning, with the pre-1.0 caveat that minor versions may change
behavior.

## [0.1.0] — 2026-11-20

### Added

- **Fork baseline.** LH Video starts from
  [open-higgsfield](https://github.com/TechBeme/open-higgsfield) at commit
  `7d06c70`, used under the MIT License. The upstream remote is retained for
  monthly merges; upstream attribution is preserved in `LICENSE` and `NOTICE.md`.
- **Brand system.** Lamboy steel palette (charcoal `#0a0a0b` ground, brushed
  silver `#d9d9e2` accent), Playfair Display headings over Manrope body text, a
  new LH Video icon set and favicons, and the Qwen-Image brand board. The
  hardcoded lime accent was replaced throughout the composer and empty state.
- **ComfyUI provider.** A `GenerationProvider` adapter for ComfyUI 0.46.0 on the
  GX10 (`COMFYUI_BASE_URL`, optional bearer token), an API-format Qwen-Image
  text-to-image template (the host exposes no checkpoint, so the graph uses the
  split `UNETLoader`/`CLIPLoader`/`VAELoader` weights), catalog entries,
  reference upload and cancellation support, mocked API contract tests, and the
  provider parity matrix (`docs/providers/parity.md`).
- **Creative Library.** A filesystem-backed library for characters, scenes and
  storyboards: zod contract with slug rules, atomic path-contained writes,
  directory-scan store with trash, REST API (`/api/library`, `/api/scenes`), and
  the library home, navigation and character/scene UI. Documents live under
  `OPEN_HIGGSFIELD_STORAGE_DIR/library/` with one folder and one JSON document
  per entity; see `docs/library.md`.
- **Storyboards.** Storyboard entity, shot helpers and persistence, including
  ordered panels with estimated duration, keyframe assets and camera direction.
- **Windows desktop build.** Per-user NSIS installer and WinForms launcher with
  the bundled Node 22.23.5 runtime, data-folder picker, generated connection
  encryption key, and the `LH_VIDEO_LOCAL` loopback-origin flag.
- **Documentation.** Rewritten README with the provider list, Windows installer
  and upstream-merge policy, this changelog, and Docker-on-Windows plus
  backup/restore guidance in `docs/production.md`.

### Changed

- Rebranded titles, metadata, manifest and generated UI copy from
  Open-Higgsfield to LH Video; the package is now `lh-video` 0.1.0.
- Next.js pinned at 16.4.6 and `workflow` at 5.7.1 (see Security below).

### Security

- Upgraded Next.js **16.4.3 → 16.4.6** for a published security advisory, and
  `workflow` **5.3.0 → 5.7.1** because the 5.3.0 tarball was missing
  `runtime/start.js`. The dependency override check now skips consumers that are
  not installed, and `dist/` build output is excluded from lint.
