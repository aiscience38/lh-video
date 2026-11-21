"use client";

import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createCharacter, libraryErrorKey, uploadReference } from "../lib/api";
import { INGREDIENT_KINDS, type IngredientKind } from "../types";

const MAX_REFERENCES = 8;

export function CreateCharacterDialog({ onClose, onCreated }: {
    onClose: () => void;
    onCreated: () => void;
}) {
    const t = useTranslations("library");
    const common = useTranslations("common");
    const [name, setName] = useState("");
    const [notes, setNotes] = useState("");
    const [kind, setKind] = useState<IngredientKind>("character");
    const [files, setFiles] = useState<File[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);

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
            const assetIds: string[] = [];
            for (const [index, file] of files.entries()) {
                setProgress({ index: index + 1, total: files.length });
                const uploaded = await uploadReference(file);
                assetIds.push(uploaded.assetId);
            }
            await createCharacter({ name: trimmed, notes: notes.trim(), assetIds, ingredientKind: kind });
            onCreated();
            onClose();
        } catch (caught) {
            const key = libraryErrorKey(caught);
            setError(t.has(key) ? t(key) : t("errors.generic"));
        } finally {
            setBusy(false);
            setProgress(null);
        }
    }

    function chooseFiles(selected: FileList | null) {
        setFiles(Array.from(selected ?? []).slice(0, MAX_REFERENCES));
        setError(null);
    }

    return <Dialog open onOpenChange={next => { if (!next && !busy) onClose(); }}>
        <DialogContent showCloseButton={!busy} className="bg-[#141618] sm:max-w-lg">
            <DialogHeader>
                <DialogTitle>{t("characters.createTitle")}</DialogTitle>
                <DialogDescription>{t("characters.createHint")}</DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="grid gap-4">
                <div className="grid gap-1.5">
                    <Label htmlFor="character-name">{t("characters.nameLabel")}</Label>
                    <Input id="character-name" value={name} onChange={event => setName(event.target.value)} placeholder={t("characters.namePlaceholder")} autoComplete="off" maxLength={120} disabled={busy} aria-invalid={Boolean(error)} />
                </div>
                <div className="grid gap-1.5">
                    <Label htmlFor="character-kind">{t("characters.ingredientLabel")}</Label>
                    <select id="character-kind" value={kind} onChange={event => setKind(event.target.value as IngredientKind)} disabled={busy}
                        className="h-9 rounded-lg border border-white/10 bg-[#101214] px-2 text-sm text-foreground outline-none focus-visible:border-ring">
                        {INGREDIENT_KINDS.map(value => <option key={value} value={value}>{t(`characters.kinds.${value}`)}</option>)}
                    </select>
                </div>
                <div className="grid gap-1.5">
                    <Label htmlFor="character-notes">{t("characters.notesLabel")}</Label>
                    <Textarea id="character-notes" rows={3} value={notes} onChange={event => setNotes(event.target.value)} placeholder={t("characters.notesPlaceholder")} maxLength={4000} disabled={busy} />
                </div>
                <div className="grid gap-1.5">
                    <Label htmlFor="character-references">{t("characters.referencesLabel")}</Label>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
                            <Upload />{t("characters.referencesLabel")}
                        </Button>
                        <span className="text-xs text-muted-foreground">{t("characters.filesSelected", { count: files.length })}</span>
                    </div>
                    <input ref={fileInput} id="character-references" type="file" accept="image/*" multiple className="sr-only" disabled={busy} onChange={event => chooseFiles(event.target.files)} aria-describedby="character-references-hint" />
                    <p id="character-references-hint" className="text-xs leading-relaxed text-muted-foreground">{t("characters.referencesHint", { max: MAX_REFERENCES })}</p>
                </div>
                {progress && <p role="status" className="text-xs text-muted-foreground">{t("characters.uploading", { index: progress.index, total: progress.total })}</p>}
                {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{common("cancel")}</Button>
                    <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : null}{t(busy ? "characters.creating" : "characters.create")}</Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>;
}
