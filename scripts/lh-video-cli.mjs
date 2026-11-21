/**
 * LH Video agent CLI.
 *
 * Every command talks to the same loopback HTTP client as the MCP server in
 * src/lib/agent-bridge/bridge.ts. `--json` prints one machine-parseable JSON
 * document on stdout; human output is a compact summary.
 */
import {
    bridgeFailure,
    createBridgeClient,
    failureCode,
    failureMessage,
    readBridgeConfig,
} from "../src/lib/agent-bridge/bridge.ts";

const USAGE = `Usage: node scripts/lh-video-cli.mjs <command> [options]

Commands:
  status                 Check the local app and count productions
  productions            List productions
  library                List creative library entities
  submit                 Submit a video generation task
  ledger                 Read one production ledger

Options:
  --json                 Print a JSON document instead of text
  --base-url <url>       Override LH_VIDEO_BASE_URL (loopback only)
  --kind <kind>          library: character, scene or storyboard
  --q <text>             library: name/slug filter
  --model <id>           submit: runtime video model id (required)
  --prompt <text>        submit: generation prompt
  --variant <id>         submit: resolution variant id
  --settings <json>      submit: model settings object
  --duration <value>     submit: settings.duration shortcut
  --aspect-ratio <ratio> submit: settings.aspectRatio shortcut
  --resolution <id>      submit: variant id when --variant is omitted
  --client-submission-id <uuid>
  --production <id>      ledger: production id (required)
  --help                 Show this message`;

const BOOLEAN_FLAGS = new Set(["json", "help"]);
const GLOBAL_FLAGS = new Set(["json", "base-url", "help"]);
const COMMAND_FLAGS = {
    status: new Set(),
    productions: new Set(),
    library: new Set(["kind", "q"]),
    submit: new Set(["model", "prompt", "variant", "settings", "duration", "aspect-ratio", "resolution", "client-submission-id"]),
    ledger: new Set(["production"]),
};

function parseArguments(argv) {
    const flags = new Map();
    const positionals = [];
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith("--")) {
            positionals.push(token);
            continue;
        }
        const equals = token.indexOf("=");
        if (equals >= 0) {
            flags.set(token.slice(2, equals), token.slice(equals + 1));
            continue;
        }
        const name = token.slice(2);
        if (BOOLEAN_FLAGS.has(name)) {
            flags.set(name, true);
            continue;
        }
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
            flags.set(name, next);
            index += 1;
        } else {
            flags.set(name, true);
        }
    }
    return { flags, positionals };
}

function flagValue(flags, name) {
    if (!flags.has(name)) return undefined;
    const value = flags.get(name);
    if (typeof value !== "string" || !value) {
        throw bridgeFailure("ERR_CLI_ARGUMENT", `--${name} requires a value.`);
    }
    return value;
}

function validateFlags(flags, command) {
    const allowed = COMMAND_FLAGS[command];
    for (const name of flags.keys()) {
        if (!GLOBAL_FLAGS.has(name) && !allowed.has(name)) {
            throw bridgeFailure("ERR_CLI_ARGUMENT", `Unknown option for ${command}: --${name}. Run with --help to see supported options.`);
        }
    }
}

function print(payload, json, human) {
    process.stdout.write(`${json ? JSON.stringify(payload, null, 2) : human(payload)}\n`);
}

function productionsOf(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === "object" && Array.isArray(payload.productions)) return payload.productions;
    return [];
}

function entitiesOf(payload) {
    if (payload && typeof payload === "object" && Array.isArray(payload.entities)) return payload.entities;
    return [];
}

async function status(client, config) {
    const health = await client.getHealth();
    const payload = {
        ok: true,
        baseUrl: config.baseUrl,
        health,
        productionsAvailable: false,
        productionCount: null,
    };
    try {
        const productions = await client.listProductions();
        payload.productionCount = productionsOf(productions).length;
        payload.productionsAvailable = true;
    } catch (error) {
        payload.productionsError = failureCode(error);
    }
    return payload;
}

function humanStatus(payload) {
    const health = payload.health && typeof payload.health === "object" ? payload.health.status : "unknown";
    const productions = payload.productionsAvailable
        ? `Productions: ${payload.productionCount}`
        : `Productions: unavailable${payload.productionsError ? ` (${payload.productionsError})` : ""}`;
    return `LH Video: reachable at ${payload.baseUrl}\nHealth: ${health ?? "unknown"}\n${productions}`;
}

