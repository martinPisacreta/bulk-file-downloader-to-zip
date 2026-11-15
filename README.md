# Bulk File Downloader to ZIP

Give it a list of file URLs and get back one ZIP archive plus a report row for every URL. No browser, no proxies, no login: plain HTTP(S) downloads of files that are already public.

Typical uses: collecting PDFs, images, CSV exports or documents produced by another Actor or listed in a spreadsheet, and handing them over as a single download.

## Quick start

```json
{
  "urls": [
    "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    "https://www.rfc-editor.org/rfc/rfc2606.txt"
  ]
}
```

The run stores `files.zip` in the default key-value store and writes one row per URL to the dataset. The `OUTPUT` record contains the direct link to the ZIP.

## Input

| Field | Accepted values | Default |
| --- | --- | --- |
| `urls` | 1 to 1000 URLs, as strings or as objects with a `url` field | Required |
| `zipFileName` | Letters, numbers, dots, hyphens and underscores; must end in `.zip` | `files.zip` |
| `prefixIndex` | `true` adds `001-`, `002-` … before each filename, in input order | `false` |
| `maxFileMegabytes` | 1 to 500 (1 MB = 1,000,000 bytes) | `50` |
| `concurrency` | 1 to 10 simultaneous downloads | `4` |

## Output

**ZIP archive.** Saved in the default key-value store under `zipFileName`, content type `application/zip`. `OUTPUT` holds `zipKey`, `zipUrl` and `totals` (`requested`, `downloaded`, `failed`, `bytes`).

**Dataset.** One row per input URL, in input order:

| Field | Meaning |
| --- | --- |
| `index` | Zero-based position in the input |
| `url` | Requested URL |
| `ok` | Whether the file is in the ZIP |
| `fileName` | Name inside the ZIP, or null |
| `bytes` | Uncompressed size |
| `contentType` | Response Content-Type, when available |
| `status` | HTTP status, when available |
| `error` | Failure reason, or null |
| `durationMs` | Download time |

A failed URL never stops the others: it gets a row with `ok: false` and the reason (HTTP 404, timeout, too large, and so on).

## File names

Names come from the `Content-Disposition` header when present, otherwise from the last segment of the final URL, otherwise `file-<n>`. A known Content-Type supplies a missing extension. Names are sanitized (no paths, no control characters, at most 120 characters) and collisions are numbered: `report.pdf`, `report-2.pdf`.

## Pricing

Pay per event:

- `run-started`: $0.005 per valid run. Invalid input is rejected before any charge.
- `file-downloaded`: $0.002 per file included in the ZIP. Failed downloads are not charged, and a URL repeated in the input is downloaded and charged once.

If you set a maximum cost per run, the Actor works out how many files that covers before downloading anything. URLs beyond that are not requested and are reported as `Skipped: spending limit reached`.

## Limits

- At most 1000 URLs and 500 MB of uncompressed content per run. Split larger jobs into several runs.
- 30 seconds per file, including redirects (up to five) and one retry on HTTP 429 or 5xx.
- Files and the ZIP are held in memory. For archives over about 300 MB, raise the run memory to 4096 MB.
- Only `http:` and `https:` URLs that resolve to public addresses. Private, loopback and link-local destinations are rejected, including when reached through a redirect.
- No JavaScript rendering, cookies or logins: the URL must return the file itself.
- ZIP64 is not supported, which is why the size and count limits exist.

## Responsible use

You are responsible for having the right to download and store the files you request. Do not use this Actor to collect copyrighted material you are not allowed to copy.

## Development

`npm test` runs the offline suite (Node 22, no network: a loopback HTTP server stands in for remote hosts).
