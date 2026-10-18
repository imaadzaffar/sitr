// One interface over both classifiers so the worker doesn't care which is on.
//   classifyText(text)        -> { scores, reason }
//   classifyImage(kind, blob) -> { scores, reason }
// Grok text calls are batched: posts arriving within a short window share a request.

import { jevClassifyText, jevClassifyImage, jevTest } from './jev.js';
import { grokClassifyTexts, grokClassifyImage, grokTest, MAX_BATCH } from './grok.js';
import { blobToDataUrl } from './images.js';
import { ApiError } from './http.js';

export function providerInfo(settings) {
  return settings.provider === 'grok'
    ? { id: 'grok', model: settings.grokModel, key: settings.xaiKey }
    : { id: 'jev', model: settings.jevModel, key: settings.typesafeKey };
}

export function createBatcher(send, { max = MAX_BATCH, windowMs = 150 } = {}) {
  let pending = [];
  let timer = null;
  let nextId = 1;

  function flush() {
    clearTimeout(timer);
    timer = null;
    const batch = pending;
    pending = [];
    if (!batch.length) return;
    send(batch.map(({ id, text }) => ({ id, text })))
      .then((map) => {
        for (const item of batch) {
          const v = map.get(item.id);
          if (v) item.resolve(v);
          else item.reject(new ApiError(0, 'The model skipped this post.'));
        }
      })
      .catch((err) => batch.forEach((item) => item.reject(err)));
  }

  return function add(text) {
    return new Promise((resolve, reject) => {
      pending.push({ id: `p${nextId++}`, text, resolve, reject });
      if (pending.length >= max) flush();
      else if (!timer) timer = setTimeout(flush, windowMs);
    });
  };
}

export function createProvider(settings, { fetchImpl } = {}) {
  const info = providerInfo(settings);
  const opts = fetchImpl ? { fetchImpl } : {};
  if (info.id === 'grok') {
    const batch = createBatcher((items) => grokClassifyTexts(info.key, info.model, items, opts));
    return {
      ...info,
      classifyText: (text) => batch(text),
      classifyImage: async (kind, blob) => grokClassifyImage(info.key, info.model, kind, await blobToDataUrl(blob), opts),
      test: () => grokTest(info.key, info.model, opts),
    };
  }
  return {
    ...info,
    classifyText: (text) => jevClassifyText(info.key, info.model, text, opts),
    classifyImage: (kind, blob) => jevClassifyImage(info.key, info.model, kind, blob, opts),
    test: () => jevTest(info.key, info.model, opts),
  };
}
