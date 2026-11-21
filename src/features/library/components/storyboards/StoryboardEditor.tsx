"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
    AlertCircle,
    ArrowDown,
    ArrowLeft,
    ArrowUp,
    Download,
    ImageOff,
    Loader2,
    Plus,
    Save,
    Trash2,
} from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LibraryShell } from "../LibraryShell";
import { libraryErrorKey } from "../../lib/api";
import { libraryAssetUrl } from "../../lib/asset-url";
import {
    addStoryboardShot,
    assetIdFromSource,
    createNote,
    deleteNote,
    listNotes,
    listStoryboards,
    noteTimecode,
    noteTimestamp,
    removeStoryboardShot,
    reorderStoryboardShots,
    resolveVideoSource,
    reviewMarkdownUrl,
    saveStoryboardShots,
    taskIdFromSource,
    type NoteRecord,
    type StoryboardShotRecord,
} from "../../lib/storyboard-api";

interface ShotEdit {
    intent?: string;
    seconds?: string;
    camera?: string;
}

function KeyframeThumbnail({ assetId, name }: { assetId: string | null; name: string }) {
    const url = assetId ? libraryAssetUrl(assetId) : null;
    if (!url) {
        return <div className="grid size-14 place-items-center rounded-lg border border-white/10 bg-white/[.03] text-muted-foreground">
            <ImageOff aria-hidden="true" className="size-4" />
        </div>;
    }
    return <div className="size-14 overflow-hidden rounded-lg border border-white/10 bg-black/40">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={name} loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" />
    </div>;
}

