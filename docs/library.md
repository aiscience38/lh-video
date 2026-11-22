# Creative Library contract

The Creative Library stores characters, scenes and storyboards as plain JSON
documents on the same persistent disk as media. It is deliberately small: the
filesystem is the source of truth, there is no database table, and media bytes
stay in the existing uploads/downloads storage.

Implementation:

- `src/server/library/contract.ts` — zod schemas, slug rules, kind guards.
- `src/server/library/atomic.ts` — path containment, atomic writes, validated reads.
- `src/server/library/store.ts` — directory scan/cache, CRUD, trash.
- `src/app/api/library/route.ts` — list and create.
- `src/app/api/library/[kind]/[id]/route.ts` — read, update, delete.

## Folder layout

`STORAGE_ROOT` comes from `OPEN_HIGGSFIELD_STORAGE_DIR` (see
`src/server/config/storage-paths.ts`). The library lives under it:

```
STORAGE_ROOT/
  uploads/                              existing media, referenced by asset id
  downloads/                            existing media, referenced by asset id
  EXPORTS/                              backup archives and manifests (never scanned)
    library-2026-11-20T18-30-00-000Z.tar.gz
  library/
    characters/
      ana/
        character.json
    scenes/
      opening/
        scene.json
    storyboards/
      teaser/
        storyboard.json
    .trash/
      characters/
        ana-2026-11-20T18-30-00-000Z/
          character.json
```

Rules:

- One entity is exactly one folder named by its slug. The folder contains one
  document: `character.json`, `scene.json` or `storyboard.json`.
- The document is the entity itself; there is no wrapper/version envelope.
- Folder name and document `slug` must match. The store refuses to list a
  document whose `kind` or `slug` disagrees with its location.
- Unknown document fields are dropped when the store rewrites an entity.
- Entity ids are UUIDs and are immutable. Slugs are immutable after creation.
- `library/.trash` is reserved for deleted entity folders and is never scanned
  as a kind directory.

## Slugs

Slugs are derived from `name` with `slugify()`:

1. Unicode NFKD normalization, combining marks removed.
2. Lowercase.
3. Every run of characters outside `[a-z0-9]` becomes a single `-`.
4. Leading and trailing `-` are removed; the result is cut to 49 characters.

The authoritative pattern is `^[a-z0-9][a-z0-9-]{1,48}$`. Consequences:

- Minimum two characters. A one-character name (`"A"`) or a name with no ASCII
  letters/digits (`"李"`, `"!!!"`) has no valid slug, so creation fails with
  `ERR_LIBRARY_INVALID`. Rename the entity to something slugifiable.
- Maximum 49 characters; longer names are truncated.
- Uppercase, spaces, dots, slashes, backslashes and `..` cannot appear.
- Windows device names are reserved even in lowercase: `con`, `prn`, `aux`,
  `nul`, `clock$`, `com1`–`com9`, `lpt1`–`lpt9`. Creating an entity whose slug
  is exactly one of these fails with `ERR_LIBRARY_INVALID`.
- Trailing dots and spaces are impossible by construction.

Collision resolution is store-owned: the first entity gets the base slug
(`ana`), then `ana-2`, `ana-3`, and so on. Suffixing truncates the stem so the
final slug still fits 49 characters. Collision detection uses exclusive
`mkdir` of the slug folder, so two concurrent creations cannot claim the same
folder. `slugify()` itself never resolves collisions and may return a value
that `isValidSlug()` rejects.

## Entity fields

`LibraryKind` is `character`, `scene` or `storyboard`. Every entity has
`id` (UUID), `kind` (literal), `name` (1–120 characters), `slug`,
`createdAt` and `updatedAt` (ISO-8601 UTC datetimes).

Character:

| Field | Contract |
| --- | --- |
| `notes` | string, max 4000, default `""` |
| `ingredientKind` | `character`, `prop` or `style`, default `character` (Google-Flow-style ingredient role) |
| `assetIds` | asset ids, default `[]` |
| `voice` | voice profile object, default `{ "provider": "none", ... }` (see below) |

