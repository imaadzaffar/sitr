import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORY_IDS, DEFAULT_SETTINGS, mergeSettings } from '../extension/lib/categories.js';
import { normalise, textCacheKey, mediaCacheKey, MAX_CHARS } from '../extension/lib/text.js';
import { decide, labelFor, combinePost } from '../extension/lib/decide.js';
import { createCache, roundScores } from '../extension/lib/cache.js';
import { buildJevTextRequest, buildJevImageRequest, toFormData, parseJevResponse, askJev, JEV_ENDPOINT, IMAGE_HEADER } from '../extension/lib/jev.js';
import { buildGrokTextRequest, buildGrokImageRequest, parseGrokResponse, resultToVerdict, askGrok, MAX_BATCH } from '../extension/lib/grok.js';
import { createBatcher } from '../extension/lib/providers.js';
import { normaliseMediaUrl, fitBox } from '../extension/lib/images.js';
import { fetchWithRetry, ApiError } from '../extension/lib/http.js';

const settings = (patch = {}) => mergeSettings(patch);
const zeros = () => Object.fromEntries(CATEGORY_IDS.map((id) => [id, 0]));
const noWait = () => Promise.resolve();

function memoryArea() {
  const data = {};
  return {
    data,
    async get(key) {
      if (key == null) return { ...data };
      return key in data ? { [key]: data[key] } : {};
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// ---------- text ----------

test('normalise collapses whitespace and caps length', () => {
  assert.equal(normalise('  hello\u00a0  world \n\n\n\n next  '), 'hello world\n\nnext');
  assert.equal(normalise('x'.repeat(5000)).length, MAX_CHARS);
  assert.equal(normalise(null), '');
});

test('cache keys hash the normalised text and include provider and model', async () => {
  const a = await textCacheKey('jev', 'jev-1.14.0', 'hello   world');
  const b = await textCacheKey('jev', 'jev-1.14.0', ' hello world ');
  const c = await textCacheKey('grok', 'grok-4.20-non-reasoning', 'hello world');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^t:jev:jev-1\.14\.0:[0-9a-f]{32}$/);
  assert.doesNotMatch(a, /hello/);
  const m = await mediaCacheKey('jev', 'jev-1.14.0', 'avatar', 'https://pbs.twimg.com/profile_images/1/a_400x400.jpg');
  assert.match(m, /^m:jev:jev-1\.14\.0:avatar:[0-9a-f]{32}$/);
});

// ---------- settings + decisions ----------

test('mergeSettings fills defaults and clamps the threshold', () => {
  const s = mergeSettings({ threshold: 7, categories: { slurs: false }, provider: 'nope' });
  assert.equal(s.threshold, 0.99);
  assert.equal(s.categories.slurs, false);
  assert.equal(s.categories.sexual, true);
  assert.equal(s.provider, 'jev');
  assert.equal(mergeSettings(null).jevModel, DEFAULT_SETTINGS.jevModel);
});

test('decide flags categories at or above the threshold', () => {
  const scores = { ...zeros(), violence: 0.7, sexual: 0.69, spam_scam: 0.95 };
  const d = decide(scores, settings({ threshold: 0.7 }));
  assert.equal(d.flagged, true);
  assert.deepEqual(
    d.categories.map((c) => c.id),
    ['spam_scam', 'violence'],
  );
  assert.equal(decide(zeros(), settings()).flagged, false);
});

test('decide ignores disabled categories and junk scores', () => {
  const s = settings({ categories: { violence: false } });
  assert.equal(decide({ violence: 0.99 }, s).flagged, false);
  assert.equal(decide({ sexual: 'high', slurs: NaN }, s).flagged, false);
  assert.equal(decide(undefined, s).flagged, false);
});

test('lower threshold blurs more', () => {
  const scores = { ...zeros(), hate_harassment: 0.55 };
  assert.equal(decide(scores, settings({ threshold: 0.7 })).flagged, false);
  assert.equal(decide(scores, settings({ threshold: 0.5 })).flagged, true);
});

test('labels name the part and the categories', () => {
  const d = decide({ ...zeros(), violence: 0.9 }, settings());
  assert.equal(labelFor('image', d), 'Image: graphic violence');
  assert.equal(labelFor('text', decide({ ...zeros(), hate_harassment: 0.8, slurs: 0.9 }, settings())), 'Text: slurs, hate/harassment');
  assert.equal(labelFor('video', decide(zeros(), settings())), '');
});

test('combinePost hides on text or media but never on the avatar alone', () => {
  const hit = decide({ ...zeros(), sexual: 0.9 }, settings());
  const miss = decide(zeros(), settings());
  assert.deepEqual(combinePost([{ kind: 'text', decision: miss }, { kind: 'image', decision: hit }]), {
    flagged: true,
    labels: ['Image: sexual/explicit'],
  });
  assert.equal(combinePost([{ kind: 'text', decision: miss }, { kind: 'avatar', decision: hit }]).flagged, false);
});

// ---------- cache ----------

test('cache stores rounded scores, not text, and prunes oldest', async () => {
  const area = memoryArea();
  const cache = createCache(area, { max: 2, pruneEvery: 1 });
  await cache.set('t:a', { scores: { violence: 0.123456 }, reason: 'r' });
  await new Promise((r) => setTimeout(r, 2));
  await cache.set('t:b', { scores: { violence: 0.5 } });
  await new Promise((r) => setTimeout(r, 2));
  await cache.set('m:c', { scores: { violence: 2 } });
  assert.equal(await cache.get('t:a'), null);
  assert.equal((await cache.get('t:b')).scores.violence, 0.5);
  assert.equal((await cache.get('m:c')).scores.violence, 1);
  area.data.settings = { keep: true };
  assert.equal(await cache.count(), 2);
  assert.equal(await cache.clear(), 2);
  assert.deepEqual(Object.keys(area.data), ['settings']);
});

test('roundScores drops non-numbers', () => {
  assert.deepEqual(roundScores({ a: 0.12345, b: 'x', c: -1 }), { a: 0.123, c: 0 });
});

// ---------- Jev ----------

test('Jev text request: post is the state, one Noul per category', () => {
  const body = buildJevTextRequest('some post', 'jev-1.14.0');
  assert.equal(body.model, 'jev-1.14.0');
  assert.deepEqual(body.state, { post: 'some post' });
  assert.deepEqual(Object.keys(body.questions), CATEGORY_IDS);
  for (const q of Object.values(body.questions)) {
    assert.equal(q.type, 'noul');
    assert.match(q.instructions, /`post`/);
    assert.ok(q.criteria.true && q.criteria.false);
  }
  assert.equal(JSON.stringify(body).includes('@'), false, 'no account info');
});

test('Jev image request: asset listed once, referenced from state, per-category image questions', () => {
  const { body, part, ref } = buildJevImageRequest({ model: 'jev-1.14.0', kind: 'avatar', ref: 'img-abc', part: 'image-1' });
  assert.equal(part, 'image-1');
  assert.deepEqual(body.assets, { 'img-abc': { type: 'image', part: 'image-1' } });
  assert.equal(body.state.image, ref);
  assert.match(body.state.context, /profile picture/);
  assert.equal(JSON.stringify(body).split('img-abc').length - 1, 2, 'reference appears once in assets and once in state');
  for (const q of Object.values(body.questions)) assert.match(q.instructions, /`image`/);
});

test('Jev image request: base64 fallback', () => {
  const { body } = buildJevImageRequest({ model: 'jev-latest', ref: 'r1', base64: 'AAAA', format: 'png' });
  assert.deepEqual(body.assets.r1, { type: 'image', format: 'png', data_base64: 'AAAA' });
});

test('Jev multipart: request JSON is the first part, then the image part', async () => {
  const { body, part } = buildJevImageRequest({ model: 'jev-1.14.0', ref: 'r', part: 'image-1' });
  const form = toFormData(body, [{ part, blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }) }]);
  const entries = [...form.entries()];
  assert.deepEqual(
    entries.map(([k]) => k),
    ['request', 'image-1'],
  );
  assert.equal(entries[0][1].type, 'application/json');
  assert.deepEqual(JSON.parse(await entries[0][1].text()), body);
  assert.equal(entries[1][1].type, 'image/jpeg');
});

