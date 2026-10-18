// fetch with a timeout and retries on rate limits and server errors.
// Both providers use it. Plain fetch so there is no build step.

export class ApiError extends Error {
  constructor(status, message, { provider = '' } = {}) {
    super(message);
    this.status = status;
    this.provider = provider;
  }
}

export const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function backoff(attempt) {
  return 700 * 2 ** attempt + Math.random() * 300;
}

// makeInit is called per attempt so bodies such as FormData are fresh each time.
export async function fetchWithRetry(url, makeInit, { retries = 2, timeoutMs = 20000, fetchImpl = fetch, wait = sleep, describe } = {}) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { ...makeInit(), signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        await wait(backoff(attempt));
        continue;
      }
      throw new ApiError(0, err?.name === 'AbortError' ? 'The request timed out.' : 'Could not reach the API.');
    }
    clearTimeout(timer);
    if (response.ok) return response.json();

    if (RETRYABLE.has(response.status) && attempt < retries) {
      const after = Number(response.headers.get('retry-after'));
      await wait(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : backoff(attempt));
      continue;
    }
    let detail = '';
    try {
      const body = await response.json();
      detail = typeof body?.detail === 'string' ? body.detail : body?.error?.message || body?.message || body?.error || '';
    } catch {
      // not JSON
    }
    throw new ApiError(response.status, describe ? describe(response.status, String(detail || '')) : `HTTP ${response.status} ${detail}`);
  }
}
