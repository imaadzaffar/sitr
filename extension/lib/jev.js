// TypeSafe Jev (System One) provider: request builders, response parsing, client.
// Docs: https://docs.typesafe.ai/api and https://docs.typesafe.ai/images
//
// Text: one request per post. The post is the `state`, and every category is its
// own Noul (yes/no) question, so each comes back as a calibrated probability.
// Images (experimental on Jev): one request per image, sent as multipart with the
// picture listed once in `assets` and referenced from `state`. The image
// questions are deliberately simple per-category yes/no checks, because the docs
// say Jev is weaker on images than on text.

import { CATEGORIES } from './categories.js';
import { fetchWithRetry, ApiError } from './http.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const IMAGE_HEADER = 'TypeSafe-Danger-Zone-Images';

function noul({ question, yes, no }) {
  return { type: 'noul', instructions: question, criteria: { true: yes, false: no } };
}

export function buildJevTextRequest(text, model) {
  const questions = {};
  for (const c of CATEGORIES) questions[c.id] = noul(c.text);
  return { model, state: { post: text }, questions };
}

// Each image gets a fresh random reference so it cannot collide with any text.
export function newRef() {
  return `img-${crypto.randomUUID()}`;
}

const KIND_CONTEXT = {
  image: 'A picture attached to a post on X.',
  video: 'The preview frame of a video attached to a post on X.',
  avatar: 'A profile picture of an account on X.',
};

// Returns { body, part, ref }. With multipart the asset names a file part; the
// base64 fallback puts the bytes in the JSON instead.
export function buildJevImageRequest({ model, kind = 'image', ref = newRef(), part = 'image-1', base64 = null, format = 'jpg' }) {
  const asset = base64 ? { type: 'image', format, data_base64: base64 } : { type: 'image', part };
  const questions = {};
  for (const c of CATEGORIES) questions[c.id] = noul(c.image);
  return {
    body: { model, state: { context: KIND_CONTEXT[kind] || KIND_CONTEXT.image, image: ref }, assets: { [ref]: asset }, questions },
    part,
    ref,
  };
}

// multipart/form-data: the JSON first as `request`, then the image as its own part.
export function toFormData(body, files) {
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify(body)], { type: 'application/json' }));
  for (const { part, blob, filename } of files) form.append(part, blob, filename || `${part}.jpg`);
  return form;
}

// Pulls one probability per category out of Jev's answers. Missing or malformed
// answers count as 0 so a partial reply can never cause a blur by itself.
export function parseJevResponse(json) {
  const answers = json?.answers;
  if (!answers || typeof answers !== 'object') throw new ApiError(0, 'TypeSafe sent an answer without `answers`.');
  const scores = {};
  for (const c of CATEGORIES) {
    const a = answers[c.id];
    const p = a?.type === 'noul' ? Number(a.noul) : NaN;
    scores[c.id] = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
  }
  return { scores, reason: '', model: json.model || '', usage: json.usage || null };
}

function describe(status, detail) {
  switch (status) {
    case 401:
      return 'TypeSafe rejected this API key.';
    case 403:
      return 'This TypeSafe key is not allowed to use Jev.';
    case 400:
    case 422:
      return `TypeSafe could not read the request${detail ? `: ${detail}` : '.'}`;
    case 413:
      return 'The image was too large for TypeSafe.';
    case 429:
    case 529:
      return 'TypeSafe is busy (rate limited).';
    default:
      return `TypeSafe answered with status ${status}${detail ? `: ${detail}` : '.'}`;
  }
}

export async function askJev(apiKey, body, { files = [], fetchImpl, retries, timeoutMs } = {}) {
  if (!apiKey) throw new ApiError(401, 'No TypeSafe API key saved.');
  const makeInit = () => {
    const headers = { Authorization: `Bearer ${apiKey}` };
    if (files.length) {
      headers[IMAGE_HEADER] = 'true';
      return { method: 'POST', headers, body: toFormData(body, files) };
    }
    if (body.assets) headers[IMAGE_HEADER] = 'true';
    headers['Content-Type'] = 'application/json';
    return { method: 'POST', headers, body: JSON.stringify(body) };
  };
  return fetchWithRetry(JEV_ENDPOINT, makeInit, { fetchImpl, retries, timeoutMs, describe });
}

export async function jevClassifyText(apiKey, model, text, opts) {
  return parseJevResponse(await askJev(apiKey, buildJevTextRequest(text, model), opts));
}

export async function jevClassifyImage(apiKey, model, kind, blob, opts) {
  const { body, part } = buildJevImageRequest({ model, kind });
  return parseJevResponse(await askJev(apiKey, body, { ...opts, files: [{ part, blob, filename: 'image.jpg' }] }));
}

// Cheapest possible request, used by "Save and test".
export async function jevTest(apiKey, model, opts) {
  const json = await askJev(
    apiKey,
    { model, state: 'Hello from Sitr.', questions: { ok: { type: 'noul', instructions: 'Is `state` a greeting?' } } },
    { retries: 0, ...opts },
  );
  return { model: json.model || model };
}