function humanProductions(payload) {
    const productions = productionsOf(payload);
    if (productions.length === 0) return "No productions.";
    return productions.map((production) => {
        const id = production.id ?? "(no id)";
        const name = production.name ?? "(unnamed)";
        const stage = production.stage ?? "-";
        return `${id}\t${name}\t${stage}\tagentCanApprove=${production.agentCanApprove === true}`;
    }).join("\n");
}

function humanLibrary(payload) {
    const entities = entitiesOf(payload);
    if (entities.length === 0) return "No library entities.";
    return entities.map((entity) => `${entity.kind ?? "?"}\t${entity.slug ?? entity.id ?? "?"}\t${entity.name ?? ""}`).join("\n");
}

function humanTask(payload) {
    const taskId = payload && typeof payload === "object" ? payload.task_id ?? payload.taskId ?? "(unknown)" : "(unknown)";
    const accepted = payload && typeof payload === "object" && payload.accepted === false ? "not accepted" : "accepted";
    return `Task ${taskId}: ${accepted}`;
}

function humanLedger(payload) {
    const entries = payload && typeof payload === "object" && Array.isArray(payload.entries) ? payload.entries : [];
    if (entries.length === 0) return "Ledger is empty.";
    return entries.map((entry) => {
        const at = entry.createdAt ?? entry.at ?? "-";
        const kind = entry.kind ?? entry.type ?? "-";
        const message = entry.message ?? entry.summary ?? "";
        return `${at}\t${kind}\t${message}`;
    }).join("\n");
}

async function submit(client, flags) {
    const settings = flagValue(flags, "settings");
    let parsedSettings;
    if (settings !== undefined) {
        try {
            parsedSettings = JSON.parse(settings);
        } catch {
            throw bridgeFailure("ERR_CLI_ARGUMENT", "--settings must be valid JSON.");
        }
        if (!parsedSettings || typeof parsedSettings !== "object" || Array.isArray(parsedSettings)) {
            throw bridgeFailure("ERR_CLI_ARGUMENT", "--settings must be a JSON object.");
        }
    }
    return client.createGenerationTask({
        modelId: flagValue(flags, "model"),
        prompt: flagValue(flags, "prompt"),
        variantId: flagValue(flags, "variant"),
        settings: parsedSettings,
        duration: flagValue(flags, "duration"),
        aspectRatio: flagValue(flags, "aspect-ratio"),
        resolution: flagValue(flags, "resolution"),
        clientSubmissionId: flagValue(flags, "client-submission-id"),
    });
}

async function main() {
    const { flags, positionals } = parseArguments(process.argv.slice(2));
    const command = positionals[0] ?? "help";
    if (command === "help" || flags.has("help")) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }
    if (!Object.hasOwn(COMMAND_FLAGS, command)) {
        throw bridgeFailure("ERR_CLI_COMMAND", `Unknown command: ${command}. Run with --help to see supported commands.`);
    }
    validateFlags(flags, command);
    const baseUrl = flagValue(flags, "base-url");
    const config = readBridgeConfig(baseUrl ? { ...process.env, LH_VIDEO_BASE_URL: baseUrl } : process.env);
    const client = createBridgeClient({ config });
    const json = flags.has("json");

    switch (command) {
        case "status":
            print(await status(client, config), json, humanStatus);
            return;
        case "productions":
            print(await client.listProductions(), json, humanProductions);
            return;
        case "library":
            print(await client.listLibrary({ kind: flagValue(flags, "kind"), q: flagValue(flags, "q") }), json, humanLibrary);
            return;
        case "submit":
            print(await submit(client, flags), json, humanTask);
            return;
        case "ledger":
            print(await client.readLedger({ productionId: flagValue(flags, "production") }), json, humanLedger);
            return;
        default:
            throw bridgeFailure("ERR_CLI_COMMAND", `Unsupported command: ${command}.`);
    }
}

main().catch((error) => {
    process.stderr.write(`lh-video-cli: ${failureCode(error, "ERR_CLI")}: ${failureMessage(error)}\n`);
    process.exitCode = 1;
});
