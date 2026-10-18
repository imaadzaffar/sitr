import { CATEGORIES, JEV_MODELS, GROK_MODELS, mergeSettings } from './lib/categories.js';

const $ = (id) => document.getElementById(id);
const TOGGLES = ['checkText', 'checkImages', 'checkVideos', 'checkAvatars', 'checkReplies'];
let settings;

async function save(patch) {
  settings = mergeSettings({ ...settings, ...patch });
  await chrome.storage.local.set({ settings });
}

function showProvider() {
  $('jev-box').hidden = settings.provider !== 'jev';
  $('grok-box').hidden = settings.provider !== 'grok';
}

async function refreshCache() {
  const { count } = await chrome.runtime.sendMessage({ type: 'cache-count' });
  $('cacheInfo').textContent = `${count} saved verdict${count === 1 ? '' : 's'}`;
}

async function init() {
  const { settings: saved } = await chrome.storage.local.get('settings');
  settings = mergeSettings(saved);

  for (const r of document.querySelectorAll('input[name=provider]')) {
    r.checked = r.value === settings.provider;
    r.addEventListener('change', async () => {
      await save({ provider: r.value });
      showProvider();
      $('saved').textContent = '';
    });
  }
  showProvider();

  const models = JEV_MODELS.includes(settings.jevModel) ? JEV_MODELS : [settings.jevModel, ...JEV_MODELS];
  $('jevModel').innerHTML = models.map((m) => `<option>${m}</option>`).join('');
  $('jevModel').value = settings.jevModel;
  $('jevModel').addEventListener('change', (e) => save({ jevModel: e.target.value }));

  $('grokModels').innerHTML = GROK_MODELS.map((m) => `<option value="${m}">`).join('');
  $('grokModel').value = settings.grokModel;
  $('grokModel').addEventListener('change', (e) => save({ grokModel: e.target.value.trim() || GROK_MODELS[0] }));

  $('typesafeKey').value = settings.typesafeKey;
  $('xaiKey').value = settings.xaiKey;

  $('save').addEventListener('click', async () => {
    await save({ typesafeKey: $('typesafeKey').value.trim(), xaiKey: $('xaiKey').value.trim(), grokModel: $('grokModel').value.trim() || GROK_MODELS[0] });
    $('saved').className = 'small status';
    $('saved').textContent = 'Saved. Testing…';
    const res = await chrome.runtime.sendMessage({ type: 'test-key' });
    $('saved').className = `small status ${res.ok ? 'ok' : 'bad'}`;
    $('saved').textContent = res.message;
  });

  $('threshold').value = settings.threshold;
  $('thresholdValue').textContent = settings.threshold.toFixed(2);
  $('threshold').addEventListener('input', (e) => ($('thresholdValue').textContent = Number(e.target.value).toFixed(2)));
  $('threshold').addEventListener('change', (e) => save({ threshold: Number(e.target.value) }));

  for (const id of TOGGLES) {
    $(id).checked = settings[id];
    $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
  }

  $('categories').innerHTML = CATEGORIES.map(
    (c) => `<label class="row">${c.label[0].toUpperCase() + c.label.slice(1)}<span class="switch"><input type="checkbox" data-cat="${c.id}" /><span></span></span></label>`,
  ).join('');
  for (const box of document.querySelectorAll('[data-cat]')) {
    box.checked = settings.categories[box.dataset.cat];
    box.addEventListener('change', () => save({ categories: { ...settings.categories, [box.dataset.cat]: box.checked } }));
  }

  $('clear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clear-cache' });
    refreshCache();
  });
  refreshCache();
}

init();
