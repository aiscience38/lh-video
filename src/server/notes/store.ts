import "server-only";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { formatTimecode } from "@/lib/timecode";
import { STORAGE_ROOT } from "@/server/config/storage-paths";
import { readJson, writeJsonAtomic } from "@/server/library/atomic";
import { ASSET_ID_PATTERN, LIBRARY_INVALID_ERROR, LIBRARY_NOT_FOUND_ERROR } from "@/server/library/contract";

/**
 * Timecoded review notes for a production or storyboard.
 *
 * One document per subject lives at `notes/<subjectId>/notes.json` under
 * `STORAGE_ROOT`. Every mutation is a locked read-modify-write followed by an
 * atomic replacement, so a crash never leaves a half-written review. Notes are
 * ordered by timecode when read; the exported REVIEW.md is deterministic.
 */

export const NOTES_INVALID_ERROR = "ERR_NOTES_INVALID";
export const NOTES_NOT_FOUND_ERROR = "ERR_NOTES_NOT_FOUND";

const SUBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const noteIdSchema = z.uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const subjectIdSchema = z.string().regex(SUBJECT_ID_PATTERN, { error: NOTES_INVALID_ERROR });
const referenceIdSchema = z.string().regex(ASSET_ID_PATTERN, { error: NOTES_INVALID_ERROR }).nullable();

/** One timecoded note. `taskId`/`assetId` may both be null for a subject-wide note. */
export const noteSchema = z.object({
    id: noteIdSchema,
    subjectId: subjectIdSchema,
    taskId: referenceIdSchema.default(null),
    assetId: referenceIdSchema.default(null),
    tSeconds: z.number().finite().min(0),
    text: z.string().min(1).max(4000),
    createdAt: timestampSchema,
    decision: z.boolean().default(false),
});
export type Note = z.infer<typeof noteSchema>;

const notesDocumentSchema = z.object({
    subjectId: subjectIdSchema,
    notes: z.array(noteSchema),
});
export type NotesDocument = z.infer<typeof notesDocumentSchema>;

export const noteDraftSchema = z.object({
    taskId: referenceIdSchema.optional(),
    assetId: referenceIdSchema.optional(),
    tSeconds: z.number().finite().min(0),
    text: z.string().trim().min(1).max(4000),
    decision: z.boolean().optional(),
});
export type NoteDraft = z.infer<typeof noteDraftSchema>;

function notesError(code: string): Error {
    return new Error(code);
}

export function isValidSubjectId(value: unknown): value is string {
    return typeof value === "string" && SUBJECT_ID_PATTERN.test(value);
}

function isValidNoteId(value: unknown): value is string {
    return typeof value === "string" && noteIdSchema.safeParse(value).success;
}

/** `notes/` below the workspace storage root. */
export function notesRoot(): string {
    return path.join(STORAGE_ROOT, "notes");
}

/** The one document that backs a subject's review. */
export function notesFile(subjectId: string): string {
    return path.join(notesRoot(), subjectId, "notes.json");
}

interface NotesGlobals {
    __reviewNotesQueues?: Map<string, Promise<unknown>>;
}
const shared = globalThis as typeof globalThis & NotesGlobals;
shared.__reviewNotesQueues ??= new Map();
const queues = shared.__reviewNotesQueues;

/** Serializes mutations per subject; atomic rename still protects across processes. */
async function withSubjectLock<T>(subjectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(subjectId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    queues.set(subjectId, pending.catch(() => undefined));
    return pending;
}

async function readNotesDocument(subjectId: string): Promise<NotesDocument> {
    if (!isValidSubjectId(subjectId)) throw notesError(NOTES_INVALID_ERROR);
    try {
        const document = await readJson(notesFile(subjectId), notesDocumentSchema);
        if (document.subjectId !== subjectId) throw notesError(NOTES_INVALID_ERROR);
        return document;
    } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === LIBRARY_NOT_FOUND_ERROR) return { subjectId, notes: [] };
        if (code === LIBRARY_INVALID_ERROR) throw notesError(NOTES_INVALID_ERROR);
        throw error;
    }
}

function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareNotes(a: Note, b: Note): number {
    return a.tSeconds - b.tSeconds
        || compareText(a.createdAt, b.createdAt)
        || compareText(a.id, b.id);
}

