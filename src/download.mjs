import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function ipv4Blocked(address) {
  const [a, b, c] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && c === 0))) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function ipv6Words(address) {
  let value = address.toLowerCase();
  if (value.includes('%')) return null;
  if (value.includes('.')) {
    const split = value.lastIndexOf(':');
    const bytes = value.slice(split + 1).split('.').map(Number);
    value = value.slice(0, split + 1) +
      ((bytes[0] << 8) | bytes[1]).toString(16) + ':' +
      ((bytes[2] << 8) | bytes[3]).toString(16);
  }
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':').map(v => parseInt(v, 16)) : [];
  const right = halves[1] ? halves[1].split(':').map(v => parseInt(v, 16)) : [];
  return halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
    : left;
}

export function isBlockedAddress(address) {
  const family = isIP(address);
  if (family === 4) return ipv4Blocked(address);
  if (family !== 6) return true;
  const words = ipv6Words(address);
  if (!words || words.length !== 8) return true;
  // Handle IPv4-mapped IPv6 before enforcing globally routable IPv6.
  if (words.slice(0, 5).every(v => v === 0) && words[5] === 0xffff) {
    return ipv4Blocked(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  if ((words[0] & 0xe000) !== 0x2000) return true;
  // Block transition ranges that can embed another destination address.
  if (words[0] === 0x2002 || (words[0] === 0x2001 && words[1] === 0)) return true;
  return false;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

async function validateDestination(value, allowPrivate, signal) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http: and https: URLs are allowed');
  }
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
  signal.throwIfAborted();
  if (!addresses.length) throw new Error('Hostname resolved to no addresses');
  if (!allowPrivate && addresses.some(item => isBlockedAddress(item.address))) {
    throw new Error('Destination resolves to a private or non-public address');
  }
  return { url, address: addresses[0] };
}

/**
 * A small fetch dispatcher backed by Node HTTP. DNS is never repeated during
 * connection: lookup returns the address validated for this exact request.
 * agent:false prevents connection reuse, and this bypasses global proxy agents.
 */
function pinnedDispatcher(target) {
  return {
    dispatch(options, handler) {
      let request;
      let response;
      let finished = false;
      function fail(error) {
        if (finished) return;
        finished = true;
        response?.destroy();
        request?.destroy();
        handler.onError(error);
      }
      try {
        const origin = new URL(String(options.origin));
        if (origin.origin !== target.url.origin ||
            options.path !== target.url.pathname + target.url.search) {
          throw new Error('Dispatcher destination differs from validated URL');
        }
        const transport = target.url.protocol === 'https:' ? https : http;
        request = transport.request(target.url, {
          method: options.method,
          headers: options.headers,
          agent: false,
          autoSelectFamily: false,
          lookup(_hostname, lookupOptions, callback) {
            if (lookupOptions?.all) callback(null, [target.address]);
            else callback(null, target.address.address, target.address.family);
          },
        });
        request.on('error', fail);
        handler.onConnect(reason => {
          fail(reason instanceof Error ? reason : new Error('Request aborted'));
        }, {});
        request.on('response', incoming => {
          response = incoming;
          if (finished) { incoming.destroy(); return; }
          incoming.pause();
          incoming.on('error', fail);
          incoming.on('aborted', () => fail(new Error('Response body was interrupted')));
          incoming.on('data', chunk => {
            try {
              if (handler.onData(chunk) === false) incoming.pause();
            } catch (error) { fail(error); }
          });
          incoming.on('end', () => {
            if (finished) return;
            try {
              handler.onComplete(incoming.rawTrailers.map(value => Buffer.from(value)));
              finished = true;
            } catch (error) { fail(error); }
          });
          try {
            const proceed = handler.onHeaders(
              incoming.statusCode,
              incoming.rawHeaders.map(value => Buffer.from(value)),
              () => incoming.resume(),
              incoming.statusMessage,
            );
            if (proceed !== false && !finished) incoming.resume();
          } catch (error) { fail(error); }
        });
        if (!finished) request.end();
      } catch (error) { fail(error); }
      return true;
    },
  };
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/** One deadline covers DNS, redirects, the optional retry, and body reading. */
export async function downloadFile(value, {
  timeoutMs = 30_000,
  maxFileBytes = 50_000_000,
  allowPrivate = false,
} = {}) {
  positiveInteger(timeoutMs, 'timeoutMs');
  positiveInteger(maxFileBytes, 'maxFileBytes');
  if (timeoutMs > 2_147_483_647) throw new RangeError('timeoutMs is too large');
  if (typeof allowPrivate !== 'boolean') throw new TypeError('allowPrivate must be a boolean');
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('URL must be a nonempty string');
  const controller = new AbortController();
  const timeoutError = new Error(`Download timed out after ${timeoutMs} ms`);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  let current = value;
  let redirects = 0;
  let retried = false;
  let status = null;
  let contentType = null;
  let activeResponse;
  try {
    for (;;) {
      const target = await validateDestination(current, allowPrivate, controller.signal);
      activeResponse = await fetch(target.url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: pinnedDispatcher(target),
      });
      status = activeResponse.status;
      contentType = activeResponse.headers.get('content-type');
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = activeResponse.headers.get('location');
        await activeResponse.body?.cancel();
        activeResponse = null;
        if (!location) throw new Error(`HTTP ${status}: redirect has no Location`);
        if (redirects >= 5) throw new Error('Download exceeds five redirects');
        redirects++;
        current = new URL(location, target.url).href;
        continue;
      }
      if (!retried && (status === 429 || (status >= 500 && status <= 599))) {
        retried = true;
        await activeResponse.body?.cancel();
        activeResponse = null;
        current = target.url.href;
        continue;
      }
      if (!activeResponse.ok) throw new Error(`HTTP ${status}`);
      const declared = activeResponse.headers.get('content-length');
      if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(maxFileBytes)) {
        throw new Error(`File exceeds ${maxFileBytes} bytes`);
      }
      const chunks = [];
      let bytes = 0;
      if (activeResponse.body) {
        const reader = activeResponse.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maxFileBytes) {
              const error = new Error(`File exceeds ${maxFileBytes} bytes`);
              controller.abort(error);
              throw error;
            }
            chunks.push(Buffer.from(chunk.value));
          }
        } finally { reader.releaseLock(); }
      }
      controller.signal.throwIfAborted();
      return {
        data: Buffer.concat(chunks, bytes),
        finalUrl: target.url.href,
        contentDisposition: activeResponse.headers.get('content-disposition'),
        contentType,
        status,
      };
    }
  } catch (caught) {
    const cause = controller.signal.aborted ? controller.signal.reason : caught;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    error.status = status;
    error.contentType = contentType;
    if (!controller.signal.aborted) controller.abort(error);
    if (activeResponse?.body && !activeResponse.body.locked) {
      await activeResponse.body.cancel().catch(() => {});
    }
    throw error;
  } finally { clearTimeout(timer); }
}