test('askJev sends the image header and multipart body for images, JSON for text', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, { answers: {} });
  };
  await askJev('k', buildJevTextRequest('hi', 'jev-1.14.0'), { fetchImpl });
  const { body, part } = buildJevImageRequest({ model: 'jev-1.14.0' });
  await askJev('k', body, { fetchImpl, files: [{ part, blob: new Blob(['x'], { type: 'image/jpeg' }) }] });
  assert.equal(calls[0].url, JEV_ENDPOINT);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers[IMAGE_HEADER], undefined);
  assert.ok(calls[1].init.body instanceof FormData);
  assert.equal(calls[1].init.headers[IMAGE_HEADER], 'true');
  assert.equal(calls[1].init.headers['Content-Type'], undefined, 'fetch sets the multipart boundary itself');
});

test('parseJevResponse reads Noul probabilities and defaults missing ones to 0', () => {
  const v = parseJevResponse({
    model: 'jev-1.14.0',
    answers: { violence: { type: 'noul', noul: 0.91 }, sexual: { type: 'noul', noul: 1.4 }, slurs: { type: 'choice', choice: 'x' } },
    usage: { input_tokens: 300, output_tokens: 6 },
  });
  assert.equal(v.scores.violence, 0.91);
  assert.equal(v.scores.sexual, 1);
  assert.equal(v.scores.slurs, 0);
  assert.equal(v.scores.spam_scam, 0);
  assert.equal(v.usage.input_tokens, 300);
  assert.throws(() => parseJevResponse({ detail: 'nope' }), ApiError);
});

