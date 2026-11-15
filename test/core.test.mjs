import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { downloadFile, isBlockedAddress } from '../src/download.mjs';
import { createNameAllocator } from '../src/names.mjs';
import { createZip } from '../src/zip.mjs';
import { runBulkZip } from '../src/run.mjs';

async function fixture(t) {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const path = req.url;
    hits.set(path, (hits.get(path) || 0) + 1);
    if (path === '/missing') { res.writeHead(404); res.end('missing'); return; }
    if (path === '/redirect' || path === '/redirect-private') {
      res.writeHead(302, { location: path === '/redirect' ? '/file.txt' : '/private' });
      res.end(); return;
    }
    if (path === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
    if (path === '/retry' && hits.get(path) === 1) {
      res.writeHead(429); res.end(); return;
    }
    if (path === '/unavailable') { res.writeHead(503); res.end(); return; }
    if (path === '/large') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('12345678'); res.end('12345678'); return;
    }
    if (path === '/declared-large') {
      res.writeHead(200, { 'content-length': '1000' }); res.end('small'); return;
    }
    if (path === '/slow') {
      const timer = setTimeout(() => res.end('late'), 500);
      res.on('close', () => clearTimeout(timer)); return;
    }
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      ...(path === '/named' ? { 'content-disposition': 'attachment; filename="informe.txt"' } : {}),
    });
    res.end('hello');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { base: `http://127.0.0.1:${server.address().port}`, hits };
}

