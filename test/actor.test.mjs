import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { main } from '../src/actor.mjs';
import { runBulkZip } from '../src/run.mjs';
import { createNameAllocator } from '../src/names.mjs';

async function localServer(t) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.setHeader('Content-Type', req.url === '/png' ? 'image/png' : 'text/plain');
    res.end('local fixture: ' + req.url);
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

function fakeActor(input, { paid = false, allowance = Infinity, stopAtStart = false } = {}) {
  const charges = [];
  const batches = [];
  const saved = new Map();
  let opens = 0;
  let calculations = 0;
  const store = {
    async setValue(key, value, options) { saved.set(key, { value, options }); },
    getPublicUrl(key) { return 'https://storage.example/' + encodeURIComponent(key); },
  };
  const actor = {
    async getInput() { return input; },
    getChargingManager() {
      return {
        getPricingInfo() { return { isPayPerEvent: paid }; },
        calculateMaxEventChargeCountWithinLimit(event) {
          assert.equal(event, 'file-downloaded');
          calculations++;
          assert.equal(charges[0]?.eventName, 'run-started');
          return allowance;
        },
      };
    },
    async charge(event) {
      charges.push(event);
      return { chargedCount: event.count, eventChargeLimitReached: stopAtStart && event.eventName === 'run-started' };
    },
    async openKeyValueStore(...args) {
      assert.equal(args.length, 0);
      opens++;
      return store;
    },
    async pushData(rows) { batches.push(rows); },
    async setValue(key, value, options) { saved.set(key, { value, options }); },
  };
  return { actor, charges, batches, saved, get opens() { return opens; }, get calculations() { return calculations; } };
}

test('extensionless names gain a known content-type extension', () => {
  const allocate = createNameAllocator();
  assert.equal(allocate({ url: 'https://example.com/image/png', contentType: 'image/png; charset=binary', index: 0 }), 'png.png');
  assert.equal(allocate({ url: 'https://example.com/a', contentDisposition: 'attachment; filename=report', contentType: 'application/pdf', index: 1 }), 'report.pdf');
  assert.equal(allocate({ url: 'https://example.com/existing.txt', contentType: 'image/png', index: 2 }), 'existing.txt');
  assert.equal(allocate({ url: 'https://example.com/unknown', contentType: 'application/x-unknown', index: 3 }), 'unknown');
});

test('normal paid run stores the exact core ZIP and charges archive entries', async t => {
  const { base, hits } = await localServer(t);
  const fake = fakeActor({ urls: [base + '/a.txt', base + '/b.txt'], zipFileName: 'bundle.zip' }, { paid: true });
  let coreResult;
  const output = await main(fake.actor, {
    allowPrivate: true,
    async runZip(input, options) {
      coreResult = await runBulkZip(input, options);
      return coreResult;
    },
  });
  assert.equal(hits.length, 2);
  assert.equal(output.totals.downloaded, 2);
  assert.equal(output.totals.failed, 0);
  assert.equal(output.zipKey, 'bundle.zip');
  assert.equal(output.zipUrl, 'https://storage.example/bundle.zip');
  assert.strictEqual(fake.saved.get('bundle.zip').value, coreResult.zip);
  assert.deepEqual(fake.saved.get('bundle.zip').options, { contentType: 'application/zip' });
  assert.deepEqual(fake.saved.get('OUTPUT').value, output);
  assert.deepEqual(fake.charges, [{ eventName: 'run-started', count: 1 }, { eventName: 'file-downloaded', count: 2 }]);
  assert.deepEqual(fake.batches.flat().map(row => row.index), [0, 1]);
});

test('invalid input fails before charging, storage or downloads', async () => {
  const inputs = [
    null, {}, { urls: [] }, { urls: [''] }, { urls: [{ url: 5 }] },
    { urls: ['x'], zipFileName: '../files.zip' },
    { urls: ['x'], prefixIndex: 'false' },
    { urls: ['x'], maxFileMegabytes: 501 },
    { urls: ['x'], concurrency: 0 },
  ];
  for (const input of inputs) {
    const fake = fakeActor(input, { paid: true });
    await assert.rejects(main(fake.actor, { runZip() { assert.fail('download must not start'); } }), TypeError);
    assert.deepEqual(fake.charges, []);
    assert.equal(fake.opens, 0);
    assert.equal(fake.saved.size, 0);
    assert.equal(fake.batches.length, 0);
  }
});

test('budget excludes requests while admitted duplicates share one charge', async t => {
  const { base, hits } = await localServer(t);
  const a = base + '/a.txt';
  const b = base + '/b.txt';
  const fake = fakeActor({ urls: [a, b, a, b] }, { paid: true, allowance: 1 });
  const output = await main(fake.actor, { allowPrivate: true });
  assert.deepEqual(hits, ['/a.txt']);
  const rows = fake.batches.flat();
  assert.deepEqual(rows.map(row => row.index), [0, 1, 2, 3]);
  assert.deepEqual(rows.map(row => row.ok), [true, false, true, false]);
  for (const index of [1, 3]) assert.equal(rows[index].error, 'Skipped: spending limit reached');
  assert.equal(rows[0].fileName, rows[2].fileName);
  assert.equal(output.totals.requested, 4);
  assert.equal(output.totals.downloaded, 1);
  assert.equal(output.totals.failed, 2);
  assert.deepEqual(fake.charges, [{ eventName: 'run-started', count: 1 }, { eventName: 'file-downloaded', count: 1 }]);
});

test('local run accepts editor objects and ignores charging limits', async t => {
  const { base, hits } = await localServer(t);
  const fake = fakeActor({ urls: [{ url: base + '/a.txt' }, { url: base + '/b.txt' }] }, { allowance: 0 });
  const output = await main(fake.actor, { allowPrivate: true });
  assert.equal(output.totals.downloaded, 2);
  assert.equal(hits.length, 2);
  assert.equal(output.zipKey, 'files.zip');
  assert.equal(fake.calculations, 0);
  assert.deepEqual(fake.charges, []);
});

test('zero file budget saves an empty ZIP and reports every skipped URL', async t => {
  const { base, hits } = await localServer(t);
  const fake = fakeActor({ urls: [base + '/a.txt'] }, { paid: true, allowance: 0 });
  const output = await main(fake.actor, { allowPrivate: true });
  assert.deepEqual(hits, []);
  assert.equal(output.totals.downloaded, 0);
  assert.equal(output.totals.failed, 1);
  assert.equal(fake.saved.get('files.zip').value.length, 22);
  assert.equal(fake.batches[0][0].error, 'Skipped: spending limit reached');
  assert.deepEqual(fake.charges, [{ eventName: 'run-started', count: 1 }]);
});

test('dataset rows are saved in batches of at most 200', async t => {
  const { base, hits } = await localServer(t);
  const fake = fakeActor({ urls: Array(401).fill(base + '/a.txt') }, { paid: true });
  const output = await main(fake.actor, { allowPrivate: true });
  assert.deepEqual(fake.batches.map(batch => batch.length), [200, 200, 1]);
  assert.equal(hits.length, 1);
  assert.equal(output.totals.requested, 401);
  assert.equal(output.totals.downloaded, 1);
  assert.deepEqual(fake.charges, [{ eventName: 'run-started', count: 1 }, { eventName: 'file-downloaded', count: 1 }]);
});
