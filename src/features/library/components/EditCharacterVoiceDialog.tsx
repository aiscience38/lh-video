"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { libraryErrorKey, updateCharacter } from "../lib/api";
import { DEFAULT_CHARACTER_VOICE, type CharacterEntity, type CharacterVoice } from "../types";
import { VoiceSection } from "./VoiceSection";

/** Edits only the voice profile; name/notes stay in their own dialogs. */
export function EditCharacterVoiceDialog({ character, onClose, onSaved }: {
    character: CharacterEntity;
    onClose: () => void;
    onSaved: () => void;
}) {
    const t = useTranslations("library");
    const common = useTranslations("common");
    const [voice, setVoice] = useState<CharacterVoice>(() => ({
        ...DEFAULT_CHARACTER_VOICE,
        ...character.voice,
        settings: { ...character.voice?.settings },
    }));
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await updateCharacter(character.id, { voice });
            onSaved();
            onClose();
        } catch (caught) {
            const key = libraryErrorKey(caught);
            setError(t.has(key) ? t(key) : t("errors.generic"));
        } finally {
            setBusy(false);
        }
    }

    return <Dialog open onOpenChange={next => { if (!next && !busy) onClose(); }}>
        <DialogContent showCloseButton={!busy} className="max-h-[calc(100vh-2rem)] overflow-y-auto bg-[#141618] sm:max-w-xl">
            <DialogHeader>
                <DialogTitle>{t("voice.editTitle")}</DialogTitle>
                <DialogDescription>{t("voice.editHint", { name: character.name })}</DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="grid gap-4">
                <VoiceSection idPrefix="character-edit" value={voice} onChange={setVoice} disabled={busy} />
                {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{common("cancel")}</Button>
                    <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : null}{t(busy ? "voice.saving" : "voice.save")}</Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>;
}