test('askJev with no key fails without calling the network', async () => {
  await assert.rejects(askJev('', {}, { fetchImpl: () => assert.fail('called') }), (e) => e.status === 401);
});

// ---------- Grok ----------

test('Grok text request: batched ids, strict schema, only post text', () => {
  const body = buildGrokTextRequest(
    [
      { id: 'p1', text: 'first' },
      { id: 'p2', text: 'second' },
    ],
    'grok-4.20-non-reasoning',
  );
  assert.equal(body.model, 'grok-4.20-non-reasoning');
  assert.equal(body.temperature, 0);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  const item = body.response_format.json_schema.schema.properties.results.items;
  assert.deepEqual(item.required, ['id', 'inappropriate', 'categories', 'confidence', 'reason']);
  assert.deepEqual(item.properties.categories.items.enum, CATEGORY_IDS);
  assert.equal(body.messages[0].role, 'system');
  const payload = JSON.parse(body.messages[1].content.slice(body.messages[1].content.indexOf('{')));
  assert.deepEqual(payload, { posts: [{ id: 'p1', text: 'first' }, { id: 'p2', text: 'second' }] });
  assert.throws(() => buildGrokTextRequest(Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ id: `${i}`, text: 'x' })), 'm'));
});

test('Grok image request sends a data URL image part', () => {
  const body = buildGrokImageRequest({ model: 'grok-4.20-non-reasoning', kind: 'video', dataUrl: 'data:image/jpeg;base64,AAAA' });
  const parts = body.messages[1].content;
  assert.equal(parts[0].type, 'image_url');
  assert.equal(parts[0].image_url.url, 'data:image/jpeg;base64,AAAA');
  assert.match(parts[1].text, /video/);
});

test('parseGrokResponse maps results to per-category scores', () => {
  const content = JSON.stringify({
    results: [
      { id: 'p1', inappropriate: true, categories: ['slurs', 'hate_harassment', 'bogus'], confidence: 0.88, reason: 'slur' },
      { id: 'p2', inappropriate: false, categories: ['violence'], confidence: 0.9, reason: 'fine' },
    ],
  });
  const map = parseGrokResponse({ choices: [{ message: { content } }] });
  assert.equal(map.get('p1').scores.slurs, 0.88);
  assert.equal(map.get('p1').scores.hate_harassment, 0.88);
  assert.equal(map.get('p1').scores.violence, 0);
  assert.equal('bogus' in map.get('p1').scores, false);
  assert.equal(map.get('p2').scores.violence, 0, 'not inappropriate means no scores');
  assert.equal(map.get('p1').reason, 'slur');
});

test('parseGrokResponse tolerates fenced JSON and rejects garbage', () => {
  const fenced = '```json\n{"results":[{"id":"img","inappropriate":true,"categories":["violence"],"confidence":0.8,"reason":"gore"}]}\n```';
  assert.equal(parseGrokResponse({ choices: [{ message: { content: fenced } }] }).get('img').scores.violence, 0.8);
  assert.throws(() => parseGrokResponse({ choices: [{ message: { content: 'nope' } }] }), ApiError);
  assert.throws(() => parseGrokResponse({}), ApiError);
});

