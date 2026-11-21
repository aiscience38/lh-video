/**
 * LH Video MCP server (stdio).
 *
 * The transport-neutral bridge in src/lib/agent-bridge/bridge.ts is loaded
 * directly with Node's built-in type stripping (Node 22.18+), so this entry
 * needs no build step and no MCP SDK dependency. stdout is reserved for
 * JSON-RPC lines; every diagnostic goes to stderr.
 */
import {
    createBridgeClient,
    createMcpServer,
    failureMessage,
    readBridgeConfig,
    serveStdio,
} from "../src/lib/agent-bridge/bridge.ts";

async function main() {
    const config = readBridgeConfig(process.env);
    const server = createMcpServer(createBridgeClient({ config }));
    process.stderr.write(`lh-video-mcp: serving ${config.baseUrl} over stdio\n`);
    await serveStdio(server, { input: process.stdin, output: process.stdout });
}

main().catch((error) => {
    process.stderr.write(`lh-video-mcp: ${failureMessage(error)}\n`);
    process.exitCode = 1;
});
