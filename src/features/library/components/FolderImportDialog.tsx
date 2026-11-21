"use client";

import { useRef, useState } from "react";
import { FolderInput, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { createCharacter, libraryErrorKey, listLibrary, updateCharacter, uploadReference } from "../lib/api";
import { importSlug, planFolderImport } from "../lib/folder-import";
import { isCharacter, type CharacterEntity } from "../types";

interface CharacterReportLine {
    kind: "created" | "appended" | "unchanged";
    name: string;
    count: number;
}

interface ImportOutcome {
    characters: number;
    created: number;
    updated: number;
    references: number;
    added: number;
    lines: CharacterReportLine[];
    skipped: string[];
    failed: Array<{ name: string; message: string }>;
}

function normalise(name: string): string {
    return name.trim().toLowerCase();
}

export function FolderImportDialog({ onClose, onImported }: {
    onClose: () => void;
    onImported: () => void;
}) {
    const t = useTranslations("library");
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<string | null>(null);
    const [selected, setSelected] = useState(0);
    const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
    const [error, setError] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);

    function describe(caught: unknown): string {
        const key = libraryErrorKey(caught);
        return t.has(key) ? t(key) : t("errors.generic");
    }

    async function importFolder(files: File[]) {
        if (files.length === 0) return;
        setBusy(true);
        setSelected(files.length);
        setOutcome(null);
        setError(null);
        setProgress(t("import.scanning"));
        try {
            const existing = (await listLibrary("character")).entities.filter(isCharacter);
            const byName = new Map<string, CharacterEntity>();
            const bySlug = new Map<string, CharacterEntity>();
            for (const character of existing) {
                byName.set(normalise(character.name), character);
                bySlug.set(character.slug, character);
            }

            const plan = planFolderImport(files);
            if (plan.characters.length === 0) {
                setError(t("import.empty"));
                return;
            }

            const lines: CharacterReportLine[] = [];
            const failed: Array<{ name: string; message: string }> = [];
            let created = 0;
            let updated = 0;
            let references = 0;
            let added = 0;

            for (const [characterIndex, character] of plan.characters.entries()) {
                const assetIds: string[] = [];
                for (const [fileIndex, file] of character.files.entries()) {
                    setProgress(t("import.progress", {
                        character: characterIndex + 1,
                        characters: plan.characters.length,
                        file: fileIndex + 1,
                        files: character.files.length,
                    }));
                    try {
                        const uploaded = await uploadReference(file);
                        assetIds.push(uploaded.assetId);
                    } catch (caught) {
                        failed.push({ name: `${character.name}/${file.name}`, message: describe(caught) });
                    }
                }
                const unique = [...new Set(assetIds)];
                references += unique.length;
                if (unique.length === 0) continue;
                setProgress(t("import.saving", { name: character.name }));
                const match = byName.get(normalise(character.name)) ?? bySlug.get(importSlug(character.name));
                try {
                    if (match) {
                        const missing = unique.filter(assetId => !match.assetIds.includes(assetId));
                        if (missing.length === 0) {
                            lines.push({ kind: "unchanged", name: match.name, count: 0 });
                        } else {
                            const next = await updateCharacter(match.id, { assetIds: [...match.assetIds, ...missing] });
                            updated += 1;
                            added += missing.length;
                            lines.push({ kind: "appended", name: next.name, count: missing.length });
                        }
                    } else {
                        const entity = await createCharacter({ name: character.name, notes: "", assetIds: unique });
                        created += 1;
                        added += unique.length;
                        lines.push({ kind: "created", name: entity.name, count: unique.length });
                    }
                } catch (caught) {
                    failed.push({ name: character.name, message: describe(caught) });
                }
            }

            setOutcome({ characters: plan.characters.length, created, updated, references, added, lines, skipped: plan.skipped, failed });
            if (added > 0) onImported();
        } catch (caught) {
            setError(describe(caught));
        } finally {
            setBusy(false);
            setProgress(null);
        }
    }

    function choose(selectedFiles: File[]) {
        if (selectedFiles.length > 0) void importFolder(selectedFiles);
    }

    return <Dialog open onOpenChange={next => { if (!next && !busy) onClose(); }}>
        <DialogContent data-testid="folder-import-dialog" showCloseButton={!busy} className="max-h-[calc(100dvh-2rem)] overflow-y-auto bg-[#141618] sm:max-w-xl">
            <DialogHeader>
                <DialogTitle>{t("import.title")}</DialogTitle>
                <DialogDescription className="leading-relaxed">{t("import.hint")}</DialogDescription>
            </DialogHeader>

            <div className="grid gap-1.5">
                <Label htmlFor="folder-import-input">{t("import.folderLabel")}</Label>
                <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
                        <FolderInput />{t("import.choose")}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                        {selected > 0 ? t("import.selected", { count: selected }) : t("import.noFolder")}
                    </span>
                </div>
                <input
                    ref={node => {
                        fileInput.current = node;
                        if (node) {
                            // React has no typed `webkitdirectory` prop; set the attribute the browser reads.
                            node.webkitdirectory = true;
                            node.setAttribute("webkitdirectory", "");
                        }
                    }}
                    data-testid="folder-import-input"
                    id="folder-import-input"
                    type="file"
                    multiple
                    className="sr-only"
                    disabled={busy}
                    onChange={event => {
                        const chosen = Array.from(event.target.files ?? []);
                        event.target.value = "";
                        choose(chosen);
                    }}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">{t("import.skipHint")}</p>
            </div>

            {progress && <div role="status" data-testid="folder-import-progress" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />{progress}
            </div>}

            {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

            {outcome && <div data-testid="folder-import-report" className="grid gap-3 rounded-xl border border-white/10 bg-black/25 p-4">
                <p data-testid="folder-import-summary" data-created={outcome.created} data-added={outcome.added} className="text-sm font-medium">
                    {t("import.summary", { characters: outcome.characters, references: outcome.references })}
                </p>
                <ul className="grid gap-1 text-xs text-muted-foreground">
                    {outcome.lines.map((line, index) => <li key={`${line.kind}-${line.name}-${index}`} data-testid="folder-import-line" data-kind={line.kind}>
                        {line.kind === "created" ? t("import.created", { name: line.name, count: line.count })
                            : line.kind === "appended" ? t("import.appended", { name: line.name, count: line.count })
                                : t("import.unchanged", { name: line.name })}
                    </li>)}
                </ul>
                {outcome.skipped.length > 0 && <section className="grid gap-1">
                    <h3 className="text-xs font-semibold text-foreground">{t("import.skippedTitle", { count: outcome.skipped.length })}</h3>
                    {outcome.skipped.map(path => <p key={path} data-testid="folder-import-skipped" className="break-all text-xs text-muted-foreground">{t("import.skippedLine", { path })}</p>)}
                </section>}
                {outcome.failed.length > 0 && <section className="grid gap-1">
                    <h3 className="text-xs font-semibold text-destructive">{t("import.failedTitle", { count: outcome.failed.length })}</h3>
                    {outcome.failed.map((line, index) => <p key={`${line.name}-${index}`} data-testid="folder-import-failed" className="break-all text-xs text-destructive">{t("import.failedLine", { name: line.name, message: line.message })}</p>)}
                </section>}
            </div>}

            <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t("import.close")}</Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>;
}