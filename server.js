const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
});

function decodeCFEmail(hex) {
    const key = parseInt(hex.substr(0, 2), 16);
    let email = "";
    for (let i = 2; i < hex.length; i += 2) {
        email += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ key);
    }
    return email;
}

function extractAll(html) {
    const emails = [...new Set(
        (html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
    )];

    const phones = [...new Set(
        (html.match(/(\+?\d[\d\s\-()]{7,}\d)/g) || [])
    )];

    const cf = [...html.matchAll(/data-cfemail="([0-9a-fA-F]+)"/g)]
        .map(m => decodeCFEmail(m[1]));

    return {
        emails,
        phones,
        cloudflare: cf
    };
}

// extract links from page
function extractLinks(html, baseUrl) {
    const matches = [...html.matchAll(/href=["'](.*?)["']/g)]
        .map(m => m[1])
        .filter(h => h.startsWith("http"));

    return [...new Set(matches)].slice(0, 10); // limit crawl
}

// BFS crawler
async function crawl(startUrl, depth = 2) {
    const visited = new Set();
    const queue = [{ url: startUrl, d: 0 }];

    let results = {
        pages: [],
        emails: new Set(),
        phones: new Set(),
        cloudflare: new Set()
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
            const extracted = extractAll(html);

            extracted.emails.forEach(e => results.emails.add(e));
            extracted.phones.forEach(p => results.phones.add(p));
            extracted.cloudflare.forEach(c => results.cloudflare.add(c));

            results.pages.push(url);

            const links = extractLinks(html, url);
            links.forEach(l => queue.push({ url: l, d: d + 1 }));

        } catch (e) {
            // ignore failed pages
        }
    }

    return {
        pages: results.pages,
        emails: [...results.emails],
        phones: [...results.phones],
        cloudflare: [...results.cloudflare]
    };
}

app.post("/crawl", async (req, res) => {
    try {
        const { url, depth } = req.body;
        if (!url) return res.status(400).json({ error: "No URL provided" });

        const data = await crawl(url, depth || 1);
        res.json(data);

    } catch (err) {
        res.status(500).json({ error: "crawl failed" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("running on", PORT));