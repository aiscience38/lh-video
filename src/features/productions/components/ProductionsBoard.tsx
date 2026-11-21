"use client";

import { useState } from "react";
import useSWR from "swr";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, Plus } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateProductionForm } from "./CreateProductionForm";
import { StopsRail } from "./StopsRail";
import { listProductions } from "../lib/api";
import { activeStop, pendingGate, sortedForBoard, type Production } from "../types";

function BoardCard({ production }: { production: Production }) {
    const t = useTranslations("productions");
    const pending = pendingGate(production);
    const stop = activeStop(production.stopStates);
    const status = pending ? t("board.pendingGate")
        : !stop ? t("board.complete")
            : t("board.atStop", { stop: t(`stops.${stop}`) });

    return <Link href={`/productions/${production.id}`} data-testid={`production-card-${production.id}`}
        aria-label={t("board.open", { title: production.title })}
        className="group block rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <Card className="h-full border-white/10 bg-[#101214] transition-colors group-hover:border-primary/40 group-hover:bg-[#141719]">
            <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <CardTitle className="text-lg">{production.title}</CardTitle>
                    <span data-testid="production-effort" className="rounded-full border border-white/15 px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                        {t(`effort.${production.effort}`)}
                    </span>
                </div>
                <CardDescription className="mt-1 line-clamp-2 leading-relaxed">
                    {production.brief.trim() || t("detail.emptyBrief")}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                <StopsRail stopStates={production.stopStates} compact />
                <p data-testid="production-status" className={`text-xs font-medium ${pending ? "text-amber-200" : !stop ? "text-emerald-200" : "text-muted-foreground"}`}>
                    {status}
                </p>
            </CardContent>
        </Card>
    </Link>;
}

export function ProductionsBoard() {
    const t = useTranslations("productions");
    const [creating, setCreating] = useState(false);
    const { data, error, isLoading, mutate } = useSWR("productions:board", listProductions);
    const productions = sortedForBoard(data ?? []);

    return <div className="flex h-full min-h-0 flex-col">
        <div className="model-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto max-w-[1200px] space-y-6 px-4 py-6 sm:px-7 sm:py-9 lg:px-10">
                <header className="max-w-2xl">
                    <p className="mb-3 text-[11px] font-bold tracking-[.2em] text-primary">{t("eyebrow")}</p>
                    <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t("title")}</h1>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t("subtitle")}</p>
                </header>

                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">{t("count", { count: productions.length })}</p>
                    <Button type="button" onClick={() => setCreating((open) => !open)} aria-expanded={creating}>
                        <Plus aria-hidden="true" className="size-4" />{t("new")}
                    </Button>
                </div>

                {creating && <CreateProductionForm
                    onCreated={() => { setCreating(false); void mutate(); }}
                    onCancel={() => setCreating(false)} />}

                {error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive">
                    <AlertCircle className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">{t("board.error")}</span>
                    <Button variant="outline" size="sm" onClick={() => { void mutate().catch(() => undefined); }}>{t("retry")}</Button>
                </div>}

                {isLoading && !data && <div role="status" className="flex items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />{t("loading")}
                </div>}

                {!isLoading && !error && productions.length === 0 && <div data-testid="productions-empty" className="rounded-2xl border border-dashed border-white/15 px-5 py-14 text-center">
                    <h2 className="text-base font-semibold">{t("board.emptyTitle")}</h2>
                    <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{t("board.emptyHint")}</p>
                </div>}

                {productions.length > 0 && <ul data-testid="productions-board" aria-label={t("board.label")} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {productions.map((production) => <li key={production.id}>
                        <BoardCard production={production} />
                    </li>)}
                </ul>}
            </div>
        </div>
    </div>;
}
