// Text helpers shared by the worker and the tests.

export const MAX_CHARS = 2000;

// Collapse whitespace and cap the length so the same post always hashes the same.
export function normalise(text) {
  return String(text ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CHARS);
}

export async function sha256(input) {
  const bytes = new TextEncoder().encode(typeof input === 'string' ? input : JSON.stringify(input));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function textCacheKey(provider, model, text) {
  return `t:${provider}:${model}:${(await sha256(normalise(text))).slice(0, 32)}`;
}

export async function mediaCacheKey(provider, model, kind, url) {
  return `m:${provider}:${model}:${kind}:${(await sha256(url)).slice(0, 32)}`;
}
