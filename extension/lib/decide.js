// Turns raw per-category scores (0..1) into a blur decision using the user's
// threshold and category toggles. Scores are what gets cached, so changing the
// settings re-decides instantly without asking the model again.

import { CATEGORY_IDS, LABELS } from './categories.js';

export function decide(scores, settings) {
  const hits = [];
  for (const id of CATEGORY_IDS) {
    if (!settings.categories?.[id]) continue;
    const p = Number(scores?.[id]);
    if (Number.isFinite(p) && p >= settings.threshold) hits.push({ id, label: LABELS[id], score: p });
  }
  hits.sort((a, b) => b.score - a.score);
  return { flagged: hits.length > 0, categories: hits };
}

const KIND_NAMES = { text: 'Text', image: 'Image', video: 'Video', avatar: 'Profile picture' };

// "Image: graphic violence" style label for one flagged part of a post.
export function labelFor(kind, decision) {
  if (!decision?.flagged) return '';
  return `${KIND_NAMES[kind] || 'Post'}: ${decision.categories.map((c) => c.label).join(', ')}`;
}

// A post is hidden when its text or any of its media is flagged. Avatars are
// handled on their own and never hide the whole post.
export function combinePost(parts) {
  const flaggedParts = parts.filter((p) => p.kind !== 'avatar' && p.decision?.flagged);
  return {
    flagged: flaggedParts.length > 0,
    labels: flaggedParts.map((p) => labelFor(p.kind, p.decision)),
  };
}
