export const MAX_FILES = 1000;

function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function parseInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Input must be an object');
  }
  if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > MAX_FILES) {
    throw new TypeError('urls must contain between 1 and 1000 entries');
  }
  // Preserve order and duplicates: the core shares downloads while reporting
  // every input row. Malformed destinations become individual download errors.
  const urls = Array.from(input.urls, (entry, index) => {
    const value = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry.url : entry;
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError(`urls[${index}] must be a nonempty string or an object with a nonempty url string`);
    }
    return value.trim();
  });

  const zipFileName = input.zipFileName === undefined ? 'files.zip' : input.zipFileName;
  if (typeof zipFileName !== 'string' || !/^[A-Za-z0-9._-]+\.zip$/.test(zipFileName)) {
    throw new TypeError('zipFileName must contain only letters, numbers, dots, hyphens or underscores and end in .zip');
  }
  const prefixIndex = input.prefixIndex === undefined ? false : input.prefixIndex;
  if (typeof prefixIndex !== 'boolean') {
    throw new TypeError('prefixIndex must be a boolean');
  }
  const maxFileMegabytes = input.maxFileMegabytes === undefined ? 50 : input.maxFileMegabytes;
  if (typeof maxFileMegabytes !== 'number' || !Number.isFinite(maxFileMegabytes) ||
      maxFileMegabytes < 1 || maxFileMegabytes > 500) {
    throw new TypeError('maxFileMegabytes must be a number between 1 and 500');
  }
  const concurrency = integer(input.concurrency === undefined ? 4 : input.concurrency, 1, 10, 'concurrency');

  return { urls, zipFileName, prefixIndex, maxFileMegabytes, concurrency };
}
