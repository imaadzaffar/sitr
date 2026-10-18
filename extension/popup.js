import { mergeSettings } from './lib/categories.js';

const $ = (id) => document.getElementById(id);

async function load() {
  const { settings: saved, keyState } = await chrome.storage.local.get(['settings', 'keyState']);
  const settings = mergeSettings(saved);
  $('enabled').checked = settings.enabled;
  const name = settings.provider === 'grok' ? `Grok · ${settings.grokModel}` : `Jev · ${settings.jevModel}`;
  $('provider').textContent = name;

  const key = settings.provider === 'grok' ? settings.xaiKey : settings.typesafeKey;
  if (!key) note('Add an API key in Settings to start blurring.', true);
  else if (keyState && !keyState.ok) note(keyState.message || 'The API key was rejected.', true);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let page = null;
  if (tab?.id != null) page = await chrome.tabs.sendMessage(tab.id, { type: 'page-stats' }).catch(() => null);
  if (!page) {
    for (const id of ['checked', 'blurred', 'media', 'avatars']) $(id).textContent = '–';
    if (key && !(keyState && !keyState.ok)) note('Open x.com in this tab to see counts.');
    return;
  }
  for (const id of ['checked', 'blurred', 'media', 'avatars']) $(id).textContent = page[id];
  if (page.errors && key) note(`${page.errors} check(s) failed and were left visible.`);
}

function note(text, bad = false) {
  $('note').textContent = text;
  $('note').className = `small ${bad ? 'status bad' : 'muted'}`;
}

$('enabled').addEventListener('change', async (e) => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...mergeSettings(settings), enabled: e.target.checked } });
});
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

load();
setInterval(load, 1500);
