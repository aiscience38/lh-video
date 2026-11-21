"use client";

import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertCircle, Check, Loader2, Pause, Play, StepBack, StepForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LibraryShell } from "../LibraryShell";
import { libraryErrorKey } from "../../lib/api";
import {
    assetIdFromSource,
    createNote,
    noteTimecode,
    noteTimestamp,
    resolveVideoSource,
    taskIdFromSource,
} from "../../lib/storyboard-api";

const FRAME_SECONDS = 1 / 24;

export function RevisionCompare() {
    const t = useTranslations("library");
    const searchParams = useSearchParams();
    const rawA = searchParams.get("a") ?? "";
    const rawB = searchParams.get("b") ?? "";
    const sourceA = useMemo(() => resolveVideoSource(rawA), [rawA]);
    const sourceB = useMemo(() => resolveVideoSource(rawB), [rawB]);
    const subjectId = searchParams.get("subject") ?? "revisions";
    const taskId = searchParams.get("task") ?? taskIdFromSource(rawB) ?? taskIdFromSource(rawA);
    const assetB = searchParams.get("asset") ?? assetIdFromSource(rawB);

    const videoARef = useRef<HTMLVideoElement>(null);
    const videoBRef = useRef<HTMLVideoElement>(null);
    const [audioSource, setAudioSource] = useState<"a" | "b">("a");
    const [playheadA, setPlayheadA] = useState(0);
    const [playheadB, setPlayheadB] = useState(0);
    const [duration, setDuration] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    // Read the real element clocks so the data attributes prove actual sync.
    useEffect(() => {
        const timer = window.setInterval(() => {
            if (videoARef.current) {
                setPlayheadA(videoARef.current.currentTime);
                setPlaying(!videoARef.current.paused);
            }
            if (videoBRef.current) setPlayheadB(videoBRef.current.currentTime);
        }, 100);
        return () => window.clearInterval(timer);
    }, []);

    function seekBoth(time: number): void {
        const limit = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
        const next = Math.max(0, Math.min(limit, time));
        for (const video of [videoARef.current, videoBRef.current]) {
            if (!video) continue;
            try {
                video.currentTime = next;
            } catch {
                // Metadata is not ready yet; the loadedmetadata handler resyncs.
            }
        }
        setPlayheadA(next);
        setPlayheadB(next);
    }

    function handleSeeked(event: SyntheticEvent<HTMLVideoElement>): void {
        const time = event.currentTarget.currentTime;
        const other = event.currentTarget === videoARef.current ? videoBRef.current : videoARef.current;
        if (other && Math.abs(other.currentTime - time) > 0.02) {
            try {
                other.currentTime = time;
            } catch {
                // Ignore a transient seek failure; the interval keeps reporting both clocks.
            }
        }
        if (videoARef.current) setPlayheadA(videoARef.current.currentTime);
        if (videoBRef.current) setPlayheadB(videoBRef.current.currentTime);
    }

    function handleMasterTimeUpdate(event: SyntheticEvent<HTMLVideoElement>): void {
        const time = event.currentTarget.currentTime;
        const other = videoBRef.current;
        if (other && Math.abs(other.currentTime - time) > 0.12) {
            try {
                other.currentTime = time;
            } catch {
                // Ignore; the next timeupdate retries.
            }
        }
    }

    async function togglePlayback(): Promise<void> {
        const a = videoARef.current;
        const b = videoBRef.current;
        if (!a || !b) return;
        if (a.paused) {
            b.currentTime = a.currentTime;
            await Promise.allSettled([a.play(), b.play()]);
            setPlaying(!a.paused);
        } else {
            a.pause();
            b.pause();
            setPlaying(false);
        }
    }

    function stepFrame(direction: -1 | 1): void {
        const a = videoARef.current;
        if (!a) return;
        a.pause();
        videoBRef.current?.pause();
        setPlaying(false);
        seekBoth(a.currentTime + direction * FRAME_SECONDS);
    }

    async function acceptRevision(): Promise<void> {
        if (!sourceB) return;
        const seconds = noteTimestamp(playheadA);
        setBusy(true);
        setActionError(null);
        setStatus(null);
        try {
            await createNote(subjectId, {
                taskId,
                assetId: assetB,
                tSeconds: seconds,
                text: "Accepted revision B over A.",
                decision: true,
            });
            setStatus(t("revisions.accepted", { time: noteTimecode(seconds) }));
        } catch (caught) {
            const key = libraryErrorKey(caught);
            setActionError(t.has(key) ? t(key) : t("revisions.acceptError"));
        } finally {
            setBusy(false);
        }
    }

    if (!sourceA || !sourceB) {
        return <LibraryShell active="storyboards" title={t("revisions.missingTitle")} subtitle={t("revisions.missingHint")}>
            <p className="rounded-2xl border border-dashed border-white/15 px-5 py-10 text-center text-sm text-muted-foreground">
                {t("revisions.missingHint")}
            </p>
        </LibraryShell>;
    }

    const safePlayhead = duration > 0 ? Math.min(playheadA, duration) : playheadA;

    return <LibraryShell active="storyboards" title={t("revisions.title")} subtitle={t("revisions.subtitle")}>
        <div className="grid gap-4 lg:grid-cols-2">
            <figure className="rounded-2xl border border-white/10 bg-[#101214] p-3">
                <figcaption className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("revisions.cutA")}</figcaption>
                <video ref={videoARef} data-testid="revision-video-a" data-current-time={playheadA.toFixed(3)}
                    src={sourceA} preload="metadata" muted={audioSource !== "a"} playsInline
                    onLoadedMetadata={(event) => {
                        setDuration(event.currentTarget.duration || 0);
                        if (videoBRef.current) videoBRef.current.currentTime = event.currentTarget.currentTime;
                    }}
                    onDurationChange={(event) => setDuration(event.currentTarget.duration || 0)}
                    onTimeUpdate={handleMasterTimeUpdate}
                    onSeeked={handleSeeked}
                    onEnded={() => {
                        videoARef.current?.pause();
                        videoBRef.current?.pause();
                        setPlaying(false);
                    }}
                    className="aspect-video w-full rounded-xl bg-black" />
            </figure>
            <figure className="rounded-2xl border border-white/10 bg-[#101214] p-3">
                <figcaption className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("revisions.cutB")}</figcaption>
                <video ref={videoBRef} data-testid="revision-video-b" data-current-time={playheadB.toFixed(3)}
                    src={sourceB} preload="metadata" muted={audioSource !== "b"} playsInline
                    onLoadedMetadata={(event) => {
                        if (videoARef.current) event.currentTarget.currentTime = videoARef.current.currentTime;
                    }}
                    onSeeked={handleSeeked}
                    className="aspect-video w-full rounded-xl bg-black" />
            </figure>
        </div>

        <section className="space-y-4 rounded-2xl border border-white/10 bg-[#101214] p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => void togglePlayback()} data-testid="revision-play">
                    {playing ? <Pause /> : <Play />}{playing ? t("revisions.pause") : t("revisions.play")}
                </Button>
                <Button variant="outline" size="icon-sm" aria-label={t("revisions.previousFrame")} onClick={() => stepFrame(-1)} data-testid="revision-frame-back">
                    <StepBack />
                </Button>
                <Button variant="outline" size="icon-sm" aria-label={t("revisions.nextFrame")} onClick={() => stepFrame(1)} data-testid="revision-frame-forward">
                    <StepForward />
                </Button>
                <span className="ml-auto font-mono text-sm text-primary" data-testid="revision-timecode">{noteTimecode(playheadA)}</span>
            </div>

            <div>
                <label htmlFor="revision-scrub" className="block text-xs font-medium text-muted-foreground">{t("revisions.scrub")}</label>
                <input id="revision-scrub" data-testid="revision-scrub" type="range" min={0} max={duration || 0} step={0.001}
                    value={safePlayhead} onChange={(event) => {
                        videoARef.current?.pause();
                        videoBRef.current?.pause();
                        setPlaying(false);
                        seekBoth(Number(event.currentTarget.value));
                    }}
                    className="mt-2 w-full accent-primary" />
            </div>

            <fieldset>
                <legend className="text-xs font-medium text-muted-foreground">{t("revisions.audioSource")}</legend>
                <div className="mt-2 flex flex-wrap gap-4 text-sm">
                    <label className="inline-flex items-center gap-2">
                        <input type="radio" name="revision-audio" checked={audioSource === "a"} data-testid="revision-audio-a"
                            onChange={() => setAudioSource("a")} className="accent-primary" />
                        {t("revisions.audioA")}
                    </label>
                    <label className="inline-flex items-center gap-2">
                        <input type="radio" name="revision-audio" checked={audioSource === "b"} data-testid="revision-audio-b"
                            onChange={() => setAudioSource("b")} className="accent-primary" />
                        {t("revisions.audioB")}
                    </label>
                </div>
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" onClick={() => void acceptRevision()} disabled={busy} data-testid="revision-accept">
                    {busy ? <Loader2 className="animate-spin" /> : <Check />}
                    {busy ? t("revisions.accepting") : t("revisions.accept")}
                </Button>
                <span className="text-xs text-muted-foreground">{t("revisions.subject", { id: subjectId })}</span>
            </div>
            {status && <p role="status" data-testid="revision-status" className="text-sm text-primary">{status}</p>}
            {actionError && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="size-4" />{actionError}</p>}
        </section>
    </LibraryShell>;
}
