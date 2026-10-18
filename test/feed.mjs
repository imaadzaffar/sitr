// A static page that looks enough like X for the content script: same
// data-testid hooks, pbs.twimg.com image URLs, infinite scroll that recycles
// posts off the top, and a pushState route to a /status/ thread.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function articleHtml(p, { focal = false, n = 1 } = {}) {
  const media = p.image
    ? `<div class="media" data-testid="tweetPhoto"><img alt="Image" src="https://pbs.twimg.com/media/${p.image}?format=jpg&amp;name=small"></div>`
    : p.video
      ? `<div class="media" data-testid="videoPlayer"><video muted playsinline poster="https://pbs.twimg.com/ext_tw_video_thumb/1${n}/pu/img/${p.video}.jpg"></video><span class="play">▶</span></div>`
      : '';
  return `<article data-testid="tweet" role="article" tabindex="${focal ? -1 : 0}" data-mock="${p.id}">
  <div class="avatar-col"><div data-testid="Tweet-User-Avatar"><div class="av"><img alt="" src="https://pbs.twimg.com/profile_images/10${n}/${p.avatar}_normal.jpg"></div></div></div>
  <div class="body">
    <div class="head"><b>${esc(p.name)}</b> <span class="muted">@${esc(p.handle)} · <a href="/${esc(p.handle)}/status/${1000 + n}"><time>${n}h</time></a></span></div>
    <div data-testid="tweetText" lang="en" dir="auto"><span>${esc(p.text)}</span></div>
    ${media}
    <div class="actions muted"><span>💬 ${n * 3}</span><span>🔁 ${n * 7}</span><span>♡ ${n * 41}</span><span>📊 ${n * 1200}</span></div>
  </div>
</article>`;
}

export function feedHtml(data) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Home / X</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #000; color: #e7e9ea; font: 15px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .shell { display: flex; justify-content: center; }
  nav { width: 240px; padding: 16px; position: sticky; top: 0; height: 100vh; font-size: 20px; }
  nav div { padding: 10px 0; } nav .logo { font-size: 30px; font-weight: 800; }
  main { width: 600px; border-left: 1px solid #2f3336; border-right: 1px solid #2f3336; min-height: 100vh; }
  aside { width: 300px; padding: 16px; } aside .box { border: 1px solid #2f3336; border-radius: 16px; padding: 14px; color: #71767b; }
  header { position: sticky; top: 0; z-index: 5; background: rgba(0,0,0,.75); backdrop-filter: blur(12px); border-bottom: 1px solid #2f3336; padding: 16px; font-weight: 700; font-size: 20px; }
  article { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #2f3336; cursor: pointer; }
  article:hover { background: #080808; }
  .avatar-col { flex: none; width: 40px; }
  .av { width: 40px; height: 40px; border-radius: 50%; overflow: hidden; }
  .av img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .body { flex: 1; min-width: 0; }
  .muted { color: #71767b; } a { color: inherit; text-decoration: none; }
  [data-testid="tweetText"] { margin: 2px 0 10px; white-space: pre-wrap; }
  .media { position: relative; border: 1px solid #2f3336; border-radius: 16px; overflow: hidden; margin-bottom: 10px; }
  .media img, .media video { display: block; width: 100%; height: auto; }
  .media video { aspect-ratio: 16 / 9; background: #111 center / cover; }
  .play { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font-size: 28px; background: #1d9bf0; border-radius: 50%; width: 56px; height: 56px; display: grid; place-items: center; }
  .actions { display: flex; justify-content: space-between; max-width: 420px; font-size: 13px; }
  .spacer { border-bottom: 1px solid #2f3336; }
</style></head>
<body><div class="shell">
  <nav><div class="logo">𝕏</div><div>⌂ Home</div><div>⌕ Explore</div><div>🔔 Notifications</div><div>✉ Messages</div></nav>
  <main><header id="title">Home</header><div id="timeline"></div></main>
  <aside><div class="box">What's happening<br><br>Mock feed for X Blur's end-to-end test.</div></aside>
</div>
<script>
const DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
const articleHtml = ${articleHtml.toString()};
const esc = ${esc.toString()};
const timeline = document.getElementById('timeline');
let page2 = false, recycled = null;

function renderHome() {
  document.getElementById('title').textContent = 'Home';
  timeline.innerHTML = DATA.feed.map((p, i) => articleHtml(p, { n: i + 1 })).join('');
  page2 = false; recycled = null;
}

// Infinite scroll the way X does it: add posts at the bottom and drop the ones far
// above, keeping a spacer so the scroll position holds. Scrolling back rebuilds them.
addEventListener('scroll', () => {
  if (location.pathname !== '/home') return;
  const nearBottom = innerHeight + scrollY > document.body.scrollHeight - 400;
  if (nearBottom && !page2) {
    page2 = true;
    timeline.insertAdjacentHTML('beforeend', DATA.page2.map((p, i) => articleHtml(p, { n: 20 + i })).join(''));
    const first = [...timeline.querySelectorAll('article')].slice(0, 3);
    const h = first.reduce((s, a) => s + a.offsetHeight, 0);
    first.forEach((a) => a.remove());
    timeline.insertAdjacentHTML('afterbegin', '<div class="spacer" style="height:' + h + 'px"></div>');
    recycled = true;
  } else if (recycled && scrollY < 200) {
    recycled = null;
    timeline.querySelector('.spacer').outerHTML = DATA.feed.slice(0, 3).map((p, i) => articleHtml(p, { n: i + 1 })).join('');
  }
});

window.openThread = () => {
  history.pushState({}, '', '/' + DATA.thread.focal.handle + '/status/1001');
  document.getElementById('title').textContent = 'Post';
  timeline.innerHTML = articleHtml(DATA.thread.focal, { focal: true, n: 30 }) +
    DATA.thread.replies.map((p, i) => articleHtml(p, { n: 31 + i })).join('');
  scrollTo(0, 0);
};
window.goHome = () => { history.pushState({}, '', '/home'); renderHome(); scrollTo(0, 0); };
addEventListener('popstate', () => (location.pathname === '/home' ? renderHome() : window.openThread()));
renderHome();
</script></body></html>`;
}
