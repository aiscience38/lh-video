"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { AlertCircle, ImageOff, Images, Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ReferenceRefusal, ReferenceSlot, ReferenceSource } from "@/models/reference-selection";
import { countSourceAssets, referenceRefusalCopy, resolveReferenceAssets } from "@/models/reference-selection";
import { listLibrary } from "../lib/api";
import { libraryAssetUrl } from "../lib/asset-url";
import { libraryAssetIds } from "../lib/reference-assets";
import type { LibraryEntity, LibraryKind } from "../types";

const KIND_FILTERS = ["all", "character", "scene", "storyboard"] as const;
type KindFilter = (typeof KIND_FILTERS)[number];

function sourceOf(entity: LibraryEntity): ReferenceSource {
    return {
        entityId: entity.id,
        entityName: entity.name,
        libraryKind: entity.kind as LibraryKind,
        assetIds: libraryAssetIds(entity),
    };
}

function Preview({ assetId, name, failedLabel }: { assetId?: string; name: string; failedLabel: string }) {
    const [failed, setFailed] = useState(false);
    const url = assetId ? libraryAssetUrl(assetId) : null;
    if (!url || failed) {
        return <span className="grid size-full place-items-center bg-white/[.03] text-muted-foreground">
            <ImageOff aria-label={failedLabel} className="size-6" />
        </span>;
    }
    return <span className="block size-full overflow-hidden bg-black/30">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={name} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-cover" />
    </span>;
}

