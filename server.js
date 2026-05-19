const express = require("express");
const axios = require("axios");
const { URL } = require("url");

const app = express();

app.use(express.json({ limit: "5mb" }));

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
});

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

function isValidUrl(string) {
    try {
        const u = new URL(string);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

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

async function crawl(startUrl, mode, depth = 1) {
    const visited = new Set();
    const queue = [{ url: normalizeUrl(startUrl), d: 0 }];

    const result = {
        pages: [],
        emails: new Set(),
        phones: new Set(),
        sites: new Set(),
    };

    while (queue.length) {
        const { url, d } = queue.shift();
        const normalized = normalizeUrl(url);
        if (visited.has(normalized) || d > depth) continue;
        visited.add(normalized);

        try {
            const res = await axios.get(url, {
                headers: {
                    "User-Agent": "ContactCrawler/1.0",
                    "Accept": "text/html,application/xhtml+xml",
                },
                timeout: 15000,
                maxRedirects: 5,
                validateStatus: status => status < 400,
            });

            const html = res.data;
            if (typeof html !== "string") continue;

            if (mode === "all" || mode === "emails") {
                extractEmails(html).forEach(e => result.emails.add(e));
            }

            if (mode === "all" || mode === "phones") {
                extractPhones(html).forEach(p => result.phones.add(p));
            }

            if (mode === "all" || mode === "sites") {
                const links = extractLinks(html, url);
                links.forEach(l => result.sites.add(l));
                links.forEach(l => queue.push({ url: l, d: d + 1 }));
            }

            result.pages.push(normalized);
        } catch {
            // ignore individual page failures
        }
    }

    return {
        pages: result.pages,
        emails: [...result.emails],
        phones: [...result.phones],
        sites: [...result.sites],
    };
}

app.post("/crawl", async (req, res) => {
    try {
        const { url, mode } = req.body;

        if (!url || typeof url !== "string") {
            return res.status(400).json({ error: "A valid URL string is required" });
        }

        if (!isValidUrl(url)) {
            return res.status(400).json({ error: "Invalid URL. Must start with http:// or https://" });
        }

        const validModes = ["all", "emails", "phones", "sites"];
        const crawlMode = validModes.includes(mode) ? mode : "all";

        const data = await crawl(url.trim(), crawlMode, 1);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Crawl failed. Please check the URL and try again." });
    }
});

app.get("/health", (req, res) => {
    res.json({ status: "ok", mode: "cf-email-decoder" });
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "test") {
    app.listen(PORT, () => console.log("running on", PORT));
}

module.exports = {
    decodeCfEmail,
    extractEmails,
    extractPhones,
    extractLinks,
    crawl,
    app,
};
