"use client";

import useSWR from "swr";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, Loader2, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getProductionLedger } from "../lib/api";

/**
 * Spend for one production: the ledger rows it owns, their totals, and a bar
 * that compares committed spend against the plan's budget cap.
 */
export function LedgerPanel({ productionId }: { productionId: string }) {
    const t = useTranslations("productions");
    const locale = useLocale();
    const money = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
    const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
    const { data, error, isLoading, mutate } = useSWR(["productions:ledger", productionId], () => getProductionLedger(productionId));

    return <section data-testid="ledger-panel" aria-labelledby="production-ledger-title"
        className="space-y-4 rounded-2xl border border-white/10 bg-[#101214] p-5">
        <div className="flex items-start justify-between gap-3">
            <div>
                <h2 id="production-ledger-title" className="flex items-center gap-2 text-sm font-semibold">
                    <Receipt aria-hidden="true" className="size-4 text-muted-foreground" />{t("ledger.title")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{t("ledger.subtitle")}</p>
            </div>
        </div>

        {isLoading && !data && <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />{t("ledger.loading")}
        </div>}

        {error && <div role="alert" data-testid="ledger-error"
            className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{t("ledger.error")}</span>
            <Button variant="outline" size="sm" onClick={() => { void mutate().catch(() => undefined); }}>{t("retry")}</Button>
        </div>}

        {data && <>
            <div data-testid="ledger-budget" data-over-budget={data.budget.overBudget ? "true" : "false"} className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
                    <p data-testid="ledger-spent">
                        {t("ledger.spentOf", { spent: money.format(data.budget.spentUsd), budget: money.format(data.budget.budgetUsd) })}
                    </p>
                    <span data-testid="ledger-remaining" className={data.budget.overBudget ? "text-red-200" : "text-emerald-200"}>
                        {data.budget.overBudget
                            ? t("ledger.overBudget", { amount: money.format(data.budget.spentUsd - data.budget.budgetUsd) })
                            : t("ledger.remaining", { amount: money.format(data.budget.remainingUsd) })}
                    </span>
                </div>
                <div role="progressbar" data-testid="ledger-budget-bar" aria-label={t("ledger.budgetBarLabel")}
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={data.budget.percentUsed}
                    className="h-2 w-full overflow-hidden rounded-full bg-white/[.08]">
                    <div className={`h-full rounded-full transition-[width] ${data.budget.overBudget ? "bg-red-400" : "bg-primary"}`}
                        style={{ width: `${data.budget.percentUsed}%` }} />
                </div>
            </div>

            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-white/[.06] pt-3 text-sm">
                <p data-testid="ledger-total" className="font-semibold">{t("ledger.total", { amount: money.format(data.totals.totalUsd) })}</p>
                <p data-testid="ledger-count" className="text-muted-foreground">{t("ledger.count", { count: data.totals.count })}</p>
                <p className="text-xs text-muted-foreground">{t("ledger.exact", { amount: money.format(data.totals.exactUsd) })}</p>
                <p className="text-xs text-muted-foreground">{t("ledger.estimated", { amount: money.format(data.totals.estimatedUsd) })}</p>
            </div>

            {data.records.length === 0 && <p data-testid="ledger-empty" className="text-sm text-muted-foreground">{t("ledger.empty")}</p>}

            {data.records.length > 0 && <ul aria-label={t("ledger.rowsLabel")} className="divide-y divide-white/[.06]">
                {data.records.map((record) => <li key={record.assetId} data-testid="ledger-row"
                    data-asset-id={record.assetId} data-provider={record.provider} data-estimated={record.estimated ? "true" : "false"}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
                    <div className="min-w-0">
                        <p className="truncate font-mono text-xs">{record.assetId}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{t("ledger.providerModel", { provider: record.provider, model: record.model })}</p>
                    </div>
                    <div className="text-right">
                        <p data-testid="ledger-row-cost" className="text-sm font-semibold tabular-nums">{money.format(record.costUsd)}</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {record.estimated ? t("ledger.estimatedBadge") : t("ledger.settledBadge")}
                        </p>
                    </div>
                    <p className="w-full text-[11px] text-muted-foreground">
                        {t("ledger.recordedAt", { date: date.format(new Date(record.createdAt)) })} · {t("ledger.license", { license: record.license })}
                    </p>
                </li>)}
            </ul>}
        </>}
    </section>;
}
