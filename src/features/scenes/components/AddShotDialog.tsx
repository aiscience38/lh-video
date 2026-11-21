"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SceneShotInput } from "../types";

export function AddShotDialog({ onClose, onAdd }: {
    onClose: () => void;
    onAdd: (shot: SceneShotInput) => Promise<void>;
}) {
    const t = useTranslations("scenes");
    const common = useTranslations("common");
    const [prompt, setPrompt] = useState("");
    const [capabilityId, setCapabilityId] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        const trimmed = prompt.trim();
        if (!trimmed) {
            setError(t("errors.ERR_SHOT_PROMPT_REQUIRED"));
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await onAdd({ prompt: trimmed, capabilityId: capabilityId.trim() || null });
            onClose();
        } catch (caught) {
            const message = caught instanceof Error && caught.message ? caught.message : "";
            setError(t.has(`errors.${message}`) ? t(`errors.${message}`) : t("errors.save"));
        } finally {
            setBusy(false);
        }
    }

    return <Dialog open onOpenChange={next => { if (!next && !busy) onClose(); }}>
        <DialogContent showCloseButton={!busy} className="bg-[#141618] sm:max-w-lg">
            <DialogHeader>
                <DialogTitle>{t("addShotTitle")}</DialogTitle>
                <DialogDescription>{t("addShotHint")}</DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="grid gap-4">
                <div className="grid gap-1.5">
                    <Label htmlFor="shot-prompt">{t("promptLabel")}</Label>
                    <Textarea id="shot-prompt" rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={t("promptPlaceholder")} maxLength={4000} disabled={busy} aria-invalid={Boolean(error)} />
                </div>
                <div className="grid gap-1.5">
                    <Label htmlFor="shot-capability">{t("capabilityLabel")}</Label>
                    <Input id="shot-capability" value={capabilityId} onChange={event => setCapabilityId(event.target.value)} placeholder={t("capabilityPlaceholder")} autoComplete="off" maxLength={200} disabled={busy} />
                    <p className="text-xs leading-relaxed text-muted-foreground">{t("capabilityHint")}</p>
                </div>
                {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{common("cancel")}</Button>
                    <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : null}{t(busy ? "adding" : "add")}</Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>;
}
