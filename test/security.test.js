process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const axios = require("axios");
const {
    assertSafeUrl,
    isBlockedIp,
    crawl,
    createApp,
    getFilteringAgents,
    MAX_PAGES,
    MAX_CONTENT_BYTES,
    SafeUrlError,
    RobotsDisallowedError,
} = require("../server");

function postJson(app, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            const payload = JSON.stringify(body);
            const req = http.request({
                hostname: "127.0.0.1",
                port,
                path: "/crawl",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                    ...headers,
                },
            }, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    server.close(() => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        let json = null;
                        try { json = JSON.parse(text); } catch { json = null; }
                        resolve({ status: res.statusCode, headers: res.headers, json, text });
                    });
                });
            });
            req.on("error", (err) => server.close(() => reject(err)));
            req.write(payload);
            req.end();
        });
    });
}

function requestRaw(app, method, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    server.close(() => {
                        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") });
                    });
                });
            });
            req.on("error", (err) => server.close(() => reject(err)));
            req.end();
        });
    });
}

test("blocks private, loopback, link-local, and metadata addresses", () => {
    const blocked = [
        "127.0.0.1",
        "10.1.2.3",
        "192.168.1.20",
        "172.16.0.1",
        "172.31.255.255",
        "169.254.169.254",
        "0.0.0.0",
        "100.100.100.200",
        "::1",
        "fe80::1",
        "fd00:ec2::254",
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
    ];
    for (const address of blocked) {
        assert.equal(isBlockedIp(address), true, address);
    }
    assert.equal(isBlockedIp("8.8.8.8"), false);
    assert.equal(isBlockedIp("1.1.1.1"), false);
    assert.equal(isBlockedIp("172.32.0.1"), false);
});

test("assertSafeUrl rejects literal and encoded private targets", async () => {
    const urls = [
        "http://127.0.0.1/",
        "http://127.1/",
        "http://2130706433/",
        "http://0x7f000001/",
        "http://0x7f.0.0.1/",
        "http://0177.0.0.1/",
        "http://017700000001/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:169.254.169.254]/",
        "http://169.254.169.254/latest/meta-data/",
        "http://169.254.170.2/",
        "http://10.0.0.5/",
        "http://192.168.0.1/",
        "http://172.16.5.5/",
        "http://0.0.0.0/",
        "http://0/",
        "http://[fd00:ec2::254]/",
        "http://100.100.100.200/",
        "http://localhost/",
        "http://localhost/admin",
        "http://127.0.0.1.nip.io/",
        "http://169.254.169.254.nip.io/latest/meta-data/",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://user:pass@example.com/",
        "file:///etc/passwd",
        "gopher://127.0.0.1/",
        "http://example/",
    ];
    for (const url of urls) {
        await assert.rejects(() => assertSafeUrl(url), SafeUrlError, url);
    }
});

test("assertSafeUrl allows a public hostname", async () => {
    const parsed = await assertSafeUrl("https://example.com/");
    assert.equal(parsed.hostname, "example.com");
});

test("request-filtering-agent refuses a loopback connection", async () => {
    const { httpAgent } = await getFilteringAgents();
    await assert.rejects(() => axios.get("http://127.0.0.1:9/", {
        httpAgent,
        timeout: 2000,
        maxRedirects: 0,
        proxy: false,
        validateStatus: () => true,
    }));
});

test("request-filtering-agent refuses the metadata address", async () => {
    const { httpAgent } = await getFilteringAgents();
    await assert.rejects(() => axios.get("http://169.254.169.254/latest/meta-data/", {
        httpAgent,
        timeout: 2000,
        maxRedirects: 0,
        proxy: false,
        validateStatus: () => true,
    }));
});

test("/crawl does not connect to loopback", async () => {
    let hits = 0;
    const sink = http.createServer((req, res) => {
        hits += 1;
        res.end("secret@example.com");
    });
    await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const port = sink.address().port;
    try {
        const app = createApp({ rateLimitMax: 100 });
        const res = await postJson(app, { url: `http://127.0.0.1:${port}/secret`, mode: "emails" });
        assert.equal(res.status, 400);
        assert.equal(res.json.error, "This URL is not allowed.");
        assert.equal(hits, 0);
    } finally {
        await new Promise((resolve) => sink.close(resolve));
    }
});

