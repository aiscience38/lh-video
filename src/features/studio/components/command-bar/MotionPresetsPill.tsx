"use client";

import { useState } from "react";
import { Move } from "lucide-react";
import { useTranslations } from "next-intl";
import type { MotionPreset } from "@/models/motion-params";
import { PillPopover } from "./PillPopover";

/**
 * Camera motion pill. The preset chips are only rendered when the selected
 * capability's family supports motion (the caller decides), so an image model
 * never shows camera controls.
 */
export function MotionPresetsPill({ presets, value, onChange }: {
    presets: MotionPreset[];
    value: string | null;
    onChange: (id: string | null) => void;
}) {
    const t = useTranslations("motion");
    const [open, setOpen] = useState(false);
    const active = presets.find((preset) => preset.id === value) ?? null;
    const labelOf = (preset: MotionPreset) => t.has(`presets.${preset.id}.label`) ? t(`presets.${preset.id}.label`) : preset.label;

    return <PillPopover
        open={open}
        onOpenChange={setOpen}
        width="w-80"
        triggerLabel={t("pillLabel")}
        trigger={<><Move className="size-4" /><span className="max-w-32 truncate">{active ? labelOf(active) : t("pillLabel")}</span></>}
    >
        <p className="text-sm font-semibold">{t("title")}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("hint")}</p>
        <div role="group" aria-label={t("title")} className="mt-1 flex flex-wrap gap-1.5">
            <button
                type="button"
                aria-pressed={!value}
                data-testid="motion-preset-none"
                onClick={() => onChange(null)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${!value ? "border-primary/50 bg-primary/10 text-primary" : "border-white/15 bg-white/[.04] text-muted-foreground hover:bg-white/[.08]"}`}
            >
                {t("none")}
            </button>
            {presets.map((preset) => <button
                key={preset.id}
                type="button"
                aria-pressed={value === preset.id}
                data-testid={`motion-preset-${preset.id}`}
                title={preset.promptFragment}
                onClick={() => onChange(preset.id)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${value === preset.id ? "border-primary/50 bg-primary/10 text-primary" : "border-white/15 bg-white/[.04] text-muted-foreground hover:bg-white/[.08]"}`}
            >
                {labelOf(preset)}
            </button>)}
        </div>
    </PillPopover>;
}
