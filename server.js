const express = require("express");
const axios = require("axios");
const dns = require("dns").promises;
const net = require("net");
const ipaddr = require("ipaddr.js");
const rateLimit = require("express-rate-limit");
const robotsParser = require("robots-parser");
const { URL } = require("url");

const DEFAULT_ALLOWED_ORIGIN = "https://hellenicdev.eu";
const MAX_PAGES = 20;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 500 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15000;
const DNS_TIMEOUT_MS = 5000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 10;
const USER_AGENT = "ContactCrawler/1.0 (+https://hellenicdev.eu/cf-email-decoder/public/)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const BLOCKED_HOSTS = new Set([
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
    "metadata.goog",
]);

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "HttpError";
        this.status = status;
    }
}

class SafeUrlError extends HttpError {
    constructor(message = "This URL is not allowed.") {
        super(400, message);
        this.name = "SafeUrlError";
    }
}

class RobotsDisallowedError extends HttpError {
    constructor(reason = "disallowed") {
        super(
            403,
            reason === "unavailable"
                ? "Crawling was skipped because robots.txt could not be confirmed."
                : "Crawling this URL is disallowed by robots.txt."
        );
        this.name = "RobotsDisallowedError";
        this.reason = reason;
    }
}

class ResponseTooLargeError extends HttpError {
    constructor() {
        super(413, "The response is larger than 2 MB.");
        this.name = "ResponseTooLargeError";
    }
}

const ALLOW_ALL = Object.freeze({ allowAll: true });
const DENY_ALL = Object.freeze({ denyAll: true, reason: "disallowed" });
const DENY_UNAVAILABLE = Object.freeze({ denyAll: true, reason: "unavailable" });

let filteringAgents = null;

async function getFilteringAgents() {
    if (!filteringAgents) {
        const { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } = await import("request-filtering-agent");
        filteringAgents = {
            httpAgent: new RequestFilteringHttpAgent({ keepAlive: false }),
            httpsAgent: new RequestFilteringHttpsAgent({ keepAlive: false }),
        };
    }
    return filteringAgents;
}

function normalizeHost(hostname) {
    let host = String(hostname || "").trim().toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) {
        host = host.slice(1, -1);
    }
    const zone = host.indexOf("%");
    if (zone !== -1) host = host.slice(0, zone);
    if (host.endsWith(".")) host = host.slice(0, -1);
    return host;
}

function isBlockedIp(address) {
    if (!net.isIP(address)) return true;
    try {
        let parsed = ipaddr.parse(address);
        if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
            parsed = parsed.toIPv4Address();
        }
        return parsed.range() !== "unicast";
    } catch {
        return true;
    }
}

function isBlockedHostname(hostname) {
    const host = normalizeHost(hostname);
    if (!host) return true;
    if (BLOCKED_HOSTS.has(host)) return true;
    if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
    if (net.isIP(host)) return isBlockedIp(host);
    if (!host.includes(".")) return true;
    return false;
}

