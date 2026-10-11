// Only accept actual image URL references, never executable or document-local schemes.
export function normalizeUrl(raw: string, base: string): string | null {
  if (!raw.trim() || raw.length > 16 * 1024) return null;
  try {
    const url = new URL(raw.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function imageName(url: string, alt = '', index = 1): string {
  try {
    const name = new URL(url).pathname.split('/').pop();
    if (name) {
      try {
        return decodeURIComponent(name).slice(0, 200);
      } catch {
        return name.slice(0, 200);
      }
    }
  } catch {
    /* Invalid input is represented by the fallback label. */
  }
  return alt.slice(0, 200) || `图片 ${index}`;
}

export function formatHint(url: string): string {
  const extension = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return extension &&
    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'apng'].includes(extension)
    ? extension.toUpperCase()
    : '未知';
}

/** Tokenize CSS url() without splitting on commas, parentheses or escapes inside strings. */
export function cssUrls(css: string): string[] {
  const urls: string[] = [];
  let index = 0;
  while (index < css.length) {
    const char = css[index]!;
    const unsupported = css.slice(index).match(/^(?:-webkit-)?image-set\s*\(/i);
    if (unsupported && (index === 0 || !/[\w-]/.test(css[index - 1]!))) {
      index += unsupported[0].length;
      let depth = 1;
      let quote: string | undefined;
      while (index < css.length && depth) {
        const token = css[index++]!;
        if (token === '\\') {
          index++;
          continue;
        }
        if (quote) {
          if (token === quote) quote = undefined;
        } else if (token === '"' || token === "'") quote = token;
        else if (token === '(') depth++;
        else if (token === ')') depth--;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index++;
      while (index < css.length) {
        if (css[index] === '\\') {
          index += 2;
          continue;
        }
        if (css[index++] === quote) break;
      }
      continue;
    }
    const match = css.slice(index).match(/^url\s*\(/i);
    if (!match || (index > 0 && /[\w-]/.test(css[index - 1]!))) {
      index++;
      continue;
    }
    index += match[0].length;
    while (/\s/.test(css[index] ?? '') && index < css.length) index++;
    const quote = css[index] === '"' || css[index] === "'" ? css[index++] : undefined;
    let value = '';
    let closed = false;
    while (index < css.length) {
      const current = css[index++]!;
      if (current === '\\') {
        const rest = css.slice(index);
        const hex = rest.match(/^[\da-f]{1,6}/i)?.[0];
        if (hex) {
          const code = Number.parseInt(hex, 16);
          value +=
            code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
              ? '\uFFFD'
              : String.fromCodePoint(code);
          index += hex.length;
          if (/\s/.test(css[index] ?? '')) index++;
        } else if (css[index] === '\r' || css[index] === '\n') {
          if (css[index++] === '\r' && css[index] === '\n') index++;
        } else {
          value += css[index++] ?? '';
        }
      } else if (quote ? current === quote : current === ')') {
        if (quote) {
          while (/\s/.test(css[index] ?? '') && index < css.length) index++;
          closed = css[index] === ')';
          if (closed) index++;
        } else {
          closed = true;
        }
        break;
      } else {
        value += current;
      }
    }
    if (closed && value.trim()) urls.push(quote ? value : value.trim());
  }
  return urls;
}

export function isSupportedPage(url = ''): boolean {
  try {
    const parsed = new URL(url);
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      !['chromewebstore.google.com', 'microsoftedge.microsoft.com', 'chrome.google.com'].includes(
        parsed.hostname,
      ) &&
      !/\.pdf$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}