test('resultToVerdict clamps confidence', () => {
  assert.equal(resultToVerdict({ inappropriate: true, categories: ['sexual'], confidence: 3 }).scores.sexual, 1);
  assert.equal(resultToVerdict(null).scores.sexual, 0);
});

test('askGrok posts to chat completions with the key', async () => {
  let seen;
  await askGrok('xai-1', { model: 'm' }, { fetchImpl: async (url, init) => ((seen = { url, init }), jsonResponse(200, {})) });
  assert.equal(seen.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer xai-1');
});

test('batcher groups posts into one request and fails open per post', async () => {
  const sent = [];
  const add = createBatcher(
    async (items) => {
      sent.push(items);
      return new Map(items.filter((i) => i.text !== 'skip').map((i) => [i.id, { scores: { violence: i.text === 'bad' ? 0.9 : 0 } }]));
    },
    { max: 3, windowMs: 5 },
  );
  const results = await Promise.allSettled([add('ok'), add('bad'), add('skip'), add('later')]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].length, 3);
  assert.equal(results[1].value.scores.violence, 0.9);
  assert.equal(results[2].status, 'rejected');
});

// ---------- http ----------

test('fetchWithRetry retries 429 using retry-after, then succeeds', async () => {
  let n = 0;
  const waits = [];
  const json = await fetchWithRetry('u', () => ({}), {
    wait: async (ms) => waits.push(ms),
    fetchImpl: async () => (++n < 3 ? jsonResponse(429, {}, { 'retry-after': '2' }) : jsonResponse(200, { ok: 1 })),
  });
  assert.deepEqual(json, { ok: 1 });
  assert.deepEqual(waits, [2000, 2000]);
});

test('fetchWithRetry gives up with a described error', async () => {
  await assert.rejects(
    fetchWithRetry('u', () => ({}), { retries: 1, wait: noWait, fetchImpl: async () => jsonResponse(503, { detail: 'down' }), describe: (s, d) => `${s}:${d}` }),
    (e) => e.status === 503 && e.message === '503:down',
  );
  await assert.rejects(
    fetchWithRetry('u', () => ({}), { retries: 0, fetchImpl: async () => jsonResponse(401, {}) }),
    (e) => e.status === 401,
  );
  await assert.rejects(
    fetchWithRetry('u', () => ({}), { retries: 1, wait: noWait, fetchImpl: async () => { throw new TypeError('net'); } }),
    (e) => e.status === 0,
  );
});

// ---------- images ----------

test('media URLs are rewritten to small JPEGs on pbs.twimg.com only', () => {
  assert.equal(
    normaliseMediaUrl('https://pbs.twimg.com/media/GabC123?format=webp&name=900x900', 'image'),
    'https://pbs.twimg.com/media/GabC123?format=jpg&name=small',
  );
  assert.equal(
    normaliseMediaUrl('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/abc.jpg', 'video'),
    'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/abc?format=jpg&name=small',
  );
  assert.equal(
    normaliseMediaUrl('https://pbs.twimg.com/amplify_video_thumb/9/img/xyz.png?name=orig', 'video'),
    'https://pbs.twimg.com/amplify_video_thumb/9/img/xyz?format=jpg&name=small',
  );
  assert.equal(
    normaliseMediaUrl('https://pbs.twimg.com/profile_images/123/me_normal.jpg', 'avatar'),
    'https://pbs.twimg.com/profile_images/123/me_400x400.jpg',
  );
  assert.equal(normaliseMediaUrl('https://evil.example/media/x.jpg', 'image'), null);
  assert.equal(normaliseMediaUrl('not a url', 'image'), null);
});

test('fitBox pads small images and shrinks huge ones to Jev limits', () => {
  assert.deepEqual(fitBox(680, 440), { drawW: 680, drawH: 440, canvasW: 680, canvasH: 440, changed: false });
  const wide = fitBox(680, 200);
  assert.equal(wide.canvasH, 280);
  assert.equal(wide.changed, true);
  const big = fitBox(4000, 3000);
  assert.equal(big.drawW, 1568);
  assert.equal(big.drawH, 1176);
  const avatar = fitBox(48, 48);
  assert.deepEqual([avatar.canvasW, avatar.canvasH], [280, 280]);
});
