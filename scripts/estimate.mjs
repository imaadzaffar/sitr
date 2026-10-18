// Rough cost estimate from request size. Builds the real requests for the sample
// posts in test/posts.json and assumes ~4 characters per token. It is an
// ESTIMATE: real token counts depend on each provider's tokenizer, and image
// token counts are an assumption (TypeSafe has not published them yet).

import { readFile } from 'node:fs/promises';
import { buildJevTextRequest, buildJevImageRequest } from '../extension/lib/jev.js';
import { buildGrokTextRequest, buildGrokImageRequest, MAX_BATCH } from '../extension/lib/grok.js';

const PRICES = {
  jev: { input: 0.042 / 1e6, output: 0 }, // jev-1.14.0, per token
  grok: { input: 1.25 / 1e6, output: 2.5 / 1e6 }, // grok-4.20-non-reasoning
};
const IMAGE_TOKENS_ASSUMED = 1000; // per small (≤680 px) JPEG, assumption
const GROK_OUTPUT_PER_ITEM = 45; // one JSON result object

const data = JSON.parse(await readFile(new URL('../test/posts.json', import.meta.url), 'utf8'));
const texts = [...data.feed, ...data.page2].map((p) => p.text);
const tokens = (obj) => Math.ceil(JSON.stringify(obj).length / 4);

const jevText = texts.reduce((s, t) => s + tokens(buildJevTextRequest(t, 'jev-1.14.0')), 0) / texts.length;
const jevImage = tokens(buildJevImageRequest({ model: 'jev-1.14.0' }).body) + IMAGE_TOKENS_ASSUMED;

let grokTextIn = 0;
for (let i = 0; i < texts.length; i += MAX_BATCH) {
  const batch = texts.slice(i, i + MAX_BATCH).map((text, j) => ({ id: `p${i + j}`, text }));
  grokTextIn += tokens(buildGrokTextRequest(batch, 'grok-4.20-non-reasoning'));
}
grokTextIn /= texts.length;
const grokImageIn = tokens(buildGrokImageRequest({ model: 'm', dataUrl: '' })) + IMAGE_TOKENS_ASSUMED;

const per1000 = (inTok, outTok, p) => 1000 * (inTok * p.input + outTok * p.output);
const fmt = (n) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

console.log('ESTIMATE ONLY (≈4 chars/token; image tokens assumed at', IMAGE_TOKENS_ASSUMED, 'each)\n');
console.log(`Jev text:    ~${Math.round(jevText)} input tokens/post   -> ${fmt(per1000(jevText, 0, PRICES.jev))} per 1,000 posts`);
console.log(`Jev image:   ~${Math.round(jevImage)} input tokens/image -> ${fmt(per1000(jevImage, 0, PRICES.jev))} per 1,000 images`);
console.log(`Grok text:   ~${Math.round(grokTextIn)} input + ${GROK_OUTPUT_PER_ITEM} output tokens/post (batches of ${MAX_BATCH}) -> ${fmt(per1000(grokTextIn, GROK_OUTPUT_PER_ITEM, PRICES.grok))} per 1,000 posts`);
console.log(`Grok image:  ~${Math.round(grokImageIn)} input + ${GROK_OUTPUT_PER_ITEM} output tokens/image -> ${fmt(per1000(grokImageIn, GROK_OUTPUT_PER_ITEM, PRICES.grok))} per 1,000 images`);