export function ReferencePickerDialog({ open, onClose, onConfirm, slots, occupied, capabilityLabel }: {
    open: boolean;
    onClose: () => void;
    /** The selected library entries; the composer resolves them into capability slots. */
    onConfirm: (sources: ReferenceSource[]) => void;
    slots: ReferenceSlot[];
    occupied: Record<string, number>;
    capabilityLabel: string;
}) {
    const t = useTranslations("picker");
    const { data, error, isLoading, mutate } = useSWR(open ? "library:picker" : null, () => listLibrary());
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState<KindFilter>("all");
    const [selected, setSelected] = useState<Record<string, ReferenceSource>>({});

    const entities = useMemo(() => (data?.entities ?? []).map((entity) => ({ entity, assetIds: libraryAssetIds(entity) })), [data]);
    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return entities.filter(({ entity }) => {
            if (kind !== "all" && entity.kind !== kind) return false;
            if (!needle) return true;
            return entity.name.toLowerCase().includes(needle) || entity.slug.toLowerCase().includes(needle);
        });
    }, [entities, kind, query]);

    const sources = useMemo(() => Object.values(selected), [selected]);
    const resolution = useMemo(() => resolveReferenceAssets(sources, slots, occupied), [sources, slots, occupied]);
    const total = countSourceAssets(sources);
    const refused = resolution.refused;

    function toggle(entity: LibraryEntity, assetIds: string[]) {
        if (assetIds.length === 0) return;
        setSelected((previous) => {
            const next = { ...previous };
            if (next[entity.id]) delete next[entity.id];
            else next[entity.id] = sourceOf(entity);
            return next;
        });
    }

    function refusalText(refusal: ReferenceRefusal) {
        const copy = referenceRefusalCopy(refusal, capabilityLabel);
        return t(copy.key, copy.values);
    }

    return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
        <DialogContent data-testid="reference-picker" className="max-h-[calc(100dvh-2rem)] overflow-y-auto bg-[#141618] sm:max-w-3xl">
            <DialogHeader>
                <DialogTitle className="flex items-center gap-2"><Images aria-hidden="true" className="size-4 text-primary" />{t("title")}</DialogTitle>
                <DialogDescription>{t("hint", { capability: capabilityLabel })}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-2">
                <div className="relative">
                    <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        aria-label={t("searchLabel")}
                        placeholder={t("searchPlaceholder")}
                        className="pl-8"
                    />
                </div>
                <div role="group" aria-label={t("filterLabel")} className="flex flex-wrap gap-1.5">
                    {KIND_FILTERS.map((filter) => <button
                        key={filter}
                        type="button"
                        aria-pressed={kind === filter}
                        data-testid={`picker-kind-${filter}`}
                        onClick={() => setKind(filter)}
                        className={`h-8 rounded-full border px-3 text-[11px] font-semibold transition-colors ${kind === filter ? "border-primary/50 bg-primary/10 text-primary" : "border-white/15 bg-white/[.04] text-muted-foreground hover:bg-white/[.08]"}`}
                    >
                        {t(`kinds.${filter}`)}
                    </button>)}
                </div>
            </div>

            {error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">{t("loadError")}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => { void mutate().catch(() => undefined); }}>{t("retry")}</Button>
            </div>}

            {isLoading && !data && !error && <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />{t("loading")}
            </div>}

            {!error && data && entities.length === 0 && <p className="rounded-xl border border-dashed border-white/15 px-4 py-8 text-center text-sm text-muted-foreground">{t("emptyLibrary")}</p>}
            {!error && data && entities.length > 0 && visible.length === 0 && <p className="rounded-xl border border-dashed border-white/15 px-4 py-8 text-center text-sm text-muted-foreground">{t("emptySearch")}</p>}

            {visible.length > 0 && <div data-testid="picker-grid" className="grid max-h-[40dvh] grid-cols-2 gap-2 overflow-y-auto overscroll-contain pr-0.5 sm:max-h-[46dvh] sm:grid-cols-3 lg:grid-cols-4">
                {visible.map(({ entity, assetIds }) => {
                    const selectable = assetIds.length > 0;
                    const isSelected = Boolean(selected[entity.id]);
                    return <button
                        key={entity.id}
                        type="button"
                        data-testid="picker-card"
                        data-kind={entity.kind}
                        aria-pressed={isSelected}
                        aria-disabled={!selectable}
                        onClick={() => toggle(entity, assetIds)}
                        className={`group flex min-w-0 flex-col overflow-hidden rounded-xl border text-left transition-colors ${isSelected ? "border-primary/60 bg-primary/[.08]" : "border-white/10 bg-white/[.02] hover:border-white/25"} ${selectable ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
                    >
                        <span className="relative block aspect-[4/3] w-full">
                            <Preview assetId={assetIds[0]} name={entity.name} failedLabel={t("noAssets")} />
                            {isSelected && <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-primary text-[11px] font-bold text-black">✓</span>}
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
                            <span className="truncate text-[12px] font-semibold text-foreground">{entity.name}</span>
                            <span className="truncate text-[10px] text-muted-foreground">{t(`kinds.${entity.kind}`)}</span>
                            <span className="text-[10px] text-muted-foreground">{selectable ? t("imageCount", { count: assetIds.length }) : t("noAssets")}</span>
                        </span>
                    </button>;
                })}
            </div>}

            <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                    <p data-testid="picker-selection-summary">{t("selectedCount", { count: sources.length })} · {t("readyCount", { count: resolution.assignments.length })}</p>
                    {refused.length > 0 && <p data-testid="picker-capacity-note" className="mt-1 text-[#ffc4c4]">{t("capacityNote", { ready: resolution.assignments.length, total, capability: capabilityLabel })}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Button type="button" variant="ghost" onClick={onClose}>{t("cancel")}</Button>
                    <Button type="button" disabled={resolution.assignments.length === 0} onClick={() => onConfirm(sources)}>{t("attach")}</Button>
                </div>
            </DialogFooter>

            {refused.length > 0 && <div data-testid="picker-refusals" role="alert" className="rounded-xl border border-[#ff8080]/25 bg-[#ff8080]/[.06] p-3">
                <p className="mb-1 text-[11px] font-bold tracking-[.08em] uppercase text-[#ffc4c4]">{t("refusalsTitle")}</p>
                <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-[#ffc4c4]">
                    {refused.map((refusal) => <li key={`${refusal.entityId}:${refusal.assetId}:${refusal.reason}`}>{refusalText(refusal)}</li>)}
                </ul>
            </div>}
        </DialogContent>
    </Dialog>;
}
