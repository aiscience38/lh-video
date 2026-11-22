"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { useTranslations } from "next-intl";
import { AlertCircle, FileJson, Loader2, Plus } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useCreateParam } from "@/lib/use-create-param";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { ComfyWorkflowDialog } from "@/features/providers/components/ComfyWorkflowDialog";
import { configRequest } from "@/features/providers/lib/api";
import type { ProviderDefinition } from "@/features/providers/types";

interface WorkflowTemplate {
    id: string;
    label: string;
    mode: string;
    /** Present when the API grows to expose provenance; absent responses are imported templates. */
    builtin?: boolean;
    source?: string;
    enabled?: boolean;
    status?: string;
}

interface WorkflowResponse {
    templates?: WorkflowTemplate[];
}

interface ProvidersResponse {
    providers: ProviderDefinition[];
}

function statusKey(template: WorkflowTemplate): "enabled" | "disabled" | "unverified" | null {
    if (template.status === "unverified") return "unverified";
    if (template.status === "enabled" || template.status === "disabled") return template.status;
    if (typeof template.enabled === "boolean") return template.enabled ? "enabled" : "disabled";
    return null;
}

export default function ToolsPage() {
    return <ToolsLibrary />;
}

function ToolsLibrary() {
    const t = useTranslations("tools");
    const createParam = useCreateParam();
    const [creating, setCreating] = useState(false);
    const createButton = useRef<HTMLButtonElement>(null);

    const workflows = useSWR("comfyui:workflows", () => configRequest<WorkflowResponse>("/api/providers/comfyui/workflows"));
    const providers = useSWR("providers:definitions", () => configRequest<ProvidersResponse>("/api/providers"));
    const comfyui = providers.data?.providers.find(provider => provider.id === "comfyui");
    const templates = workflows.data?.templates ?? [];
    const dialogOpen = creating || (createParam.open && Boolean(comfyui));

    // Deep link from the sidebar: /tools?create=1 opens the import dialog.
    function closeCreate() {
        setCreating(false);
        createParam.close();
    }

    return <div className="flex h-full min-h-0 flex-col">
        <div className="model-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto max-w-[1200px] space-y-6 px-4 py-6 sm:px-7 sm:py-9 lg:px-10">
                <header className="max-w-2xl">
                    <p className="mb-3 text-[11px] font-bold tracking-[.2em] text-primary">{t("eyebrow")}</p>
                    <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t("title")}</h1>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t("subtitle")}</p>
                </header>

                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p role="status" className="text-sm text-muted-foreground">{t("count", { count: templates.length })}</p>
                    <Button ref={createButton} data-testid="tools-create" onClick={() => setCreating(true)} disabled={!comfyui}
                        title={comfyui ? undefined : t("providerMissing")}>
                        <Plus aria-hidden="true" className="size-4" />{t("create")}
                    </Button>
                </div>

                {providers.error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive">
                    <AlertCircle className="size-4 shrink-0" /><span className="min-w-0 flex-1">{t("providerMissing")}</span>
                    <Button variant="outline" size="sm" onClick={() => { void providers.mutate().catch(() => undefined); }}>{t("retry")}</Button>
                </div>}

                {workflows.error && <>
                    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive">
                        <AlertCircle className="size-4 shrink-0" /><span className="min-w-0 flex-1">{t("error")}</span>
                        <Button variant="outline" size="sm" onClick={() => { void workflows.mutate().catch(() => undefined); }}>{t("retry")}</Button>
                    </div>
                    <p className="text-sm leading-relaxed text-muted-foreground">{t("emptyHint")} <Link href="/settings" className="text-primary underline-offset-4 hover:underline">{t("emptyAction")}</Link></p>
                </>}

                {workflows.isLoading && !workflows.data && <div role="status" className="flex items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />{t("loading")}
                </div>}

                {!workflows.isLoading && !workflows.error && templates.length === 0 && <div data-testid="tools-empty" className="rounded-2xl border border-dashed border-white/15 px-5 py-14 text-center">
                    <span className="mx-auto grid size-12 place-items-center rounded-2xl border border-white/10 bg-white/[.03] text-primary"><FileJson aria-hidden="true" className="size-5" /></span>
                    <h2 className="mt-4 text-base font-semibold">{t("emptyTitle")}</h2>
                    <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">{t("emptyHint")}</p>
                    <Link href="/settings" className={`${buttonVariants({ variant: "outline" })} mt-4`}>{t("emptyAction")}</Link>
                </div>}

                {templates.length > 0 && <>
                    <div className="hidden px-4 text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_5rem_7rem_8rem] sm:gap-3" aria-hidden="true">
                        <span>{t("columns.label")}</span><span>{t("columns.id")}</span><span>{t("columns.mode")}</span><span>{t("columns.source")}</span><span>{t("columns.status")}</span>
                    </div>
                    <ul data-testid="tools-list" aria-label={t("title")} className="divide-y divide-white/[.06] overflow-hidden rounded-2xl border border-white/10 bg-[#101214]">
                        {templates.map(template => {
                            const status = statusKey(template);
                            const builtin = template.builtin === true || template.source === "builtin";
                            return <li key={template.id} data-testid="tool-row" data-template-id={template.id} data-mode={template.mode}
                                className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_5rem_7rem_8rem] sm:items-center sm:gap-3">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{template.label}</p>
                                    <code className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground sm:hidden" title={template.id}>{template.id}</code>
                                </div>
                                <code className="hidden truncate font-mono text-[11px] text-muted-foreground sm:block" title={template.id}>{template.id}</code>
                                <span className="text-xs text-muted-foreground">{template.mode === "video" ? t("modes.video") : t("modes.image")}</span>
                                <span className="w-fit rounded-full border border-white/10 bg-white/[.04] px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{t(`sources.${builtin ? "builtin" : "imported"}`)}</span>
                                <span className={`w-fit rounded-full px-2 py-0.5 text-[11px] font-medium ${status === "enabled" ? "bg-emerald-400/10 text-emerald-200" : "border border-white/10 bg-white/[.04] text-muted-foreground"}`}>
                                    {status ? t(`status.${status}`) : "—"}
                                </span>
                            </li>;
                        })}
                    </ul>
                </>}

                {dialogOpen && comfyui && <ComfyWorkflowDialog provider={comfyui} returnFocus={createButton}
                    onClose={closeCreate} onImported={async () => { await workflows.mutate(); }} />}
            </div>
        </div>
    </div>;
}
