"use client";

import { useTranslations } from "next-intl";
import { PRODUCTION_STOPS, stopTone, type StopStates } from "../types";

const TONE_CLASSES: Record<string, string> = {
    amber: "border-amber-400/50 bg-amber-400/10 text-amber-200",
    violet: "border-violet-400/50 bg-violet-400/10 text-violet-200",
    green: "border-emerald-400/50 bg-emerald-400/10 text-emerald-200",
    red: "border-red-400/50 bg-red-400/10 text-red-200",
};

/** Ordered pipeline rail: one chip per stop, colour carried in `data-tone`. */
export function StopsRail({ stopStates, compact = false }: { stopStates: StopStates; compact?: boolean }) {
    const t = useTranslations("productions");

    return <ol data-testid="stops-rail" aria-label={t("rail.label")} className="flex flex-wrap items-center gap-1.5">
        {PRODUCTION_STOPS.map((stop) => {
            const state = stopStates[stop];
            const tone = stopTone(state);
            return <li key={stop} data-stop={stop} data-state={state} data-tone={tone}
                aria-label={`${t(`stops.${stop}`)}: ${t(`states.${state}`)}`}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASSES[tone]}`}>
                <span>{t(`stops.${stop}`)}</span>
                {!compact && <span className="opacity-80">{t(`states.${state}`)}</span>}
            </li>;
        })}
    </ol>;
}
