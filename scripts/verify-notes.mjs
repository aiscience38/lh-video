import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModuleLoader } from "./test-module-loader.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const SUBJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_SUBJECT = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const NOTE_A = "9d3e1c62-6a41-4f0e-8a37-5b9b0c9f2f11";
const NOTE_B = "1c9e6a2b-4f0a-4c3d-8e11-7a5b9c0d2e33";
const NOTE_UNKNOWN = "2d7f5b1c-6a2b-4c3d-9e11-8a5b9c0d2e44";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function harness(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-notes-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const env = { OPEN_HIGGSFIELD_STORAGE_DIR: dir, NODE_ENV: "development" };
    const loader = createModuleLoader({ env, mocks: { "next/server": { NextResponse: Response } } });
    return {
        dir,
        env,
        notes: loader.load("@/server/notes/store"),
        timecode: loader.load("@/lib/timecode"),
        collection: loader.load("src/app/api/notes/route.ts"),
        item: loader.load("src/app/api/notes/[id]/route.ts"),
    };
}

function apiRequest(url, method = "GET", body, origin = "http://127.0.0.1:3120") {
    const headers = { origin, host: "127.0.0.1:3120", "sec-fetch-site": "same-origin" };
    if (body !== undefined) headers["content-type"] = "application/json";
    return new Request(`http://localhost:3120${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

function context(id) {
    return { params: Promise.resolve({ id }) };
}

function notesPath(dir, subject = SUBJECT) {
    return path.join(dir, "notes", subject, "notes.json");
}

async function readDocument(dir, subject = SUBJECT) {
    return JSON.parse(await fs.readFile(notesPath(dir, subject), "utf8"));
}

test("createNote stores one atomic document with every contract field", async (t) => {
    const { dir, notes } = await harness(t);
    const note = await notes.createNote(SUBJECT, { taskId: "task_alpha", tSeconds: 3.2, text: "  Hero enters late  " });

    assert.match(note.id, UUID_PATTERN);
    assert.equal(note.subjectId, SUBJECT);
    assert.equal(note.taskId, "task_alpha");
    assert.equal(note.assetId, null);
    assert.equal(note.tSeconds, 3.2);
    assert.equal(note.text, "Hero enters late", "text is trimmed");
    assert.equal(note.decision, false);
    assert.match(note.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const raw = await readDocument(dir);
    assert.equal(raw.subjectId, SUBJECT);
    assert.equal(raw.notes.length, 1);
    assert.deepEqual(
        Object.keys(raw.notes[0]).sort(),
        ["assetId", "createdAt", "decision", "id", "subjectId", "tSeconds", "taskId", "text"],
    );
    assert.deepEqual(plain(raw.notes[0]), plain(note));
    const directoryEntries = await fs.readdir(path.dirname(notesPath(dir)));
    assert.deepEqual(directoryEntries, ["notes.json"], "no temporary file survives the atomic write");

    const assetNote = await notes.createNote(SUBJECT, { assetId: "asset_keyframe_01", tSeconds: 5, text: "Keyframe too dark" });
    assert.equal(assetNote.taskId, null);
    assert.equal(assetNote.assetId, "asset_keyframe_01");

    const general = await notes.createNote(SUBJECT, { tSeconds: 0, text: "Subject-wide note" });
    assert.equal(general.taskId, null);
    assert.equal(general.assetId, null);

    for (const draft of [
        {},
        { taskId: "task_alpha", tSeconds: -1, text: "negative" },
        { taskId: "task_alpha", tSeconds: Number.NaN, text: "nan" },
        { taskId: "task alpha", tSeconds: 1, text: "bad task id" },
        { assetId: "a/b", tSeconds: 1, text: "bad asset id" },
        { taskId: "task_alpha", tSeconds: 1, text: "   " },
        { taskId: "task_alpha", tSeconds: 1, text: "x".repeat(4001) },
    ]) {
        await assert.rejects(notes.createNote(SUBJECT, draft), /ERR_NOTES_INVALID/, JSON.stringify(draft));
    }
    await assert.rejects(notes.createNote("../escape", { tSeconds: 1, text: "nope" }), /ERR_NOTES_INVALID/);
    await assert.rejects(notes.createNote("bad subject", { tSeconds: 1, text: "nope" }), /ERR_NOTES_INVALID/);
    assert.equal((await readDocument(dir)).notes.length, 3, "rejected writes never mutate the document");
});

test("listNotes orders by timecode and deleteNote removes only one note", async (t) => {
    const { dir, notes } = await harness(t);
    const late = await notes.createNote(SUBJECT, { tSeconds: 65, text: "Slate needs a retake" });
    const early = await notes.createNote(SUBJECT, { tSeconds: 3.2, text: "Hero enters late" });
    const middle = await notes.createNote(SUBJECT, { taskId: "task_alpha", tSeconds: 12.5, text: "Cut on the beat", decision: true });

    const listed = await notes.listNotes(SUBJECT);
    assert.deepEqual(plain(listed.map((note) => note.tSeconds)), [3.2, 12.5, 65]);
    assert.deepEqual(plain(listed.map((note) => note.id)), [early.id, middle.id, late.id]);
    assert.equal(listed[1].decision, true);

    assert.equal(await notes.deleteNote(SUBJECT, middle.id), true);
    assert.deepEqual(plain((await notes.listNotes(SUBJECT)).map((note) => note.id)), [early.id, late.id]);
    assert.equal(await notes.deleteNote(SUBJECT, middle.id), false, "deleting twice reports false");
    assert.equal((await readDocument(dir)).notes.length, 2);
    await assert.rejects(notes.deleteNote(SUBJECT, "not-a-uuid"), /ERR_NOTES_INVALID/);
    await assert.rejects(notes.deleteNote("bad subject", middle.id), /ERR_NOTES_INVALID/);

    await notes.createNote(OTHER_SUBJECT, { tSeconds: 1, text: "Other subject" });
    assert.equal((await notes.listNotes(OTHER_SUBJECT)).length, 1);
    assert.equal((await notes.listNotes(SUBJECT)).length, 2, "subjects stay isolated");
});

test("REVIEW.md is deterministic and groups decisions and notes by task", async (t) => {
    const { notes, timecode } = await harness(t);
    assert.equal(timecode.formatTimecode(3.2), "00:03.200");
    assert.equal(timecode.formatTimecode(12.5), "00:12.500");
    assert.equal(timecode.formatTimecode(65), "01:05.000");
    assert.equal(timecode.formatTimecode(3661.25), "01:01:01.250");

    const fixture = [
        { id: NOTE_B, subjectId: SUBJECT, taskId: null, assetId: null, tSeconds: 65, text: "Slate   needs\na retake", createdAt: "2026-01-01T00:00:04.000Z", decision: false },
        { id: NOTE_A, subjectId: SUBJECT, taskId: "task_alpha", assetId: null, tSeconds: 12.5, text: "Accepted revision B over A", createdAt: "2026-01-01T00:00:02.000Z", decision: true },
        { id: NOTE_UNKNOWN, subjectId: SUBJECT, taskId: "task_beta", assetId: null, tSeconds: 20, text: "Cut on the beat", createdAt: "2026-01-01T00:00:03.000Z", decision: false },
        { id: "6ba7b811-9dad-41d1-80b4-00c04fd430c8", subjectId: SUBJECT, taskId: null, assetId: "asset_keyframe_01", tSeconds: 5, text: "Keyframe is too dark", createdAt: "2026-01-01T00:00:01.000Z", decision: false },
        { id: "3f2504e0-4f89-41d3-9a0c-0305e82c3302", subjectId: SUBJECT, taskId: "task_alpha", assetId: null, tSeconds: 3.2, text: "Hero enters late", createdAt: "2026-01-01T00:00:00.000Z", decision: false },
    ];
    const expected = `# REVIEW — ${SUBJECT}

## Task task_alpha

### Decisions

- \`00:12.500\` **Decision** — Accepted revision B over A

### Notes

- \`00:03.200\` Hero enters late

## Task task_beta

### Notes

- \`00:20.000\` Cut on the beat

## Asset asset_keyframe_01

### Notes

- \`00:05.000\` Keyframe is too dark

## General

### Notes

- \`01:05.000\` Slate needs a retake
`;
    assert.equal(notes.renderReviewMarkdownFromNotes(SUBJECT, fixture), expected);
    assert.equal(notes.renderReviewMarkdownFromNotes(SUBJECT, [...fixture].reverse()), expected, "input order never changes the export");
    assert.equal(
        notes.renderReviewMarkdownFromNotes(SUBJECT, []),
        `# REVIEW — ${SUBJECT}\n\n_No review notes yet._\n`,
    );

    await notes.createNote(SUBJECT, { taskId: "task_alpha", tSeconds: 3.2, text: "Hero enters late" });
    await notes.createNote(SUBJECT, { taskId: "task_alpha", tSeconds: 12.5, text: "Accepted revision B over A", decision: true });
    const exported = await notes.renderReviewMarkdown(SUBJECT);
    assert.match(exported, /^# REVIEW — /);
    assert.match(exported, /### Decisions/);
    assert.match(exported, /`00:03\.200` Hero enters late/);
    assert.match(exported, /`00:12\.500` \*\*Decision\*\* — Accepted revision B over A/);
});

test("notes API supports GET, POST and DELETE with workspace guards", async (t) => {
    const { dir, collection, item } = await harness(t);
    const url = "/api/notes";

    const created = await collection.POST(apiRequest(url, "POST", {
        subjectId: SUBJECT,
        taskId: "task_alpha",
        tSeconds: 3.2,
        text: "Hero enters late",
    }));
    assert.equal(created.status, 201);
    const note = (await created.json()).note;
    assert.match(note.id, UUID_PATTERN);
    assert.equal(note.subjectId, SUBJECT);

    const listed = await collection.GET(apiRequest(`${url}?subjectId=${SUBJECT}`));
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.equal(listedBody.count, 1);
    assert.deepEqual(plain(listedBody.notes), plain([note]));

    const markdown = await collection.GET(apiRequest(`${url}?subjectId=${SUBJECT}&format=markdown`));
    assert.equal(markdown.status, 200);
    assert.match(markdown.headers.get("content-type") ?? "", /text\/markdown/);
    assert.match(markdown.headers.get("content-disposition") ?? "", /attachment; filename="REVIEW\.md"/);
    const markdownText = await markdown.text();
    assert.match(markdownText, /^# REVIEW — /);
    assert.match(markdownText, /`00:03\.200` Hero enters late/);

    const decision = await collection.POST(apiRequest(url, "POST", {
        subjectId: SUBJECT,
        assetId: "asset_cut_b",
        tSeconds: 12.5,
        text: "Accepted revision B over A",
        decision: true,
    }));
    assert.equal(decision.status, 201);
    assert.equal((await decision.json()).note.decision, true);
    assert.equal((await (await collection.GET(apiRequest(`${url}?subjectId=${SUBJECT}`))).json()).count, 2);
    assert.equal((await readDocument(dir)).notes.length, 2);

    const removed = await item.DELETE(apiRequest(`${url}/${note.id}?subjectId=${SUBJECT}`, "DELETE"), context(note.id));
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true, id: note.id });
    assert.equal((await (await collection.GET(apiRequest(`${url}?subjectId=${SUBJECT}`))).json()).count, 1);

    const missing = await item.DELETE(apiRequest(`${url}/${note.id}?subjectId=${SUBJECT}`, "DELETE"), context(note.id));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "ERR_NOTES_NOT_FOUND");

    const crossOrigin = await collection.POST(apiRequest(url, "POST", { subjectId: SUBJECT, tSeconds: 1, text: "nope" }, "http://evil.example"));
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error, "ERR_ORIGIN_FORBIDDEN");

    const noOrigin = await collection.POST(new Request(`http://localhost:3120${url}`, {
        method: "POST",
        headers: { host: "127.0.0.1:3120", "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ subjectId: SUBJECT, tSeconds: 1, text: "nope" }),
    }));
    assert.equal(noOrigin.status, 403);

    const wrongType = await collection.POST(new Request(`http://localhost:3120${url}`, {
        method: "POST",
        headers: { origin: "http://127.0.0.1:3120", host: "127.0.0.1:3120", "sec-fetch-site": "same-origin", "content-type": "text/plain" },
        body: "{}",
    }));
    assert.equal(wrongType.status, 415);

    const invalidBody = await collection.POST(apiRequest(url, "POST", { subjectId: SUBJECT, tSeconds: -1, text: "bad" }));
    assert.equal(invalidBody.status, 400);
    assert.equal((await invalidBody.json()).error, "ERR_NOTES_INVALID");

    const invalidSubject = await collection.GET(apiRequest(`${url}?subjectId=../escape`));
    assert.equal(invalidSubject.status, 400);
    const missingSubject = await collection.GET(apiRequest(url));
    assert.equal(missingSubject.status, 400);
    const arrayBody = await collection.POST(apiRequest(url, "POST", [{ subjectId: SUBJECT }]));
    assert.equal(arrayBody.status, 400);

    const invalidNoteId = await item.DELETE(apiRequest(`${url}/not-a-uuid?subjectId=${SUBJECT}`, "DELETE"), context("not-a-uuid"));
    assert.equal(invalidNoteId.status, 400);
    const unknownNote = await item.DELETE(apiRequest(`${url}/${NOTE_UNKNOWN}?subjectId=${SUBJECT}`, "DELETE"), context(NOTE_UNKNOWN));
    assert.equal(unknownNote.status, 404);
    assert.equal((await readDocument(dir)).notes.length, 1, "rejected requests never mutate");
});