async function lookupAll(hostname) {
    let timer;
    try {
        return await Promise.race([
            dns.lookup(hostname, { all: true, verbatim: true }),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("dns timeout")), DNS_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function assertSafeUrl(urlString) {
    let parsed;
    try {
        parsed = new URL(urlString);
    } catch {
        throw new SafeUrlError("Invalid URL. Must start with http:// or https://");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new SafeUrlError("Invalid URL. Must start with http:// or https://");
    }
    if (parsed.username || parsed.password) {
        throw new SafeUrlError("This URL is not allowed.");
    }

    const host = normalizeHost(parsed.hostname);
    if (!host || isBlockedHostname(host)) {
        throw new SafeUrlError("This URL is not allowed.");
    }

    if (net.isIP(host)) return parsed;

    let records;
    try {
        records = await lookupAll(host);
    } catch {
        throw new SafeUrlError("Could not resolve host.");
    }
    if (!Array.isArray(records) || records.length === 0) {
        throw new SafeUrlError("Could not resolve host.");
    }
    for (const record of records) {
        if (!record || !record.address || isBlockedIp(record.address)) {
            throw new SafeUrlError("This URL is not allowed.");
        }
    }
    return parsed;
}

function isObviouslyBlocked(urlString) {
    try {
        const parsed = new URL(urlString);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
        if (parsed.username || parsed.password) return true;
        return isBlockedHostname(parsed.hostname);
    } catch {
        return true;
    }
}

function rethrowRequestError(err) {
    if (err instanceof HttpError) throw err;
    const message = String(err && err.message ? err.message : "");
    if (/private IP address|meta IP address|is not allowed\. Because/i.test(message)) {
        throw new SafeUrlError("This URL is not allowed.");
    }
    if (/maxContentLength|maxBodyLength/i.test(message)) {
        throw new ResponseTooLargeError();
    }
    throw err;
}

async function requestOnce(url, ctx = {}, maxBytes = MAX_CONTENT_BYTES) {
    await assertSafeUrl(url);
    const agents = await getFilteringAgents();
    const config = {
        headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        },
        timeout: REQUEST_TIMEOUT_MS,
        maxRedirects: 0,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        httpAgent: agents.httpAgent,
        httpsAgent: agents.httpsAgent,
        proxy: false,
        responseType: "text",
        transformResponse: [(data) => data],
        validateStatus: () => true,
    };

    const httpGet = ctx.httpGet || axios.get.bind(axios);
    let res;
    try {
        res = await httpGet(url, config);
    } catch (err) {
        rethrowRequestError(err);
    }

    if (typeof res.data === "string" && Buffer.byteLength(res.data) > maxBytes) {
        throw new ResponseTooLargeError();
    }
    return res;
}

function robotsAllow(robots, url) {
    if (!robots || robots.allowAll) return true;
    if (robots.denyAll) return false;
    try {
        return robots.isAllowed(url, USER_AGENT) === true;
    } catch {
        return false;
    }
}

async function fetchResource(url, ctx, options = {}) {
    const checkRobots = options.checkRobots === true;
    const robotsCache = options.robotsCache || new Map();
    const maxBytes = options.maxBytes || MAX_CONTENT_BYTES;
    let current = url;
    const seen = new Set();

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let parsed;
        try {
            parsed = new URL(current);
        } catch {
            throw new SafeUrlError("This URL is not allowed.");
        }
        current = parsed.href;
        if (seen.has(current)) throw new SafeUrlError("This URL is not allowed.");
        seen.add(current);

        await assertSafeUrl(current);

        if (checkRobots) {
            const robots = await loadRobots(parsed.origin, robotsCache, ctx);
            if (!robotsAllow(robots, current)) {
                throw new RobotsDisallowedError(robots && robots.reason ? robots.reason : "disallowed");
            }
        }

        const res = await requestOnce(current, ctx, maxBytes);
        if (!REDIRECT_STATUSES.has(res.status)) {
            return { url: current, status: res.status, data: res.data, headers: res.headers || {} };
        }

        const location = res.headers && (res.headers.location || res.headers.Location);
        if (!location || hop === MAX_REDIRECTS) {
            throw new SafeUrlError("This URL is not allowed.");
        }
        try {
            current = new URL(location, current).href;
        } catch {
            throw new SafeUrlError("This URL is not allowed.");
        }
    }

    throw new SafeUrlError("This URL is not allowed.");
}

async function loadRobots(origin, cache, ctx) {
    if (cache.has(origin)) return cache.get(origin);

    const robotsUrl = new URL("/robots.txt", origin).href;
    let decision = DENY_UNAVAILABLE;
    try {
        const res = await fetchResource(robotsUrl, ctx, {
            checkRobots: false,
            robotsCache: cache,
            maxBytes: MAX_ROBOTS_BYTES,
        });
        if (res.status === 401 || res.status === 403) {
            decision = DENY_ALL;
        } else if (res.status >= 200 && res.status < 300) {
            const body = typeof res.data === "string" ? res.data.slice(0, MAX_ROBOTS_BYTES) : "";
            decision = robotsParser(robotsUrl, body);
        } else if (res.status >= 400 && res.status < 500) {
            decision = ALLOW_ALL;
        } else {
            decision = DENY_UNAVAILABLE;
        }
    } catch (err) {
        if (err instanceof SafeUrlError) {
            cache.set(origin, DENY_ALL);
            throw err;
        }
        if (err instanceof ResponseTooLargeError) {
            decision = DENY_ALL;
        } else {
            decision = DENY_UNAVAILABLE;
        }
    }

    cache.set(origin, decision);
    return decision;
}

const STOP_DOMAINS = new Set([
    "youtube.com",
    "google.com",
    "googleapis.com",
    "gstatic.com",
    "cdnjs.cloudflare.com",
    "doubleclick.net",
    "facebook.com",
    "twitter.com",
    "instagram.com",
    "linkedin.com",
    "github.com",
]);

const STOP_EXTENSIONS = new Set([
    ".css", ".js", ".json", ".xml", ".svg", ".ico", ".png", ".jpg",
    ".jpeg", ".gif", ".webp", ".mp4", ".webm", ".mp3", ".wav",
    ".pdf", ".doc", ".docx", ".zip", ".tar", ".gz",
]);

function decodeCfEmail(encoded) {
    try {
        const hex = encoded.replace(/[^0-9a-fA-F]/g, "");
        if (hex.length < 2 || hex.length % 2 !== 0) return null;
        const bytes = [];
        for (let i = 0; i < hex.length; i += 2) {
            bytes.push(parseInt(hex.substring(i, i + 2), 16));
        }
        const key = bytes[0];
        const decoded = [];
        for (let i = 1; i < bytes.length; i++) {
            decoded.push(String.fromCharCode(bytes[i] ^ key));
        }
        const email = decoded.join("");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
        return email;
    } catch {
        return null;
    }
}

function extractCfEmails(html) {
    const emails = new Set();
    const regex = /data-cfemail=["']([^"']+)["']/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
        const decoded = decodeCfEmail(match[1]);
        if (decoded) emails.add(decoded);
    }
    return emails;
}

