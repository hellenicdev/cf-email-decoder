# CF Email Decoder

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/S6S31XB030)

> ⚠️ **Educational purposes only.** Only crawl sites you are allowed to access, and follow their terms, robots.txt and the law (including the GDPR).

A small crawler that finds contact details on a website and automatically decodes Cloudflare-obfuscated (`data-cfemail`) email addresses.

**Live:** https://hellenicdev.eu/cf-email-decoder/public/

## Features

- Decodes Cloudflare `data-cfemail` / `/cdn-cgi/l/email-protection` emails (XOR decoding)
- Extracts emails, phone numbers and links. Choose all, or one type only
- Same-site crawl of up to 20 pages, with responses capped at 2 MB
- Obeys robots.txt
- SSRF protection: blocks loopback, private, link-local and cloud-metadata addresses, checked at every redirect hop
- Rate limiting: 10 crawls per 15 minutes per IP
- CORS allow-list
- Crawl results go back to your browser only. They aren't stored or logged
- Export results as JSON

## Tech stack

- **Frontend:** single static HTML page (GitHub Pages)
- **Backend:** Node.js, Express, axios, request-filtering-agent, robots-parser, express-rate-limit
- **Tests:** `node:test`

## Setup

```bash
git clone https://github.com/hellenicdev/cf-email-decoder.git
cd cf-email-decoder
npm install
npm start      # http://localhost:3000
npm test
```

Open `public/index.html` and point the `API` constant at your server.

### Environment variables

| Name | Description |
| --- | --- |
| `PORT` | HTTP port (default `3000`). The server listens on `0.0.0.0`. |
| `ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the API (default `https://hellenicdev.eu`). A `*` entry is ignored. |
| `NODE_ENV` | Set to `test` to skip starting the listener. |

### API

`POST /crawl` with the body `{ "url": "https://example.com", "mode": "all" | "emails" | "phones" | "sites" }` returns `{ pages, emails, phones, sites }`. `GET /health` is a health check.

## Project structure

```
├── server.js          # Crawler, decoder, SSRF guard and Express API
├── public/index.html  # Web UI
└── test/              # extraction and security tests
```

## License

MIT. See [LICENSE](LICENSE).

---

Made by [HellenicDev](https://hellenicdev.eu).