export function StoryboardEditor({ slug }: { slug: string }) {
    const t = useTranslations("library");
    const searchParams = useSearchParams();
    const videoRef = useRef<HTMLVideoElement>(null);

    const { data: storyboards, error, isLoading, mutate } = useSWR("library:storyboards", listStoryboards);
    const storyboard = storyboards?.find((item) => item.slug === slug) ?? null;
    const { data: notesData, mutate: mutateNotes } = useSWR(
        storyboard ? `notes:${storyboard.id}` : null,
        storyboard ? () => listNotes(storyboard.id) : null,
    );
    const notes: NoteRecord[] = notesData?.notes ?? [];

    const rawVideo = searchParams.get("video") ?? "";
    const videoUrl = resolveVideoSource(rawVideo);
    const taskId = searchParams.get("task") ?? taskIdFromSource(rawVideo);
    const assetId = searchParams.get("asset") ?? assetIdFromSource(rawVideo);

    const [edits, setEdits] = useState<Record<string, ShotEdit>>({});
    const [busy, setBusy] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [noteText, setNoteText] = useState("");
    const [noteStatus, setNoteStatus] = useState<string | null>(null);
    const [playhead, setPlayhead] = useState(0);

    function describeError(caught: unknown): string {
        const key = libraryErrorKey(caught);
        return t.has(key) ? t(key) : t("errors.generic");
    }

    function valuesFor(shot: StoryboardShotRecord): { intent: string; seconds: string; camera: string } {
        const edit = edits[shot.id];
        return {
            intent: edit?.intent ?? shot.intent,
            seconds: edit?.seconds ?? String(shot.seconds),
            camera: edit?.camera ?? shot.camera,
        };
    }

    function isDirty(shot: StoryboardShotRecord): boolean {
        const edit = edits[shot.id];
        if (!edit) return false;
        return (edit.intent !== undefined && edit.intent !== shot.intent)
            || (edit.seconds !== undefined && edit.seconds !== String(shot.seconds))
            || (edit.camera !== undefined && edit.camera !== shot.camera);
    }

    function updateEdit(shotId: string, patch: ShotEdit): void {
        setEdits((previous) => ({ ...previous, [shotId]: { ...previous[shotId], ...patch } }));
    }

    async function persist(operation: () => Promise<unknown>, key: string): Promise<void> {
        setBusy(key);
        setActionError(null);
        try {
            await operation();
            await mutate();
        } catch (caught) {
            setActionError(describeError(caught));
        } finally {
            setBusy(null);
        }
    }

    async function saveRow(shot: StoryboardShotRecord): Promise<void> {
        if (!storyboard) return;
        const values = valuesFor(shot);
        const seconds = Number(values.seconds);
        if (!Number.isFinite(seconds) || seconds <= 0) {
            setActionError(t("storyboardEditor.invalidSeconds"));
            return;
        }
        const next = storyboard.shots.map((item) => item.id === shot.id
            ? { ...item, intent: values.intent, seconds, camera: values.camera }
            : item);
        setBusy(`save:${shot.id}`);
        setActionError(null);
        try {
            await saveStoryboardShots(storyboard.id, next);
            setEdits((previous) => {
                const copy = { ...previous };
                delete copy[shot.id];
                return copy;
            });
            await mutate();
        } catch (caught) {
            setActionError(describeError(caught));
        } finally {
            setBusy(null);
        }
    }

    async function moveRow(shot: StoryboardShotRecord, direction: -1 | 1): Promise<void> {
        if (!storyboard) return;
        const index = storyboard.shots.findIndex((item) => item.id === shot.id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= storyboard.shots.length) return;
        const orderedIds = storyboard.shots.map((item) => item.id);
        const current = orderedIds[index];
        orderedIds[index] = orderedIds[target];
        orderedIds[target] = current;
        await persist(() => reorderStoryboardShots(storyboard.id, orderedIds), `move:${shot.id}`);
    }

    async function addShot(): Promise<void> {
        if (!storyboard) return;
        await persist(() => addStoryboardShot(storyboard.id), "add");
    }

    async function removeRow(shot: StoryboardShotRecord): Promise<void> {
        if (!storyboard) return;
        await persist(() => removeStoryboardShot(storyboard.id, shot.id), `delete:${shot.id}`);
    }

    async function addNote(): Promise<void> {
        if (!storyboard || !noteText.trim()) return;
        const seconds = noteTimestamp(videoRef.current?.currentTime ?? playhead, 1);
        setBusy("note");
        setActionError(null);
        setNoteStatus(null);
        try {
            await createNote(storyboard.id, { taskId, assetId, tSeconds: seconds, text: noteText.trim() });
            setNoteText("");
            setNoteStatus(t("storyboardEditor.noteSaved", { time: noteTimecode(seconds) }));
            await mutateNotes();
        } catch (caught) {
            setActionError(describeError(caught));
        } finally {
            setBusy(null);
        }
    }

    async function removeNote(note: NoteRecord): Promise<void> {
        if (!storyboard) return;
        setBusy(`note:${note.id}`);
        setActionError(null);
        try {
            await deleteNote(storyboard.id, note.id);
            await mutateNotes();
        } catch (caught) {
            setActionError(describeError(caught));
        } finally {
            setBusy(null);
        }
    }

    async function downloadReview(): Promise<void> {
        if (!storyboard) return;
        setBusy("download");
        setActionError(null);
        try {
            const response = await fetch(reviewMarkdownUrl(storyboard.id), { cache: "no-store" });
            if (!response.ok) throw new Error("ERR_NOTES_UNAVAILABLE");
            const markdown = await response.text();
            const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "REVIEW.md";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (caught) {
            setActionError(describeError(caught));
        } finally {
            setBusy(null);
        }
    }

    if (isLoading && !storyboards) {
        return <LibraryShell active="storyboards" title={t("storyboardEditor.loading")} subtitle={t("storyboards.subtitle")}>
            <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />{t("storyboardEditor.loading")}
            </div>
        </LibraryShell>;
    }

    if (!storyboard) {
        return <LibraryShell active="storyboards" title={t("storyboardEditor.notFound")} subtitle={t("storyboardEditor.notFoundHint")}>
            {error && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="size-4" />{t("errors.load")}</p>}
            <Link href="/library/storyboards" className="inline-flex items-center gap-2 text-sm text-primary"><ArrowLeft className="size-4" />{t("storyboardEditor.back")}</Link>
        </LibraryShell>;
    }

    return <LibraryShell active="storyboards" title={storyboard.name} subtitle={t("storyboardEditor.shotsHint")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
            <Link href="/library/storyboards" className="inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-4" />{t("storyboardEditor.back")}
            </Link>
            <span className="font-mono text-xs text-muted-foreground">{storyboard.slug}</span>
        </div>

        {actionError && <p role="alert" className="flex items-center gap-2 rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />{actionError}
        </p>}

        <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">{t("storyboardEditor.shots")}</h2>
                <Button size="sm" onClick={() => void addShot()} disabled={busy !== null}>
                    {busy === "add" ? <Loader2 className="animate-spin" /> : <Plus />}
                    {busy === "add" ? t("storyboardEditor.adding") : t("storyboardEditor.addShot")}
                </Button>
            </div>

            {storyboard.shots.length === 0
                ? <p className="rounded-2xl border border-dashed border-white/15 px-5 py-10 text-center text-sm text-muted-foreground">{t("storyboardEditor.emptyShots")}</p>
                : <div className="overflow-x-auto rounded-2xl border border-white/10 bg-[#101214]">
                    <table className="w-full min-w-[780px] text-sm">
                        <thead className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <tr>
                                <th scope="col" className="px-3 py-2 font-medium">{t("storyboardEditor.order")}</th>
                                <th scope="col" className="px-3 py-2 font-medium">{t("storyboardEditor.intent")}</th>
                                <th scope="col" className="px-3 py-2 font-medium">{t("storyboardEditor.seconds")}</th>
                                <th scope="col" className="px-3 py-2 font-medium">{t("storyboardEditor.camera")}</th>
                                <th scope="col" className="px-3 py-2 font-medium">{t("storyboardEditor.keyframe")}</th>
                                <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">{t("storyboardEditor.save")}</span></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[.06]">
                            {storyboard.shots.map((shot, index) => {
                                const values = valuesFor(shot);
                                const label = index + 1;
                                const rowBusy = busy === `save:${shot.id}`;
                                return <tr key={shot.id} data-testid="storyboard-shot-row" data-shot-id={shot.id}>
                                    <td className="px-3 py-2 align-top">
                                        <div className="flex items-center gap-1">
                                            <span className="w-5 font-mono text-xs text-muted-foreground">{label}</span>
                                            <Button variant="ghost" size="icon-xs" aria-label={t("storyboardEditor.moveUp", { index: label })}
                                                disabled={index === 0 || busy !== null} onClick={() => void moveRow(shot, -1)}><ArrowUp /></Button>
                                            <Button variant="ghost" size="icon-xs" aria-label={t("storyboardEditor.moveDown", { index: label })}
                                                disabled={index === storyboard.shots.length - 1 || busy !== null} onClick={() => void moveRow(shot, 1)}><ArrowDown /></Button>
                                        </div>
                                    </td>
                                    <td className="px-3 py-2 align-top">
                                        <Input aria-label={t("storyboardEditor.intentFor", { index: label })} value={values.intent}
                                            onChange={(event) => updateEdit(shot.id, { intent: event.currentTarget.value })} className="h-9 min-w-[220px]" />
                                    </td>
                                    <td className="px-3 py-2 align-top">
                                        <Input aria-label={t("storyboardEditor.secondsFor", { index: label })} type="number" min="0.1" step="0.1"
                                            value={values.seconds} onChange={(event) => updateEdit(shot.id, { seconds: event.currentTarget.value })} className="h-9 w-24" />
                                    </td>
                                    <td className="px-3 py-2 align-top">
                                        <Input aria-label={t("storyboardEditor.cameraFor", { index: label })} value={values.camera}
                                            onChange={(event) => updateEdit(shot.id, { camera: event.currentTarget.value })} className="h-9 min-w-[150px]" />
                                    </td>
                                    <td className="px-3 py-2 align-top">
                                        <KeyframeThumbnail assetId={shot.keyframeAssetId} name={`${storyboard.name} ${label}`} />
                                    </td>
                                    <td className="px-3 py-2 align-top">
                                        <div className="flex items-center justify-end gap-1">
                                            <Button variant="outline" size="sm" disabled={!isDirty(shot) || busy !== null}
                                                onClick={() => void saveRow(shot)} data-testid="storyboard-shot-save">
                                                {rowBusy ? <Loader2 className="animate-spin" /> : <Save />}
                                                {busy === `save:${shot.id}` ? t("storyboardEditor.saving") : t("storyboardEditor.save")}
                                            </Button>
                                            <Button variant="ghost" size="icon-sm" aria-label={t("storyboardEditor.delete", { index: label })}
                                                disabled={busy !== null} onClick={() => void removeRow(shot)}><Trash2 /></Button>
                                        </div>
                                    </td>
                                </tr>;
                            })}
                        </tbody>
                    </table>
                </div>}
        </section>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <section className="rounded-2xl border border-white/10 bg-[#101214] p-4 sm:p-5">
                <h2 className="text-sm font-semibold">{t("storyboardEditor.preview")}</h2>
                {videoUrl
                    ? <>
                        <video ref={videoRef} data-testid="storyboard-video" data-current-time={playhead.toFixed(3)}
                            src={videoUrl} controls playsInline preload="metadata"
                            onTimeUpdate={(event) => setPlayhead(event.currentTarget.currentTime)}
                            onSeeked={(event) => setPlayhead(event.currentTarget.currentTime)}
                            className="mt-3 aspect-video w-full rounded-xl bg-black" />
                        <p className="mt-2 font-mono text-sm text-muted-foreground" data-testid="storyboard-note-time">{noteTimecode(noteTimestamp(playhead, 1))}</p>
                    </>
                    : <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t("storyboardEditor.previewHint")}</p>}
            </section>

            <section className="rounded-2xl border border-white/10 bg-[#101214] p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold">{t("storyboardEditor.review")}</h2>
                    <Button variant="outline" size="sm" data-testid="storyboard-download-review" onClick={() => void downloadReview()} disabled={busy === "download"}>
                        {busy === "download" ? <Loader2 className="animate-spin" /> : <Download aria-hidden="true" />}
                        {t("storyboardEditor.downloadReview")}
                    </Button>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t("storyboardEditor.reviewHint")}</p>

                <label htmlFor="storyboard-note-text" className="mt-4 block text-xs font-medium text-muted-foreground">{t("storyboardEditor.noteLabel")}</label>
                <Textarea id="storyboard-note-text" data-testid="storyboard-note-text" value={noteText} maxLength={4000}
                    onChange={(event) => setNoteText(event.currentTarget.value)} placeholder={t("storyboardEditor.notePlaceholder")}
                    className="mt-1 min-h-20" />
                <Button className="mt-2" size="sm" data-testid="storyboard-note-add" onClick={() => void addNote()}
                    disabled={busy === "note" || !noteText.trim()}>
                    {busy === "note" ? <Loader2 className="animate-spin" /> : <Plus />}
                    {t("storyboardEditor.addNoteAt", { time: noteTimecode(noteTimestamp(playhead, 1)) })}
                </Button>
                {noteStatus && <p role="status" data-testid="storyboard-note-status" className="mt-2 text-xs text-primary">{noteStatus}</p>}

                {notes.length === 0
                    ? <p className="mt-4 text-sm text-muted-foreground">{t("storyboardEditor.notesEmpty")}</p>
                    : <ul aria-label={t("storyboardEditor.review")} className="mt-4 divide-y divide-white/[.06]">
                        {notes.map((note) => <li key={note.id} data-testid="storyboard-note" data-t-seconds={note.tSeconds} className="py-3">
                            <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                    <time className="font-mono text-xs text-primary">{noteTimecode(note.tSeconds)}</time>
                                    {note.decision && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">{t("storyboardEditor.decision")}</span>}
                                </div>
                                <Button variant="ghost" size="icon-xs" aria-label={t("storyboardEditor.deleteNote", { time: noteTimecode(note.tSeconds) })}
                                    disabled={busy !== null} onClick={() => void removeNote(note)}><Trash2 /></Button>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{note.text}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {note.taskId ? t("storyboardEditor.attachedToTask", { id: note.taskId })
                                    : note.assetId ? t("storyboardEditor.attachedToAsset", { id: note.assetId })
                                        : t("storyboardEditor.attachedToSubject")}
                            </p>
                        </li>)}
                    </ul>}
            </section>
        </div>
    </LibraryShell>;
}
