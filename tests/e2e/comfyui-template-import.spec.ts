import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "./fixtures";
import en from "../../src/messages/en.json";

// LAM-14 browser coverage. A local HTTP server answers GET /object_info so the
// import dialog exercises the real allowlist cache without touching the GX10.
const NODES = ["CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage"];
const WORKFLOW = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-dev.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
    "3": { class_type: "EmptyLatentImage", inputs: { width: 768, height: 768, batch_size: 1 } },
    "4": { class_type: "KSampler", inputs: { seed: 0, steps: 20, cfg: 1, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["1", 0], positive: ["2", 0], latent_image: ["3", 0] } },
    "5": { class_type: "VAEDecode", inputs: { samples: ["4", 0], vae: ["1", 2] } },
    "6": { class_type: "SaveImage", inputs: { filename_prefix: "e2e-import", images: ["5", 0] } },
};
const TEMPLATE_ID = "e2e-imported";
const MODEL_LABEL = "E2E Imported Flow";
const MODEL_ID = `comfyui:${TEMPLATE_ID}`;

test("ComfyUI workflow import persists hidden until enabled and rejects invalid JSON", async ({ page }) => {
    const server = createServer((request, response) => {
        if (request.url !== "/object_info") { response.writeHead(404).end(); return; }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(Object.fromEntries(NODES.map(name => [name, { input: {}, output: [] }]))));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let connectionId: string | undefined;
    try {
        await page.goto("/en/settings?provider=comfyui");
        const origin = new URL(page.url()).origin;
        const created = await page.request.post("/api/providers", { headers: { origin },
            data: { providerId: "comfyui", label: "E2E ComfyUI", secret: "synthetic-e2e-comfyui-key", metadata: { baseUrl } } });
        expect(created.ok()).toBeTruthy();
        connectionId = (await created.json()).connection.id;
        await page.reload();

        const workflowPosts: string[] = [];
        page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/api/providers/comfyui/workflows")) workflowPosts.push(request.url()); });

        await page.getByRole("button", { name: en.providers.importWorkflow, exact: true }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByRole("heading", { name: en.providers.importWorkflowTitle })).toBeVisible();
        await dialog.getByLabel(en.providers.workflowName, { exact: true }).fill(MODEL_LABEL);
        await dialog.getByLabel(/Template ID/).fill(TEMPLATE_ID);
        await dialog.getByLabel(en.providers.workflowJson, { exact: true }).fill(JSON.stringify(WORKFLOW, null, 2));
        // The cached /object_info allowlist arrives from the local ComfyUI stub.
        await expect(dialog.getByTestId("workflow-node-status")).toHaveText(en.providers.workflowNodeList.replace("{count}", String(NODES.length)));

        const mapping = (name: string) => dialog.getByLabel(en.providers.workflowParamSelect.replace("{name}", name));
        await mapping(en.providers.workflowParams.prompt).selectOption("2.text");
        await mapping(en.providers.workflowParams.width).selectOption("3.width");
        await mapping(en.providers.workflowParams.height).selectOption("3.height");
        await dialog.getByLabel(en.providers.workflowOutput, { exact: true }).selectOption("6");
        const [imported] = await Promise.all([
            page.waitForResponse(response => response.url().endsWith("/api/providers/comfyui/workflows") && response.request().method() === "POST"),
            dialog.getByRole("button", { name: en.providers.workflowSave, exact: true }).click(),
        ]);
        expect(imported.status()).toBe(201);
        await expect(dialog).toBeHidden();

        // Saved disabled and unverified: the model is listed in the provider settings but hidden in the Studio.
        const toggle = page.getByRole("switch", { name: en.providers.showModel.replace("{name}", MODEL_LABEL) });
        await expect(toggle).toBeVisible();
        await expect(toggle).not.toBeChecked();
        await page.reload();
        await expect(toggle).not.toBeChecked();

        await page.getByRole("link", { name: en.workspace.studio, exact: true }).click();
        await expect(page.getByRole("textbox", { name: en.commandBar.promptLabel })).toBeEnabled();
        await page.getByRole("button", { name: en.commandBar.chooseImageModel }).click();
        await expect(page.locator("[data-model-id]").first()).toBeVisible();
        await expect(page.locator(`[data-model-id="${MODEL_ID}"]`)).toHaveCount(0);
        await page.keyboard.press("Escape");

        // Enable the imported model: only then does the Studio offer it.
        await page.getByRole("link", { name: en.workspace.providers, exact: true }).click();
        await page.locator('a[href*="provider=comfyui"]').click();
        await expect(toggle).not.toBeChecked();
        await toggle.click();
        await expect(toggle).toBeChecked();
        await page.getByRole("link", { name: en.workspace.studio, exact: true }).click();
        await page.getByRole("button", { name: en.commandBar.chooseImageModel }).click();
        await expect(page.locator(`[data-model-id="${MODEL_ID}"]`)).toBeVisible();
        await page.keyboard.press("Escape");

        // Invalid JSON stays inline and never reaches the API.
        const before = workflowPosts.length;
        await page.getByRole("link", { name: en.workspace.providers, exact: true }).click();
        await page.locator('a[href*="provider=comfyui"]').click();
        await page.getByRole("button", { name: en.providers.importWorkflow, exact: true }).click();
        const invalid = page.getByRole("dialog");
        await invalid.getByLabel(en.providers.workflowJson, { exact: true }).fill("{ not valid json");
        await expect(invalid.getByTestId("workflow-json-error")).toHaveText(en.providers.workflowJsonInvalid);
        await expect(invalid.getByRole("button", { name: en.providers.workflowSave, exact: true })).toBeDisabled();
        await invalid.getByRole("button", { name: en.providers.cancel, exact: true }).click();
        await expect(invalid).toBeHidden();
        expect(workflowPosts.length).toBe(before);
        const catalog = await (await page.request.get("/api/catalog")).json();
        expect(catalog.images.filter((model: { provider: string }) => model.provider === "comfyui")).toHaveLength(2);
    } finally {
        const origin = new URL(page.url()).origin;
        await page.request.delete("/api/providers/comfyui/workflows", { headers: { origin }, data: { id: TEMPLATE_ID } }).catch(() => undefined);
        if (connectionId) await page.request.delete(`/api/providers/${connectionId}`, { headers: { origin } }).catch(() => undefined);
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
