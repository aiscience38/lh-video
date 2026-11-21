"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createProduction, productionErrorKey, type CreateProductionInput } from "../lib/api";
import type { ProductionEffort } from "../types";

const EFFORTS: ProductionEffort[] = ["quick", "standard", "studio"];

export function CreateProductionForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
    const t = useTranslations("productions");
    const [title, setTitle] = useState("");
    const [brief, setBrief] = useState("");
    const [effort, setEffort] = useState<ProductionEffort>("standard");
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy || !title.trim()) return;
        setBusy(true);
        setFailure(null);
        try {
            const input: CreateProductionInput = { title: title.trim(), brief: brief.trim(), effort };
            await createProduction(input);
            onCreated();
        } catch (error) {
            setFailure(t(productionErrorKey(error)));
        } finally {
            setBusy(false);
        }
    }

    return <form onSubmit={submit} data-testid="production-create-form" className="space-y-4 rounded-2xl border border-white/10 bg-[#101214] p-5">
        <div>
            <h2 className="text-sm font-semibold">{t("create.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("create.hint")}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
                <Label htmlFor="production-title">{t("create.titleLabel")}</Label>
                <Input id="production-title" value={title} maxLength={120} required autoComplete="off"
                    placeholder={t("create.titlePlaceholder")} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className="space-y-1.5">
                <Label htmlFor="production-effort">{t("create.effortLabel")}</Label>
                <select id="production-effort" value={effort} onChange={(event) => setEffort(event.target.value as ProductionEffort)}
                    className="h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-[#0b0c0d]">
                    {EFFORTS.map((value) => <option key={value} value={value}>{t(`effort.${value}`)}</option>)}
                </select>
            </div>
        </div>
        <div className="space-y-1.5">
            <Label htmlFor="production-brief">{t("create.briefLabel")}</Label>
            <Textarea id="production-brief" value={brief} maxLength={4000} rows={3}
                placeholder={t("create.briefPlaceholder")} onChange={(event) => setBrief(event.target.value)} />
        </div>
        {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
        <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>{busy ? t("create.submitting") : t("create.submit")}</Button>
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>{t("create.cancel")}</Button>
        </div>
    </form>;
}