function decodeHtmlEntities(text) {
    return text
        .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCharCode(parseInt(c, 16)))
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ");
}

function extractEmails(html) {
    const emails = new Set();

    const cfEmails = extractCfEmails(html);
    cfEmails.forEach(e => emails.add(e));

    const decodedHtml = decodeHtmlEntities(html);

    const mailtoRegex = /href=["']mailto:([^"']+)["']/gi;
    let match;
    while ((match = mailtoRegex.exec(decodedHtml)) !== null) {
        const email = match[1].split("?")[0].trim();
        if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            emails.add(email);
        }
    }

    const textRegex = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}/g;
    while ((match = textRegex.exec(decodedHtml)) !== null) {
        const email = match[0].toLowerCase();
        if (!email.endsWith(".png") && !email.endsWith(".jpg") && !email.endsWith(".jpeg") && !email.endsWith(".gif") && !email.endsWith(".svg")) {
            emails.add(email);
        }
    }

    return [...emails];
}

function extractPhones(html) {
    const decoded = decodeHtmlEntities(html);
    const phones = new Set();

    const patterns = [
        /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,9}/g,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(decoded)) !== null) {
            const digits = match[0].replace(/\D/g, "");
            if (digits.length >= 7 && digits.length <= 15) {
                const countryCode = digits.length > 10 ? "+" + digits.slice(0, digits.length - 10) : "";
                const local = digits.slice(-10);
                const area = local.slice(0, 3);
                const rest = local.slice(3, 6) + local.slice(6);
                phones.add(countryCode + " " + area + " " + rest.slice(0, 3) + " " + rest.slice(3));
            }
        }
    }

    return [...phones].filter(p => {
        const digits = p.replace(/\D/g, "");
        return digits.length >= 7 && digits.length <= 15;
    });
}

function resolveUrl(base, raw) {
    try {
        return new URL(raw, base).href;
    } catch {
        return null;
    }
}

function extractLinks(html, baseUrl) {
    const links = new Set();

    const hrefRegex = /href=["'](.*?)["']/gi;
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
        const raw = match[1].trim();
        if (!raw || raw.startsWith("#") || raw.startsWith("javascript:") || raw.startsWith("tel:") || raw.startsWith("mailto:")) continue;

        const resolved = resolveUrl(baseUrl, raw);
        if (!resolved) continue;

        const u = new URL(resolved);

        if (u.protocol !== "http:" && u.protocol !== "https:") continue;

        if (STOP_DOMAINS.has(u.hostname) || [...STOP_DOMAINS].some(d => u.hostname.endsWith("." + d) || u.hostname === d)) continue;

        const pathname = u.pathname.toLowerCase();
        if ([...STOP_EXTENSIONS].some(ext => pathname.endsWith(ext))) continue;

        if (u.hash) u.hash = "";
        u.search = "";

        if (u.href.includes("utm_")) continue;

        links.add(u.href);
    }

    return [...links];
}

function normalizeUrl(url) {
    try {
        const u = new URL(url);
        u.hash = "";
        return u.href;
    } catch {
        return url;
    }
}

