"use client";

import { useState } from "react";
import useSWR from "swr";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DecisionCards } from "./DecisionCards";
import { StopsRail } from "./StopsRail";
import { advanceProduction, getProduction, productionErrorKey, requestGate, ProductionRequestError } from "../lib/api";
import { activeStop, isComplete, optionLabel, pendingGate, type Production } from "../types";

/** Requests a decision on the active stop: one option per line, first one recommended. */
function RequestGatePanel({ production, onRequested }: { production: Production; onRequested: () => void }) {
    const t = useTranslations("productions");
    const stop = activeStop(production.stopStates);
    const [options, setOptions] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    if (!stop) return null;
    const gateStop = stop;

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        const labels = options.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6);
        if (labels.length === 0) return;
        setBusy(true);
        setFailure(null);
        try {
            await requestGate(production.id, {
                stop: gateStop,
                note: note.trim(),
                options: labels.map((label, index) => ({ label, recommended: index === 0 })),
            });
            setOptions("");
            setNote("");
            onRequested();
        } catch (error) {
            setFailure(t(productionErrorKey(error)));
        } finally {
            setBusy(false);
        }
    }

    return <form onSubmit={submit} data-testid="gate-request-form" className="space-y-3 rounded-2xl border border-white/10 bg-[#101214] p-5">
        <div>
            <h2 className="text-sm font-semibold">{t("gate.requestTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("gate.requestHint", { stop: t(`stops.${stop}`) })}</p>
        </div>
        <div className="space-y-1.5">
            <label htmlFor="gate-options" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("gate.optionsInputLabel")}</label>
            <Textarea id="gate-options" value={options} rows={3} maxLength={1000} disabled={busy} required
                placeholder={t("gate.optionsInputPlaceholder")} onChange={(event) => setOptions(event.target.value)} />
            <p className="text-xs text-muted-foreground">{t("gate.optionsHelp")}</p>
        </div>
        <div className="space-y-1.5">
            <label htmlFor="gate-request-note" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("gate.noteLabel")}</label>
            <Textarea id="gate-request-note" value={note} rows={2} maxLength={2000} disabled={busy}
                placeholder={t("gate.notePlaceholder")} onChange={(event) => setNote(event.target.value)} />
        </div>
        {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
        <Button type="submit" disabled={busy || !options.trim()}>{busy ? t("gate.requesting") : t("gate.requestSubmit")}</Button>
    </form>;
}

function GateHistory({ production }: { production: Production }) {
    const t = useTranslations("productions");
    const locale = useLocale();
    const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
    const decided = production.gates.filter((gate) => gate.state !== "pending").slice().reverse();

    return <section className="rounded-2xl border border-white/10 bg-[#101214] p-5">
        <h2 className="text-sm font-semibold">{t("detail.historyTitle")}</h2>
        {decided.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t("detail.historyEmpty")}</p>}
        {decided.length > 0 && <ul className="mt-3 space-y-3">
            {decided.map((gate) => <li key={gate.id} data-testid={`gate-history-${gate.id}`} className="rounded-xl border border-white/[.06] p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className={`text-xs font-semibold ${gate.state === "approved" ? "text-emerald-200" : "text-amber-200"}`}>
                        {gate.state === "approved" ? t("gate.decidedApproved") : t("gate.decidedRejected")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        {gate.decidedAt ? t("gate.decidedAt", { date: formatter.format(new Date(gate.decidedAt)) }) : ""}
                    </span>
                </div>
                <p className="mt-1 text-sm">{t("detail.historyStop", { stop: t(`stops.${gate.stop}`), option: optionLabel(gate, gate.selected) ?? t("detail.historyNoOption") })}</p>
                {gate.note && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{gate.note}</p>}
            </li>)}
        </ul>}
    </section>;
}

export function ProductionDetail({ id }: { id: string }) {
    const t = useTranslations("productions");
    const locale = useLocale();
    const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
    const { data: production, error, isLoading, mutate } = useSWR(["productions:detail", id], () => getProduction(id));
    const [advancing, setAdvancing] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    const back = <Link href="/productions" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden="true" className="size-4" />{t("detail.back")}
    </Link>;

    if (error) {
        const missing = error instanceof ProductionRequestError && error.status === 404;
        return <div className="mx-auto max-w-[1000px] space-y-6 px-4 py-9 sm:px-7">
            {back}
            <div role="alert" className="rounded-2xl border border-white/10 bg-[#101214] p-6">
                <h1 className="text-xl font-semibold">{missing ? t("detail.notFound") : t("detail.errorTitle")}</h1>
                <p className="mt-2 text-sm text-muted-foreground">{missing ? t("detail.notFoundHint") : t(productionErrorKey(error))}</p>
            </div>
        </div>;
    }

    if (isLoading || !production) {
        return <div role="status" className="flex items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />{t("loading")}
        </div>;
    }

    const pending = pendingGate(production);
    const stop = activeStop(production.stopStates);
    const blocked = stop !== null && production.stopStates[stop] === "blocked";
    const complete = isComplete(production);

    async function advance() {
        setAdvancing(true);
        setFailure(null);
        try {
            await advanceProduction(id);
            await mutate();
        } catch (advanceError) {
            setFailure(t(productionErrorKey(advanceError)));
        } finally {
            setAdvancing(false);
        }
    }

    return <div className="model-scrollbar h-full overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[1000px] space-y-5 px-4 py-6 sm:px-7 sm:py-9">
            {back}
            <header className="max-w-3xl">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{production.title}</h1>
                    <span className="rounded-full border border-white/15 px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">{t(`effort.${production.effort}`)}</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{t("detail.meta", { date: formatter.format(new Date(production.updatedAt)) })}</p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{production.brief.trim() || t("detail.emptyBrief")}</p>
            </header>

            <section className="space-y-2 rounded-2xl border border-white/10 bg-[#101214] p-5">
                <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("rail.label")}</h2>
                <StopsRail stopStates={production.stopStates} />
            </section>

            {pending && <DecisionCards key={pending.id} productionId={id} gate={pending} onDecided={() => { void mutate(); }} />}

            {!pending && <div className="space-y-3 rounded-2xl border border-white/10 bg-[#101214] p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-semibold">{complete ? t("detail.completeHint") : blocked ? t("detail.blockedHint") : t("detail.noPendingTitle")}</h2>
                        {!complete && !blocked && <p className="mt-1 text-sm text-muted-foreground">{t("detail.noPendingHint")}</p>}
                    </div>
                    {!complete && !blocked && <Button type="button" disabled={advancing} onClick={() => { void advance(); }}>
                        {advancing ? t("detail.advancing") : t("detail.advance")}
                    </Button>}
                </div>
                {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
            </div>}

            {!pending && !complete && !blocked && stop && <RequestGatePanel production={production} onRequested={() => { void mutate(); }} />}

            <GateHistory production={production} />
        </div>
    </div>;
}
