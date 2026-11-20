"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { libraryErrorKey, updateCharacter } from "../lib/api";
import type { CharacterEntity } from "../types";

export function RenameCharacterDialog({ character, onClose, onRenamed }: {
    character: CharacterEntity;
    onClose: () => void;
    onRenamed: () => void;
}) {
    const t = useTranslations("library");
    const common = useTranslations("common");
    const [name, setName] = useState(character.name);
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
            await updateCharacter(character.id, { name: trimmed });
            onRenamed();
            onClose();
        } catch (caught) {
            const key = libraryErrorKey(caught);
            setError(t.has(key) ? t(key) : t("errors.generic"));
        } finally {
            setBusy(false);
        }
    }

    return <Dialog open onOpenChange={next => { if (!next && !busy) onClose(); }}>
        <DialogContent showCloseButton={!busy} className="bg-[#141618] sm:max-w-md">
            <DialogHeader>
                <DialogTitle>{t("characters.renameTitle")}</DialogTitle>
                <DialogDescription>{t("characters.renameHint")}</DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="grid gap-4">
                <div className="grid gap-1.5">
                    <Label htmlFor="character-rename-name">{t("characters.nameLabel")}</Label>
                    <Input id="character-rename-name" value={name} onChange={event => setName(event.target.value)} autoComplete="off" maxLength={120} disabled={busy} aria-invalid={Boolean(error)} autoFocus />
                </div>
                {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{common("cancel")}</Button>
                    <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : null}{t(busy ? "characters.saving" : "characters.save")}</Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>;
}
