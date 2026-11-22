"use client";

import { useState } from "react";
import { AlertCircle, ArrowLeft, Loader2, Mic, Pencil, Trash2 } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LibraryShell } from "./LibraryShell";
import { CharacterThumbnail } from "./CharacterThumbnail";
import { RenameCharacterDialog } from "./RenameCharacterDialog";
import { EditCharacterVoiceDialog } from "./EditCharacterVoiceDialog";
import { useCharacters } from "../hooks/useCharacters";
import { deleteCharacter, findCharacter, libraryErrorKey } from "../lib/api";

export function CharacterDetail({ slug }: { slug: string }) {
    const t = useTranslations("library");
    const common = useTranslations("common");
    const router = useRouter();
    const { data, error, isLoading, mutate } = useCharacters();
    const character = data ? findCharacter(data.entities, slug) : undefined;
    const [renaming, setRenaming] = useState(false);
    const [editingVoice, setEditingVoice] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);

    async function confirmDelete() {
        if (!character) return;
        setDeleteBusy(true);
        setDeleteError(null);
        try {
            await deleteCharacter(character.id);
            setDeleting(false);
            await mutate();
            router.push("/library/characters");
        } catch (caught) {
            const key = libraryErrorKey(caught);
            setDeleteError(t.has(key) ? t(key) : t("errors.generic"));
        } finally {
            setDeleteBusy(false);
        }
    }

    if (isLoading && !data) {
        return <LibraryShell active="characters" title={t("characters.detail.notFound")} subtitle={t("characters.detail.notFoundHint")}>
            <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground"><Loader2 className="size-5 animate-spin" />{t("characters.detail.loading")}</div>
        </LibraryShell>;
    }

    if (!character) {
        return <LibraryShell active="characters" title={t("characters.detail.notFound")} subtitle={t("characters.detail.notFoundHint")}>
            {error && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="size-4" />{t("errors.load")}</p>}
            <Link href="/library/characters" className="inline-flex items-center gap-2 text-sm text-primary"><ArrowLeft className="size-4" />{t("characters.detail.back")}</Link>
        </LibraryShell>;
    }

    return <LibraryShell active="characters" title={character.name} subtitle={t("characters.detail.slug", { slug: character.slug })}>
        <div className="flex flex-wrap items-center justify-between gap-3">
            <Link href="/library/characters" className="inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />{t("characters.detail.back")}</Link>
            <div className="flex gap-1">
                <Button variant="outline" size="sm" onClick={() => setEditingVoice(true)}><Mic />{t("characters.editVoice")}</Button>
                <Button variant="outline" size="sm" onClick={() => setRenaming(true)}><Pencil />{t("characters.rename")}</Button>
                <Button variant="ghost" size="sm" onClick={() => { setDeleteError(null); setDeleting(true); }}><Trash2 />{t("characters.delete")}</Button>
            </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <section className="rounded-2xl border border-white/10 bg-[#101214] p-5">
                <h2 className="text-sm font-semibold">{t("characters.detail.notes")}</h2>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{character.notes.trim() || t("characters.detail.noNotes")}</p>
            </section>
            <section className="rounded-2xl border border-white/10 bg-[#101214] p-5">
                <h2 className="text-sm font-semibold">{t("characters.detail.references")}</h2>
                {character.assetIds.length === 0
                    ? <p className="mt-2 text-sm text-muted-foreground">{t("characters.references", { count: 0 })}</p>
                    : <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {character.assetIds.map(assetId => <CharacterThumbnail key={assetId} assetId={assetId} name={character.name} className="aspect-square w-full rounded-xl" />)}
                    </div>}
            </section>
        </div>

        {renaming && <RenameCharacterDialog character={character} onClose={() => setRenaming(false)} onRenamed={() => { void mutate().catch(() => undefined); }} />}
        {editingVoice && <EditCharacterVoiceDialog character={character} onClose={() => setEditingVoice(false)} onSaved={() => { void mutate().catch(() => undefined); }} />}
        <ConfirmDialog open={deleting} onClose={() => { if (!deleteBusy) { setDeleting(false); setDeleteError(null); } }}
            onConfirm={() => void confirmDelete()} busy={deleteBusy}
            title={t("characters.deleteTitle")}
            description={t("characters.deleteDescription", { slug: character.slug })}
            error={deleteError ?? undefined}
            confirmLabel={t("characters.deleteConfirm")}
            cancelLabel={common("cancel")} />
    </LibraryShell>;
}
