import "server-only";

import {
    createBridgeClient,
    createMcpServer,
    readBridgeConfig,
    serveStdio,
    TOOLS,
    type BridgeConfig,
    type BridgeEnvironment,
    type McpServer,
} from "@/lib/agent-bridge/bridge";

/**
 * Server-only composition root for the agent bridge.
 *
 * The transport-neutral implementation lives in `@/lib/agent-bridge/bridge`
 * because the CLI and the stdio entry run it under plain Node, where the
 * `server-only` marker package does not exist. Next code imports this module;
 * the stdio entry reuses the same implementation without duplicating tools.
 */

export * from "@/lib/agent-bridge/bridge";

/**
 * The complete agent surface. Kept explicit here so widening the MCP tool list
 * is a reviewed, server-boundary change rather than an accidental re-export.
 */
export const EXPOSED_TOOLS = [
    "list_productions",
    "list_library",
    "get_task",
    "create_generation_task",
    "read_ledger",
    "advance_production_stop",
] as const;

export type ExposedTool = (typeof EXPOSED_TOOLS)[number];

function assertToolSurface(): void {
    const catalog = new Set(TOOLS.map((tool) => tool.name));
    const missing = EXPOSED_TOOLS.filter((name) => !catalog.has(name));
    const extra = [...catalog].filter((name) => !(EXPOSED_TOOLS as readonly string[]).includes(name));
    if (missing.length > 0 || extra.length > 0) {
        throw new Error(`ERR_MCP_TOOL_SURFACE: missing [${missing.join(", ")}], unexpected [${extra.join(", ")}].`);
    }
}

export function createServerFromEnvironment(environment: BridgeEnvironment = process.env): McpServer {
    assertToolSurface();
    const config: BridgeConfig = readBridgeConfig(environment);
    return createMcpServer(createBridgeClient({ config }));
}

export async function runStdioServer(environment: BridgeEnvironment = process.env): Promise<void> {
    await serveStdio(createServerFromEnvironment(environment), {
        input: process.stdin,
        output: process.stdout,
    });
}
