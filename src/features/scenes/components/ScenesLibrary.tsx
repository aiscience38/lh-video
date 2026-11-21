"use client";

import { useState } from "react";
import { AlertCircle, Clapperboard, Loader2, Plus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ScenesShell } from "./ScenesShell";
import { CreateSceneDialog } from "./CreateSceneDialog";
import { useScenes } from "../hooks/useScenes";

export function ScenesLibrary() {
    const t = useTranslations("scenes");
    const locale = useLocale();
    const { data, error, isLoading, mutate } = useScenes();
    const scenes = data?.scenes ?? [];
    const [createOpen, setCreateOpen] = useState(false);
    const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

    return <ScenesShell title={t("title")} subtitle={t("subtitle")}
        actions={<>
            <p className="text-sm text-muted-foreground" data-testid="scenes-count">{t("count", { count: scenes.length })}</p>
            <Button onClick={() => setCreateOpen(true)}><Plus />{t("new")}</Button>
        </>}>
        {error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{t("errors.load")}</span>
            <Button variant="outline" size="sm" onClick={() => { void mutate().catch(() => undefined); }}>{t("retry")}</Button>
        </div>}

        {isLoading && !data && <div role="status" className="flex items-center justify-center gap-3 py-16 text-sm text-muted-foreground"><Loader2 className="size-5 animate-spin" />{t("loading")}</div>}

        {!isLoading && !error && scenes.length === 0 && <div data-testid="scenes-empty" className="rounded-2xl border border-dashed border-white/15 px-5 py-14 text-center">
            <span className="mx-auto grid size-12 place-items-center rounded-2xl border border-white/10 bg-white/[.03] text-primary"><Clapperboard aria-hidden="true" className="size-5" /></span>
            <h2 className="mt-4 text-base font-semibold">{t("emptyTitle")}</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{t("emptyHint")}</p>
            <Button className="mt-4" onClick={() => setCreateOpen(true)}><Plus />{t("emptyAction")}</Button>
        </div>}

        {scenes.length > 0 && <ul aria-label={t("scenesListLabel")} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {scenes.map(scene => <li key={scene.id}>
                <Card data-testid="scene-card" data-scene-id={scene.id} data-slug={scene.slug} className="h-full border-white/10 bg-[#101214]">
                    <CardHeader className="gap-1">
                        <CardTitle><Link href={`/scenes/${scene.id}`} aria-label={t("open", { name: scene.name })} className="rounded-sm hover:text-primary focus-visible:outline-1">{scene.name}</Link></CardTitle>
                        <CardDescription className="font-mono text-xs">{scene.slug}</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span data-testid="scene-shot-count" data-count={scene.shots.length}>{t("shotCount", { count: scene.shots.length })}</span>
                        <span aria-hidden="true">·</span>
                        <span>{t("updated", { date: formatter.format(new Date(scene.updatedAt)) })}</span>
                    </CardContent>
                    <CardFooter className="mt-auto justify-end">
                        <Link href={`/scenes/${scene.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>{t("openBoard")}</Link>
                    </CardFooter>
                </Card>
            </li>)}
        </ul>}

        {createOpen && <CreateSceneDialog onClose={() => setCreateOpen(false)} onCreated={() => { void mutate().catch(() => undefined); }} />}
    </ScenesShell>;
}