Scene:

| Field | Contract |
| --- | --- |
| `shots` | ordered shot array, default `[]` |

Scene shot (`Shot`):

| Field | Contract |
| --- | --- |
| `id` | UUID |
| `order` | integer ≥ 0 |
| `prompt` | string, default `""` |
| `capabilityId` | string or `null`, default `null` |
| `params` | JSON object, default `{}` |
| `assetIds` | asset ids, default `[]` |
| `taskIds` | task ids, default `[]` |

Storyboard:

| Field | Contract |
| --- | --- |
| `productionId` | string (1–128 characters) or `null`, default `null` |
| `shots` | ordered panel array, default `[]` |

Storyboard shot:

| Field | Contract |
| --- | --- |
| `id` | UUID |
| `order` | integer ≥ 0 |
| `intent` | string, default `""` |
| `seconds` | positive number, default `3` (estimate, not a guarantee) |
| `keyframeAssetId` | asset id or `null`, default `null` |
| `camera` | string, default `""` |

Asset and task ids are opaque: `^[A-Za-z0-9_-]{1,128}$`. The library does not
verify that a referenced asset exists; that check belongs to the media layer
when the asset is actually used.

## Character voice profile

`voice` is optional in the UI but always present in a stored character document.
Documents written before this field existed parse with the complete default
profile, so reads and listings never fail:

```json
{
  "provider": "none",
  "voiceId": null,
  "language": "en",
  "settings": {},
  "previewAssetId": null
}
```

| Field | Contract |
| --- | --- |
| `provider` | `elevenlabs`, `comfyui` or `none`, default `none` |
| `voiceId` | provider voice identifier, 1–128 characters, or `null`, default `null` |
| `language` | BCP-47-style language tag, 2–35 characters, default `en` |
| `settings` | opaque JSON object for provider tuning, default `{}` |
| `previewAssetId` | asset id of the last generated preview, or `null`, default `null` |

Rules:

- `provider: "none"` means no voice is attached; the other fields stay at their
  defaults (`voiceId` and `previewAssetId` are `null`).
- Provider availability is **not** stored. The UI asks the TTS server
  (`GET /api/tts/providers`) for `{ configured, reachable, reason }` per
  provider and only enables providers that are both configured and reachable.
  A character may therefore keep a voice whose provider is temporarily down.
- `previewAssetId` is an opaque asset id, like every other asset reference: the
  library never checks that the preview still exists.
- `POST /api/library` accepts a partial `voice` object; missing fields take the
  defaults above.
- `PATCH /api/library/character/[id]` replaces the **whole** voice profile. The
  update schema has no defaults, so send all five fields when changing a voice
  (the UI always does). Omitting `voice` leaves the stored profile untouched.
- An unknown provider, an empty or over-long `language`, a `voiceId` longer than
  128 characters, a non-object `settings` or a malformed `previewAssetId` is
  `400 ERR_LIBRARY_INVALID`.

## Media rule

Media is never copied, moved or deleted by the library. Characters, scenes and
storyboard panels reference ids in `uploads/` / `downloads/` (or the configured
object store). Deleting a library entity only renames its JSON folder into
`.trash`; the same asset can remain referenced by other entities. Backup and
retention for media are unchanged by this feature.

## Folder import

The characters page offers "Import folder", which selects a directory through
an `<input type="file" webkitdirectory>` and maps the selection like this:

- Every first-level subfolder becomes a character named after the folder.
- Images directly inside the selected folder go to one character named after
  the selected folder.
- Images nested deeper inside a first-level folder stay with that folder's
  character. Non-images are skipped and produce one report line each.
- Images are uploaded in natural filename order (`2.png` before `10.png`)
  through `POST /api/library/assets`; the resulting asset ids are appended to
  an existing character with the same name or slug, or used to create a new
  character with `POST /api/library`.
- Asset ids are content addressed, so importing the same folder twice uploads
  the same bytes to the same ids and the merge adds nothing.

