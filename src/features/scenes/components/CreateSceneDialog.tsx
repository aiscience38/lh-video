"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createScene, sceneErrorKey } from "../lib/api";

export function CreateSceneDialog({ onClose, onCreated }: {
    onClose: () => void;
    onCreated: () => void;
}) {
    const t = useTranslations("scenes");
    const common = useTranslations("common");
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        const trimmed = name.trim();
        if (trimmed.length < 2) {
            setError(t("errors.ERR_LIBRARY_INVALID"));
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await createScene(trimmed);
            onCreated();
            onClose();
        } catch (caught) {
            const key = sceneErrorKey(caught);
            setError(t.has(key) ? t(key) : t("errors.generic"));
        } finally {
            setBusy(false);
        }
    }

    return <Dialog open onOpenChange={next => { if (!next && !busy) onClose(); }}>
        <DialogContent showCloseButton={!busy} className="bg-[#141618] sm:max-w-lg">
            <DialogHeader>
                <DialogTitle>{t("createTitle")}</DialogTitle>
                <DialogDescription>{t("createHint")}</DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="grid gap-4">
                <div className="grid gap-1.5">
                    <Label htmlFor="scene-name">{t("nameLabel")}</Label>
                    <Input id="scene-name" value={name} onChange={event => setName(event.target.value)} placeholder={t("namePlaceholder")} autoComplete="off" maxLength={120} disabled={busy} aria-invalid={Boolean(error)} />
                </div>
                {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{common("cancel")}</Button>
                    <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : null}{t(busy ? "creating" : "create")}</Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>;
}