// Independent CRC implementation checks the archive writer's checksums.
function crc(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function readZip(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  const centralSize = zip.readUInt32LE(end + 12);
  const centralOffset = zip.readUInt32LE(end + 16);
  assert.equal(centralOffset + centralSize, end);
  const files = [];
  let position = centralOffset;
  for (let index = 0; index < count; index++) {
    assert.equal(zip.readUInt32LE(position), 0x02014b50);
    assert.equal(zip.readUInt16LE(position + 8) & 0x0800, 0x0800);
    const method = zip.readUInt16LE(position + 10);
    const checksum = zip.readUInt32LE(position + 16);
    const packedSize = zip.readUInt32LE(position + 20);
    const size = zip.readUInt32LE(position + 24);
    const nameLength = zip.readUInt16LE(position + 28);
    const extraLength = zip.readUInt16LE(position + 30);
    const commentLength = zip.readUInt16LE(position + 32);
    const local = zip.readUInt32LE(position + 42);
    const name = zip.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(zip.readUInt16LE(local + 6), 0x0800);
    assert.equal(zip.readUInt16LE(local + 8), method);
    assert.equal(zip.readUInt32LE(local + 14), checksum);
    const localNameLength = zip.readUInt16LE(local + 26);
    const localExtraLength = zip.readUInt16LE(local + 28);
    assert.equal(zip.subarray(local + 30, local + 30 + localNameLength).toString('utf8'), name);
    const start = local + 30 + localNameLength + localExtraLength;
    const packed = zip.subarray(start, start + packedSize);
    assert.equal(packed.length, packedSize);
    assert.ok(method === 0 || method === 8);
    const data = method === 8 ? inflateRawSync(packed) : Buffer.from(packed);
    assert.equal(data.length, size);
    assert.equal(crc(data), checksum);
    files.push({ name, data, method });
    position += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(position, end);
  return files;
}

const localOptions = { allowPrivate: true, timeoutMs: 2000 };

test('normal download and relative redirect', async t => {
  const { base, hits } = await fixture(t);
  const normal = await downloadFile(`${base}/file.txt`, localOptions);
  assert.equal(normal.data.toString(), 'hello');
  assert.equal(normal.status, 200);
  assert.equal(normal.contentType, 'text/plain; charset=utf-8');
  const redirected = await downloadFile(`${base}/redirect`, localOptions);
  assert.equal(redirected.finalUrl, `${base}/file.txt`);
  assert.equal(redirected.data.toString(), 'hello');
  assert.equal(hits.get('/redirect'), 1);
});

test('404 is reported without retry', async t => {
  const { base, hits } = await fixture(t);
  await assert.rejects(downloadFile(`${base}/missing`, localOptions), error => {
    assert.equal(error.status, 404);
    assert.match(error.message, /HTTP 404/);
    return true;
  });
  assert.equal(hits.get('/missing'), 1);
});

test('429 and 5xx receive at most one retry', async t => {
  const { base, hits } = await fixture(t);
  assert.equal((await downloadFile(`${base}/retry`, localOptions)).data.toString(), 'hello');
  assert.equal(hits.get('/retry'), 2);
  await assert.rejects(downloadFile(`${base}/unavailable`, localOptions), /HTTP 503/);
  assert.equal(hits.get('/unavailable'), 2);
});

test('redirect limit is enforced', async t => {
  const { base, hits } = await fixture(t);
  await assert.rejects(downloadFile(`${base}/loop`, localOptions), /five redirects/);
  assert.equal(hits.get('/loop'), 6);
});

test('streamed and declared oversize files are rejected', async t => {
  const { base } = await fixture(t);
  for (const path of ['/large', '/declared-large']) {
    await assert.rejects(downloadFile(base + path, { ...localOptions, maxFileBytes: 10 }), /exceeds 10 bytes/);
  }
});

test('timeout interrupts a stalled response without retry', async t => {
  const { base, hits } = await fixture(t);
  await assert.rejects(downloadFile(`${base}/slow`, { ...localOptions, timeoutMs: 80 }), /timed out/);
  assert.equal(hits.get('/slow'), 1);
});

test('private destinations and unsupported protocols are rejected before connecting', async t => {
  const { base, hits } = await fixture(t);
  await assert.rejects(downloadFile(`${base}/private`), /private or non-public/);
  assert.equal(hits.size, 0);
  await assert.rejects(downloadFile('file:///etc/passwd'), /Only http: and https:/);
  await assert.rejects(downloadFile('http://2130706433/'), /private or non-public/);
  await assert.rejects(downloadFile('http://[::ffff:127.0.0.1]/'), /private or non-public/);
});

test('private redirect is rejected without connecting to its destination', async t => {
  const { base, hits } = await fixture(t);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  t.after(() => { globalThis.fetch = originalFetch; });
  // Supply the first public response from our local server. No public network
  // request is made; destination validation remains enabled for both hops.
  globalThis.fetch = async url => {
    calls++;
    assert.equal(String(url), 'http://8.8.8.8/start');
    return new Promise((resolve, reject) => {
      const request = http.get(`${base}/redirect-private`, response => {
        response.resume();
        resolve(new Response(null, {
          status: response.statusCode,
          headers: { location: new URL(response.headers.location, base).href },
        }));
      });
      request.on('error', reject);
    });
  };
  await assert.rejects(downloadFile('http://8.8.8.8/start'), /private or non-public/);
  assert.equal(calls, 1);
  assert.equal(hits.get('/redirect-private'), 1);
  assert.equal(hits.get('/private'), undefined);
});

test('address classification covers required IPv4 and IPv6 ranges', () => {
  for (const address of [
    '127.1.2.3', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '::1', '::', 'fc00::1',
    'fdff::1', 'fe80::1', 'febf::1', '::ffff:192.168.1.1',
  ]) assert.equal(isBlockedAddress(address), true, address);
  for (const address of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test('filenames prefer disposition, sanitize paths, and number collisions', () => {
  const allocate = createNameAllocator();
  const input = { url: 'https://example.test/url.txt', index: 0 };
  assert.equal(allocate({ ...input, contentDisposition: 'attachment; filename="../../informe.pdf"' }), 'informe.pdf');
  assert.equal(allocate({ ...input, index: 1, contentDisposition: 'attachment; filename="informe.pdf"' }), 'informe-2.pdf');
  assert.equal(allocate({ ...input, index: 2, contentDisposition: "attachment; filename=plain.txt; filename*=UTF-8''caf%C3%A9.txt" }), 'café.txt');
  assert.equal(allocate({ url: 'https://example.test/%2e%2e%2fevil.txt', index: 3 }), 'evil.txt');
  assert.equal(allocate({ url: 'https://example.test/', contentType: 'application/pdf', index: 4 }), 'file-5.pdf');
  const long = allocate({ url: `https://example.test/${'a'.repeat(200)}.txt`, index: 5 });
  assert.equal(Array.from(long).length, 120);
  assert.ok(long.endsWith('.txt'));
  const safe = allocate({ ...input, index: 6, contentDisposition: 'attachment; filename="..bad\u0001name.txt"' });
  assert.doesNotMatch(safe, /[\/\u0000-\u001f]|\.\./);
  const prefixed = createNameAllocator({ prefixIndex: true });
  assert.equal(prefixed(input), '001-url.txt');
  assert.equal(prefixed({ ...input, index: 1 }), '002-url.txt');
});

test('ZIP central directory, UTF-8, stored and deflated data round-trip', () => {
  const original = [
    { name: 'café.txt', data: Buffer.from('compressible text '.repeat(100)) },
    { name: 'tiny.bin', data: Buffer.from([0, 255, 1]) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const decoded = readZip(createZip(original));
  assert.deepEqual(decoded.map(({ name, data }) => ({ name, data })), original);
  assert.equal(decoded[0].method, 8);
  assert.equal(decoded[1].method, 0);
  assert.equal(decoded[2].method, 0);
  assert.deepEqual(readZip(createZip([])), []);
});

test('ZIP limits and unsafe filenames produce clear errors', () => {
  const item = { name: 'file.txt', data: Buffer.from('hello') };
  assert.throws(() => createZip([item], { maxTotalBytes: 4 }), /exceeds 4/);
  assert.throws(() => createZip(Array(1001).fill(item)), /exceeds 1000 files/);
  assert.throws(() => createZip([], { maxTotalBytes: 500_000_001 }), /maxTotalBytes/);
  assert.throws(() => createZip([{ ...item, name: '../file.txt' }]), /safe/);
});

test('run isolates failures, preserves order, and downloads repeated URLs once', async t => {
  const { base, hits } = await fixture(t);
  const urls = [`${base}/named`, `${base}/missing`, `${base}/named`, `${base}/file.txt`];
  const result = await runBulkZip({ urls, concurrency: 2, prefixIndex: true }, localOptions);
  assert.deepEqual(result.report.map(row => row.index), [0, 1, 2, 3]);
  assert.deepEqual(result.report.map(row => row.url), urls);
  assert.deepEqual(result.report.map(row => row.ok), [true, false, true, true]);
  assert.equal(result.report[0].fileName, '001-informe.txt');
  assert.equal(result.report[2].fileName, result.report[0].fileName);
  assert.equal(result.report[1].status, 404);
  assert.equal(hits.get('/named'), 1);
  assert.deepEqual(result.totals, { requested: 4, downloaded: 2, failed: 1, bytes: 10 });
  const files = readZip(result.zip);
  assert.deepEqual(files.map(file => file.name), ['001-informe.txt', '004-file.txt']);
  assert.ok(files.every(file => file.data.toString() === 'hello'));
  for (const row of result.report) {
    assert.deepEqual(Object.keys(row).sort(), [
      'index', 'url', 'ok', 'fileName', 'bytes', 'contentType', 'status', 'error', 'durationMs',
    ].sort());
    assert.ok(Number.isFinite(row.durationMs) && row.durationMs >= 0);
  }
});

test('run enforces total budget while keeping other rows reportable', async t => {
  const { base } = await fixture(t);
  const result = await runBulkZip({
    urls: [`${base}/file.txt`, `${base}/named`, 'file:///forbidden'],
    maxTotalBytes: 7, concurrency: 2,
  }, localOptions);
  assert.deepEqual(result.report.map(row => row.ok), [true, false, false]);
  assert.match(result.report[1].error, /Total exceeds 7/);
  assert.equal(result.totals.bytes, 5);
  assert.equal(readZip(result.zip).length, 1);
});

test('run rejects invalid limits and supports an empty input', async () => {
  await assert.rejects(runBulkZip({ urls: ['https://example.test/'], maxFiles: 0 }), /maxFiles/);
  await assert.rejects(runBulkZip({ urls: ['a', 'b'], maxFiles: 1 }), /exceeds 1 files/);
  await assert.rejects(runBulkZip({ urls: [], concurrency: 0 }), /concurrency/);
  const result = await runBulkZip({ urls: [] });
  assert.deepEqual(result.totals, { requested: 0, downloaded: 0, failed: 0, bytes: 0 });
  assert.deepEqual(result.report, []);
  assert.deepEqual(readZip(result.zip), []);
});
