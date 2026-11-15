import { downloadFile } from './download.mjs';
import { createNameAllocator } from './names.mjs';
import { createZip, MAX_ZIP_FILES, MAX_ZIP_BYTES } from './zip.mjs';

const DEFAULT_FILE_BYTES = 50_000_000;

function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * downloadFile(url, options) returns
 * { data: Buffer, finalUrl, contentDisposition, contentType, status }.
 * Input indexes are zero-based. Duplicate URLs share one archive entry.
 * totals.downloaded counts archive entries; totals.bytes counts their data.
 * totals.failed counts failed input rows, including repeated failed URLs.
 */
export async function runBulkZip({
  urls,
  maxFiles = MAX_ZIP_FILES,
  maxFileBytes = DEFAULT_FILE_BYTES,
  maxTotalBytes = MAX_ZIP_BYTES,
  concurrency = 4,
  prefixIndex = false,
} = {}, options = {}) {
  if (!Array.isArray(urls)) throw new TypeError('urls must be an array');
  integer(maxFiles, 1, MAX_ZIP_FILES, 'maxFiles');
  integer(maxFileBytes, 1, MAX_ZIP_BYTES, 'maxFileBytes');
  integer(maxTotalBytes, 1, MAX_ZIP_BYTES, 'maxTotalBytes');
  integer(concurrency, 1, MAX_ZIP_FILES, 'concurrency');
  if (typeof prefixIndex !== 'boolean') {
    throw new TypeError('prefixIndex must be a boolean');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  if (urls.length > maxFiles) {
    throw new RangeError(`Input exceeds ${maxFiles} files`);
  }
  const timeoutMs = integer(options.timeoutMs ?? 30_000, 1, 2_147_483_647, 'timeoutMs');
  if (options.allowPrivate !== undefined && typeof options.allowPrivate !== 'boolean') {
    throw new TypeError('allowPrivate must be a boolean');
  }

  // Snapshot inputs before awaiting so caller mutations cannot change the run.
  const input = urls.slice();
  const unique = [];
  const byUrl = new Map();
  const references = input.map((url, index) => {
    if (typeof url === 'string' && byUrl.has(url)) return byUrl.get(url);
    const item = { url, index, result: null };
    unique.push(item);
    if (typeof url === 'string') byUrl.set(url, item);
    return item;
  });
  const allocate = createNameAllocator({ prefixIndex });
  const files = [];
  let totalBytes = 0;

  async function fetchItem(item) {
    const started = performance.now();
    try {
      if (typeof item.url !== 'string' || !item.url.trim()) {
        throw new TypeError('URL must be a nonempty string');
      }
      const response = await downloadFile(item.url, {
        timeoutMs,
        maxFileBytes: Math.min(maxFileBytes, maxTotalBytes),
        allowPrivate: options.allowPrivate === true,
      });
      if (!response || !Buffer.isBuffer(response.data)) {
        throw new TypeError('Downloader did not return a Buffer');
      }
      if (response.data.length > maxFileBytes) {
        throw new RangeError(`File exceeds ${maxFileBytes} bytes`);
      }
      return { response, durationMs: Math.round(performance.now() - started) };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        status: Number.isInteger(error?.status) ? error.status : null,
        contentType: typeof error?.contentType === 'string' ? error.contentType : null,
        durationMs: Math.round(performance.now() - started),
      };
    }
  }

  // Process bounded batches and allocate names in input order. Completed data
  // outside the ZIP budget is discarded before starting another batch.
  for (let offset = 0; offset < unique.length; offset += concurrency) {
    const batch = unique.slice(offset, offset + concurrency);
    const outcomes = await Promise.all(batch.map(fetchItem));
    for (let position = 0; position < batch.length; position++) {
      const item = batch[position];
      const outcome = outcomes[position];
      const response = outcome.response;
      const row = {
        index: item.index,
        url: typeof item.url === 'string' ? item.url : null,
        ok: false,
        fileName: null,
        bytes: 0,
        contentType: response?.contentType ?? outcome.contentType ?? null,
        status: response?.status ?? outcome.status ?? null,
        error: outcome.error ?? null,
        durationMs: outcome.durationMs,
      };
      if (response) {
        if (totalBytes + response.data.length > maxTotalBytes) {
          row.error = `Total exceeds ${maxTotalBytes} uncompressed bytes`;
        } else {
          try {
            row.fileName = allocate({
              url: response.finalUrl || item.url,
              contentDisposition: response.contentDisposition,
              contentType: response.contentType,
              index: item.index,
            });
            files.push({ name: row.fileName, data: response.data });
            totalBytes += response.data.length;
            row.bytes = response.data.length;
            row.ok = true;
          } catch (error) {
            row.fileName = null;
            row.error = error instanceof Error ? error.message : String(error);
          }
        }
        // Release rejected buffers and avoid retaining accepted buffers twice.
        outcome.response = null;
      }
      item.result = row;
    }
  }

  const report = references.map((item, index) => ({ ...item.result, index }));
  return {
    zip: createZip(files, { maxFiles, maxTotalBytes }),
    report,
    totals: {
      requested: input.length,
      downloaded: files.length,
      failed: report.filter((row) => !row.ok).length,
      bytes: totalBytes,
    },
  };
}