## Atomic writes

`writeJsonAtomic(target, value)`:

1. Reject any target outside `STORAGE_ROOT` (lexical `path.resolve` check).
2. Create the parent directories, then verify the parent's canonical real path
   is still inside `STORAGE_ROOT` (blocks symlink/junction escapes).
3. Serialize the complete document in memory; a serialization failure never
   touches the target.
4. Open a dot-prefixed temp file in the same directory
   (`.character.json.<uuid>.tmp`) with exclusive create.
5. Write, `fsync` the file handle, close it.
6. `rename` the temp file over the target (`MoveFileEx` replace semantics on
   Windows, `rename(2)` on POSIX).
7. Flush the directory entry (`syncDirectory`; a no-op on Windows, where NTFS
   journals the rename and directory handles cannot be flushed).

A reader therefore sees either the old document or the new one, never a
partial file. A failed write removes its temp file and leaves the original
intact. `readJson(target, schema)` applies the same containment check to the
canonical file path, rejects symlinks that resolve outside the root, parses
JSON, and validates against the kind schema. Missing file →
`ERR_LIBRARY_NOT_FOUND`; corrupt JSON or schema mismatch → `ERR_LIBRARY_INVALID`.

Atomicity is per document. There is no multi-entity transaction: creating or
renaming two entities is two independent atomic operations. Ordering is
serialized per kind inside one process; across processes, exclusive `mkdir` and
rename-over are the only coordination primitives. Do not hand-edit a document
in place; write a temp file and rename it, or use the API.

## Cache

`listEntities`, `findEntityBySlug` and `readEntity` share a per-kind in-memory
cache keyed by the kind directory's `mtimeMs`, scoped to the process. Every
store mutation invalidates its kind explicitly. External writers that follow
the atomic-rename rule bump the directory mtime and are picked up on the next
scan. An in-place file edit that does not change the directory entry can be
missed until the process restarts; that is another reason to write atomically.

## Trash and deletion

Deleting an entity:

- renames `library/<kindFolder>/<slug>/` to
  `library/.trash/<kindFolder>/<slug>-<timestamp>/`, where the timestamp is
  `new Date().toISOString()` with `:` and `.` replaced by `-` (Windows-safe),
  for example `ana-2026-11-20T18-30-00-000Z`;
- appends `-2`, `-3`, … if a folder with that name already exists;
- returns `false` when the entity id is unknown;
- never deletes or modifies media.

There is no automatic purge. `.trash` grows until an operator removes folders.
Deleting from `.trash` is permanent and remains an operator decision.

### Restore from trash

1. Stop the server (or at least avoid concurrent writes) so the kind cache and
   in-flight writes do not race the restore.
2. Move `.trash/<kindFolder>/<name>/` back to `library/<kindFolder>/<slug>/`.
3. The folder name must equal the document's `slug`. If the original slug is
   now taken by another entity, pick a new free slug, rename the folder to it,
   and update `slug` and `updatedAt` in the document. Slug immutability is an
   API rule; an operator restore is an explicit migration.
4. Confirm with `GET /api/library/<kind>/<id>` or `findEntityBySlug`.

## Backup

`POST /api/library/export` archives `library/` with the operating system's tar
into `STORAGE_ROOT/EXPORTS/library-<timestamp>.tar.gz`, where the timestamp is
`new Date().toISOString()` with `:` and `.` replaced by `-`. The route is
guarded like every other mutation, creates `EXPORTS/` through the storage
containment check, and only accepts generated `library-*.tar.gz` /
`library-*.manifest.json` names inside that folder.

When tar cannot be spawned on the host (for example a minimal container), the
route writes the entity documents to `EXPORTS/library-<timestamp>.manifest.json`
and returns `mode: "manifest"` with a note instead of failing. A host can point
at another tar binary with `LIBRARY_TAR_COMMAND`; on Windows the System32
`tar.exe` is preferred over a PATH hit. Both modes report the absolute output
path in the JSON response (`{ ok, mode, path, directory, count, ... }`), which
the library overview shows after "Create backup".

