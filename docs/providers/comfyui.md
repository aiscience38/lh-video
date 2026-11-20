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
