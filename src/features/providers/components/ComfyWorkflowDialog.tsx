"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { configRequest, providerErrorMessage } from "../lib/api";
import { fieldClass } from "./styles";
import type { ProviderDefinition } from "../types";

const CANONICAL = ["prompt", "negative_prompt", "width", "height", "seed", "cfg"] as const;
type Canonical = typeof CANONICAL[number];
const REQUIRED: Canonical = "prompt";
const IMAGE_OUTPUTS = new Set(["SaveImage", "SaveAnimatedWEBP"]);
const NODE_ID = /^[1-9][0-9]{0,8}$/;

interface GraphNode { class_type: string; inputs: Record<string, unknown> }
interface NodeList { nodes: string[]; fetchedAt: string; cached: boolean }
interface InputTarget { node: string; input: string; value: unknown }

function parseGraph(json: string): { graph?: Record<string, GraphNode>; error?: string } {
    if (!json.trim()) return {};
    let value: unknown;
    try { value = JSON.parse(json); } catch { return { error: "json" }; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "shape" };
    const graph: Record<string, GraphNode> = {};
    for (const [id, node] of Object.entries(value as Record<string, unknown>)) {
        if (!NODE_ID.test(id) || !node || typeof node !== "object" || Array.isArray(node)) return { error: "shape" };
        const entry = node as Record<string, unknown>;
        if (typeof entry.class_type !== "string" || !entry.inputs || typeof entry.inputs !== "object" || Array.isArray(entry.inputs)) return { error: "shape" };
        graph[id] = { class_type: entry.class_type, inputs: entry.inputs as Record<string, unknown> };
    }
    return Object.keys(graph).length ? { graph } : { error: "shape" };
}

