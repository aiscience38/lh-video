# NOTICE

LH Video is a fork of [open-higgsfield](https://github.com/TechBeme/open-higgsfield)
by Rafael Vieira (TechBeme), used under the MIT License (see `LICENSE`).

It also takes conceptual inspiration from
[OpenVideoHarness](https://github.com/ZLHad/OpenVideoHarness) (MIT) for the
production workflow ideas: human approval gates, storyboard review with
timecoded notes, automated QA checks, an asset ledger and budget holds.
No OpenVideoHarness code is vendored here.

Modifications in this fork include (non-exhaustive):

- `src/server/security/workspace-access.ts`: a `LH_VIDEO_LOCAL=true` flag that
  allows http loopback origins for the packaged desktop build; production
  deployments still require an https origin.
- Packaging under `packaging/` (WinForms launcher, NSIS installer, icon assets)
  and the bundled portable Node runtime used by the Windows desktop build.

"LH Video" and its icon are original to this fork.
