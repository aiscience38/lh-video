"use client";

import { useState } from "react";
import useSWR from "swr";
import { useTranslations } from "next-intl";
import { AlertCircle, Archive, Clapperboard, FolderTree, Loader2, PanelsTopLeft, Users } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LibraryShell } from "./LibraryShell";
import { createLibraryBackup, listLibrary, type LibraryBackupResult } from "../lib/api";
import type { LibraryEntity, LibraryKind } from "../types";

const CARDS: Array<{ key: "characters" | "scenes" | "storyboards"; kind: LibraryKind; icon: typeof Users }> = [
    { key: "characters", kind: "character", icon: Users },
    { key: "scenes", kind: "scene", icon: Clapperboard },
    { key: "storyboards", kind: "storyboard", icon: PanelsTopLeft },
];

const LAYOUT = `library/
  characters/
    <slug>/
      character.json
  scenes/
    <slug>/
      scene.json
  storyboards/
    <slug>/
      storyboard.json
  .trash/`;

function kindCount(entities: LibraryEntity[], kind: LibraryKind): number {
    return entities.filter(entity => entity.kind === kind).length;
}

export function LibraryOverview() {
    const t = useTranslations("library");
    const { data, error, isLoading, mutate } = useSWR("library:overview", () => listLibrary());
    const entities = data?.entities ?? [];
    const total = entities.length;
    const [backup, setBackup] = useState<LibraryBackupResult | null>(null);
    const [backupBusy, setBackupBusy] = useState(false);
    const [backupError, setBackupError] = useState<string | null>(null);

    async function createBackup() {
        setBackupBusy(true);
        setBackupError(null);
        setBackup(null);
        try {
            setBackup(await createLibraryBackup());
        } catch {
            setBackupError(t("backup.error"));
        } finally {
            setBackupBusy(false);
        }
    }

    return <LibraryShell active="overview" title={t("overview.title")} subtitle={t("overview.subtitle")}>
        {error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{t("errors.load")}</span>
            <Button variant="outline" size="sm" onClick={() => { void mutate().catch(() => undefined); }}>{t("overview.retry")}</Button>
        </div>}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {CARDS.map(({ key, kind, icon: Icon }) => {
                const title = t(`overview.${key}.title`);
                return <Link key={key} href={`/library/${key}`} data-testid={`library-card-${key}`}
                    aria-label={t("overview.open", { section: title })}
                    className="group block rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    <Card className="h-full border-white/10 bg-[#101214] transition-colors group-hover:border-primary/40 group-hover:bg-[#141719]">
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <span className="grid size-10 place-items-center rounded-xl border border-white/10 bg-white/[.03] text-primary"><Icon aria-hidden="true" className="size-5" /></span>
                                <CardTitle className="text-lg">{title}</CardTitle>
                            </div>
                            <CardDescription className="mt-2 leading-relaxed">{t(`overview.${key}.description`)}</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <p className="flex items-baseline gap-2 text-sm text-muted-foreground">
                                <span data-testid={`library-count-${key}`} className="text-2xl font-semibold text-foreground">{isLoading ? "…" : kindCount(entities, kind)}</span>
                                {t("overview.savedEntries")}
                            </p>
                        </CardContent>
                    </Card>
                </Link>;
            })}
        </div>

        <section className="rounded-2xl border border-white/10 bg-[#101214] p-5">
            <div className="flex items-start gap-3">
                <FolderTree aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
                <div>
                    <h2 className="text-sm font-semibold">{t("overview.layoutTitle")}</h2>
                    <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">{t("overview.layoutHint")}</p>
                </div>
            </div>
            <pre data-testid="library-layout" className="mt-4 overflow-x-auto rounded-xl border border-white/[.06] bg-black/40 p-4 text-xs leading-relaxed text-muted-foreground">{LAYOUT}</pre>
        </section>

        <section className="rounded-2xl border border-white/10 bg-[#101214] p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                    <Archive aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
                    <div className="min-w-0">
                        <h2 className="text-sm font-semibold">{t("backup.title")}</h2>
                        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{t("backup.hint")}</p>
                    </div>
                </div>
                <Button variant="outline" data-testid="library-backup-button" disabled={backupBusy} onClick={() => void createBackup()}>
                    {backupBusy ? <Loader2 className="animate-spin" /> : <Archive />}
                    {t(backupBusy ? "backup.creating" : "backup.create")}
                </Button>
            </div>
            {backup && <div role="status" data-testid="library-backup-result" className="mt-4 rounded-xl border border-white/10 bg-black/25 p-3 text-xs leading-relaxed">
                <p className="text-muted-foreground">{t("backup.entries", { count: backup.count })}</p>
                <p className="mt-1 break-all font-mono">
                    {backup.mode === "tar" ? t("backup.done", { path: backup.path }) : t("backup.manifest", { path: backup.path })}
                </p>
                {backup.note && <p className="mt-1 text-muted-foreground">{t("backup.note", { note: backup.note })}</p>}
            </div>}
            {backupError && <p role="alert" className="mt-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{backupError}</p>}
        </section>

        {!isLoading && !error && total === 0 && <div data-testid="library-overview-empty" className="rounded-2xl border border-dashed border-white/15 px-5 py-10 text-center">
            <h2 className="text-base font-semibold">{t("overview.emptyTitle")}</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{t("overview.emptyHint")}</p>
            <Link href="/library/characters" className="mt-4 inline-flex h-10 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground">{t("characters.emptyAction")}</Link>
        </div>}

        {isLoading && <div role="status" className="flex items-center justify-center gap-3 py-10 text-sm text-muted-foreground"><Loader2 className="size-5 animate-spin" />{t("overview.loading")}</div>}
    </LibraryShell>;
}
