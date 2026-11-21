# Provider parity

Capability matrix for every provider registered in `src/server/providers/registry.ts`.
Updated 2026-11-20. The seven capability columns are derived from the runtime
catalog and asserted by `scripts/verify-comfyui-capabilities.mjs`; a catalog or
adapter change that moves a column must update this table in the same commit.

| Provider | Image | Video | Image refs | Video refs | Audio refs | Native audio | Multi-shot | v1 validation |
|---|---|---|---|---|---|---|---|---|
| `magnific` | yes | yes | yes | yes | yes | model-dependent | model-dependent | not validated in v1 (no live key) |
| `google` (AI Studio) | yes | yes (Omni) | yes | yes | yes (Omni input) | no | no | not validated in v1 (no live key) |
| `vertex` | yes | yes | yes | yes | no | model-dependent (Veo only) | no | not validated in v1 (no live credentials) |
| `ai-gateway` (Vercel) | yes | yes | yes | yes | yes | model-dependent | model-dependent | not validated in v1 (no live key) |
| `toapis` | yes | yes | yes | yes | yes | model-dependent | no | not validated in v1 (no live key) |
| `runware` | yes | yes | yes | yes | yes | model-dependent | model-dependent | not validated in v1 (no live key) |
| `comfyui` | yes (Qwen-Image template) | **no** — no video template shipped | no (shipped template has no media slot) | no | no | no | no | **live-verified 2026-11-20** (512×512, 16 steps, 16.4 s) |

## Notes

- The six built-in providers ship from upstream and are intentionally left untouched and unvalidated in v1; their rows describe what the adapters declare, not a live-tested result.
- `comfyui` is the only v1 target. Its catalog exposes image templates only; video needs a reviewed LTX graph validated against the GX10 inventory before an `ltx-i2v` template can exist.
- The GX10 has **no checkpoints** (`CheckpointLoaderSimple.ckpt_name` is empty), so the shipped image template is the split-loader `qwen-t2i` graph. The earlier `flux-t2i` checkpoint template was deleted because it could never execute on this host.
- "Native audio" means the capability declares an audio-generation control (`NATIVE_AUDIO_FIELDS` in `src/server/catalog/adapter-support.ts`); the adapter must translate it or the capability must not declare it. "Model-dependent" means some video models expose the control and others do not — it is a declaration audit, not a claim that the silent models are silent.
- "Multi-shot" means the capability declares the canonical `shot_type` toggle or a multi-shot vendor field (`multiShot`, `multiPrompt`, `multiClip` and their provider-prefixed forms). The same adapter-support matrix enforces it, so ComfyUI templates cannot claim multi-shot without translator support.
- "Model-dependent" features are exposed per model in the runtime catalog rather than per provider.
- Every capability in the runtime catalog must have an entry in `ADAPTER_SUPPORT`; the matrix test fails on an unknown provider, an unclassified audio/multi-shot field, or a control the adapter silently drops.
- Live verification for ComfyUI is done: one real still through the `qwen-t2i` template against `http://100.92.10.72:8188`, with `/queue` empty before submission — 512×512 at 16 steps in 16.4 s (2026-11-20).
