"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { decideGate, productionErrorKey } from "../lib/api";
import { recommendedOption, type Gate } from "../types";

/**
 * One card per gate option. The recommended option is preselected, and both
 * decisions post to the single decide endpoint.
 */
export function DecisionCards({ productionId, gate, onDecided }: {
    productionId: string;
    gate: Gate;
    onDecided: () => void;
}) {
    const t = useTranslations("productions");
    const [selected, setSelected] = useState(() => recommendedOption(gate)?.id ?? "");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    async function submit(decision: "approved" | "rejected") {
        if (busy || !selected) return;
        setBusy(true);
        setFailure(null);
        try {
            await decideGate(productionId, gate.id, { decision, selected, note: note.trim() || undefined });
            onDecided();
        } catch (error) {
            setFailure(t(productionErrorKey(error)));
        } finally {
            setBusy(false);
        }
    }

    return <section data-testid="decision-cards" aria-label={t("detail.pendingTitle")}
        className="space-y-4 rounded-2xl border border-amber-400/25 bg-amber-400/[.04] p-5">
        <div>
            <h2 className="text-base font-semibold">{t("detail.pendingTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("detail.pendingHint", { stop: t(`stops.${gate.stop}`) })}</p>
        </div>

        <fieldset className="space-y-2">
            <legend className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("gate.optionsLabel")}</legend>
            {gate.options.map((option) => <label key={option.id} data-testid={`gate-option-${option.id}`}
                data-recommended={option.recommended ? "true" : "false"}
                className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors ${selected === option.id ? "border-primary/50 bg-white/[.06]" : "border-white/10 hover:bg-white/[.03]"}`}>
                <input type="radio" name={`gate-${gate.id}`} value={option.id} checked={selected === option.id}
                    onChange={() => setSelected(option.id)} className="mt-1 size-4 accent-[var(--color-primary)]" />
                <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {option.label}
                        {option.recommended && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">{t("gate.recommended")}</span>}
                    </span>
                    {option.detail && <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{option.detail}</span>}
                </span>
            </label>)}
        </fieldset>

        <div className="space-y-1.5">
            <label htmlFor={`gate-note-${gate.id}`} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("gate.noteLabel")}</label>
            <Textarea id={`gate-note-${gate.id}`} value={note} rows={2} maxLength={2000} disabled={busy}
                placeholder={t("gate.notePlaceholder")} onChange={(event) => setNote(event.target.value)} />
        </div>

        {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}

        <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy || !selected} onClick={() => { void submit("approved"); }}>
                {busy ? t("gate.submitting") : t("gate.approve")}
            </Button>
            <Button type="button" variant="outline" disabled={busy || !selected} onClick={() => { void submit("rejected"); }}>
                {t("gate.reject")}
            </Button>
        </div>
    </section>;
}