async function crawl(startUrl, mode, depth = 1, ctx = {}) {
    const normalizedStart = normalizeUrl(String(startUrl).trim());
    await assertSafeUrl(normalizedStart);

    const robotsCache = new Map();
    const startRobots = await loadRobots(new URL(normalizedStart).origin, robotsCache, ctx);
    if (!robotsAllow(startRobots, normalizedStart)) {
        throw new RobotsDisallowedError(startRobots && startRobots.reason ? startRobots.reason : "disallowed");
    }

    const visited = new Set();
    const queue = [{ url: normalizedStart, d: 0 }];
    const result = {
        pages: [],
        emails: new Set(),
        phones: new Set(),
        sites: new Set(),
    };

    while (queue.length && result.pages.length < MAX_PAGES) {
        const { url, d } = queue.shift();
        const normalized = normalizeUrl(url);
        if (visited.has(normalized) || d > depth) continue;
        visited.add(normalized);
        const isStart = result.pages.length === 0 && visited.size === 1;

        try {
            const page = await fetchResource(normalized, ctx, {
                checkRobots: true,
                robotsCache,
            });
            const html = page.data;
            if (page.status >= 400 || typeof html !== "string") continue;

            if (mode === "all" || mode === "emails") {
                extractEmails(html).forEach(e => result.emails.add(e));
            }

            if (mode === "all" || mode === "phones") {
                extractPhones(html).forEach(p => result.phones.add(p));
            }

            if (mode === "all" || mode === "sites") {
                const links = extractLinks(html, page.url);
                for (const link of links) {
                    result.sites.add(link);
                    if (d + 1 > depth) continue;
                    if (visited.has(normalizeUrl(link))) continue;
                    if (isObviouslyBlocked(link)) continue;
                    if (visited.size + queue.length >= MAX_PAGES) continue;
                    queue.push({ url: link, d: d + 1 });
                }
            }

            result.pages.push(normalizeUrl(page.url));
        } catch (err) {
            if (isStart && err instanceof HttpError) throw err;
        }
    }

    return {
        pages: result.pages,
        emails: [...result.emails],
        phones: [...result.phones],
        sites: [...result.sites],
    };
}

function allowedOrigins() {
    const raw = process.env.ALLOWED_ORIGINS;
    if (raw == null || String(raw).trim() === "") return [DEFAULT_ALLOWED_ORIGIN];
    const origins = String(raw)
        .split(",")
        .map(origin => origin.trim())
        .filter(origin => origin && origin !== "*");
    return origins.length ? origins : [DEFAULT_ALLOWED_ORIGIN];
}

function createApp(options = {}) {
    const app = express();
    app.disable("x-powered-by");
    app.set("trust proxy", 1);
    app.use(express.json({ limit: "32kb" }));

    app.use((req, res, next) => {
        const origin = req.headers.origin;
        const allowed = allowedOrigins();
        const originAllowed = typeof origin === "string" && allowed.includes(origin);
        if (originAllowed) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        }
        if (req.method === "OPTIONS") {
            return res.sendStatus(originAllowed ? 204 : 403);
        }
        if (typeof origin === "string" && origin && !originAllowed) {
            return res.status(403).json({ error: "Origin is not allowed." });
        }
        next();
    });

    const crawlLimiter = rateLimit({
        windowMs: options.rateLimitWindowMs || RATE_LIMIT_WINDOW_MS,
        limit: options.rateLimitMax || RATE_LIMIT_MAX,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        handler: (req, res) => {
            res.status(429).json({ error: "Too many crawl requests. Please try again later." });
        },
    });

    app.post("/crawl", crawlLimiter, async (req, res) => {
        try {
            const body = req.body || {};
            const { url, mode } = body;

            if (!url || typeof url !== "string") {
                return res.status(400).json({ error: "A valid URL string is required" });
            }

            const validModes = ["all", "emails", "phones", "sites"];
            const crawlMode = validModes.includes(mode) ? mode : "all";

            const data = await crawl(url.trim(), crawlMode, 1);
            res.json(data);
        } catch (err) {
            if (err instanceof HttpError) {
                return res.status(err.status).json({ error: err.message });
            }
            res.status(500).json({ error: "Crawl failed. Please check the URL and try again." });
        }
    });

    app.get("/health", (req, res) => {
        res.json({ status: "ok", mode: "cf-email-decoder" });
    });

    return app;
}

const app = createApp();

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "test") {
    app.listen(PORT, "0.0.0.0", () => console.log("running on", PORT));
}

module.exports = {
    decodeCfEmail,
    extractEmails,
    extractPhones,
    extractLinks,
    crawl,
    app,
    createApp,
    assertSafeUrl,
    isBlockedIp,
    isBlockedHostname,
    getFilteringAgents,
    MAX_PAGES,
    MAX_CONTENT_BYTES,
    USER_AGENT,
    SafeUrlError,
    RobotsDisallowedError,
    ResponseTooLargeError,
};