test("redirect hops are checked before the next request", async () => {
    const calls = [];
    const httpGet = async (url) => {
        calls.push(url);
        if (String(url).endsWith("/robots.txt")) {
            return { status: 404, headers: {}, data: "" };
        }
        if (url === "https://example.com/") {
            return { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" }, data: "" };
        }
        throw new Error("fetched blocked hop " + url);
    };

    await assert.rejects(
        () => crawl("https://example.com/", "emails", 1, { httpGet }),
        (err) => err instanceof SafeUrlError
    );
    assert.equal(calls.some((url) => String(url).includes("169.254.169.254")), false);
    assert.equal(calls.filter((url) => !String(url).endsWith("/robots.txt")).length, 1);
});

test("safe redirects are followed and re-checked", async () => {
    const calls = [];
    const httpGet = async (url) => {
        calls.push(url);
        if (String(url).endsWith("/robots.txt")) return { status: 404, headers: {}, data: "" };
        if (url === "https://example.com/start") {
            return { status: 302, headers: { location: "https://example.com/next" }, data: "" };
        }
        if (url === "https://example.com/next") {
            return { status: 200, headers: {}, data: "reach-me@example.com" };
        }
        throw new Error("unexpected " + url);
    };

    const data = await crawl("https://example.com/start", "emails", 1, { httpGet });
    assert.ok(data.emails.includes("reach-me@example.com"));
    assert.ok(calls.includes("https://example.com/next"));
});

test("robots.txt disallow skips the fetch", async () => {
    const calls = [];
    const httpGet = async (url) => {
        calls.push(url);
        if (String(url).endsWith("/robots.txt")) {
            return { status: 200, headers: {}, data: "User-agent: *\nDisallow: /\n" };
        }
        throw new Error("fetched disallowed url " + url);
    };
    await assert.rejects(
        () => crawl("https://example.com/private", "all", 1, { httpGet }),
        (err) => err instanceof RobotsDisallowedError
    );
    assert.equal(calls.some((url) => String(url).includes("/private")), false);
});

test("crawl stops at 20 pages and 2 MB responses", async () => {
    const calls = [];
    const links = Array.from({ length: 40 }, (_, i) => `<a href="https://example.com/p${i}">p</a>`).join("");
    const html = `<html><body>secret@example.com ${links}</body></html>`;
    const httpGet = async (url, config) => {
        calls.push({ url, config });
        if (String(url).endsWith("/robots.txt")) return { status: 404, headers: {}, data: "" };
        return { status: 200, headers: { "content-type": "text/html" }, data: html };
    };

    const logs = [];
    const methods = ["log", "info", "warn", "error", "debug"];
    const originals = {};
    for (const method of methods) {
        originals[method] = console[method];
        console[method] = (...args) => logs.push(args.map(String).join(" "));
    }
    try {
        const data = await crawl("https://example.com/", "all", 1, { httpGet });
        const pageCalls = calls.filter((call) => !String(call.url).endsWith("/robots.txt"));
        assert.equal(pageCalls.length, MAX_PAGES);
        assert.equal(pageCalls.some((call) => String(call.url).includes("/p39")), false);
        assert.equal(data.pages.length, MAX_PAGES);
        assert.ok(data.emails.includes("secret@example.com"));
        for (const call of pageCalls) {
            assert.equal(call.config.maxContentLength, MAX_CONTENT_BYTES);
            assert.equal(call.config.maxBodyLength, MAX_CONTENT_BYTES);
            assert.equal(call.config.maxRedirects, 0);
            assert.equal(call.config.proxy, false);
            assert.ok(call.config.httpAgent);
            assert.ok(call.config.httpsAgent);
        }
        assert.equal(logs.some((line) => line.includes("secret@example.com")), false);
        assert.equal(logs.some((line) => line.includes("/p0")), false);
    } finally {
        for (const method of methods) console[method] = originals[method];
    }
});

test("oversized decoded bodies are rejected", async () => {
    const httpGet = async (url) => {
        if (String(url).endsWith("/robots.txt")) return { status: 404, headers: {}, data: "" };
        return { status: 200, headers: {}, data: "x".repeat(MAX_CONTENT_BYTES + 1) };
    };
    await assert.rejects(() => crawl("https://example.com/", "emails", 1, { httpGet }));
});

test("crawl results are not logged", async () => {
    const httpGet = async (url) => {
        if (String(url).endsWith("/robots.txt")) return { status: 404, headers: {}, data: "" };
        return { status: 200, headers: {}, data: "logged-secret@example.com +1 (555) 123-4567" };
    };
    const logs = [];
    const methods = ["log", "info", "warn", "error", "debug"];
    const originals = {};
    for (const method of methods) {
        originals[method] = console[method];
        console[method] = (...args) => logs.push(args.map(String).join(" "));
    }
    try {
        const app = createApp({ rateLimitMax: 100 });
        const originalCrawl = crawl;
        const serverModule = require("../server");
        const data = await originalCrawl("https://example.com/", "all", 1, { httpGet });
        assert.ok(data.emails.includes("logged-secret@example.com"));
        assert.ok(data.phones.length > 0);
        const joined = logs.join("\n");
        assert.equal(joined.includes("logged-secret@example.com"), false);
        assert.equal(joined.includes("555"), false);
        assert.equal(serverModule.crawl, originalCrawl);
        void app;
    } finally {
        for (const method of methods) console[method] = originals[method];
    }
});

test("CORS allows only configured origins", async () => {
    delete process.env.ALLOWED_ORIGINS;
    const app = createApp({ rateLimitMax: 100 });
    const allowed = await requestRaw(app, "OPTIONS", "/crawl", {
        Origin: "https://hellenicdev.eu",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers["access-control-allow-origin"], "https://hellenicdev.eu");
    assert.notEqual(allowed.headers["access-control-allow-origin"], "*");

    const denied = await postJson(app, { url: "http://127.0.0.1/" }, { Origin: "https://evil.example" });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);

    process.env.ALLOWED_ORIGINS = "https://example.com, https://hellenicdev.eu";
    const custom = createApp({ rateLimitMax: 100 });
    const customRes = await postJson(custom, { url: "not a url" }, { Origin: "https://example.com" });
    assert.equal(customRes.headers["access-control-allow-origin"], "https://example.com");
    delete process.env.ALLOWED_ORIGINS;
});

test("crawl endpoint is rate limited", async () => {
    const app = createApp({ rateLimitMax: 2, rateLimitWindowMs: 60000 });
    const first = await postJson(app, {});
    const second = await postJson(app, {});
    const third = await postJson(app, {});
    assert.equal(first.status, 400);
    assert.equal(second.status, 400);
    assert.equal(third.status, 429);
    assert.match(third.json.error, /Too many crawl requests/);
});

test("server source does not log crawl output and does not use open CORS", () => {
    const source = fs.readFileSync(require.resolve("../server.js"), "utf8");
    const calls = source.match(/console\.(log|info|warn|error|debug|trace)\(/g) || [];
    assert.deepEqual(calls, ["console.log("]);
    assert.match(source, /console\.log\("running on", PORT\)/);
    assert.equal(source.includes('Access-Control-Allow-Origin", "*"'), false);
    assert.equal(source.includes("Access-Control-Allow-Origin\", \"*\""), false);
});

test("page has description, canonical, og:url, main, and terms", () => {
    const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
    assert.match(html, /<meta\s+name="description"\s+content="[^"]+"\s*>/i);
    assert.match(html, /<link\s+rel="canonical"\s+href="https:\/\/hellenicdev\.eu\/cf-email-decoder\/public\/"\s*>/i);
    assert.match(html, /<meta\s+property="og:url"\s+content="https:\/\/hellenicdev\.eu\/cf-email-decoder\/public\/"\s*>/i);
    assert.match(html, /<main[\s>]/i);
    assert.match(html, /Terms of use/i);
    assert.match(html, /robots\.txt/i);
});
