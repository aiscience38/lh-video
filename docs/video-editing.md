# Video editing (v2v) — capability contract

## Current state

The workspace can render, download, scrub, extend and review generated videos,
but it does **not** support true video-to-video editing. No connected model
declares `video_edit`, so the video detail page shows a disabled editing-model
picker with an explanation. The composer still accepts an edit request and
stores it as a task-linked review note; it never submits a provider job and
never claims that an edit was rendered.

Capabilities that accept a video reference, motion video or a last frame are
**not** editing support. A reference informs generation; an edit target is the
source that must be transformed.

## Declaring support

A capability opts in with the optional field on `ModelCapabilities`:

```ts
video_edit: {
    source_slot: "source_video", // an existing media slot with kind: "video"
    modes: ["restyle", "replace_subject"],
}
```

`declaresVideoEditing()` in `src/models/capabilities/video-edit.ts` is the only
switch the composer uses. Setting the field is a claim that the adapter can
honour end to end; it must not be added to a catalog entry ahead of the adapter
work below.

## What a future v2v adapter must provide

1. **Source binding.** The declared `source_slot` must exist in `media_slots`
   with `kind: "video"` and must be required. The adapter must upload the task's
   rendered video into that slot, not a reference image or a last frame.
2. **Contract translation.** Translate the review request (prompt, time range,
   masks/regions if declared) into the provider's documented edit operation.
   Unknown fields must be rejected, not forwarded blindly.
3. **Validation.** Reject clips that exceed provider duration, resolution,
   codecs or byte limits before submission, with a stable `ERR_*` code.
4. **Single submission.** Follow the task lifecycle rules: persist the provider
   operation before submitting, never auto-resubmit a possibly-paid job, and
   expose reconciliation when the outcome is unknown.
5. **Budget and provider gates.** Paid providers must pass `checkBudget`; the
   adapter must reuse the existing provider registry and connection checks.
6. **Revision linkage.** Store the source task id and revision on the new task
   so `/library/revisions?a=…&b=…` can compare the edit against its source.
7. **Output handling.** Download the edited render through the normal asset
   pipeline, run ffprobe QA, and preserve audio only when the provider contract
   allows it.
8. **UI honesty.** Enable the composer's model picker only when
   `declaresVideoEditing()` is true. Until then the detail page keeps the
   disabled explanation and the notes-only workflow.
9. **Tests.** Add a provider-contract fixture, a `scripts/verify-*.mjs` adapter
   test, and an e2e that proves a submitted edit becomes a new task rather than
   a note.

## Non-goals

- Last-frame extension is a separate action (`POST /api/media/last-frame`); it
  seeds a new generation, not an edit of the source clip.
- Revision comparison is a review surface for two existing cuts; it does not
  create a new render.
- The notes API records intent. It is not a queue and does not trigger work.
