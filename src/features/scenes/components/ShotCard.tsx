"use client";

import { ArrowDown, ArrowUp, Film, GripVertical, MoreHorizontal, Trash2, Wand2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Link } from "@/i18n/navigation";
import type { SceneShot, ShotStatus } from "../types";

const STATUS_CLASS: Record<ShotStatus, string> = {
    idle: "border-white/10 bg-white/[.04] text-muted-foreground",
    queued: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    running: "border-primary/40 bg-primary/10 text-primary",
    done: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
    failed: "border-destructive/40 bg-destructive/10 text-destructive",
};

export const SHOT_DRAG_TYPE = "application/x-lh-scene-shot";

export function ShotCard({ shot, index, total, status, videoTaskIds, saving, dragging, over, onMove, onDelete, onDragStart, onOver, onLeave, onDrop, onDragEnd }: {
    shot: SceneShot;
    index: number;
    total: number;
    status: ShotStatus;
    videoTaskIds: string[];
    saving: boolean;
    dragging: boolean;
    over: boolean;
    onMove: (direction: number) => void;
    onDelete: () => void;
    onDragStart: (event: React.DragEvent) => void;
    onOver: (event: React.DragEvent) => void;
    onLeave: (event: React.DragEvent) => void;
    onDrop: (event: React.DragEvent) => void;
    onDragEnd: () => void;
}) {
    const t = useTranslations("scenes");

    return <article data-testid="shot-card" data-shot-id={shot.id} data-order={index} draggable={!saving}
        onDragStart={onDragStart} onDragOver={onOver} onDragLeave={onLeave} onDrop={onDrop} onDragEnd={onDragEnd}
        className={`rounded-2xl border bg-[#101214] p-4 transition-[opacity,box-shadow] ${over ? "border-primary/60 ring-2 ring-primary/30" : "border-white/10"} ${dragging ? "opacity-40" : ""}`}>
        <div className="flex items-start gap-3">
            <span aria-hidden="true" title={t("dragHint")} className={`mt-1.5 shrink-0 text-muted-foreground ${saving ? "" : "cursor-grab active:cursor-grabbing"}`}><GripVertical className="size-4" /></span>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold">{t("shotLabel", { index: index + 1 })}</h2>
                    <Badge data-testid="shot-status" data-status={status} variant="outline" className={STATUS_CLASS[status]}>{t(`status.${status}`)}</Badge>
                    {shot.taskIds.length > 0 && <span className="text-xs text-muted-foreground">{t("taskCount", { count: shot.taskIds.length })}</span>}
                </div>
                <p data-testid="shot-prompt" className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">{shot.prompt.trim() || t("noPrompt")}</p>
                {videoTaskIds.length > 0 && <ul className="mt-2 flex flex-wrap gap-2">
                    {videoTaskIds.map(taskId => <li key={taskId}>
                        <Link href={`/media/${encodeURIComponent(taskId)}`} data-testid="shot-video-link"
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary">
                            <Film aria-hidden="true" className="size-3.5" />{t("openVideo")}
                        </Link>
                    </li>)}
                </ul>}
                {shot.capabilityId && <p className="mt-2 font-mono text-xs text-muted-foreground">{shot.capabilityId}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-1">
                    <Button type="button" size="sm" disabled data-testid="shot-generate" title={t("generateHint")} aria-describedby="scenes-generate-hint"><Wand2 />{t("generate")}</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={onDelete} disabled={saving}><Trash2 />{t("deleteShot")}</Button>
                </div>
            </div>
            <DropdownMenu>
                <DropdownMenuTrigger aria-label={t("moreActions")} title={t("moreActions")} data-testid="shot-menu" disabled={saving} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-50"><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48 p-1.5">
                    <DropdownMenuItem className="min-h-9" disabled={index === 0 || saving} onClick={() => onMove(-1)}><ArrowUp />{t("moveEarlier")}</DropdownMenuItem>
                    <DropdownMenuItem className="min-h-9" disabled={index === total - 1 || saving} onClick={() => onMove(1)}><ArrowDown />{t("moveLater")}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" className="min-h-9" disabled={saving} onClick={onDelete}><Trash2 />{t("deleteShot")}</DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    </article>;
}
