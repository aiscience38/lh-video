import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { builtinModules } from "node:module";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(root, "src");
// Node's recursive readdir yields native separators, so Windows would hand back "server\config\x.ts".
// The graph is POSIX-keyed: "@/..." aliases and the "server/" boundary prefixes below only match
// forward slashes, and a partially-matched walk would silently make those assertions vacuous.
const files = fs.readdirSync(sourceRoot, { recursive: true })
    .map(file => file.replaceAll(path.sep, "/"))
    .filter(file => /\.(ts|tsx)$/.test(file));
const fileSet = new Set(files);
const graph = new Map();
const serverDependencies = new Set(["@neondatabase/serverless", "@google/genai", "@ai-sdk/gateway", "ai", "sharp", "formidable", "@vercel/blob", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "workflow", "workflow/api"]);
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

/** Resolve a source specifier against the POSIX-keyed walk; undefined means nothing real backs it. */
function resolveImport(from, name) {
    const base = name.startsWith("@/") ? name.slice(2) : path.posix.join(path.posix.dirname(from), name);
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(candidate => fileSet.has(candidate));
}

/** Same resolution, but a missing module is a hard failure rather than a silently dropped edge. */
function resolveSourceImport(from, name) {
    const target = resolveImport(from, name);
    // CSS and JSON resources do not introduce runtime code dependencies.
    if (!target && !/\.(css|json)$/.test(name)) throw new Error(`Unresolved source import: ${from} -> ${name}`);
    return target;
}

for (const file of files) {
    const source = fs.readFileSync(path.join(sourceRoot, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const imports = [];
    const add = (specifier, typeOnly = false) => {
        const name = specifier.text;
        const target = name.startsWith("@/") || name.startsWith(".") ? resolveSourceImport(file, name) : undefined;
        imports.push({ name, target, typeOnly });
    };
    const visit = node => {
        if (ts.isImportDeclaration(node)) {
            const clause = node.importClause;
            const bindings = clause?.namedBindings;
            const typeOnly = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
                && bindings.elements.length > 0 && bindings.elements.every(entry => entry.isTypeOnly));
            add(node.moduleSpecifier, Boolean(typeOnly));
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            add(node.moduleSpecifier, node.isTypeOnly);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
            add(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    graph.set(file, { imports, client: ast.statements.some(node => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === "use client") });
}

test("source walk is POSIX-keyed so imports resolve and genuinely missing modules still fail", () => {
    assert.ok(files.length > 0, "no source files were walked");
    if (path.sep === "\\") assert.deepEqual(files.filter(file => file.includes("\\")), [], "walk must not leak Windows separators");
    // The alias that aborted this walk on Windows now resolves to the real module.
    assert.equal(resolveSourceImport("instrumentation.ts", "@/server/config/production"), "server/config/production.ts");
    // Relative imports resolve against the importer's directory without picking up native separators.
    assert.equal(resolveSourceImport("server/library/store.ts", "./atomic"), "server/library/atomic.ts");
    // A module that truly is not in the tree must still abort the run, not be silently dropped.
    assert.throws(() => resolveSourceImport("instrumentation.ts", "@/server/config/production-missing"), /Unresolved source import: instrumentation\.ts -> @\/server\/config\/production-missing/);
    assert.equal(resolveSourceImport("app/layout.tsx", "./globals.css"), undefined);
});

test("server modules declare Next's server-only boundary and never depend on product UI", () => {
    for (const [file, { imports }] of graph) {
        if (!file.startsWith("server/")) continue;
        assert.ok(imports.some(entry => entry.name === "server-only"), `${file} must declare its server boundary`);
        for (const { name, target } of imports) {
            assert.ok(!target || !/^(features|components|app)\//.test(target), `${file} imports presentation layer ${target}`);
            assert.ok(!["react", "react-dom", "swr"].includes(name), `${file} imports client state ${name}`);
        }
    }
});

test("client dependency graphs cannot reach credentials, catalogs, provider SDKs or Node builtins", () => {
    const visited = new Set();
    function visit(file, trail) {
        if (visited.has(file)) return;
        visited.add(file);
        assert.ok(!file.startsWith("server/"), `${trail.join(" -> ")} -> ${file}`);
        for (const { name, target, typeOnly } of graph.get(file).imports) {
            if (typeOnly) continue;
            assert.ok(name !== "server-only" && !builtins.has(name) && !serverDependencies.has(name), `${file} imports server runtime ${name}`);
            if (target) visit(target, [...trail, file]);
        }
    }
    for (const [file, module] of graph) if (module.client) visit(file, []);
});

test("shared contracts stay independent from server and feature implementations", () => {
    for (const [file, { imports }] of graph) {
        if (!/^(models|providers|types|lib)\//.test(file)) continue;
        for (const { target } of imports) {
            assert.ok(!target || !/^(server|features|components|app)\//.test(target), `${file} couples a shared contract to ${target}`);
        }
    }
});

test("every product component is reachable from a Next route or layout", () => {
    const reachable = new Set();
    function visit(file) {
        if (reachable.has(file)) return;
        reachable.add(file);
        for (const { target } of graph.get(file).imports) if (target) visit(target);
    }
    for (const file of files) if (file.startsWith("app/")) visit(file);
    for (const file of files) {
        if ((file.startsWith("features/") || file.startsWith("components/layout/")) && file.endsWith(".tsx")) {
            assert.ok(reachable.has(file), `Unreachable product component: ${file}`);
        }
    }
});
