import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export interface FixtureServer {
    baseUrl: string;
    close: () => Promise<void>;
}

/**
 * Loopback HTTP server for the MP4 fixtures.
 *
 * WebKit refuses to load media from a self-signed HTTPS origin even with
 * `ignoreHTTPSErrors`, so its tests use this plain-HTTP origin; Chromium and
 * Firefox keep using the e2e server's HTTPS `/e2e-fixtures` route.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
    const root = path.join(process.cwd(), "tests", "e2e", "assets");
    const server = http.createServer((request, response) => {
        const name = path.basename(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
        if (!/^[A-Za-z0-9._-]+\.mp4$/.test(name)) {
            response.writeHead(404);
            response.end();
            return;
        }
        let body: Buffer;
        try {
            body = fs.readFileSync(path.join(root, name));
        } catch {
            response.writeHead(404);
            response.end();
            return;
        }
        const range = request.headers.range;
        const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
        const start = match ? Number(match[1]) : 0;
        const end = match && match[2] ? Math.min(body.length - 1, Number(match[2])) : body.length - 1;
        if (start >= body.length || start > end) {
            response.writeHead(416, { "Content-Range": `bytes */${body.length}` });
            response.end();
            return;
        }
        const headers: Record<string, string> = {
            "Content-Type": "video/mp4",
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
        };
        if (match) headers["Content-Range"] = `bytes ${start}-${end}/${body.length}`;
        response.writeHead(match ? 206 : 200, headers);
        response.end(body.subarray(start, end + 1));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind a TCP port");
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
