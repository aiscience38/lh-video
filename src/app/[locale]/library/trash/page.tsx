"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { AlertCircle, Loader2, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { listLibraryTrash } from "@/features/library/lib/api";

export default function TrashPage() {
    const t = useTranslations("library");
    const locale = useLocale();
    const { data, error, isLoading, mutate } = useSWR("library:trash", listLibraryTrash);
    const entries = data?.entries ?? [];
    const formatter = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);

    function formatDate(value: string | null): string {
        if (!value) return t("trash.unknownDate");
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? t("trash.unknownDate") : formatter.format(parsed);
    }

    return <div className="flex h-full min-h-0 flex-col">
        <div className="model-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto max-w-[1200px] space-y-6 px-4 py-6 sm:px-7 sm:py-9 lg:px-10">
                <header className="max-w-2xl">
                    <p className="mb-3 text-[11px] font-bold tracking-[.2em] text-primary">{t("eyebrow")}</p>
                    <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t("trash.title")}</h1>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t("trash.subtitle")}</p>
                </header>

                {error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive">
                    <AlertCircle className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">{t("trash.error")}</span>
                    <Button variant="outline" size="sm" onClick={() => { void mutate().catch(() => undefined); }}>{t("trash.retry")}</Button>
                </div>}

                {isLoading && !data && <div role="status" className="flex items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />{t("trash.loading")}
                </div>}

                {!isLoading && !error && entries.length === 0 && <div data-testid="trash-empty" className="rounded-2xl border border-dashed border-white/15 px-5 py-14 text-center">
                    <span className="mx-auto grid size-12 place-items-center rounded-2xl border border-white/10 bg-white/[.03] text-primary"><Trash2 aria-hidden="true" className="size-5" /></span>
                    <h2 className="mt-4 text-base font-semibold">{t("trash.emptyTitle")}</h2>
                    <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{t("trash.emptyHint")}</p>
                    <Link href="/library" className={`${buttonVariants({ variant: "outline" })} mt-4`}>{t("trash.emptyAction")}</Link>
                </div>}

                {entries.length > 0 && <>
                    <p role="status" className="text-sm text-muted-foreground">{t("trash.count", { count: entries.length })}</p>
                    <div className="hidden px-4 text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground sm:grid sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:gap-3" aria-hidden="true">
                        <span>{t("trash.columns.kind")}</span><span>{t("trash.columns.folder")}</span><span>{t("trash.columns.date")}</span>
                    </div>
                    <ul data-testid="trash-list" aria-label={t("trash.title")} className="divide-y divide-white/[.06] overflow-hidden rounded-2xl border border-white/10 bg-[#101214]">
                        {entries.map(entry => <li key={`${entry.kind}:${entry.folder}`} data-testid="trash-row" data-kind={entry.kind} data-folder={entry.folder}
                            className="grid gap-2 px-4 py-3 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
                            <span className="w-fit rounded-full border border-white/10 bg-white/[.04] px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{t(`trash.kinds.${entry.kind}`)}</span>
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{entry.name ?? t("trash.unknownName")}</p>
                                <code className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground" title={entry.folder}>{entry.folder}</code>
                            </div>
                            <time dateTime={entry.trashedAt ?? undefined} className="text-xs text-muted-foreground">{formatDate(entry.trashedAt)}</time>
                        </li>)}
                    </ul>
                </>}
            </div>
        </div>
    </div>;
}
