// End-to-end test: loads the unpacked extension into Chromium, serves the mock
// feed at https://x.com/home, mocks pbs.twimg.com images and both classifier
// APIs (TypeSafe Jev and xAI Grok), scrolls through and checks what got blurred.
//
//   node test/e2e.mjs            both providers
//   node test/e2e.mjs --jev      only Jev      (--grok for only Grok)
//   add --headed to watch

import { chromium } from 'playwright-core';
import { mkdtemp, readFile, mkdir, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedHtml } from './feed.mjs';
import { LABELS } from '../extension/lib/categories.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(root, 'extension');
const OUT = path.join(root, 'test', 'results');
const HEADED = process.argv.includes('--headed');
const ONLY = process.argv.includes('--jev') ? ['jev'] : process.argv.includes('--grok') ? ['grok'] : ['jev', 'grok'];
await mkdir(OUT, { recursive: true });

const data = JSON.parse(await readFile(path.join(root, 'test', 'posts.json'), 'utf8'));
const allPosts = [...data.feed, ...data.page2, data.thread.focal, ...data.thread.replies];
const html = feedHtml(data);
const fixtures = {};
for (const name of ['sunset', 'cat', 'gore', 'explicit', 'poster-clean', 'poster-violent', 'panorama', 'avatar-a', 'avatar-b', 'avatar-c', 'avatar-d', 'avatar-e', 'avatar-bad']) {
  fixtures[name] = await readFile(path.join(root, 'test', 'fixtures', `${name}.jpg`));
}
const KIND_NAME = { text: 'Text', image: 'Image', video: 'Video' };

