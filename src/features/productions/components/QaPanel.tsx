"use client";

import useSWR from "swr";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, Loader2, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getProductionQa } from "../lib/api";
import { QA_FINDING_TYPES, type QaFindingType } from "../types";

function timecode(value: number): string {
    return `${value.toFixed(3)}s`;
}

/**
 * Stored QA findings for one production. Findings are grouped by defect class
 * so a black run, a freeze and an audio dropout never blur into one list.
 */
export function QaPanel({ productionId }: { productionId: string }) {
    const t = useTranslations("productions");
    const locale = useLocale();
    const saved = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
    const { data, error, isLoading, mutate } = useSWR(["productions:qa", productionId], () => getProductionQa(productionId));
    const report = data?.report ?? null;
    const groups = report
        ? QA_FINDING_TYPES.map((type: QaFindingType) => ({ type, findings: report.findings.filter((finding) => finding.type === type) }))
            .filter((group) => group.findings.length > 0)
        : [];

    return <section data-testid="qa-panel" aria-labelledby="production-qa-title"
        className="space-y-4 rounded-2xl border border-white/10 bg-[#101214] p-5">
        <div>
            <h2 id="production-qa-title" className="flex items-center gap-2 text-sm font-semibold">
                <ScanSearch aria-hidden="true" className="size-4 text-muted-foreground" />{t("qa.title")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("qa.subtitle")}</p>
        </div>

        {isLoading && !data && <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />{t("qa.loading")}
        </div>}

        {error && <div role="alert" data-testid="qa-error"
            className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{t("qa.error")}</span>
            <Button variant="outline" size="sm" onClick={() => { void mutate().catch(() => undefined); }}>{t("retry")}</Button>
        </div>}

        {data && !report && <p data-testid="qa-empty" className="rounded-xl border border-dashed border-white/15 px-4 py-6 text-sm text-muted-foreground">
            {t("qa.empty")}
        </p>}

        {report && <>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <p data-testid="qa-duration">{t("qa.duration", { duration: timecode(report.durationSeconds) })}</p>
                <p data-testid="qa-findings-count">{t("qa.findingsCount", { count: report.findings.length })}</p>
                <p>{t("qa.savedAt", { date: saved.format(new Date(report.updatedAt)) })}</p>
            </div>

            {report.contactSheetUrl && <figure className="space-y-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img data-testid="qa-contact-sheet" src={report.contactSheetUrl} alt={t("qa.contactSheetAlt")}
                    className="w-full rounded-xl border border-white/10 bg-black/40 object-contain" width={640} height={360} />
                <figcaption className="text-[11px] text-muted-foreground">{t("qa.contactSheetCaption")}</figcaption>
            </figure>}

            {report.findings.length === 0 && <p data-testid="qa-no-findings" className="text-sm text-emerald-200">{t("qa.noFindings")}</p>}

            {groups.length > 0 && <ul aria-label={t("qa.findingsLabel")} className="space-y-4">
                {groups.map((group) => <li key={group.type} data-testid="qa-group" data-type={group.type} data-count={group.findings.length}>
                    <h3 className="flex items-baseline justify-between gap-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        <span>{t(`qa.types.${group.type}`)}</span>
                        <span className="rounded-full border border-white/15 px-2 py-0.5 text-[11px] font-semibold normal-case">{group.findings.length}</span>
                    </h3>
                    <ul className="mt-2 space-y-1.5">
                        {group.findings.map((finding, index) => <li key={`${group.type}-${index}`} data-testid="qa-finding"
                            data-severity={finding.severity} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                            <time data-testid="qa-timecode" className="font-mono text-xs tabular-nums text-amber-200">
                                {t("qa.timecode", { start: timecode(finding.tStart), end: timecode(finding.tEnd) })}
                            </time>
                            <span className="min-w-0 flex-1 text-muted-foreground">{finding.detail}</span>
                        </li>)}
                    </ul>
                </li>)}
            </ul>}
        </>}
    </section>;
}
