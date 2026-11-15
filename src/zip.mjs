import { crc32, deflateRawSync } from 'node:zlib';

export const MAX_ZIP_FILES = 1000;
export const MAX_ZIP_BYTES = 500_000_000;

function limit(value, ceiling, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new RangeError(`${name} must be an integer between 1 and ${ceiling}`);
  }
  return value;
}

function dosDate(date) {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** files: [{ name: string, data: Buffer }]. Limits apply to uncompressed data. */
export function createZip(files, {
  maxFiles = MAX_ZIP_FILES,
  maxTotalBytes = MAX_ZIP_BYTES,
} = {}) {
  limit(maxFiles, MAX_ZIP_FILES, 'maxFiles');
  limit(maxTotalBytes, MAX_ZIP_BYTES, 'maxTotalBytes');
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  if (files.length > maxFiles) throw new RangeError(`ZIP exceeds ${maxFiles} files`);
  let total = 0;
  const names = new Set();
  const entries = files.map((file) => {
    if (!file || !Buffer.isBuffer(file.data)) throw new TypeError('Each file requires a Buffer data');
    if (typeof file.name !== 'string' || !file.name ||
        /[\\/\u0000-\u001f\u007f-\u009f]/.test(file.name) || file.name.includes('..')) {
      throw new TypeError('ZIP entry requires a safe, nonempty filename');
    }
    const name = Buffer.from(file.name, 'utf8');
    if (name.length > 65535) throw new RangeError('ZIP filename exceeds 65535 UTF-8 bytes');
    if (names.has(file.name)) throw new Error(`Duplicate ZIP filename: ${file.name}`);
    names.add(file.name);
    total += file.data.length;
    if (total > maxTotalBytes) throw new RangeError(`ZIP exceeds ${maxTotalBytes} uncompressed bytes`);
    return { name, data: file.data };
  });

  const localChunks = [];
  const centralChunks = [];
  const stamp = dosDate(new Date());
  let offset = 0;
  let centralSize = 0;
  for (const { name, data } of entries) {
    const compressed = deflateRawSync(data);
    const method = compressed.length < data.length ? 8 : 0;
    const payload = method === 8 ? compressed : data;
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    localChunks.push(local, name, payload);
    centralChunks.push(central, name);
    offset += local.length + name.length + payload.length;
    centralSize += central.length + name.length;
  }
  if (offset + centralSize + 22 > 0xffffffff) {
    throw new RangeError('ZIP64 would be required; archive is too large');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, ...centralChunks, end]);
}