function slug(value: string): string {
    return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export function ComfyWorkflowDialog({ provider, onClose, onImported, returnFocus }: {
    provider: ProviderDefinition; onClose: () => void; onImported: () => Promise<void>; returnFocus: React.RefObject<HTMLElement | null>;
}) {
    const t = useTranslations("providers");
    const common = useTranslations("common");
    const [json, setJson] = useState("");
    const [label, setLabel] = useState("");
    const [id, setId] = useState("");
    const [family, setFamily] = useState(provider.label);
    const [mapping, setMapping] = useState<Partial<Record<Canonical, string>>>({});
    const [output, setOutput] = useState("");
    const [nodeList, setNodeList] = useState<NodeList | null>(null);
    const [loadingNodes, setLoadingNodes] = useState(true);
    const [nodeError, setNodeError] = useState("");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    const parsed = useMemo(() => parseGraph(json), [json]);
    const graph = parsed.graph;
    const inputs = useMemo<InputTarget[]>(() => graph
        ? Object.entries(graph).flatMap(([node, entry]) => Object.entries(entry.inputs)
            .filter(([, value]) => !Array.isArray(value))
            .map(([input, value]) => ({ node, input, value })))
        : [], [graph]);
    const outputs = graph ? Object.entries(graph).filter(([, entry]) => IMAGE_OUTPUTS.has(entry.class_type)) : [];
    const unknown = nodeList && graph
        ? [...new Set(Object.values(graph).map(entry => entry.class_type).filter(classType => !nodeList.nodes.includes(classType)))]
        : [];

    async function fetchNodes(refresh = false) {
        setLoadingNodes(true); setNodeError("");
        try {
            const result = await configRequest<NodeList>(`/api/providers/comfyui/workflows${refresh ? "?refresh=1" : ""}`);
            setNodeList(result);
        } catch { setNodeError(t("workflowNodeListError")); }
        finally { setLoadingNodes(false); }
    }

    useEffect(() => {
        let active = true;
        // The node list is read once when the dialog opens; refresh is explicit.
        configRequest<NodeList>("/api/providers/comfyui/workflows")
            .then(result => { if (active) { setNodeList(result); setNodeError(""); } })
            .catch(() => { if (active) setNodeError(t("workflowNodeListError")); })
            .finally(() => { if (active) setLoadingNodes(false); });
        return () => { active = false; };
    }, [t]);

    function changeJson(value: string) {
        setJson(value); setError("");
        // Keep only mappings whose target still exists in the new graph.
        const next = parseGraph(value).graph;
        setMapping(current => Object.fromEntries(Object.entries(current).filter(([, target]) => {
            if (!target || !next) return false;
            const [node, input] = target.split(".");
            const entry = next[node];
            return Boolean(entry) && Object.hasOwn(entry.inputs, input) && !Array.isArray(entry.inputs[input]);
        })) as Partial<Record<Canonical, string>>);
    }

    function validate(): string | undefined {
        if (parsed.error === "json") return t("workflowJsonInvalid");
        if (parsed.error === "shape" || !graph || !inputs.length) return t("workflowShapeInvalid");
        if (!nodeList) return nodeError || t("workflowNodeListError");
        if (unknown.length) return t("workflowNodeUnknown", { nodes: unknown.slice(0, 5).join(", ") });
        if (!mapping.prompt) return t("workflowPromptRequired");
        if (!output || !IMAGE_OUTPUTS.has(graph[output]?.class_type ?? "")) return t("workflowOutputRequired");
        return undefined;
    }

    async function save(event: React.FormEvent) {
        event.preventDefault(); setError("");
        const failure = validate();
        if (failure) { setError(failure); return; }
        const templateId = id.trim() || slug(label);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(templateId)) { setError(t("workflowIdInvalid")); return; }
        const targets = Object.fromEntries(Object.entries(mapping).filter(([, target]) => Boolean(target)).map(([key, target]) => {
            const [node, input] = (target as string).split(".");
            return [key, [node, input]];
        }));
        setSaving(true);
        try {
            await configRequest("/api/providers/comfyui/workflows", "POST", {
                id: templateId, label: label.trim(), family: family.trim() || provider.label, json, mapping: targets, output,
            });
            onClose();
            void onImported().catch(() => undefined);
        } catch (cause) { setError(providerErrorMessage(cause, t, "workflowSaveError")); }
        finally { setSaving(false); }
    }

    return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}><DialogContent finalFocus={returnFocus} closeLabel={common("close")} showCloseButton={!saving} className="max-h-[90dvh] overflow-y-auto bg-[#141618] p-5 sm:max-w-3xl sm:p-6">
        <div><DialogTitle className="pr-6 text-xl leading-snug">{t("importWorkflowTitle")}</DialogTitle><DialogDescription className="mt-2 leading-relaxed">{t("importWorkflowHint")}</DialogDescription></div>
        <form onSubmit={save} className="space-y-4">
            {error && <p role="alert" data-testid="workflow-error" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
            <div className="grid gap-4 sm:grid-cols-2">
                <label className="block space-y-2"><span className="text-sm font-medium">{t("workflowName")}</span><input required maxLength={120} value={label} onChange={event => setLabel(event.target.value)} placeholder={t("workflowNamePlaceholder")} className={fieldClass} /></label>
                <label className="block space-y-2"><span className="text-sm font-medium">{t("workflowId")}</span><input value={id} maxLength={64} onChange={event => setId(event.target.value)} placeholder={slug(label) || "workflow"} className={`${fieldClass} font-mono`} /><span className="block text-xs text-muted-foreground">{t("workflowIdHint")}</span></label>
            </div>
            <label className="block space-y-2"><span className="text-sm font-medium">{t("workflowFamily")}</span><input maxLength={120} value={family} onChange={event => setFamily(event.target.value)} className={fieldClass} /></label>
            <div className="space-y-2">
                <label className="block space-y-2"><span className="text-sm font-medium">{t("workflowJson")}</span><textarea aria-label={t("workflowJson")} spellCheck={false} value={json} onChange={event => changeJson(event.target.value)} placeholder={t("workflowJsonPlaceholder")} className={`${fieldClass} h-48 resize-y py-3 font-mono text-xs`} /></label>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span role="status" data-testid="workflow-node-status">{loadingNodes ? t("workflowNodeListLoading") : nodeList ? t("workflowNodeList", { count: nodeList.nodes.length }) : t("workflowNodeListError")}</span>
                    <Button type="button" size="sm" variant="ghost" disabled={loadingNodes} onClick={() => void fetchNodes(true)}>{loadingNodes ? <Loader2 className="animate-spin" /> : <RefreshCw />}{t("workflowRefreshNodes")}</Button>
                </div>
                {nodeError && <p className="text-xs text-destructive">{nodeError}</p>}
                {parsed.error && <p role="alert" data-testid="workflow-json-error" className="text-xs text-destructive">{t(parsed.error === "json" ? "workflowJsonInvalid" : "workflowShapeInvalid")}</p>}
                {!loadingNodes && nodeList && unknown.length > 0 && <p className="text-xs text-destructive">{t("workflowNodeUnknown", { nodes: unknown.slice(0, 5).join(", ") })}</p>}
            </div>
            <fieldset className="space-y-3 rounded-xl border border-white/15 p-4">
                <legend className="px-1 text-sm font-medium">{t("workflowMapping")}</legend>
                <p className="text-xs leading-relaxed text-muted-foreground">{t("workflowMappingHint")}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                    {CANONICAL.map(key => <label key={key} className="block space-y-1.5"><span className="text-xs font-medium">{t(`workflowParams.${key}`)}{key === REQUIRED ? " *" : ""}</span>
                        <select aria-label={t("workflowParamSelect", { name: t(`workflowParams.${key}`) })} value={mapping[key] ?? ""} onChange={event => setMapping(current => ({ ...current, [key]: event.target.value }))} className={fieldClass}>
                            <option value="">{t("workflowUnused")}</option>
                            {inputs.map(({ node, input, value }) => {
                                const target = `${node}.${input}`;
                                const kind = typeof value === "number" ? "number" : typeof value === "string" ? "text" : typeof value === "boolean" ? "boolean" : "value";
                                return <option key={target} value={target}>{target} ({kind})</option>;
                            })}
                        </select>
                    </label>)}
                </div>
                <label className="block space-y-1.5"><span className="text-xs font-medium">{t("workflowOutput")} *</span>
                    <select aria-label={t("workflowOutput")} value={output} onChange={event => setOutput(event.target.value)} className={fieldClass}>
                        <option value="">{t("workflowChooseOutput")}</option>
                        {outputs.map(([node, entry]) => <option key={node} value={node}>{node}.{entry.class_type}</option>)}
                    </select>
                </label>
            </fieldset>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("workflowDisabledHint")}</p>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4"><span className="text-xs text-muted-foreground">{t("workflowNoSubmit")}</span><div className="flex gap-2"><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>{t("cancel")}</Button><Button type="submit" disabled={saving || loadingNodes || !json.trim() || Boolean(parsed.error) || unknown.length > 0}>{saving && <Loader2 className="animate-spin" />}{t("workflowSave")}</Button></div></div>
        </form>
    </DialogContent></Dialog>;
}
