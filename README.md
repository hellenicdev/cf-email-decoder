# cf-email-decoder
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/S6S31XB030)
Educational purposes ONLY!

The crawler fetches at most 20 pages, refuses responses larger than 2 MB, obeys robots.txt, and does not request loopback, private, link-local, or cloud metadata addresses. Crawl results are returned to the caller and are not written to server logs.

## Configuration

- `PORT` — HTTP port. Defaults to `3000`. The server listens on `0.0.0.0`.
- `ALLOWED_ORIGINS` — comma-separated browser origins allowed to call the API. Defaults to `https://hellenicdev.eu`. A `*` entry is ignored.
