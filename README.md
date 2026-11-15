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

## What can you do with it?

### Package reference documents
Download a list of public file URLs into one ZIP archive. These illustrative URLs come from the local README and mocked tests; replace them with public files you have permission to download. They do not demonstrate successful public downloads.

```json
{
  "urls": [
    "https://example.com/report.pdf",
    "https://example.com/image/png"
  ],
  "zipFileName": "reference-documents.zip"
}
```

### Prepare an ordered download bundle
Add sequential index prefixes to archived filenames when preparing a bundle for review. The input supplies the file URLs directly, so no page crawling is required.

```json
{
  "urls": [
    "https://example.com/image/png",
    "https://example.com/report.pdf"
  ],
  "prefixIndex": true,
  "zipFileName": "review-bundle.zip"
}
```

### Set a per-file size ceiling
Apply a download size limit when collecting public files. Files exceeding that limit produce errors in the report rather than being treated as successful downloads.

```json
{
  "urls": [
    "https://example.com/report.pdf"
  ],
  "maxFileMegabytes": 5,
  "zipFileName": "limited-bundle.zip"
}
```

### Download with lower concurrency
Set concurrency to one when you want fewer simultaneous downloads. This controls download parallelism while keeping the same public URL input format.

```json
{
  "urls": [
    "https://example.com/report.pdf",
    "https://example.com/image/png"
  ],
  "concurrency": 1,
  "maxFileMegabytes": 10,
  "zipFileName": "sequential-downloads.zip"
}
```

## How much does it cost?

The event prices are USD 0.005 per valid run plus USD 0.002 per unique file included in the ZIP. Failed downloads and duplicate report rows do not create additional file events.

- A run with 2 billed file events: USD 0.005 + (2 × USD 0.002) = **USD 0.009**.
- A run with 100 billed file events: USD 0.005 + (100 × USD 0.002) = **USD 0.205**.

Use the run's actual billed event count when reconciling its cost. These calculations cover the listed event prices; check your Apify account for any additional applicable platform charges.

## FAQ

### Does it find files on a website?
You provide the file URLs in `urls`. The Actor downloads that list rather than discovering links by crawling a website.

### Can I download from private destinations?
The input is intended for public HTTP or HTTPS file URLs. Private destinations are rejected.

### What are the input limits?
Provide 1–1000 URL strings, with `concurrency` from 1 to 10 and `maxFileMegabytes` from 1 to 500. One megabyte means 1000000 bytes; the archive has a 500000000-byte uncompressed total limit and is built in memory. Repeated URLs share one download and one ZIP entry.

### What happens when a file cannot be downloaded?
Inspect the download report for errors, including files exceeding the configured size limit. Check the actual successful downloads before treating the ZIP as a complete copy of your input list.

### How do I schedule a daily run?
Save the input as an Apify Task and create a daily Schedule for that Task. Each scheduled execution runs the supplied download list again.

### Can I export CSV or JSON instead of downloading the ZIP?
Use Apify's dataset export to obtain the run's report records as CSV or JSON. That export contains report data; retrieve the ZIP separately from the run's default key-value store using the configured `zipFileName`.

## Integrations

Start a run through the Apify API with your public file URL list and download settings. Configure Apify webhooks to notify your system about run lifecycle events. In an automation workflow, wait for completion, inspect the download report and retrieve the ZIP from the run's key-value store.

## Responsible use

You are responsible for having the right to download and store the files you request. Do not use this Actor to collect copyrighted material you are not allowed to copy.

## Development

`npm test` runs the offline suite (Node 22, no network: a loopback HTTP server stands in for remote hosts).
