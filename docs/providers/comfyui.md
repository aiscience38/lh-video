# ComfyUI provider (GX10)

Verified 2026-11-20 from the LH Video host.

## Endpoint

- Base URL: `http://100.92.10.72:8188` (Tailscale). No auth header required on the LAN.
- Health: `GET /system_stats`
- Submit: `POST /prompt` with `{ "prompt": <api-format graph>, "client_id": "<uuid>" }` → `{ prompt_id, node_errors }`
- Observe: `GET /history/{prompt_id}` → `outputs.<node>.images[]` when complete
- Bytes: `GET /view?filename=&subfolder=&type=output`
- Upload references: `POST /upload/image` (multipart) → `{ name }`
- Cancel: `POST /queue` with `{ "delete": [prompt_id] }`

## GX10 facts (system_stats)

- comfyui_version: 0.46.0 (frontend 1.59.10, templates 0.11.112)
- OS: Linux, RAM total ~130.6 GB, free ~27 GB at check time
- Node classes available: 2277; includes `CheckpointLoaderSimple`, `SaveImage`, `LoadImage`
- LTX node classes present: `ModelMergeLTXV`, `LTXVLatentUpsampler`, `LTXVAudioVAELoader`, `LTXVAudioVAEEncode`, `LTXVAudioVAEDecode` (full LTX graph support requires checking loader/sampler classes per workflow)

## Host tools

- ffmpeg n9.0.1 present on the LH Video host (needed by shot extension and QA checks).

## Notes

- Do not queue jobs while a Canon Foundry render is running; check `GET /queue` first.
- No credentials are stored in this document.

## Custom workflow import (LAM-14)

The ComfyUI provider settings expose **Import workflow**. It accepts the
API-format prompt JSON that ComfyUI's *Save (API Format)* action produces, so a
reviewed graph does not need a source edit and a rebuild.

- `GET /api/providers/comfyui/workflows` returns the node classes from
  `GET /object_info`. Only class names are cached in
  `comfyui-object-info.json` under the storage root; repeat imports reuse the
  cache and `?refresh=1` refetches after installing nodes. A missing connection
  or an unreachable host fails the request; nothing is written.
- `POST /api/providers/comfyui/workflows` re-parses the graph (bounded size,
  API-format node ids, link targets, `class_type` and `inputs`), rejects classes
  that are not in the cached allowlist, and requires the mapping form to point
  every exposed parameter at an existing literal input. Prompt is required;
  `negative_prompt`, `width`, `height`, `seed` and `cfg` are optional.
- The output node must be `SaveImage` or `SaveAnimatedWEBP`. Imported templates
  expose no media slot in v1: reference uploads stay on reviewed templates.
- A successful import stores the template beside the provider config and creates
  the `comfyui:<template-id>` catalog model **disabled and unverified**, per the
  custom-model policy. The model is hidden in the Studio until it is enabled in
  the provider's model list, and it still runs through the unchanged adapter.
- `DELETE /api/providers/comfyui/workflows` removes the template and its catalog
  model. Importing never calls `/prompt`, `/upload/image` or `/queue`.