Back up `STORAGE_ROOT` as a unit: `library/`, `uploads/`, `downloads/` (or the
configured object store) and `tasks_history.json`. A database deployment must
back up the database alongside media. `.trash` may be included if deleted
entities must be recoverable, and may be excluded to keep backups small.

Because writes are atomic, a live filesystem snapshot is usually consistent per
document. For a strictly consistent library across multiple docs, quiesce
writes or snapshot the whole storage volume. Restoring media and library from
different points in time can leave asset ids dangling; the library tolerates
that (ids are opaque) but previews will fail until the media is restored.

To restore: stop the process, replace `library/` (and media if needed), then
start the process. The mtime cache is process-local, so a restart always
re-reads the directory tree. A document that fails validation makes
`listEntities` fail with `ERR_LIBRARY_INVALID` rather than being silently
hidden; repair or move the folder out of the kind directory.

## HTTP API

All routes run on the Node runtime, call `guardWorkspaceRequest`, and use the
bounded JSON reader (`readBoundedJson`, 256 KiB body limit). Responses carry
`Cache-Control: private, no-store` and the workspace security headers.

### `GET /api/library`

Query parameters:

- `kind` (optional): `character`, `scene` or `storyboard`. Anything else is
  `400 ERR_LIBRARY_KIND`.
- `q` (optional): case-insensitive substring match on `name` or `slug`, max
  120 characters; longer is `400 ERR_LIBRARY_INVALID`.

Response `200`: `{ "entities": [...], "count": n }`, sorted by name then slug.

### `POST /api/library`

Body: flat create input including `kind`:

```json
{ "kind": "character", "name": "Ana", "notes": "Lead", "assetIds": ["asset_1"] }
```

Server-owned `id`, `slug`, `createdAt`, `updatedAt` are ignored/derived.
Response `201`: `{ "entity": { ... } }`.

### `GET /api/library/[kind]/[id]`

Response `200`: `{ "entity": { ... } }`; unknown id → `404 ERR_LIBRARY_NOT_FOUND`;
unknown kind → `400 ERR_LIBRARY_KIND`.

### `PATCH /api/library/[kind]/[id]`

Body: any mutable subset (`name`, `notes`, `assetIds`, `voice` for characters;
`name`, `shots` for scenes; `name`, `productionId`, `shots` for storyboards).

`id`, `kind` and `slug` are immutable: sending the current values is accepted,
sending different values is `400 ERR_LIBRARY_INVALID`. `createdAt` is likewise
immutable; `updatedAt` is always regenerated (strictly later than the previous
value). Response `200`: `{ "entity": { ... } }`.

### `DELETE /api/library/[kind]/[id]`

Empty body required. Moves the folder to `.trash` and returns `200
{ "ok": true }`; unknown id → `404 ERR_LIBRARY_NOT_FOUND`.

### Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `ERR_LIBRARY_KIND` | 400 | kind is not character/scene/storyboard |
| `ERR_LIBRARY_INVALID` | 400 | schema, slug, path, body shape or immutable-field violation |
| `ERR_LIBRARY_NOT_FOUND` | 404 | no entity with that id/slug |
| `ERR_LIBRARY_CONFLICT` | 409 | no free slug after the retry bound |
| `ERR_LIBRARY_UNAVAILABLE` | 503 | unexpected storage/filesystem failure |

Request-body failures from `readBoundedJson` keep their existing codes
(`ERR_CONTENT_TYPE` 415, `ERR_REQUEST_TOO_LARGE` 413, `ERR_INVALID_JSON` 400,
`ERR_REQUEST_INVALID` 400); access failures keep the workspace guard's codes.

## Out of scope for this slice

- UI components and client state.
- Copying, transcoding or deleting media.
- Validating that referenced asset/task ids exist.
- Cross-entity referential integrity (a storyboard pointing at a deleted scene).
- Pagination; listing reads every folder of the requested kind.
- Multi-process locking beyond atomic rename/exclusive mkdir.
