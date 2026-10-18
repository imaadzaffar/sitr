// Service worker. The only part of Sitr that sees API keys or talks to an API.
// Content scripts send post text or image URLs; they get back a blur decision.
// Every failure "fails open": the answer is an error status and nothing is blurred.

import { mergeSettings } from './lib/categories.js';
import { normalise, textCacheKey, mediaCacheKey } from './lib/text.js';
import { decide, labelFor } from './lib/decide.js';
import { createCache } from './lib/cache.js';
import { createProvider, providerInfo } from './lib/providers.js';
import { normaliseMediaUrl, fetchPreparedImage } from './lib/images.js';

const MAX_ACTIVE = 6;
const cache = createCache(chrome.storage.local);

// ---------- settings ----------

let settingsPromise = null;
function getSettings() {
  settingsPromise ??= chrome.storage.local.get('settings').then(({ settings }) => mergeSettings(settings));
  return settingsPromise;
}
let provider = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settingsPromise = null;
    provider = null;
    pausedUntil = 0;
    keyOk = false;
    broadcast({ type: 'settings-changed' });
  }
});

// Keys live in storage.local; keep that area away from content scripts entirely.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

async function broadcast(msg) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const tab of tabs) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
}

// What content scripts may know: no keys.
async function publicSettings() {
  const s = await getSettings();
  return { enabled: s.enabled, checkReplies: s.checkReplies, provider: s.provider, hasKey: Boolean(providerInfo(s).key) };
}

async function getProvider() {
  const settings = await getSettings();
  provider ??= createProvider(settings);
  return provider;
}

async function setKeyState(state) {
  await chrome.storage.local.set({ keyState: { ...state, at: Date.now() } });
  chrome.action.setBadgeText({ text: state.ok ? '' : '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' }).catch(() => {});
}

// ---------- queue ----------

let active = 0;
const waiting = [];
const inFlight = new Map();
let pausedUntil = 0; // set after repeated rate limiting so we back off as a whole

function schedule(task) {
  return new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < MAX_ACTIVE && waiting.length) {
    const { task, resolve, reject } = waiting.shift();
    active++;
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}
function once(key, work) {
  if (!inFlight.has(key)) inFlight.set(key, work().finally(() => inFlight.delete(key)));
  return inFlight.get(key);
}

async function handleError(err) {
  const status = err?.status ?? 0;
  if (status === 401 || status === 403) await setKeyState({ ok: false, status, message: err.message });
  if (status === 429 || status === 529) pausedUntil = Date.now() + 30000;
  console.warn('[Sitr]', err?.message || err);
  return { status: 'error', error: err?.message || String(err), code: status };
}

async function verdictFor(cacheKey, work) {
  const hit = await cache.get(cacheKey);
  if (hit) return { verdict: hit, cached: true };
  if (Date.now() < pausedUntil) throw Object.assign(new Error('Paused after rate limiting.'), { status: 429 });
  const verdict = await once(cacheKey, () => schedule(work).then((v) => cache.set(cacheKey, v)));
  return { verdict, cached: false };
}

// ---------- classification ----------

async function checkText(text) {
  const settings = await getSettings();
  if (!settings.enabled) return { status: 'off' };
  if (!settings.checkText) return { status: 'skipped' };
  const clean = normalise(text);
  if (clean.length < 2) return { status: 'skipped' };
  const info = providerInfo(settings);
  if (!info.key) return { status: 'error', error: 'no-key' };
  try {
    const p = await getProvider();
    const { verdict, cached } = await verdictFor(await textCacheKey(info.id, info.model, clean), () => p.classifyText(clean));
    await setKeyStateOk();
    return result('text', verdict, settings, cached);
  } catch (err) {
    return handleError(err);
  }
}

const KIND_SETTING = { image: 'checkImages', video: 'checkVideos', avatar: 'checkAvatars' };

async function checkMedia(url, kind) {
  const settings = await getSettings();
  if (!settings.enabled) return { status: 'off' };
  if (!settings[KIND_SETTING[kind]]) return { status: 'skipped' };
  const src = normaliseMediaUrl(url, kind);
  if (!src) return { status: 'skipped' };
  const info = providerInfo(settings);
  if (!info.key) return { status: 'error', error: 'no-key' };
  try {
    const p = await getProvider();
    const { verdict, cached } = await verdictFor(await mediaCacheKey(info.id, info.model, kind, src), async () =>
      p.classifyImage(kind, await fetchPreparedImage(src)),
    );
    await setKeyStateOk();
    return result(kind, verdict, settings, cached);
  } catch (err) {
    return handleError(err);
  }
}

let keyOk = false;
async function setKeyStateOk() {
  if (keyOk) return;
  keyOk = true;
  await setKeyState({ ok: true });
}

function result(kind, verdict, settings, cached) {
  const decision = decide(verdict.scores, settings);
  return { status: 'ok', kind, decision, label: labelFor(kind, decision), reason: verdict.reason || '', cached };
}

async function testKey() {
  const settings = await getSettings();
  const p = createProvider(settings);
  if (!p.key) return { ok: false, message: `No ${p.id === 'grok' ? 'xAI' : 'TypeSafe'} key saved.` };
  try {
    const { model } = await p.test();
    keyOk = true;
    await setKeyState({ ok: true });
    return { ok: true, message: `Key works (${model}).` };
  } catch (err) {
    keyOk = false;
    if (err.status === 401 || err.status === 403) await setKeyState({ ok: false, status: err.status, message: err.message });
    return { ok: false, message: err.message };
  }
}

// ---------- messages ----------

const handlers = {
  'check-text': (m) => checkText(m.text),
  'check-media': (m) => checkMedia(m.url, m.kind),
  'test-key': () => testKey(),
  'public-settings': () => publicSettings(),
  'clear-cache': async () => ({ removed: await cache.clear() }),
  'cache-count': async () => ({ count: await cache.count() }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ status: 'error', error: String(err?.message || err) }));
  return true;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: mergeSettings(null) });
  if (reason === 'install' && !settings) chrome.runtime.openOptionsPage();
});
