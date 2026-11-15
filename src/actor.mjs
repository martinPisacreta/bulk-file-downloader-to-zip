import { parseInput } from './input.mjs';
import { runBulkZip } from './run.mjs';
import { affordableFileCount, chargeEvent, RUN_EVENT, FILE_EVENT, MAX_BATCH_SIZE } from './billing.mjs';

export async function main(actor, {
  runZip = runBulkZip,
  allowPrivate = false,
  timeoutMs = 30_000,
} = {}) {
  // Validate before charging or accessing output storage.
  const input = parseInput(await actor.getInput());
  const started = await chargeEvent(actor, RUN_EVENT);
  const uniqueCount = new Set(input.urls).size;
  const allowance = started.stop || started.processedCount !== 1
    ? 0 : await affordableFileCount(actor, uniqueCount);

  // Duplicate URLs share a download and a billing event, including when
  // a duplicate appears after a URL excluded by the spending limit.
  const admitted = new Set();
  const selectedUrls = [];
  const originalIndexes = [];
  for (let index = 0; index < input.urls.length; index++) {
    const url = input.urls[index];
    if (!admitted.has(url) && admitted.size < allowance) admitted.add(url);
    if (admitted.has(url)) {
      selectedUrls.push(url);
      originalIndexes.push(index);
    }
  }

  const maxFileBytes = Math.floor(input.maxFileMegabytes * 1_000_000);
  const result = await runZip({
    urls: selectedUrls,
    prefixIndex: input.prefixIndex,
    concurrency: input.concurrency,
    maxFileBytes,
  }, { allowPrivate, timeoutMs, maxFileBytes });

  const report = input.urls.map((url, index) => ({
    index, url, ok: false, fileName: null, bytes: 0,
    contentType: null, status: null,
    error: 'Skipped: spending limit reached', durationMs: 0,
  }));
  for (const row of result.report) {
    const originalIndex = originalIndexes[row.index];
    report[originalIndex] = { ...row, index: originalIndex };
  }
  const totals = {
    requested: input.urls.length,
    downloaded: result.totals.downloaded,
    failed: report.filter(row => !row.ok).length,
    bytes: result.totals.bytes,
  };

  const store = await actor.openKeyValueStore();
  await store.setValue(input.zipFileName, result.zip, {
    contentType: 'application/zip',
  });
  for (let offset = 0; offset < report.length; offset += MAX_BATCH_SIZE) {
    await actor.pushData(report.slice(offset, offset + MAX_BATCH_SIZE));
  }

  // Charge archive entries, never duplicate report rows or failed downloads.
  // Storage and charging are separate operations; failures propagate and
  // charges are never retried automatically.
  const charged = await chargeEvent(actor, FILE_EVENT, totals.downloaded);
  if (charged.processedCount !== totals.downloaded) {
    throw new Error('Spending limit prevented charging every archived file; charge was not retried');
  }

  const output = {
    zipKey: input.zipFileName,
    zipUrl: await store.getPublicUrl(input.zipFileName),
    totals,
  };
  await actor.setValue('OUTPUT', output);
  return output;
}
