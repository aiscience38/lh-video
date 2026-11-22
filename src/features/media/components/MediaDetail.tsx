"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, CalendarDays, Clapperboard, Download, Film, GitCompareArrows, Loader2, MessageSquarePlus, Play, SkipBack, SkipForward, Sparkles } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useModelCopy } from "@/i18n/use-model-copy";
import { useRuntimeModels } from "@/features/catalog/hooks/useRuntimeModels";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatFrameTimecode } from "@/lib/timecode";
import { declaresVideoEditing } from "@/models/capabilities/video-edit";
import { useFilmstrip, useMediaTask } from "../hooks/useMediaDetail";
import { createMediaNote, extractLastFrame, listMediaNotes, MediaRequestError } from "../lib/api";
import type { LastFrameAsset, MediaNote } from "../types";

/**
 * Rendered-video detail page.
 *
 * The player is the browser's native video element; the filmstrip is a cached
 * ffmpeg artifact, and every edit action either stores a note or links to an
 * existing review surface. No provider generation job is ever submitted here.
 */
export function MediaDetail({ taskId }: { taskId: string }) {
    const t = useTranslations("media.detail");
    const edit = useTranslations("media.edit");
    const errors = useTranslations("errors");
    const locale = useLocale();
    const { modelLabel } = useModelCopy();
    const videoCatalog = useRuntimeModels("video");
    const { task, error, isLoading } = useMediaTask(taskId);
    const { filmstrip, error: filmstripError, isLoading: filmstripLoading } = useFilmstrip(taskId);

    const videoRef = useRef<HTMLVideoElement>(null);
    const requestRef = useRef<HTMLTextAreaElement>(null);
    const [currentTime, setCurrentTime] = useState(0);
    const [mediaDuration, setMediaDuration] = useState(0);
    const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
    const [request, setRequest] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [submitStatus, setSubmitStatus] = useState<string | null>(null);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [extending, setExtending] = useState(false);
    const [extendStatus, setExtendStatus] = useState<string | null>(null);
    const [extendError, setExtendError] = useState<string | null>(null);
    const [startFrame, setStartFrame] = useState<LastFrameAsset | null>(null);
    const [notes, setNotes] = useState<MediaNote[]>([]);
    const [notesLoading, setNotesLoading] = useState(true);
    const [notesFailed, setNotesFailed] = useState(false);

    const editingModels = useMemo(() => videoCatalog.models.filter(declaresVideoEditing), [videoCatalog.models]);
    const capability = videoCatalog.byId[task?.model_id ?? ""];
    const fps = filmstrip?.fps ?? 24;
    const duration = filmstrip?.durationSeconds ?? mediaDuration;
    const completed = (task?.status ?? task?.freepik_status) === "COMPLETED";
    const downloadUrl = `/api/download/${encodeURIComponent(taskId)}?index=0&download=1`;
    const playerUrl = `/api/download/${encodeURIComponent(taskId)}?inline=1`;

    const failureText = (caught: unknown, fallback: string) => {
        const code = caught instanceof MediaRequestError ? caught.code : "";
        return code && errors.has(code) ? errors(code) : fallback;
    };

    useEffect(() => {
        let cancelled = false;
        listMediaNotes(taskId).then(result => {
            if (!cancelled) { setNotes(result); setNotesFailed(false); setNotesLoading(false); }
        }).catch(() => {
            if (!cancelled) { setNotesFailed(true); setNotesLoading(false); }
        });
        return () => { cancelled = true; };
    }, [taskId]);

    function seekTo(time: number): void {
        const limit = duration > 0 ? duration : Number.POSITIVE_INFINITY;
        const next = Math.max(0, Math.min(limit, Number.isFinite(time) ? time : 0));
        const video = videoRef.current;
        if (video) {
            try { video.currentTime = next; } catch { /* Metadata is not ready; loadedmetadata keeps the clock. */ }
        }
        setCurrentTime(next);
    }

    function stepFrame(direction: -1 | 1): void {
        videoRef.current?.pause();
        seekTo(currentTime + direction / fps);
    }

    async function extend(): Promise<void> {
        if (extending || !completed) return;
        setExtending(true);
        setExtendError(null);
        setExtendStatus(null);
        try {
            const frame = await extractLastFrame(taskId);
            setStartFrame(frame);
            setExtendStatus(edit("extendReady"));
            requestRef.current?.focus();
        } catch (caught) {
            setExtendError(failureText(caught, edit("extendError")));
        } finally {
            setExtending(false);
        }
    }

    async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        const text = request.trim();
        if (!text || submitting) return;
        setSubmitting(true);
        setSubmitError(null);
        setSubmitStatus(null);
        try {
            await createMediaNote(taskId, { tSeconds: currentTime, text });
            setRequest("");
            setNotes(await listMediaNotes(taskId));
            setSubmitStatus(edit("submitted"));
        } catch (caught) {
            setSubmitError(failureText(caught, edit("submitError")));
        } finally {
            setSubmitting(false);
        }
    }

    const backLink = <Link href="/" className="inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
        <ArrowLeft aria-hidden="true" className="size-4" />{t("backToGallery")}
    </Link>;

    if (isLoading) {
        return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />{t("loading")}
        </div>;
    }

    if (!task) {
        const notFound = error instanceof MediaRequestError && error.status === 404;
        return <div className="mx-auto max-w-2xl space-y-4 px-4 py-10">
            {backLink}
            <h1 className="font-display text-2xl font-semibold">{notFound ? t("notFound") : t("loadError")}</h1>
            <p className="text-sm text-muted-foreground">{notFound ? t("notFoundHint") : t("loadErrorHint")}</p>
        </div>;
    }

    const prompt = task.prompt?.trim() || t("noPrompt");
    const model = modelLabel(capability?.label ?? task.provider_capabilities?.label ?? task.model_id);
    const provider = capability?.provider ?? task.provider_id ?? t("unknown");
    const width = filmstrip?.width ?? dimensions?.width ?? numberParam(task.params?.width) ?? numberParam(task.params?.size_width);
    const height = filmstrip?.height ?? dimensions?.height ?? numberParam(task.params?.height) ?? numberParam(task.params?.size_height);
    const resolution = width && height ? `${width} × ${height}` : t("unknown");
    const seed = scalar(task.params?.seed);
    const createdAt = formatCreatedAt(task.created_at, locale);
    const params = Object.entries(task.params ?? {}).filter(([key, value]) => key !== "seed" && scalar(value) !== null).slice(0, 12);
    const resultCount = Math.max(task.result_count ?? 0, task.video_urls?.length ?? 0, 1);
    const primaryAsset = `/api/download/${encodeURIComponent(taskId)}?index=0`;
    const secondaryAsset = resultCount > 1 ? `/api/download/${encodeURIComponent(taskId)}?index=1` : primaryAsset;
    const compareHref = `/library/revisions?a=${encodeURIComponent(primaryAsset)}&b=${encodeURIComponent(secondaryAsset)}&task=${encodeURIComponent(taskId)}`;
    const safeTime = duration > 0 ? Math.min(currentTime, duration) : currentTime;
    const timelineFrames = filmstrip
        ? (filmstrip.frames?.length ? filmstrip.frames : Array.from({ length: filmstrip.frameCount }, (_, index) => ({
            index,
            timeSeconds: filmstrip.durationSeconds * (index + 0.5) / Math.max(1, filmstrip.frameCount),
            url: `/api/media/${encodeURIComponent(taskId)}/frames?index=${index}`,
        })))
        : [];

    return <div className="model-scrollbar h-full min-h-0 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-7 sm:py-9 lg:px-10">
            <div>{backLink}</div>
            <header className="max-w-3xl">
                <p className="mb-2 text-[11px] font-bold tracking-[.2em] text-primary">{t("eyebrow")}</p>
                <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t("title")}</h1>
                <p className="mt-2 break-words text-sm leading-relaxed text-muted-foreground">{prompt}</p>
            </header>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="min-w-0 space-y-6">
                    <section aria-label={t("playerLabel")} className="space-y-3">
                        <div className="overflow-hidden rounded-2xl border border-white/10 bg-black">
                            {completed ? <video ref={videoRef} data-testid="media-player" src={playerUrl} controls playsInline preload="metadata"
                                onLoadedMetadata={event => {
                                    const video = event.currentTarget;
                                    setMediaDuration(Number.isFinite(video.duration) ? video.duration : 0);
                                    if (video.videoWidth && video.videoHeight) setDimensions({ width: video.videoWidth, height: video.videoHeight });
                                    setCurrentTime(video.currentTime);
                                }}
                                onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)}
                                onSeeked={event => setCurrentTime(event.currentTarget.currentTime)}
                                className="aspect-video max-h-[72dvh] w-full bg-black object-contain" />
                                : <p role="status" className="grid aspect-video place-items-center gap-2 p-8 text-center text-sm text-muted-foreground">
                                    <Clapperboard aria-hidden="true" className="mx-auto size-6" />{t("notReady")}
                                </p>}
                        </div>

                        <div className="rounded-2xl border border-white/10 bg-[#101214] p-3" data-testid="media-timeline">
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("timelineLabel")}</p>
                                <p className="font-mono text-xs tabular-nums text-foreground/90">
                                    <span data-testid="media-current-timecode">{formatFrameTimecode(safeTime, fps)}</span>
                                    <span aria-hidden="true"> / </span>
                                    <span data-testid="media-total-timecode">{formatFrameTimecode(duration, fps)}</span>
                                </p>
                            </div>
                            {filmstripLoading && <p role="status" className="flex items-center gap-2 py-3 text-xs text-muted-foreground"><Loader2 aria-hidden="true" className="size-3.5 animate-spin" />{t("framesLoading")}</p>}
                            {filmstripError && <p role="alert" className="flex items-center gap-2 py-3 text-xs text-destructive"><AlertCircle aria-hidden="true" className="size-3.5" />{failureText(filmstripError, t("framesError"))}</p>}
                            {filmstrip && <div className="relative">
                                <div className="flex overflow-hidden rounded-lg border border-white/10">
                                    {timelineFrames.map(frame => <button key={frame.index} type="button" data-testid={`media-filmstrip-frame-${frame.index}`}
                                        onClick={() => seekTo(frame.timeSeconds)}
                                        aria-label={t("seekTo", { time: formatFrameTimecode(frame.timeSeconds, fps) })}
                                        className="relative min-w-0 flex-1 border-r border-black/60 last:border-r-0 focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={frame.url} alt="" loading="lazy" className="aspect-video w-full object-cover" />
                                    </button>)}
                                </div>
                                <span aria-hidden="true" data-testid="media-playhead" className="pointer-events-none absolute inset-y-0 w-0.5 bg-primary shadow-[0_0_0_1px_rgba(0,0,0,.6)]"
                                    style={{ left: `${duration > 0 ? Math.min(100, Math.max(0, safeTime / duration * 100)) : 0}%` }} />
                            </div>}
                            <label className="mt-3 block">
                                <span className="sr-only">{t("scrub")}</span>
                                <input type="range" data-testid="media-scrub" min={0} max={Math.max(duration, 0)} step={1 / fps}
                                    value={Math.max(0, Math.min(duration || 0, safeTime))}
                                    onChange={event => seekTo(Number(event.target.value))}
                                    aria-label={t("scrub")} aria-valuetext={formatFrameTimecode(safeTime, fps)}
                                    className="h-2 w-full cursor-pointer accent-primary" />
                            </label>
                            <div className="mt-2 flex flex-wrap items-center gap-1">
                                <Button type="button" variant="outline" size="sm" onClick={() => stepFrame(-1)} aria-label={t("previousFrame")} title={t("previousFrame")} disabled={!completed}>
                                    <SkipBack aria-hidden="true" />{t("previousFrame")}
                                </Button>
                                <Button type="button" variant="outline" size="sm" data-testid="media-next-frame" onClick={() => stepFrame(1)} aria-label={t("nextFrame")} title={t("nextFrame")} disabled={!completed}>
                                    <SkipForward aria-hidden="true" />{t("nextFrame")}
                                </Button>
                                <Button type="button" variant="ghost" size="sm" onClick={() => void videoRef.current?.play().catch(() => undefined)} aria-label={t("play")} title={t("play")} disabled={!completed}>
                                    <Play aria-hidden="true" />{t("play")}
                                </Button>
                            </div>
                        </div>
                    </section>

                    <section aria-labelledby="media-edit-heading" className="rounded-2xl border border-white/10 bg-[#101214] p-4 sm:p-5">
                        <div className="flex items-start gap-3">
                            <Sparkles aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
                            <div className="min-w-0">
                                <h2 id="media-edit-heading" className="text-base font-semibold">{edit("title")}</h2>
                                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{edit("subtitle")}</p>
                            </div>
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            <label htmlFor="media-edit-model" className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                                {edit("model")}
                                <select id="media-edit-model" data-testid="media-edit-model" disabled={editingModels.length === 0}
                                    aria-describedby="media-edit-model-hint"
                                    className="h-10 rounded-lg border border-white/10 bg-[#0d0f10] px-2.5 text-sm text-foreground disabled:opacity-70">
                                    <option value="">{editingModels.length ? edit("chooseModel") : edit("noVideoEditingModels")}</option>
                                    {editingModels.map(modelOption => <option key={modelOption.id} value={modelOption.id}>{modelLabel(modelOption.label)}</option>)}
                                </select>
                            </label>
                            <p id="media-edit-model-hint" data-testid="media-edit-capability-hint" className="self-end rounded-lg border border-white/10 bg-white/[.03] p-2.5 text-xs leading-relaxed text-muted-foreground">
                                {edit("noModelsExplanation")}
                            </p>
                        </div>

                        <form onSubmit={event => void submit(event)} className="mt-4 grid gap-2">
                            <label htmlFor="media-edit-request" className="text-xs font-medium text-muted-foreground">{edit("requestLabel")}</label>
                            <textarea id="media-edit-request" ref={requestRef} data-testid="media-edit-request" value={request} maxLength={4000} rows={4}
                                onChange={event => setRequest(event.target.value)} placeholder={edit("requestPlaceholder")}
                                className="w-full resize-y rounded-lg border border-white/10 bg-[#0d0f10] px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60" />
                            <div className="flex flex-wrap items-center gap-2">
                                <Button type="submit" data-testid="media-edit-submit" disabled={!request.trim() || submitting}>
                                    {submitting ? <Loader2 aria-hidden="true" className="animate-spin" /> : <MessageSquarePlus aria-hidden="true" />}
                                    {submitting ? edit("submitting") : edit("submit")}
                                </Button>
                                <Button type="button" variant="outline" data-testid="media-edit-extend" onClick={() => void extend()} disabled={extending || !completed}>
                                    {extending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Film aria-hidden="true" />}
                                    {extending ? edit("extending") : edit("extend")}
                                </Button>
                                <Link href={compareHref} data-testid="media-edit-compare" className={buttonVariants({ variant: "outline", size: "default" })}>
                                    <GitCompareArrows aria-hidden="true" />{edit("compare")}
                                </Link>
                            </div>
                        </form>

                        {startFrame && <figure className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 p-3">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={startFrame.url} alt={edit("startFrameAlt")} className="h-20 w-32 rounded-lg border border-white/10 object-cover" />
                            <figcaption className="text-xs leading-relaxed text-muted-foreground">
                                <span className="block font-semibold text-foreground">{edit("startFrame")}</span>
                                <code className="mt-1 block break-all font-mono text-[11px]">{startFrame.assetId}</code>
                            </figcaption>
                        </figure>}

                        {extendStatus && <p role="status" className="mt-3 text-xs text-muted-foreground">{extendStatus}</p>}
                        {extendError && <p role="alert" className="mt-3 flex items-center gap-2 text-xs text-destructive"><AlertCircle aria-hidden="true" className="size-3.5" />{extendError}</p>}
                        {submitStatus && <p role="status" className="mt-3 text-xs text-muted-foreground">{submitStatus}</p>}
                        {submitError && <p role="alert" className="mt-3 flex items-center gap-2 text-xs text-destructive"><AlertCircle aria-hidden="true" className="size-3.5" />{submitError}</p>}

                        <div className="mt-6 border-t border-white/10 pt-4">
                            <h3 className="text-sm font-semibold">{edit("notesTitle")}</h3>
                            <p className="mt-1 text-xs text-muted-foreground">{edit("notesHint")}</p>
                            {notesLoading && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 aria-hidden="true" className="size-3.5 animate-spin" />{edit("notesLoading")}</p>}
                            {notesFailed && <p role="alert" className="mt-3 text-xs text-destructive">{edit("notesError")}</p>}
                            {!notesLoading && !notesFailed && notes.length === 0 && <p data-testid="media-edit-notes-empty" className="mt-3 text-xs text-muted-foreground">{edit("notesEmpty")}</p>}
                            {notes.length > 0 && <ol data-testid="media-edit-notes" className="mt-3 space-y-2">
                                {notes.map(note => <li key={note.id} data-testid="media-edit-note" className="rounded-lg border border-white/10 bg-white/[.02] p-3">
                                    <p className="font-mono text-[11px] tabular-nums text-primary">{formatFrameTimecode(note.tSeconds, fps)}</p>
                                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">{note.text}</p>
                                </li>)}
                            </ol>}
                        </div>
                    </section>
                </div>

                <aside aria-label={t("metadataLabel")} className="space-y-4">
                    <section className="rounded-2xl border border-white/10 bg-[#101214] p-4">
                        <h2 className="text-sm font-semibold">{t("metadataLabel")}</h2>
                        <dl className="mt-3 grid gap-3 text-sm">
                            <div><dt className="text-xs text-muted-foreground">{t("prompt")}</dt><dd className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{prompt}</dd></div>
                            <div><dt className="text-xs text-muted-foreground">{t("model")}</dt><dd data-testid="media-model" className="mt-1 break-words">{model}</dd></div>
                            <div><dt className="text-xs text-muted-foreground">{t("provider")}</dt><dd data-testid="media-provider" className="mt-1 break-words">{provider}</dd></div>
                            <div className="grid grid-cols-2 gap-3">
                                <div><dt className="text-xs text-muted-foreground">{t("duration")}</dt><dd data-testid="media-duration" className="mt-1 font-mono tabular-nums">{formatFrameTimecode(duration, fps)}</dd></div>
                                <div><dt className="text-xs text-muted-foreground">{t("resolution")}</dt><dd data-testid="media-resolution" className="mt-1">{resolution}</dd></div>
                            </div>
                            <div><dt className="flex items-center gap-1.5 text-xs text-muted-foreground"><CalendarDays aria-hidden="true" className="size-3.5" />{t("createdAt")}</dt><dd className="mt-1">{createdAt}</dd></div>
                            {seed !== null && <div><dt className="text-xs text-muted-foreground">{t("seed")}</dt><dd data-testid="media-seed" className="mt-1 font-mono tabular-nums">{seed}</dd></div>}
                            {params.length > 0 && <div>
                                <dt className="text-xs text-muted-foreground">{t("params")}</dt>
                                <dd className="mt-1"><dl className="grid gap-1 rounded-lg border border-white/10 bg-white/[.02] p-2 font-mono text-[11px]">
                                    {params.map(([key, value]) => <div key={key} className="flex items-start justify-between gap-3"><dt className="break-all text-muted-foreground">{key}</dt><dd className="break-all text-right">{String(value)}</dd></div>)}
                                </dl></dd>
                            </div>}
                        </dl>
                        <a href={downloadUrl} download data-testid="media-download" className={buttonVariants({ variant: "default", size: "default", className: "mt-4 w-full" })}>
                            <Download aria-hidden="true" />{t("download")}
                        </a>
                    </section>
                    <p className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[.02] p-3 text-xs leading-relaxed text-muted-foreground">
                        <Clapperboard aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{t("nativePlayerHint")}
                    </p>
                </aside>
            </div>
        </div>
    </div>;
}

function numberParam(value: unknown): number | null {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function scalar(value: unknown): string | number | boolean | null {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function formatCreatedAt(value: string, locale: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    try {
        return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date);
    } catch {
        return date.toISOString();
    }
}
