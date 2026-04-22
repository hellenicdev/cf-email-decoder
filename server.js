const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

// CORS
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
});

const STOP_DOMAINS = [
    "youtube.com",
    "google.com",
    "googleapis.com",
    "gstatic.com",
    "cdnjs.cloudflare.com",
    "fontawesome",
    "doubleclick.net",
    "facebook.com",
    "twitter.com"
];

function extractEmails(html) {
    return [...new Set(
        (html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
    )];
}

function extractPhones(html) {
    const raw = html.match(/(\+?\d[\d\s\-()]{8,}\d)/g) || [];

    return [...new Set(
        raw.filter(p => {
            const digits = p.replace(/\D/g, "");
            return digits.length >= 9 && digits.length <= 15;
        })
    )];
}

function extractLinks(html) {
    const links = [...html.matchAll(/href=["'](.*?)["']/g)]
        .map(m => m[1])
        .filter(l =>
            l.startsWith("http") &&
            !STOP_DOMAINS.some(d => l.includes(d)) &&
            !l.endsWith(".css") &&
            !l.endsWith(".js") &&
            !l.includes("utm_")
        );

    return [...new Set(links)].slice(0, 8);
}

async function crawl(startUrl, mode, depth = 1) {
    const visited = new Set();
    const queue = [{ url: startUrl, d: 0 }];

    const result = {
        pages: [],
        emails: new Set(),
        phones: new Set(),
        sites: new Set()
    };

    while (queue.length) {
        const { url, d } = queue.shift();
        if (visited.has(url) || d > depth) continue;

        visited.add(url);

        try {
            const res = await axios.get(url, {
                headers: { "User-Agent": "Mozilla/5.0" }
            });

            const html = res.data;

            if (mode === "all" || mode === "emails") {
                extractEmails(html).forEach(e => result.emails.add(e));
            }

            if (mode === "all" || mode === "phones") {
                extractPhones(html).forEach(p => result.phones.add(p));
            }

            if (mode === "all" || mode === "sites") {
                extractLinks(html).forEach(l => result.sites.add(l));
            }

            result.pages.push(url);

            const links = extractLinks(html);
            links.forEach(l => queue.push({ url: l, d: d + 1 }));

        } catch (e) {
            // ignore failures
        }
    }

    return {
        pages: result.pages,
        emails: [...result.emails],
        phones: [...result.phones],
        sites: [...result.sites]
    };
}

app.post("/crawl", async (req, res) => {
    try {
        const { url, mode } = req.body;

        if (!url) return res.status(400).json({ error: "No URL provided" });

        const data = await crawl(url, mode || "all", 1);
        res.json(data);

    } catch (err) {
        res.status(500).json({ error: "crawl failed" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("running on", PORT));