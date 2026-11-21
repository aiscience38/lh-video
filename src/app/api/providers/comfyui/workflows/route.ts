import { NextResponse } from "next/server";
import { comfyuiCapabilities } from "@/server/catalog/comfyui";
import { compileComfyuiWorkflow, getComfyuiNodeClasses } from "@/server/catalog/comfyui-workflows";
import { deleteComfyuiTemplate, listComfyuiTemplates, resolveProviderConnection, saveComfyuiTemplate, saveCustomModel, deleteCustomModel } from "@/server/config/provider-store";
import { comfyuiBaseUrl } from "@/server/providers/comfyui";
import { providerConfigFailure, readConfigObject } from "@/server/http/provider-config";
import { applyWorkspaceHeaders, guardWorkspaceRequest } from "@/server/security/workspace-access";

export const runtime = "nodejs";

const WORKFLOW_BODY_MAX_BYTES = 512 * 1024;

/**
 * ComfyUI workflow import. The generic provider connection route stores
 * credentials and metadata only, so an imported graph gets its own endpoint.
 * Nothing here submits a prompt: /object_info is read-only and the template is
 * saved disabled until the operator enables its derived catalog model.
 */
export async function GET(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    try {
        const connection = await resolveProviderConnection("comfyui");
        const baseUrl = comfyuiBaseUrl(typeof connection?.metadata?.baseUrl === "string" ? connection.metadata.baseUrl : undefined);
        const refresh = new URL(request.url).searchParams.get("refresh") === "1";
        const nodes = await getComfyuiNodeClasses({ baseUrl, secret: connection?.secret, refresh });
        const templates = (await listComfyuiTemplates()).map(template => ({ id: template.id, label: template.label, mode: template.mode }));
        return applyWorkspaceHeaders(NextResponse.json({ nodes: nodes.classes, fetchedAt: nodes.fetchedAt, cached: nodes.cached, templates }));
    } catch (error) { return providerConfigFailure(error, "ERR_COMFYUI_NODE_LIST"); }
}

export async function POST(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    try {
        const body = await readConfigObject(request, WORKFLOW_BODY_MAX_BYTES);
        const connection = await resolveProviderConnection("comfyui");
        const baseUrl = comfyuiBaseUrl(typeof connection?.metadata?.baseUrl === "string" ? connection.metadata.baseUrl : undefined);
        const { classes } = await getComfyuiNodeClasses({ baseUrl, secret: connection?.secret });
        const template = compileComfyuiWorkflow(body, classes);
        const saved = await saveComfyuiTemplate(template);
        try {
            const model = await saveCustomModel({ mediaType: "image", capabilities: comfyuiCapabilities(saved), enabled: false });
            return applyWorkspaceHeaders(NextResponse.json({ template: { id: saved.id, label: saved.label, mode: saved.mode }, model }, { status: 201 }));
        } catch (error) {
            // The catalog row is the only reason to keep the graph; never leave an orphan.
            await deleteComfyuiTemplate(saved.id).catch(() => undefined);
            throw error;
        }
    } catch (error) { return providerConfigFailure(error, "ERR_COMFYUI_WORKFLOW_INVALID"); }
}

export async function DELETE(request: Request) {
    const denial = guardWorkspaceRequest(request);
    if (denial) return denial;
    try {
        const body = await readConfigObject(request);
        if (typeof body.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.id)) throw new Error("ERR_COMFYUI_WORKFLOW_INVALID");
        // Remove the catalog row first: a template without a model is inert, while
        // a model without its template would make the saved config unreadable.
        const modelDeleted = await deleteCustomModel(`comfyui:${body.id}`, "image");
        const deleted = await deleteComfyuiTemplate(body.id);
        return applyWorkspaceHeaders(NextResponse.json({ deleted, modelDeleted }));
    } catch (error) { return providerConfigFailure(error, "ERR_COMFYUI_WORKFLOW_INVALID"); }
}
