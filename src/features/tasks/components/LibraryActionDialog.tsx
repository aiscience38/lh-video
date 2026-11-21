"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { addImagesToCharacter, listCharacterOptions, listStoryboardOptions, setStoryboardKeyframe,
    type CharacterOption, type StoryboardOption } from "../lib/library-actions";

/** What the gallery wants to save and which library record receives it. */
export type LibraryTarget =
    | { kind: "character"; assetIds: string[] }
    | { kind: "storyboard"; assetId: string };

const fieldClass = "h-9 w-full rounded-lg border border-white/10 bg-[#0d0f10] px-2.5 text-sm text-foreground";
const labelClass = "grid gap-1.5 text-[11px] font-medium text-muted-foreground";

/**
 * One dialog serves both library hand-offs: appending gallery images to a
 * character, and pinning one image as a storyboard shot keyframe. It loads the
 * options on open so the list is never stale.
 */
export function LibraryActionDialog({ target, onClose, onDone }: {
    target: LibraryTarget;
    onClose: () => void;
    onDone: (message: string) => void;
}) {
    const t = useTranslations("tasks");
    const common = useTranslations("common");
    const [characters, setCharacters] = useState<CharacterOption[]>([]);
    const [storyboards, setStoryboards] = useState<StoryboardOption[]>([]);
    const [characterId, setCharacterId] = useState("");
    const [storyboardId, setStoryboardId] = useState("");
    const [shotIndex, setShotIndex] = useState(0);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        const options = target.kind === "character"
            ? listCharacterOptions().then(items => {
                if (!active) return;
                setCharacters(items);
                setCharacterId(items[0]?.id ?? "");
            })
            : listStoryboardOptions().then(items => {
                if (!active) return;
                const usable = items.filter(item => item.shots.length > 0);
                setStoryboards(usable);
                setStoryboardId(usable[0]?.id ?? "");
                setShotIndex(0);
            });
        void options.catch(() => { if (active) setError(t("libraryActionFailed")); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [target, t]);

    const storyboard = storyboards.find(item => item.id === storyboardId);
    const shots = storyboard?.shots ?? [];
    const canSubmit = target.kind === "character" ? characters.length > 0 : shots.length > 0;

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (busy || !canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            if (target.kind === "character") {
                const character = characters.find(item => item.id === characterId);
                if (!character) throw new Error("ERR_LIBRARY_NOT_FOUND");
                const updated = await addImagesToCharacter(character, target.assetIds);
                onDone(t("addedToCharacter", { count: target.assetIds.length, name: updated.name }));
            } else {
                if (!storyboard) throw new Error("ERR_LIBRARY_NOT_FOUND");
                await setStoryboardKeyframe(storyboard, shotIndex, target.assetId);
                onDone(t("keyframeSaved"));
            }
        } catch {
            setError(t("libraryActionFailed"));
        } finally {
            setBusy(false);
        }
    }

    return <Dialog open onOpenChange={next => { if (!next && !busy) onClose(); }}>
        <DialogContent className="bg-[#141618] sm:max-w-md">
            <DialogHeader>
                <DialogTitle>{t(target.kind === "character" ? "characterPickerTitle" : "storyboardPickerTitle")}</DialogTitle>
                <DialogDescription>{t(target.kind === "character" ? "characterPickerHint" : "storyboardPickerHint")}</DialogDescription>
            </DialogHeader>
            {loading
                ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("pickerLoading")}</p>
                : <form onSubmit={submit} className="grid gap-4">
                    {error && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="size-4 shrink-0" />{error}</p>}
                    {target.kind === "character"
                        ? characters.length === 0
                            ? <p className="text-sm text-muted-foreground">{t("noCharacters")}</p>
                            : <label className={labelClass}>{t("characterLabel")}
                                <select aria-label={t("characterLabel")} className={fieldClass} value={characterId} onChange={event => setCharacterId(event.target.value)}>
                                    {characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
                                </select>
                            </label>
                        : shots.length === 0
                            ? <p className="text-sm text-muted-foreground">{t("noStoryboards")}</p>
                            : <>
                                <label className={labelClass}>{t("storyboardLabel")}
                                    <select aria-label={t("storyboardLabel")} className={fieldClass} value={storyboardId} onChange={event => { setStoryboardId(event.target.value); setShotIndex(0); }}>
                                        {storyboards.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                                    </select>
                                </label>
                                <label className={labelClass}>{t("shotLabel")}
                                    <select aria-label={t("shotLabel")} className={fieldClass} value={shotIndex} onChange={event => setShotIndex(Number(event.target.value))}>
                                        {shots.map((shot, index) => <option key={shot.id} value={index}>{t("shotOption", { index: index + 1 })}</option>)}
                                    </select>
                                </label>
                            </>}
                    <DialogFooter>
                        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{common("cancel")}</Button>
                        <Button type="submit" disabled={busy || !canSubmit}>{busy && <Loader2 className="animate-spin" />}{t("pickerConfirm")}</Button>
                    </DialogFooter>
                </form>}
        </DialogContent>
    </Dialog>;
}
