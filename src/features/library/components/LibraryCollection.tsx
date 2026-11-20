"use client";

import useSWR from "swr";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LibraryShell } from "./LibraryShell";
import { listLibrary } from "../lib/api";
import type { LibraryEntity } from "../types";

export function LibraryCollection({ kind }: { kind: "scene" | "storyboard" }) {
    const section = kind === "scene" ? "scenes" : "storyboards";
    const t = useTranslations("library");
    const locale = useLocale();
    const { data, error, isLoading, mutate } = useSWR(`library:${kind}s`, () => listLibrary(kind));
    const entities: LibraryEntity[] = (data?.entities ?? []).filter(entity => entity.kind === kind);
    const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

    return <LibraryShell active={section} title={t(`${section}.title`)} subtitle={t(`${section}.subtitle`)}>
        {error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{t("errors.load")}</span>
            <Button variant="outline" size="sm" onClick={() => { void mutate().catch(() => undefined); }}>{t("collection.retry")}</Button>
        </div>}

        {isLoading && !data && <div role="status" className="flex items-center justify-center gap-3 py-16 text-sm text-muted-foreground"><Loader2 className="size-5 animate-spin" />{t("collection.loading")}</div>}

        {!isLoading && !error && entities.length === 0 && <div className="rounded-2xl border border-dashed border-white/15 px-5 py-14 text-center">
            <h2 className="text-base font-semibold">{t(`${section}.emptyTitle`)}</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{t(`${section}.emptyHint`)}</p>
        </div>}

        {entities.length > 0 && <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t("collection.count", { count: entities.length })}</p>
            <ul aria-label={t(`${section}.listLabel`)} className="divide-y divide-white/[.06] overflow-hidden rounded-2xl border border-white/10 bg-[#101214]">
                {entities.map(entity => <li key={entity.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
                    <span className="text-sm font-medium">{entity.name}</span>
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{entity.slug}</span>
                    <span className="text-xs text-muted-foreground">{t("collection.updated", { date: formatter.format(new Date(entity.updatedAt)) })}</span>
                </li>)}
            </ul>
        </div>}
    </LibraryShell>;
}
