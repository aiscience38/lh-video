# Voice (text-to-speech)

M5 adds a server-side TTS surface with two providers: the hosted ElevenLabs
API and the local ComfyUI GX10. The UI can ask which providers are usable,
list voices, render one preview, and play the resulting MP3. Nothing in this
layer generates video, touches the library, or changes a production.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tts/providers` | Per-provider availability: `{ providers: { elevenlabs, comfyui } }`. Never throws. |
| `GET` | `/api/tts/voices?provider=elevenlabs\|comfyui` | `{ provider, voices: [{ id, name, language, previewUrl? }] }`. |
| `POST` | `/api/tts/preview` | `{ provider, voiceId, text, language?, speed? }` → `{ assetId, url, mimeType }`. |
| `GET` | `/api/tts/audio/{assetId}` | Serves the materialized MP3 inline. |

All routes use the workspace guard (`guardWorkspaceRequest`); `POST` is
origin-checked like every other mutating route. The audio route is read-only
and therefore also works in demo mode.

A successful preview writes one content-addressed file under
`<storage root>/tts/audio/<sha256>.mp3` and one row in the shared asset ledger
(`src/server/ledger/store.ts`). Identical bytes reuse the same asset id and
ledger row. The URL is derived from the hash, not from a user-supplied name.

## ElevenLabs

### Setup

```bash
export ELEVENLABS_API_KEY="..."
```

The key is **environment-only**. Unlike the image/video providers there is no
saved browser connection: synthesis is billed and must not be repointable
from the settings UI. When the variable is absent the availability row is:

```json
{ "configured": false, "reachable": false, "reason": "no_api_key" }
```

### Voice list

`GET https://api.elevenlabs.io/v1/voices` with the `xi-api-key` header. The
account voice library is the source of truth; entries expose `voice_id`,
`name`, `labels.language` and an optional `preview_url`. The list is cached
for 60 seconds per credential. A 401/403 is reported as
`{ configured: true, reachable: true, reason: "unauthorized" }`, so an invalid
key is distinguishable from an unreachable network.

### Synthesis

`POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}` with
`{ text, model_id, voice_settings? }`, default model `eleven_multilingual_v2`.
The response must be MP3 bytes (ID3 or an `0xFFFB` frame header), otherwise the
call fails as `malformed_result`.

Error taxonomy:

| Upstream | Adapter code | HTTP |
| --- | --- | --- |
| 401 / 403 | `auth` | 401 |
| 429 | `quota`, with `Retry-After` surfaced | 429 |
| other 4xx | `invalid_request` | 400 |
| network / 5xx | `upstream_down` | 503 |
| unusable 2xx body | `malformed_result` | 502 |

## ComfyUI (GX10)

### Setup

```bash
export COMFYUI_BASE_URL="http://100.92.10.72:8188"
# COMFYUI_API_KEY is optional on the LAN/Tailscale network.
```

The shipped template is
`src/server/catalog/comfyui-templates/qwen3-tts.json`:
`FB_Qwen3TTSVoiceDesign` (node 1) → `SaveAudioMP3` (node 2, `quality: 128k`).
It is intentionally **not** registered in the image/video catalog: that
template parser only accepts image/video outputs. The TTS adapter loads and
validates the JSON itself.

Actual node inputs differ slightly from the generic preview contract:

- `speaker` maps to the node's `instruct` input. `FB_Qwen3TTSVoiceDesign` has
  no fixed speaker list; it designs a voice from a natural-language
  instruction. The template ships five presets (`warm-narrator`,
  `bright-host`, `deep-documentary`, `soft-conversational`,
  `clear-announcer`) and `GET /api/tts/voices?provider=comfyui` lists them
  once `/object_info` confirms both required node classes exist.
- `language` maps to the node's documented language combo (`Auto`, `English`,
  …). Unknown values are rejected before submission.
- `speed` is a soft pace hint appended to the voice instruction (0.5–2.0).
  The node has no numeric speed input, so this is not a hard time-stretch.
- `text` is capped at 2,000 characters, matching the preview contract.

Discovery uses `GET /object_info`, cached for 60 seconds. Availability uses
`GET /system_stats` only, so a queue full of renders is still reported as
reachable. When `COMFYUI_BASE_URL` is unset the row is
`{ configured: false, reachable: false, reason: "no_base_url" }`; when
`/system_stats` fails it is
`{ configured: true, reachable: false, reason: "upstream_down" }`. Neither
case throws into the route.

Synthesis follows the same transport as the image/video adapter:
`POST /prompt` → poll `GET /history/{prompt_id}` → download
`GET /view?filename=&subfolder=&type=`. A `node_errors` envelope or an
`execution_error` carrying `node_errors` is a rejected request, never a
successful submission.

## Latency and cost

| | ElevenLabs | ComfyUI GX10 |
| --- | --- | --- |
| Network | Public internet | LAN / Tailscale |
| Typical latency | Sub-second to a few seconds for a short line, plus queueing on the account | Seconds while the model is resident; tens of seconds when the Qwen3-TTS weights load |
| Cost | Billed per character | 0 (local hardware) |
| Ledger row | `estimated: true`, quoted at ~$0.18 per 1,000 characters | `estimated: false`, `costUsd: 0` |
| Failure modes | 401/403, 429 with `Retry-After`, 5xx | Unreachable host, node errors, execution timeout |
| Voice source | Account voice library (`/v1/voices`) | Five shipped voice-design presets in the template |

The ElevenLabs figure is a planning quote, not an invoice. It is written with
`estimated: true` so `ledgerTotals` keeps it in the outstanding-hold pool
instead of settled spend. ComfyUI is the ledger's `FREE_PROVIDER_ID` and must
stay at cost 0.

## Offline behaviour

- `/api/tts/providers` always answers 200 with a reason per provider; a
  disconnected host or a missing key never produces a failed request.
- Voice listing and preview return a provider error (401/429/502/503) when the
  selected provider is unusable; they never fall back to another provider.
- Previously materialized MP3s remain playable offline: they are local,
  content-addressed files served by `/api/tts/audio/{assetId}` without any
  upstream call.
- No preview is queued while a provider is unreachable. The route does not
  cache or replay a failed synthesis.

## No automatic resubmission

A preview submits **exactly once**. There is no retry on network errors, 5xx,
malformed responses, or timeouts, because a request that reached ElevenLabs
may already have been billed and a request that reached ComfyUI may still be
queued or running.

- A ComfyUI history timeout leaves the prompt observable on the host. Check
  `GET /queue` / `GET /history` before deliberately trying again; do not let a
  client loop create duplicate renders.
- An ElevenLabs 429 surfaces `Retry-After`; the caller decides when to retry.
- The adapter never cancels or deletes a queued prompt on timeout. That is a
  separate, explicit operator action.

## Verification

```bash
node --test scripts/verify-tts-elevenlabs.mjs scripts/verify-tts-comfyui.mjs
```

Both suites mock `fetch`; no live ElevenLabs or ComfyUI synthesis is required.
`ELEVENLABS_API_KEY` is not configured on this host, and a live ComfyUI TTS
smoke is only allowed when `/queue` reports zero running and zero pending.