/** Notes sorted by timecode, then creation time, then id. */
export async function listNotes(subjectId: string): Promise<Note[]> {
    const document = await readNotesDocument(subjectId);
    return [...document.notes].sort(compareNotes);
}

/** Appends one note and returns it. The subject document is created on first use. */
export async function createNote(subjectId: string, draft: unknown): Promise<Note> {
    if (!isValidSubjectId(subjectId)) throw notesError(NOTES_INVALID_ERROR);
    const parsed = noteDraftSchema.safeParse(draft);
    if (!parsed.success) throw notesError(NOTES_INVALID_ERROR);
    const value = parsed.data;
    return withSubjectLock(subjectId, async () => {
        const document = await readNotesDocument(subjectId);
        const note = noteSchema.parse({
            id: randomUUID(),
            subjectId,
            taskId: value.taskId ?? null,
            assetId: value.assetId ?? null,
            tSeconds: value.tSeconds,
            text: value.text,
            createdAt: new Date().toISOString(),
            decision: value.decision ?? false,
        });
        await writeJsonAtomic(notesFile(subjectId), {
            subjectId,
            notes: [...document.notes, note],
        });
        return note;
    });
}

/** Removes one note. Returns false when the id is not part of the subject. */
export async function deleteNote(subjectId: string, noteId: string): Promise<boolean> {
    if (!isValidSubjectId(subjectId) || !isValidNoteId(noteId)) throw notesError(NOTES_INVALID_ERROR);
    return withSubjectLock(subjectId, async () => {
        const document = await readNotesDocument(subjectId);
        const remaining = document.notes.filter((note) => note.id !== noteId);
        if (remaining.length === document.notes.length) return false;
        await writeJsonAtomic(notesFile(subjectId), { subjectId, notes: remaining });
        return true;
    });
}

function normalizeLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

interface ReviewGroup {
    heading: string;
    notes: Note[];
}

function appendGroup(lines: string[], group: ReviewGroup): void {
    const decisions = group.notes.filter((note) => note.decision);
    const notes = group.notes.filter((note) => !note.decision);
    lines.push(group.heading, "");
    if (decisions.length > 0) {
        lines.push("### Decisions", "");
        for (const note of decisions) {
            lines.push(`- \`${formatTimecode(note.tSeconds)}\` **Decision** — ${normalizeLine(note.text)}`);
        }
        lines.push("");
    }
    if (notes.length > 0) {
        lines.push("### Notes", "");
        for (const note of notes) {
            lines.push(`- \`${formatTimecode(note.tSeconds)}\` ${normalizeLine(note.text)}`);
        }
        lines.push("");
    }
}

/**
 * Renders deterministic review markdown: one section per task (then asset,
 * then subject-wide notes), decisions before notes, every bullet timecoded.
 */
export function renderReviewMarkdownFromNotes(subjectId: string, notes: readonly Note[]): string {
    const sorted = [...notes].sort(compareNotes);
    const lines = [`# REVIEW — ${subjectId}`, ""];
    if (sorted.length === 0) {
        lines.push("_No review notes yet._", "");
        return lines.join("\n");
    }
    const tasks = new Map<string, Note[]>();
    const assets = new Map<string, Note[]>();
    const general: Note[] = [];
    for (const note of sorted) {
        if (note.taskId) {
            tasks.set(note.taskId, [...(tasks.get(note.taskId) ?? []), note]);
        } else if (note.assetId) {
            assets.set(note.assetId, [...(assets.get(note.assetId) ?? []), note]);
        } else {
            general.push(note);
        }
    }
    for (const taskId of [...tasks.keys()].sort(compareText)) {
        appendGroup(lines, { heading: `## Task ${taskId}`, notes: tasks.get(taskId) ?? [] });
    }
    for (const assetId of [...assets.keys()].sort(compareText)) {
        appendGroup(lines, { heading: `## Asset ${assetId}`, notes: assets.get(assetId) ?? [] });
    }
    if (general.length > 0) appendGroup(lines, { heading: "## General", notes: general });
    return lines.join("\n");
}

/** REVIEW.md for one subject, derived from the persisted notes. */
export async function renderReviewMarkdown(subjectId: string): Promise<string> {
    return renderReviewMarkdownFromNotes(subjectId, await listNotes(subjectId));
}
