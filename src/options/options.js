const DEFAULTS = globalThis.IMPORTIFY_DEFAULTS;
const form = document.getElementById('form');

function fill(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const fields = form.elements[key];
    if (!fields) continue;
    if (fields instanceof RadioNodeList) {
      fields.forEach((f) => { f.checked = f.value === value; });
    } else if (fields.type === 'checkbox') {
      fields.checked = !!value;
    } else {
      fields.value = value ?? '';
    }
  }
  toggleAuth();
  toggleAi();
}

function read() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const field = form.elements[key];
    if (!field) continue;
    if (field instanceof RadioNodeList) out[key] = field.value;
    else if (field.type === 'checkbox') out[key] = field.checked;
    else if (field.type === 'number') out[key] = field.value === '' ? DEFAULTS[key] : parseFloat(field.value);
    else out[key] = field.value.trim();
  }
  if (!out.apiVersion) out.apiVersion = DEFAULTS.apiVersion;
  return out;
}

function toggleAi() {
  const provider = form.elements.aiProvider.value || 'openai';
  document.querySelectorAll('[data-ai]').forEach((el) => { el.hidden = el.dataset.ai !== provider; });
}

function toggleAuth() {
  const mode = form.elements.authMode.value || 'token';
  document.querySelectorAll('[data-auth]').forEach((el) => { el.hidden = el.dataset.auth !== mode; });
}

function flash(el, text, cls) {
  el.textContent = text;
  el.className = cls || '';
}

async function save() {
  await chrome.storage.local.set(read());
  await chrome.storage.session.remove('tokenCache');
}

form.addEventListener('change', (e) => {
  if (e.target.name === 'authMode') toggleAuth();
  if (e.target.name === 'aiProvider') toggleAi();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await save();
  const el = document.getElementById('saved');
  flash(el, 'Saved ✓', 'ok');
  setTimeout(() => flash(el, ''), 2000);
});

document.getElementById('test').addEventListener('click', async () => {
  const el = document.getElementById('testResult');
  flash(el, 'Testing…');
  await save();
  const res = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
  if (res?.ok && res.collectionError) flash(el, `Connected to ${res.name}, but: ${res.collectionError}`, 'err');
  else if (res?.ok) flash(el, `Connected to ${res.name} (${res.shop}, ${res.currency})${res.collections ? ` · ${res.collections} collection(s) found` : ''}`, 'ok');
  else flash(el, res?.error || 'Failed', 'err');
});

chrome.storage.local.get(null).then((stored) => fill({ ...DEFAULTS, ...stored }));
