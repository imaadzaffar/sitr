// Image URL handling for X's CDN (pbs.twimg.com) plus image preparation.
// URLs are rewritten so X serves a small JPEG: that keeps uploads small and is a
// format both Jev and Grok accept.

export const TWIMG_HOST = 'pbs.twimg.com';
export const MIN_SIDE = 280; // Jev rejects images with a side under 280 px
export const MAX_SIDE = 1568;

export function isTwimg(url) {
  try {
    return new URL(url).hostname === TWIMG_HOST;
  } catch {
    return false;
  }
}

// kind: 'image' (post photo), 'video' (poster frame) or 'avatar'.
export function normaliseMediaUrl(url, kind) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== TWIMG_HOST) return null;
  if (kind === 'avatar' || u.pathname.startsWith('/profile_images/')) {
    // .../abc_normal.jpg (48px) -> .../abc_400x400.jpg
    u.pathname = u.pathname.replace(/_(normal|bigger|mini|x96|200x200|reasonably_small)(\.\w+)$/, '_400x400$2');
    u.search = '';
    return u.toString();
  }
  // /media/<id>?format=webp&name=small, /ext_tw_video_thumb/..., /amplify_video_thumb/...
  const ext = u.pathname.match(/\.(jpe?g|png|webp)$/i);
  if (ext) u.pathname = u.pathname.slice(0, -ext[0].length);
  u.search = '';
  u.searchParams.set('format', 'jpg');
  u.searchParams.set('name', 'small');
  return u.toString();
}

// Fit width/height into Jev's limits: scale down past MAX_SIDE, pad under MIN_SIDE.
export function fitBox(width, height) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { drawW: w, drawH: h, canvasW: Math.max(MIN_SIDE, w), canvasH: Math.max(MIN_SIDE, h), changed: scale < 1 || w < MIN_SIDE || h < MIN_SIDE };
}

// Worker-only: fetch an image and return a JPEG/PNG Blob within the size limits.
// The original bytes are kept when they already fit.
export async function fetchPreparedImage(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const box = fitBox(bitmap.width, bitmap.height);
  const okType = /^image\/(jpeg|jpg|png)$/.test(blob.type);
  if (okType && !box.changed) {
    bitmap.close?.();
    return blob;
  }
  const canvas = new OffscreenCanvas(box.canvasW, box.canvasH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, box.canvasW, box.canvasH);
  ctx.drawImage(bitmap, Math.floor((box.canvasW - box.drawW) / 2), Math.floor((box.canvasH - box.drawH) / 2), box.drawW, box.drawH);
  bitmap.close?.();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
}

export async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}`;
}
