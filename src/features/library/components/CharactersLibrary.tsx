"use client";

import { useState } from "react";
import { AlertCircle, FolderInput, Loader2, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LibraryShell } from "./LibraryShell";
import { CharacterThumbnail } from "./CharacterThumbnail";
import { CreateCharacterDialog } from "./CreateCharacterDialog";
import { FolderImportDialog } from "./FolderImportDialog";
import { RenameCharacterDialog } from "./RenameCharacterDialog";
import { useCharacters } from "../hooks/useCharacters";
import { deleteCharacter, libraryErrorKey } from "../lib/api";
import { isCharacter, type CharacterEntity } from "../types";

export function CharactersLibrary() {
    const t = useTranslations("library");
    const common = useTranslations("common");
    const { data, error, isLoading, mutate } = useCharacters();
    const characters = (data?.entities ?? []).filter(isCharacter);
    const [createOpen, setCreateOpen] = useState(false);
    const [importOpen, setImportOpen] = useState(false);
    const [renaming, setRenaming] = useState<CharacterEntity | null>(null);
    const [deleting, setDeleting] = useState<CharacterEntity | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);

    async function confirmDelete() {
        if (!deleting) return;
        setDeleteBusy(true);
        setDeleteError(null);
        try {
            await deleteCharacter(deleting.id);
            setDeleting(null);
            await mutate();
        } catch (caught) {
            const key = libraryErrorKey(caught);
            setDeleteError(t.has(key) ? t(key) : t("errors.generic"));
        } finally {
            setDeleteBusy(false);
        }
    }

    return <LibraryShell active="characters" title={t("characters.title")} subtitle={t("characters.subtitle")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{t("collection.count", { count: characters.length })}</p>
            <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" data-testid="folder-import-trigger" onClick={() => setImportOpen(true)}><FolderInput />{t("import.trigger")}</Button>
                <Button onClick={() => setCreateOpen(true)}><Plus />{t("characters.new")}</Button>
            </div>
        </div>

        {error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{t("errors.load")}</span>
            <Button variant="outline" size="sm" onClick={() => { void mutate().catch(() => undefined); }}>{t("overview.retry")}</Button>
        </div>}

        {isLoading && !data && <div role="status" className="flex items-center justify-center gap-3 py-16 text-sm text-muted-foreground"><Loader2 className="size-5 animate-spin" />{t("overview.loading")}</div>}

        {!isLoading && !error && characters.length === 0 && <div data-testid="characters-empty" className="rounded-2xl border border-dashed border-white/15 px-5 py-14 text-center">
            <span className="mx-auto grid size-12 place-items-center rounded-2xl border border-white/10 bg-white/[.03] text-primary"><Users aria-hidden="true" className="size-5" /></span>
            <h2 className="mt-4 text-base font-semibold">{t("characters.emptyTitle")}</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{t("characters.emptyHint")}</p>
            <Button className="mt-4" onClick={() => setCreateOpen(true)}><Plus />{t("characters.emptyAction")}</Button>
        </div>}

        {characters.length > 0 && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {characters.map(character => <Card key={character.id} data-testid="character-card" data-slug={character.slug} className="border-white/10 bg-[#101214]">
                <Link href={`/library/characters/${character.slug}`} className="block outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    <CharacterThumbnail assetId={character.assetIds[0]} name={character.name} className="aspect-[4/3] w-full" />
                </Link>
                <CardHeader className="gap-1">
                    <CardTitle><Link href={`/library/characters/${character.slug}`} className="rounded-sm hover:text-primary focus-visible:outline-1">{character.name}</Link></CardTitle>
                    <CardDescription>
                        <span data-testid="character-reference-count" data-count={character.assetIds.length}>{t("characters.references", { count: character.assetIds.length })}</span>
                    </CardDescription>
                </CardHeader>
                <CardFooter className="justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setRenaming(character)}><Pencil />{t("characters.rename")}</Button>
                    <Button variant="ghost" size="sm" onClick={() => { setDeleteError(null); setDeleting(character); }}><Trash2 />{t("characters.delete")}</Button>
                </CardFooter>
            </Card>)}
        </div>}

        {createOpen && <CreateCharacterDialog onClose={() => setCreateOpen(false)} onCreated={() => { void mutate().catch(() => undefined); }} />}
        {importOpen && <FolderImportDialog onClose={() => setImportOpen(false)} onImported={() => { void mutate().catch(() => undefined); }} />}
        {renaming && <RenameCharacterDialog character={renaming} onClose={() => setRenaming(null)} onRenamed={() => { void mutate().catch(() => undefined); }} />}
        <ConfirmDialog open={Boolean(deleting)} onClose={() => { if (!deleteBusy) { setDeleting(null); setDeleteError(null); } }}
            onConfirm={() => void confirmDelete()} busy={deleteBusy}
            title={t("characters.deleteTitle")}
            description={t("characters.deleteDescription", { slug: deleting?.slug ?? "" })}
            error={deleteError ?? undefined}
            confirmLabel={t("characters.deleteConfirm")}
            cancelLabel={common("cancel")} />
    </LibraryShell>;
}
