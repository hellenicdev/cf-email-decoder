const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

// CORS so GitHub Pages can call it
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
});

function decodeCFEmail(hex) {
    const key = parseInt(hex.substr(0, 2), 16);
    let email = "";

    for (let i = 2; i < hex.length; i += 2) {
        const byte = parseInt(hex.substr(i, 2), 16);
        email += String.fromCharCode(byte ^ key);
    }

    return email;
}

app.post("/extract", async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) return res.status(400).json({ error: "No URL provided" });

        const response = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0"
            }
        });

        const html = response.data;

        const matches = [...html.matchAll(/data-cfemail="([0-9a-fA-F]+)"/g)];

        const emails = matches.map(m => decodeCFEmail(m[1]));

        res.json({ emails });

    } catch (err) {
        res.status(500).json({ error: "Failed to fetch URL" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port", PORT));