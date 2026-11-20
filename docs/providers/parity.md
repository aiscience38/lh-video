# Provider parity

Capability matrix for every provider registered in `src/server/providers/registry.ts`.
Updated 2026-11-20.

| Provider | Image | Video | Image refs | Video refs | Audio refs | Native audio | Multi-shot | v1 validation |
|---|---|---|---|---|---|---|---|---|
| `magnific` | yes | yes | yes | no | no | no | no | not validated in v1 (no live key) |
| `google` (AI Studio) | yes | yes (Veo) | yes | yes | no | model-dependent | model-dependent | not validated in v1 (no live key) |
| `vertex` | yes | yes | yes | yes | no | yes (`generateAudio`) | no | not validated in v1 (no live credentials) |
| `ai-gateway` (Vercel) | yes | yes | yes | no | no | no | no | not validated in v1 (no live key) |
| `toapis` | yes | yes | yes | yes | yes | model-dependent | model-dependent | not validated in v1 (no live key) |
| `runware` | yes | yes | yes | yes | no | model-dependent | model-dependent | not validated in v1 (no live key) |
| `comfyui` | yes (FLUX template) | **no** — no video template shipped | yes (template media slots) | no | no | no | no | **mocked tests only**; live smoke pending LAM-15 |

## Notes

- The six built-in providers ship from upstream and are intentionally left untouched and unvalidated in v1; their rows describe what the adapters declare, not a live-tested result.
- `comfyui` is the only v1 target. Its catalog exposes image templates only; video needs a reviewed LTX graph validated against the GX10 inventory before an `ltx-i2v` template can exist.
- "Native audio" means the capability declares an audio-generation control; the adapter must translate it or the capability must not declare it (enforced by the adapter-support matrix test in LAM-21).
- "Model-dependent" features are exposed per model in the runtime catalog rather than per provider.
- Live verification for ComfyUI is LAM-15: one real still through the FLUX template against `http://100.92.10.72:8188`, with `/queue` checked first.
