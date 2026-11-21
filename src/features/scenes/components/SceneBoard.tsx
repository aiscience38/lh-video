"use client";

import { useState } from "react";
import { AlertCircle, ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ScenesShell } from "./ScenesShell";
import { AddShotDialog } from "./AddShotDialog";
import { ShotCard, SHOT_DRAG_TYPE } from "./ShotCard";
import { useScene, SCENES_KEY } from "../hooks/useScenes";
import { deriveShotStatus, useTaskStatuses } from "../hooks/useShotStatuses";
import { deleteScene, sceneErrorKey, updateSceneShots } from "../lib/api";
import { sortShots, type SceneShotInput } from "../types";
import { useSWRConfig } from "swr";

export function SceneBoard({ sceneId }: { sceneId: string }) {
    const t = useTranslations("scenes");
    const common = useTranslations("common");
    const router = useRouter();
    const { mutate: mutateCache } = useSWRConfig();
    const { data: scene, error, isLoading, mutate } = useScene(sceneId);
    const shots = scene ? sortShots(scene.shots) : [];
    const taskStatuses = useTaskStatuses(shots.flatMap(shot => shot.taskIds));

    const [addOpen, setAddOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [dragging, setDragging] = useState<string | null>(null);
    const [over, setOver] = useState<string | null>(null);
    const [deletingShot, setDeletingShot] = useState<number | null>(null);
    const [deletingScene, setDeletingScene] = useState(false);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    function failureMessage(caught: unknown): string {
        const key = sceneErrorKey(caught);
        return t.has(key) ? t(key) : t("errors.save");
    }

    async function persist(next: SceneShotInput[]): Promise<{ ok: boolean; message?: string }> {
        if (!scene) return { ok: false, message: t("errors.generic") };
        setSaving(true);
        setSaveError(null);
        try {
            const updated = await updateSceneShots(scene.id, next);
            await mutate(updated, { revalidate: false });
            return { ok: true };
        } catch (caught) {
            const message = failureMessage(caught);
            setSaveError(message);
            return { ok: false, message };
        } finally {
            setSaving(false);
        }
    }

    function moveShot(from: number, to: number) {
        if (saving || to < 0 || to >= shots.length || from === to) return;
        const next = [...shots];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        void persist(next);
    }

    function moveBefore(draggedId: string, targetId: string) {
        const from = shots.findIndex(shot => shot.id === draggedId);
        const to = shots.findIndex(shot => shot.id === targetId);
        if (from < 0 || to < 0 || from === to) return;
        moveShot(from, to);
    }

    async function addShot(shot: SceneShotInput): Promise<void> {
        if (!scene) throw new Error("ERR_LIBRARY_NOT_FOUND");
        setSaving(true);
        setSaveError(null);
        try {
            const updated = await updateSceneShots(scene.id, [...shots, shot]);
            await mutate(updated, { revalidate: false });
        } catch (caught) {
            throw new Error(sceneErrorKey(caught).replace(/^errors\./, ""));
        } finally {
            setSaving(false);
        }
    }

    async function removeShot() {
        if (deletingShot === null) return;
        const shot = shots[deletingShot];
        if (!shot) return;
        setDeleteBusy(true);
        setDeleteError(null);
        const result = await persist(shots.filter(candidate => candidate.id !== shot.id));
        if (result.ok) setDeletingShot(null);
        else setDeleteError(result.message ?? t("errors.save"));
        setDeleteBusy(false);
    }

    async function removeScene() {
        if (!scene) return;
        setDeleteBusy(true);
        setDeleteError(null);
        try {
            await deleteScene(scene.id);
            await mutateCache(SCENES_KEY);
            router.push("/scenes");
        } catch (caught) {
            setDeleteError(failureMessage(caught));
        } finally {
            setDeleteBusy(false);
        }
    }

    if (isLoading && !scene) {
        return <ScenesShell title={t("loadingScene")} subtitle={t("subtitle")}>
            <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground"><Loader2 className="size-5 animate-spin" />{t("loadingScene")}</div>
        </ScenesShell>;
    }

    if (!scene) {
        const notFound = error instanceof Error && error.message === "ERR_LIBRARY_NOT_FOUND";
        return <ScenesShell title={notFound ? t("notFound") : t("errors.load")} subtitle={t("notFoundHint")}>
            {error && !notFound && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="size-4" />{t("errors.load")}</p>}
            <Link href="/scenes" className="inline-flex items-center gap-2 text-sm text-primary"><ArrowLeft className="size-4" />{t("back")}</Link>
        </ScenesShell>;
    }

    return <ScenesShell title={scene.name} subtitle={t("sceneSubtitle", { slug: scene.slug, count: shots.length })}
        actions={<>
            <Link href="/scenes" className="inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />{t("back")}</Link>
            <div className="flex flex-wrap gap-1">
                <Button onClick={() => setAddOpen(true)} disabled={saving}><Plus />{t("addShot")}</Button>
                <Button variant="ghost" onClick={() => { setDeleteError(null); setDeletingScene(true); }} disabled={saving}><Trash2 />{t("deleteScene")}</Button>
            </div>
        </>}>
        <p id="scenes-generate-hint" className="rounded-xl border border-white/10 bg-white/[.02] p-3 text-xs leading-relaxed text-muted-foreground">{t("generateHint")}</p>
        {saveError && <p role="alert" className="flex items-center gap-2 rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"><AlertCircle className="size-4 shrink-0" />{saveError}</p>}
        {saving && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t("saving")}</p>}

        {shots.length === 0
            ? <div data-testid="shots-empty" className="rounded-2xl border border-dashed border-white/15 px-5 py-14 text-center">
                <h2 className="text-base font-semibold">{t("shotsEmptyTitle")}</h2>
                <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{t("shotsEmptyHint")}</p>
                <Button className="mt-4" onClick={() => setAddOpen(true)}><Plus />{t("addShot")}</Button>
            </div>
            : <ol aria-label={t("shotsListLabel")} className="space-y-3">
                {shots.map((shot, index) => <li key={shot.id}>
                    <ShotCard shot={shot} index={index} total={shots.length}
                        status={deriveShotStatus(shot.taskIds, taskStatuses)}
                        saving={saving} dragging={dragging === shot.id} over={over === shot.id}
                        onMove={direction => moveShot(index, index + direction)}
                        onDelete={() => { setDeleteError(null); setDeletingShot(index); }}
                        onDragStart={event => {
                            event.dataTransfer.setData(SHOT_DRAG_TYPE, shot.id);
                            event.dataTransfer.effectAllowed = "move";
                            setDragging(shot.id);
                        }}
                        onOver={event => {
                            if (dragging && dragging !== shot.id && event.dataTransfer.types.includes(SHOT_DRAG_TYPE)) {
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                setOver(shot.id);
                            }
                        }}
                        onLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(current => current === shot.id ? null : current); }}
                        onDrop={event => {
                            if (event.dataTransfer.types.includes(SHOT_DRAG_TYPE)) {
                                event.preventDefault();
                                moveBefore(event.dataTransfer.getData(SHOT_DRAG_TYPE), shot.id);
                            }
                        }}
                        onDragEnd={() => { setDragging(null); setOver(null); }} />
                </li>)}
            </ol>}

        {addOpen && <AddShotDialog onClose={() => setAddOpen(false)} onAdd={addShot} />}
        <ConfirmDialog open={deletingShot !== null} onClose={() => { if (!deleteBusy) { setDeletingShot(null); setDeleteError(null); } }}
            onConfirm={() => void removeShot()} busy={deleteBusy}
            title={t("deleteShotTitle")}
            description={t("deleteShotDescription", { index: (deletingShot ?? 0) + 1 })}
            error={deleteError ?? undefined}
            confirmLabel={t("deleteShotConfirm")}
            cancelLabel={common("cancel")} />
        <ConfirmDialog open={deletingScene} onClose={() => { if (!deleteBusy) { setDeletingScene(false); setDeleteError(null); } }}
            onConfirm={() => void removeScene()} busy={deleteBusy}
            title={t("deleteSceneTitle")}
            description={t("deleteSceneDescription", { slug: scene.slug })}
            error={deleteError ?? undefined}
            confirmLabel={t("deleteSceneConfirm")}
            cancelLabel={common("cancel")} />
    </ScenesShell>;
}
