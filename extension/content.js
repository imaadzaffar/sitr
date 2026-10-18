// X Blur content script. Finds posts on x.com / twitter.com as they scroll into
// view, asks the background worker about their text and media, and blurs what it
// flags. It never sends usernames, handles or account details: only post text and
// image URLs (the worker fetches the image itself).

(() => {
  'use strict';

  // ---------- selectors: update these when X changes its markup ----------
  const SELECTORS = {
    tweet: 'article[data-testid="tweet"]',
    // The focal post on a /status/ page. Every other article there is a reply or context.
    focalTweet: 'article[data-testid="tweet"][tabindex="-1"]',
    tweetText: 'div[data-testid="tweetText"]',
    photo: 'div[data-testid="tweetPhoto"]',
    photoImg: 'img[src*="pbs.twimg.com/media/"]',
    video: 'div[data-testid="videoPlayer"]',
    videoPosterImg: 'img[src*="video_thumb/"]',
    card: 'div[data-testid="card.wrapper"]',
    avatar: 'div[data-testid="Tweet-User-Avatar"]',
    avatarImg: 'img[src*="pbs.twimg.com/profile_images/"]',
    permalink: 'a[href*="/status/"] time',
  };
  // What gets blurred when a whole post is hidden.
  const BLUR_TARGETS = [SELECTORS.tweetText, SELECTORS.photo, SELECTORS.video, SELECTORS.card].join(',');
  const ROOT_MARGIN = '800px 0px';

  const state = new WeakMap(); // article -> { parts: Map, revealed, postId }
  const tracked = new Set(); // articles we have looked at (pruned when detached)
  const avatarCache = new Map(); // url -> Promise<result>, one request per avatar per page load
  let settings = { enabled: true, checkReplies: true };
  let stats = freshStats();
  let lastUrl = location.href;

  function freshStats() {
    return { checked: new Set(), blurred: new Set(), media: new Set(), avatars: new Set(), errors: 0 };
  }

  // ---------- messaging ----------

  function ask(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ status: 'error', error: chrome.runtime.lastError.message });
          else resolve(res || { status: 'error' });
        });
      } catch (err) {
        resolve({ status: 'error', error: String(err) }); // extension reloaded underneath us
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'page-stats') {
      sendResponse({
        url: location.href,
        enabled: settings.enabled,
        checked: stats.checked.size,
        blurred: stats.blurred.size,
        media: stats.media.size,
        avatars: stats.avatars.size,
        errors: stats.errors,
      });
    } else if (msg?.type === 'settings-changed') {
      loadSettings().then(recheckAll);
    }
    return false;
  });

  async function loadSettings() {
    const s = await ask({ type: 'public-settings' });
    if (s && typeof s.enabled === 'boolean') settings = s;
  }

  // ---------- reading a post ----------

  function snapshot(article) {
    const texts = [...article.querySelectorAll(SELECTORS.tweetText)].map((el) => el.innerText.trim()).filter(Boolean);
    const media = [];
    for (const box of article.querySelectorAll(SELECTORS.photo)) {
      const img = box.querySelector(SELECTORS.photoImg);
      if (img?.src) media.push({ kind: 'image', url: img.src, el: box });
    }
    for (const box of article.querySelectorAll(SELECTORS.video)) {
      const video = box.querySelector('video[poster]');
      const url = video?.getAttribute('poster') || box.querySelector(SELECTORS.videoPosterImg)?.src;
      if (url) media.push({ kind: 'video', url, el: box });
    }
    const avatarBox = article.querySelector(SELECTORS.avatar);
    const avatarUrl = avatarBox?.querySelector(SELECTORS.avatarImg)?.src;
    return { text: texts.join('\n\n'), media, avatar: avatarUrl ? { kind: 'avatar', url: avatarUrl, el: avatarBox } : null };
  }

  function postIdOf(article, text) {
    const link = article.querySelector(SELECTORS.permalink)?.closest('a');
    return link?.getAttribute('href') || `text:${text.slice(0, 120)}`;
  }

  function isReply(article) {
    return /\/status\/\d+/.test(location.pathname) && !article.matches(SELECTORS.focalTweet);
  }

  // ---------- processing ----------

  function processArticle(article) {
    if (!settings.enabled || !article.isConnected) return;
    tracked.add(article);
    let st = state.get(article);
    if (!st) {
      st = { parts: new Map(), revealed: false, postId: '' };
      state.set(article, st);
    }
    if (!settings.checkReplies && isReply(article)) {
      if (st.parts.size) resetArticle(article);
      article.dataset.xb = 'skipped';
      return;
    }

    const snap = snapshot(article);
    const wanted = new Map();
    if (snap.text) wanted.set(`text:${snap.text}`, { kind: 'text', text: snap.text, el: null });
    for (const m of snap.media) wanted.set(`${m.kind}:${m.url}`, m);
    if (snap.avatar) wanted.set(`avatar:${snap.avatar.url}`, snap.avatar);
    if (!wanted.size) return;

    // A recycled article now showing a different post: start over.
    const oldText = [...st.parts.keys()].find((k) => k.startsWith('text:'));
    const newText = [...wanted.keys()].find((k) => k.startsWith('text:'));
    if (oldText && oldText !== newText) resetArticle(article);

    let changed = false;
    for (const [key, part] of st.parts) {
      if (!wanted.has(key)) {
        clearPart(part);
        st.parts.delete(key);
        changed = true;
      }
    }
    st.postId = postIdOf(article, snap.text);
    for (const [key, info] of wanted) {
      const existing = st.parts.get(key);
      if (existing) {
        existing.el = info.el; // React may have swapped the element
        continue;
      }
      const part = { ...info, result: null };
      st.parts.set(key, part);
      changed = true;
      request(article, part);
    }
    if (st.parts.size) {
      stats.checked.add(st.postId);
      article.dataset.xb = article.dataset.xb || 'checking';
    }
    if (changed) render(article);
  }

  function request(article, part) {
    let promise;
    if (part.kind === 'text') promise = ask({ type: 'check-text', text: part.text });
    else if (part.kind === 'avatar') {
      if (!avatarCache.has(part.url)) avatarCache.set(part.url, ask({ type: 'check-media', kind: 'avatar', url: part.url }));
      promise = avatarCache.get(part.url);
    } else promise = ask({ type: 'check-media', kind: part.kind, url: part.url });

    promise.then((res) => {
      const st = state.get(article);
      if (!st || ![...st.parts.values()].includes(part)) return; // stale
      part.result = res;
      if (res?.status === 'error') {
        stats.errors++;
        if (part.kind === 'avatar') avatarCache.delete(part.url); // try again later
      }
      render(article);
    });
  }

  // ---------- rendering ----------

  function render(article) {
    const st = state.get(article);
    if (!st) return;
    const parts = [...st.parts.values()];
    const flaggedParts = parts.filter((p) => p.kind !== 'avatar' && p.result?.status === 'ok' && p.result.decision?.flagged);
    const pending = parts.some((p) => !p.result);

    // Media and avatars are blurred on their own, independent of the post overlay.
    for (const p of parts) {
      if (p.kind === 'text' || !p.el) continue;
      const flagged = p.result?.status === 'ok' && p.result.decision?.flagged;
      if (p.kind === 'avatar') setAvatarBlur(p, flagged);
      else setMediaBlur(p, flagged);
    }

    if (flaggedParts.length) {
      stats.blurred.add(st.postId);
      article.dataset.xb = 'flagged';
      setPostHidden(article, st, flaggedParts.map((p) => p.result.label));
    } else {
      stats.blurred.delete(st.postId);
      removePostOverlay(article);
      article.dataset.xb = pending ? 'checking' : parts.some((p) => p.result?.status === 'error') ? 'error' : 'clean';
    }
  }

  function setPostHidden(article, st, labels) {
    article.classList.add('xb-post');
    article.classList.toggle('xb-hidden', !st.revealed);
    article.classList.toggle('xb-revealed', st.revealed);

    let overlay = article.querySelector(':scope > .xb-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'xb-overlay';
      overlay.innerHTML =
        '<div class="xb-card" role="group" aria-label="Hidden by X Blur">' +
        '<span class="xb-eye" aria-hidden="true"></span>' +
        '<span class="xb-text"><span class="xb-title">Hidden by X Blur</span><span class="xb-labels"></span></span>' +
        '<button type="button" class="xb-show">Show anyway</button></div>';
      overlay.querySelector('.xb-show').addEventListener('click', (e) => {
        stop(e);
        st.revealed = true;
        render(article);
      });
      swallowClicks(overlay);
      article.appendChild(overlay);
    }
    overlay.querySelector('.xb-labels').textContent = labels.join(' · ');

    let rehide = article.querySelector(':scope > .xb-rehide');
    if (!rehide) {
      rehide = document.createElement('button');
      rehide.type = 'button';
      rehide.className = 'xb-rehide';
      rehide.textContent = 'Hide again';
      rehide.addEventListener('click', (e) => {
        stop(e);
        st.revealed = false;
        render(article);
      });
      swallowClicks(rehide);
      article.appendChild(rehide);
    }
    rehide.title = labels.join(' · ');
  }

  function removePostOverlay(article) {
    article.classList.remove('xb-post', 'xb-hidden', 'xb-revealed');
    article.querySelector(':scope > .xb-overlay')?.remove();
    article.querySelector(':scope > .xb-rehide')?.remove();
  }

  function setMediaBlur(part, flagged) {
    const el = part.el;
    if (!flagged) {
      if (el.classList.contains('xb-media-flagged')) clearPart(part);
      return;
    }
    stats.media.add(part.url);
    if (el.classList.contains('xb-media-flagged') || el.classList.contains('xb-media-shown')) return;
    el.classList.add('xb-media-flagged');
    el.dataset.xbLabel = part.result.label;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xb-media-btn';
    btn.textContent = `${part.result.label} · Show`;
    btn.addEventListener('click', (e) => {
      stop(e);
      el.classList.remove('xb-media-flagged');
      el.classList.add('xb-media-shown');
      btn.remove();
    });
    swallowClicks(btn);
    el.appendChild(btn);
  }

  function setAvatarBlur(part, flagged) {
    const el = part.el;
    if (flagged) {
      stats.avatars.add(part.url);
      el.classList.add('xb-avatar-flagged');
      el.title = part.result.label;
    } else if (el.classList.contains('xb-avatar-flagged')) clearPart(part);
  }

  function clearPart(part) {
    const el = part.el;
    if (!el) return;
    el.classList.remove('xb-media-flagged', 'xb-media-shown', 'xb-avatar-flagged');
    el.querySelector(':scope > .xb-media-btn')?.remove();
    delete el.dataset.xbLabel;
    if (part.kind === 'avatar') el.removeAttribute('title');
  }

  function resetArticle(article) {
    const st = state.get(article);
    if (st) {
      for (const p of st.parts.values()) clearPart(p);
      st.parts.clear();
      st.revealed = false;
    }
    removePostOverlay(article);
    delete article.dataset.xb;
  }

  function stop(e) {
    e.preventDefault();
    e.stopPropagation();
  }
  // X opens the post when you click anywhere in it; keep our controls from doing that.
  function swallowClicks(el) {
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'auxclick']) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  function recheckAll() {
    for (const article of [...tracked]) {
      if (!article.isConnected) {
        tracked.delete(article);
        continue;
      }
      resetArticle(article);
    }
    avatarCache.clear();
    stats = freshStats();
    if (!settings.enabled) return;
    for (const article of document.querySelectorAll(SELECTORS.tweet)) visibility.unobserve(article), visibility.observe(article);
  }

  // ---------- watching the page ----------

  const visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (entry.isIntersecting) processArticle(entry.target);
    },
    { rootMargin: ROOT_MARGIN },
  );
  const observed = new WeakSet();

  function observeAll(root) {
    if (root.matches?.(SELECTORS.tweet)) watch(root);
    root.querySelectorAll?.(SELECTORS.tweet).forEach(watch);
  }
  function watch(article) {
    if (observed.has(article)) return;
    observed.add(article);
    visibility.observe(article);
  }

  // Batched per animation frame so X's heavy DOM churn stays cheap.
  const dirty = new Set();
  let frame = 0;
  function markDirty(article) {
    dirty.add(article);
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      for (const a of dirty) if (state.has(a) && isNear(a)) processArticle(a);
      dirty.clear();
    });
  }
  function isNear(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > -800 && r.top < innerHeight + 800;
  }

  const mutations = new MutationObserver((records) => {
    checkNavigation();
    for (const rec of records) {
      if (rec.type === 'childList') {
        for (const node of rec.addedNodes) if (node.nodeType === 1) observeAll(node);
      }
      const target = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement;
      if (target && !target.closest('.xb-overlay, .xb-media-btn, .xb-rehide')) {
        const article = target.closest(SELECTORS.tweet);
        if (article) markDirty(article);
      }
    }
  });

  // X is a single-page app: count stats per page and notice route changes.
  function checkNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    stats = freshStats();
    for (const article of document.querySelectorAll(SELECTORS.tweet)) if (state.has(article) && isNear(article)) processArticle(article);
  }
  setInterval(checkNavigation, 1000);
  addEventListener('popstate', checkNavigation);

  loadSettings().then(() => {
    observeAll(document);
    mutations.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['src', 'poster'],
    });
  });
})();
