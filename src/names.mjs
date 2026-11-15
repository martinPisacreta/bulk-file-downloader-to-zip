const EXTENSIONS = new Map(Object.entries({
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'text/csv': 'csv', 'application/json': 'json', 'text/plain': 'txt',
  'text/html': 'html', 'application/zip': 'zip', 'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
}));

function dispositionName(value) {
  if (typeof value !== 'string') return '';
  const parameters = new Map();
  const pattern = /;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/g;
  for (const match of value.matchAll(pattern)) {
    parameters.set(match[1].toLowerCase(), match[2] === undefined
      ? match[3].trim() : match[2].replace(/\\(.)/g, '$1'));
  }
  const extended = parameters.get('filename*');
  if (extended) {
    const match = /^utf-8'[^']*'(.*)$/i.exec(extended);
    if (match) {
      try { return decodeURIComponent(match[1]); } catch {}
    }
  }
  return parameters.get('filename') || '';
}

function sanitize(value) {
  return String(value || '').normalize('NFC').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[<>:"|?*]/g, '_').replace(/\.{2,}/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

function shorten(value, length) {
  return Array.from(value).slice(0, Math.max(0, length)).join('');
}

function parts(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && Array.from(name.slice(dot)).length <= 20
    ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/** Allocate names in input order; index is zero-based. */
export function createNameAllocator({ prefixIndex = false } = {}) {
  const used = new Set();
  return function allocate({ url, contentDisposition, contentType, index }) {
    if (!Number.isInteger(index) || index < 0) {
      throw new TypeError('index must be a nonnegative integer');
    }
    let name = sanitize(dispositionName(contentDisposition));
    if (!name) {
      try {
        const segment = new URL(url).pathname.split('/').pop();
        let decoded = segment;
        try { decoded = decodeURIComponent(segment); } catch {}
        name = sanitize(decoded);
      } catch {}
    }
    if (!name) {
      const extension = EXTENSIONS.get(String(contentType || '').split(';')[0].trim().toLowerCase());
      name = `file-${index + 1}${extension ? '.' + extension : ''}`;
    }
    if (!parts(name)[1]) {
      const inferred = EXTENSIONS.get(String(contentType || '').split(';')[0].trim().toLowerCase());
      if (inferred) name += '.' + inferred;
    }
    const [stem, extension] = parts(name);
    const prefix = prefixIndex ? `${String(index + 1).padStart(3, '0')}-` : '';
    for (let number = 1; ; number++) {
      const suffix = number === 1 ? '' : `-${number}`;
      const room = 120 - Array.from(prefix + suffix + extension).length;
      const candidate = prefix + shorten(stem, room) + suffix + extension;
      const key = candidate.toLowerCase();
      if (!used.has(key)) {
        used.add(key);
        return candidate;
      }
    }
  };
}