let failures = 0;
function check(ok, message) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${message}`);
  if (!ok) failures++;
}

// ---------- mocks ----------

function fixtureIn(buf) {
  for (const [name, bytes] of Object.entries(fixtures)) if (buf.indexOf(bytes) >= 0) return name;
  return null; // re-encoded (e.g. padded panorama): treat as clean
}
function postByText(text) {
  const t = String(text).trim();
  return allPosts.find((p) => p.text.trim() === t);
}
const imageCats = (fixture) => data.flaggedFixtures[fixture] || [];

function makeMocks(stats) {
  const jev = async (route) => {
    const req = route.request();
    const buf = req.postDataBuffer() || Buffer.alloc(0);
    const type = req.headers()['content-type'] || '';
    let body;
    let cats = [];
    if (type.startsWith('multipart/form-data')) {
      stats.jevImage++;
      const json = buf.toString('latin1').match(/name="request"[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*?)\r\n--/);
      body = JSON.parse(Buffer.from(json[1], 'latin1').toString('utf8'));
      const refs = Object.keys(body.assets || {});
      if (req.headers()['typesafe-danger-zone-images'] !== 'true') stats.problems.push('image request without TypeSafe-Danger-Zone-Images header');
      if (refs.length !== 1 || body.state.image !== refs[0] || !body.assets[refs[0]].part) stats.problems.push('asset not referenced from state');
      if (!buf.toString('latin1').startsWith(`--${type.split('boundary=')[1]}\r\nContent-Disposition: form-data; name="request"`)) stats.problems.push('request is not the first multipart part');
      cats = imageCats(fixtureIn(buf));
    } else {
      stats.jevText++;
      body = JSON.parse(buf.toString('utf8'));
      if (body.questions?.ok) return route.fulfill({ json: { model: body.model, answers: { ok: { type: 'noul', noul: 0.99 } } } });
      if (String(body.state.post).includes('MOCK_SERVER_ERROR')) return route.fulfill({ status: 500, json: { detail: 'mock failure' } });
      if (/@\w/.test(JSON.stringify(body))) stats.problems.push('a handle was sent to Jev');
      cats = postByText(body.state.post)?.expect.text || [];
    }
    await new Promise((r) => setTimeout(r, 250));
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: cats.includes(id) ? 0.94 : 0.03 }]));
    await route.fulfill({ json: { model: 'jev-1.14.0', answers, usage: { input_tokens: 300, output_tokens: 6 } } });
  };

  const grok = async (route) => {
    const body = JSON.parse(route.request().postData());
    const user = body.messages.at(-1).content;
    if (body.max_tokens === 1) return route.fulfill({ json: { model: body.model, choices: [{ message: { content: 'OK' } }] } });
    let results;
    if (Array.isArray(user)) {
      stats.grokImage++;
      const b64 = user.find((p) => p.type === 'image_url').image_url.url.split(',')[1];
      const cats = imageCats(fixtureIn(Buffer.from(b64, 'base64')));
      results = [{ id: 'img', inappropriate: cats.length > 0, categories: cats, confidence: cats.length ? 0.9 : 0.05, reason: cats.length ? 'mock flag' : 'fine' }];
    } else {
      stats.grokText++;
      const { posts } = JSON.parse(user.slice(user.indexOf('{')));
      stats.grokBatchSizes.push(posts.length);
      // The model "skips" the error post: it must fail open.
      results = posts
        .filter((p) => !p.text.includes('MOCK_SERVER_ERROR'))
        .map((p) => {
          const cats = postByText(p.text)?.expect.text || [];
          return { id: p.id, inappropriate: cats.length > 0, categories: cats, confidence: cats.length ? 0.92 : 0.04, reason: cats.length ? 'mock flag' : 'fine' };
        });
    }
    await new Promise((r) => setTimeout(r, 250));
    await route.fulfill({ json: { model: body.model, choices: [{ message: { role: 'assistant', content: JSON.stringify({ results }) } }] } });
  };
  return { jev, grok };
}

// ---------- helpers ----------

async function articleState(page, id) {
  return page.evaluate((id) => {
    const a = document.querySelector(`article[data-mock="${id}"]`);
    if (!a) return null;
    const text = a.querySelector('[data-testid="tweetText"]');
    const media = a.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]');
    const avatar = a.querySelector('[data-testid="Tweet-User-Avatar"]');
    return {
      xb: a.dataset.xb || '',
      hidden: a.classList.contains('xb-hidden'),
      revealed: a.classList.contains('xb-revealed'),
      textFilter: getComputedStyle(text).filter,
      labels: a.querySelector('.xb-labels')?.textContent || '',
      mediaFlagged: media?.classList.contains('xb-media-flagged') || false,
      avatarFlagged: avatar?.classList.contains('xb-avatar-flagged') || false,
    };
  }, id);
}

async function settle(page, ids, timeout = 15000) {
  await page
    .waitForFunction(
      (ids) =>
        ids.every((id) => {
          const a = document.querySelector(`article[data-mock="${id}"]`);
          return a && ['clean', 'flagged', 'error', 'skipped'].includes(a.dataset.xb);
        }),
      ids,
      { timeout },
    )
    .catch(() => {});
  // Media and avatar answers can land after the text answer.
  await page.waitForTimeout(700);
}

async function assertPost(page, post, provider) {
  const s = await articleState(page, post.id);
  if (!s) return check(false, `[${provider}] ${post.id}: article present`);
  const e = post.expect;
  const postFlagged = Boolean(e.text?.length || e.image?.length || e.video?.length);
  if (postFlagged) {
    check(s.xb === 'flagged' && s.hidden && s.textFilter.includes('blur'), `[${provider}] ${post.id}: post blurred`);
    for (const kind of ['text', 'image', 'video']) {
      for (const cat of e[kind] || []) check(s.labels.includes(KIND_NAME[kind]) && s.labels.includes(LABELS[cat]), `[${provider}] ${post.id}: label names ${KIND_NAME[kind]}: ${LABELS[cat]} ("${s.labels}")`);
    }
  } else {
    const ok = !s.hidden && s.textFilter === 'none' && !s.labels;
    check(ok && (s.xb === 'clean' || (post.id === 'error' && s.xb === 'error')), `[${provider}] ${post.id}: left untouched (${s.xb})`);
  }
  if (e.image?.length || e.video?.length) check(s.mediaFlagged, `[${provider}] ${post.id}: media blurred on its own`);
  else if (post.image || post.video) check(!s.mediaFlagged, `[${provider}] ${post.id}: clean media not blurred`);
  check(s.avatarFlagged === Boolean(e.avatar?.length), `[${provider}] ${post.id}: avatar ${e.avatar?.length ? 'blurred' : 'untouched'}`);
}

async function scrollThrough(page) {
  for (let i = 0; i < 40; i++) {
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('article[data-mock]')]
        .filter((a) => {
          const r = a.getBoundingClientRect();
          return r.bottom > 0 && r.top < innerHeight;
        })
        .map((a) => a.dataset.mock),
    );
    await settle(page, ids);
    const atBottom = await page.evaluate(() => innerHeight + scrollY >= document.body.scrollHeight - 2);
    if (atBottom && (await page.$('article[data-mock="p2-photo"]'))) {
      await settle(page, ['p2-clean', 'p2-selfharm', 'p2-photo']);
      return;
    }
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(250);
  }
}

// ---------- one run per provider ----------

async function run(provider) {
  console.log(`\n${provider === 'jev' ? 'TypeSafe Jev' : 'xAI Grok'} (mocked)`);
  const stats = { jevText: 0, jevImage: 0, grokText: 0, grokImage: 0, grokBatchSizes: [], problems: [] };
  const mocks = makeMocks(stats);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'xblur-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !HEADED,
    viewport: { width: 1180, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  try {
    await context.route('https://api.typesafe.ai/**', mocks.jev);
    await context.route('https://api.x.ai/**', mocks.grok);
    await context.route('https://pbs.twimg.com/**', (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop().replace(/_(normal|400x400)/, '').replace(/\.\w+$/, '');
      const bytes = fixtures[name];
      return bytes ? route.fulfill({ status: 200, contentType: 'image/jpeg', body: bytes }) : route.fulfill({ status: 404 });
    });
    await context.route(/^https:\/\/(x|twitter)\.com\//, (route) =>
      route.request().resourceType() === 'document'
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
        : route.fulfill({ status: 204, body: '' }),
    );

    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    const extId = new URL(worker.url()).host;
    await worker.evaluate(async (provider) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings || {}), provider, typesafeKey: 'ts-test-key', xaiKey: 'xai-test-key' } });
    }, provider);
    for (const p of context.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();

    const page = await context.newPage();
    page.on('pageerror', (err) => console.log('page error:', err.message));
    await page.goto('https://x.com/home');
    await page.waitForSelector('article[data-mock]');

    // Top of the feed, for the screenshot.
    await settle(page, ['launch', 'harass', 'crash', 'demo']);

    await scrollThrough(page);
    for (const post of [...data.feed.slice(3), ...data.page2]) await assertPost(page, post, provider);
    check((await page.$$('article[data-mock="launch"]')).length === 0, `[${provider}] infinite scroll recycled the top posts out of the DOM`);

    // Back to the top: X rebuilds the posts as new nodes. Verdicts come from the cache.
    const before = { ...stats };
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForSelector('article[data-mock="launch"]');
    await settle(page, ['launch', 'harass', 'crash']);
    for (const post of data.feed.slice(0, 3)) await assertPost(page, post, provider);
    const calls = (s) => s.jevText + s.jevImage + s.grokText + s.grokImage;
    check(calls(stats) === calls(before), `[${provider}] rebuilt posts answered from cache (no new API calls)`);

    const totalCalls = calls(stats);
    if (provider === 'jev') {
      // The first six posts: clean, harassment, gory image, clean video, scam, flagged avatar.
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(300);
      const clip = await page.evaluate(() => {
        const main = document.querySelector('main').getBoundingClientRect();
        const last = document.querySelector('article[data-mock="avatar"]').getBoundingClientRect();
        return { x: main.left - 24, y: 0, width: main.width + 48, height: last.bottom + scrollY + 8 };
      });
      await page.screenshot({ path: path.join(OUT, 'feed.png'), fullPage: true, clip });
      await copyFile(path.join(OUT, 'feed.png'), path.join(root, 'docs', 'screenshot.png'));
      await copyFile(path.join(OUT, 'feed.png'), '/workspace/x-blur-screenshot.png').catch(() => {});
    }
    if (provider === 'jev') {
      // Show anyway / hide again.
      await page.click('article[data-mock="harass"] .xb-show');
      let s = await articleState(page, 'harass');
      check(s.revealed && !s.hidden && s.textFilter === 'none', '[jev] "Show anyway" reveals the post');
      await page.click('article[data-mock="harass"] .xb-rehide');
      s = await articleState(page, 'harass');
      check(s.hidden && s.textFilter.includes('blur'), '[jev] "Hide again" re-hides it');
      check(page.url() === 'https://x.com/home', '[jev] clicking our buttons did not open the post');

      await page.click('article[data-mock="crash"] .xb-show');
      s = await articleState(page, 'crash');
      check(s.revealed && s.mediaFlagged, '[jev] revealing the post keeps the flagged image blurred');
      await page.click('article[data-mock="crash"] .xb-media-btn');
      s = await articleState(page, 'crash');
      check(!s.mediaFlagged, '[jev] the image can be shown on its own');

      // Popup counts come from the content script.
      const counts = await worker.evaluate(async () => {
        for (const tab of await chrome.tabs.query({})) {
          const res = await chrome.tabs.sendMessage(tab.id, { type: 'page-stats' }).catch(() => null);
          if (res) return res;
        }
        return {};
      });
      check(counts.checked >= 15 && counts.blurred >= 7 && counts.media >= 3 && counts.avatars >= 1, `[jev] page counts (${JSON.stringify(counts)})`);

      check(stats.problems.length === 0, `[jev] request shape checks ${stats.problems.length ? stats.problems.join('; ') : 'ok'}`);
      check(stats.jevImage > 0 && stats.jevText > 0, `[jev] sent ${stats.jevText} text and ${stats.jevImage} image requests`);
    } else {
      check(stats.grokImage > 0 && stats.grokText > 0, `[grok] sent ${stats.grokText} text batches and ${stats.grokImage} image requests`);
      check(Math.max(...stats.grokBatchSizes) > 1, `[grok] text was batched (sizes ${stats.grokBatchSizes.join(',')})`);
    }

    // SPA navigation to a thread: replies are checked...
    await page.evaluate(() => window.openThread());
    await settle(page, ['focal', 'reply-clean', 'reply-bad']);
    await assertPost(page, data.thread.focal, provider);
    await assertPost(page, data.thread.replies[0], provider);
    await assertPost(page, data.thread.replies[1], provider);
    // ...until the user turns replies off.
    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, checkReplies: false } });
    });
    await page.waitForFunction(() => document.querySelector('article[data-mock="reply-bad"]')?.dataset.xb === 'skipped', null, { timeout: 5000 }).catch(() => {});
    const r = await articleState(page, 'reply-bad');
    check(r.xb === 'skipped' && !r.hidden, `[${provider}] with replies off, replies are left alone`);

    // Turning the extension off unblurs everything.
    await page.evaluate(() => window.goHome());
    await settle(page, ['harass']);
    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, enabled: false } });
    });
    await page.waitForTimeout(800);
    check((await page.$$('article.xb-hidden, .xb-media-flagged, .xb-avatar-flagged')).length === 0, `[${provider}] turning it off removes every blur`);

    // Options page: Save and test against the mocked API.
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extId}/options.html`);
    await options.click('#save');
    await options.waitForFunction(() => /Key works|rejected|status/.test(document.getElementById('saved').textContent), null, { timeout: 8000 }).catch(() => {});
    const saved = await options.textContent('#saved');
    check(saved.includes('Key works'), `[${provider}] options "Save and test": ${saved}`);
    if (provider === 'jev') await options.screenshot({ path: path.join(OUT, 'options.png'), fullPage: true });
    console.log(`  (${totalCalls} API calls before the thread step)`);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

for (const p of ONLY) await run(p);
console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
