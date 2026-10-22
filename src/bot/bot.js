// Bulk-import bot.
//   1. Scan: walks every page of a supplier's product list and builds a product table.
//   2. Run:  opens each selected product in a dedicated worker window, scrapes it and
//            creates it in Shopify using the saved settings, one at a time.
// When Alibaba blocks a page (slider/captcha) or a page doesn't load properly, the bot pauses on
// that exact page/product and waits for the user to click Resume – nothing is skipped.
// State is saved after every step, so a run survives closing the tab or restarting Chrome.
const DEFAULTS = globalThis.IMPORTIFY_DEFAULTS;
const Pricing = globalThis.ImportifyPricing;

const MAX_ATTEMPTS = 3;
const LOG_LIMIT = 500;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rand = (min, max) => min + Math.random() * Math.max(0, max - min);

let state = null;                                   // persisted as botState
const control = { running: null, stop: false };     // running: null | 'scan' | 'import'
const worker = { windowId: null, tabId: null };

// Collections the bot adds every product to (titles). Lives in state once a scan has started.
let storeCollections = null;          // [{id, title}] from Shopify, for the picker
let collectionsError = null;
const pickedTitles = new Set();       // selection before a scan exists
// Runs started before the picker existed were set up with these.
const LEGACY_COLLECTIONS = ["Men's Fashion & Accessories > Watches", 'Poedagar Watch'];

// Thrown when Alibaba blocks the page or it doesn't load: pause and wait for the user.
class NeedsUser extends Error {}

// Timers in background tabs get throttled to once per minute, so waiting is done in the service worker.
function sleep(ms) {
  return chrome.runtime.sendMessage({ type: 'SLEEP', ms }).catch(() => new Promise((r) => setTimeout(r, ms)));
}

async function loadSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(null)) };
}

// ---------- state ----------

function newState(listUrl, options) {
  return {
    listUrl,
    options,
    scan: { page: 1, totalPages: null, done: false },
    items: [],
    collections: [...pickedTitles],
    task: null,        // what Resume continues: 'scan' | 'import'
    paused: null,      // { reason: 'blocked' | 'error' | 'user', message, itemId? }
    current: null,
    timings: [],
    log: []
  };
}

function persist() {
  return chrome.storage.local.set({ botState: state });
}

function log(msg, kind = '') {
  state.log.push({ t: Date.now(), msg, kind });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
  renderLog();
}

function readOptions() {
  return {
    minDelay: Math.max(0, parseFloat($('minDelay').value) || 0),
    maxDelay: Math.max(0, parseFloat($('maxDelay').value) || 0),
    maxPages: parseInt($('maxPages').value, 10) || null
  };
}

function pageUrl(listUrl, n) {
  const u = new URL(listUrl);
  if (/productgrouplist-\d+(-\d+)?(\/|\.html)/.test(u.pathname)) {
    u.pathname = u.pathname.replace(/productgrouplist-(\d+)(-\d+)?(\/|\.html)/, `productgrouplist-$1-${n}$3`);
  } else if (/productlist(-\d+)?\.html/.test(u.pathname)) {
    u.pathname = u.pathname.replace(/productlist(-\d+)?\.html/, `productlist-${n}.html`);
  } else {
    u.pathname = u.pathname.replace(/\/?$/, `/productlist-${n}.html`);
  }
  u.searchParams.delete('spm');
  return u.href;
}

const isBlockedUrl = (url) => /punish|captcha|_____tmd_____|login\.alibaba|passport\.alibaba/i.test(url || '');

// ---------- worker window ----------

async function openInWorker(url) {
  if (worker.tabId != null) {
    try {
      await chrome.tabs.update(worker.tabId, { url });
      return worker.tabId;
    } catch (_) {
      worker.tabId = null; // window was closed – make a new one
    }
  }
  const win = await chrome.windows.create({ url, focused: false, width: 1280, height: 900 });
  worker.windowId = win.id;
  worker.tabId = win.tabs[0].id;
  return worker.tabId;
}

// Navigates the worker tab and resolves once the page has finished loading (or after 60 s).
async function loadUrl(url) {
  let tabId = null;
  const completedEarly = new Set();
  let resolveLoaded;
  const loaded = new Promise((r) => { resolveLoaded = r; });
  const onUpdated = (id, info) => {
    if (info.status !== 'complete') return;
    if (tabId === null) completedEarly.add(id);
    else if (id === tabId) resolveLoaded();
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    tabId = await openInWorker(url);
    if (completedEarly.has(tabId)) resolveLoaded();
    await Promise.race([loaded, sleep(60_000)]);
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
  await sleep(1500); // let the page's scripts finish setting up
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new NeedsUser('The Alibaba worker window was closed.');
  if (isBlockedUrl(tab.url)) throw new NeedsUser('Alibaba is asking for verification (slider/captcha).');
  return tab;
}

// Content scripts can take a moment to be ready; retry until they answer.
async function askWorker(message, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.tabs.sendMessage(worker.tabId, message);
      if (res) return res;
    } catch (_) { /* not ready yet */ }
    await sleep(1000);
  }
  return null;
}

async function showWorker() {
  try {
    await chrome.windows.update(worker.windowId, { focused: true, state: 'normal' });
  } catch (_) { /* window gone – Resume reopens it */ }
}

// ---------- scan ----------

async function scan() {
  let emptyTries = 0;
  while (!control.stop) {
    const { maxPages } = state.options;
    const lastPage = Math.min(state.scan.totalPages || Infinity, maxPages || Infinity);
    if (state.scan.page > lastPage) break;

    const page = state.scan.page;
    log(`Scanning list page ${page}${Number.isFinite(lastPage) ? ` of ${lastPage}` : ''}…`);
    await loadUrl(pageUrl(state.listUrl, page));
    const res = await askWorker({ type: 'BOT_LIST_LINKS' });
    if (!res) throw new NeedsUser(`List page ${page} didn't load properly. Alibaba may be asking for verification.`);
    if (res.captcha) throw new NeedsUser('Alibaba is asking for verification (slider/captcha).');
    if (!res.ok) throw new Error(res.error);

    if (res.totalPages && res.totalPages > (state.scan.totalPages || 0)) state.scan.totalPages = res.totalPages;

    if (!res.links.length) {
      if (!state.scan.totalPages) break; // no pagination info and an empty page: end of the list
      if (++emptyTries < 2) { await sleep(3000); continue; }
      throw new NeedsUser(`List page ${page} shows no products. Check the Alibaba window for a verification, then Resume.`);
    }
    emptyTries = 0;

    const byId = new Map(state.items.map((i) => [i.id, i]));
    let fresh = 0;
    for (const link of res.links) {
      const known = byId.get(link.id);
      if (known) {
        // fill in details a previous scan might have missed
        if ((link.title || '').length > (known.title || '').length) known.title = link.title;
        known.image ||= link.image;
        known.price ||= link.price;
        continue;
      }
      state.items.push({ ...link, selected: true, status: 'pending', attempts: 0 });
      fresh++;
    }
    log(`Page ${page}: ${res.links.length} products (${fresh} new). Total so far: ${state.items.length}`, fresh ? 'ok' : '');

    // Without pagination info, stop when a page brings nothing new.
    if (!state.scan.totalPages && fresh === 0) break;

    state.scan.page++;
    await persist();
    render();
    await sleep(rand(1500, 3500));
  }
  if (control.stop) return;

  state.scan.done = true;
  await markExisting();
  log(`Scan complete: ${state.items.length} products found. Review the list, then click "Run bot".`, 'ok');
}

// Marks products that are already in Shopify so they aren't imported twice.
async function markExisting() {
  log('Checking which products are already in Shopify…');
  const res = await chrome.runtime.sendMessage({ type: 'GET_IMPORTED_IDS' });
  if (!res?.ok) throw new Error(res?.error || 'Could not read your Shopify products');
  let marked = 0;
  for (const item of state.items) {
    if (res.ids[item.id] && item.status !== 'done' && item.status !== 'exists') {
      item.status = 'exists';
      item.adminUrl = res.ids[item.id];
      marked++;
    }
  }
  if (marked) log(`${marked} products are already in Shopify and will be skipped.`);
}

// ---------- import ----------

const FATAL = /collection not found|automated \(smart\)|access token|client id|no shopify|myshopify|returned 40[13]|access denied|scope|claude api key|openai api key|no credit left/i;

function nextItem() {
  const eligible = (i) => i.selected && (i.status === 'pending' || (i.status === 'failed' && i.attempts < MAX_ATTEMPTS));
  return state.items.find((i) => eligible(i) && i.status === 'pending') || state.items.find(eligible);
}

async function importAll() {
  await markExisting();
  while (!control.stop) {
    const item = nextItem();
    if (!item) break;

    state.current = item.id;
    render();
    const started = Date.now();

    // Reading the product: any problem here pauses on this product (not counted as a failed try).
    await loadUrl(item.url);
    const res = await askWorker({ type: 'BOT_SCRAPE' });
    if (!res) throw new NeedsUser("The product page didn't load properly. Alibaba may be asking for verification.");
    if (res.captcha) throw new NeedsUser('Alibaba is asking for verification (slider/captcha).');
    if (!res.ok) throw new NeedsUser(`Couldn't read the product page: ${res.error}`);
    if (!res.data.title) throw new NeedsUser("The product page loaded without product data. Alibaba may be asking for verification.");

    // Uploading: Shopify errors count as a failed try (retried later), setup errors stop the bot.
    item.attempts++;
    try {
      const settings = await loadSettings();
      let descriptionHtml;
      if (settings.aiDescription) {
        const ai = await chrome.runtime.sendMessage({
          type: 'GENERATE_DESCRIPTION',
          product: {
            title: res.data.title,
            options: res.data.options,
            specRows: res.data.specRows,
            specsHtml: res.data.specsHtml,
            supplierText: res.data.supplierText
          }
        });
        if (!ai?.ok) throw new Error(`AI description: ${ai?.error || 'no response'}`);
        descriptionHtml = ai.html;
      }
      const payload = Pricing.buildAutoPayload(res.data, settings, { descriptionHtml, collections: state.collections });
      const created = await chrome.runtime.sendMessage({ type: 'CREATE_PRODUCT', payload });
      if (!created?.ok) throw new Error(created?.error || 'Shopify did not respond');

      item.status = 'done';
      item.title = created.product.title;
      item.adminUrl = created.adminUrl;
      item.error = null;
      state.timings.push(Date.now() - started);
      if (state.timings.length > 30) state.timings.shift();
      log(`Imported: ${created.product.title}`, 'ok');
      (created.warnings || []).forEach((w) => log(w, 'warn'));
    } catch (err) {
      item.error = err.message || String(err);
      if (FATAL.test(item.error)) {
        item.attempts--; // a setup problem, not this product's fault
        throw new Error(`${item.error}. Fix this in Settings, then click Resume.`);
      }
      item.status = 'failed';
      log(`Failed (try ${item.attempts}/${MAX_ATTEMPTS}): ${item.title || item.url}: ${item.error}`, 'err');
    } finally {
      state.current = null;
      await persist();
      render();
    }

    const { minDelay, maxDelay } = state.options;
    if (!control.stop) await sleep(rand(minDelay, maxDelay) * 1000);
  }
  if (control.stop) return;

  const c = counts();
  log(`Finished: ${c.done} imported, ${c.exists} already in Shopify, ${c.failed} failed.`, 'ok');
  if (worker.windowId != null) chrome.windows.remove(worker.windowId).catch(() => {});
  worker.windowId = worker.tabId = null;
}

// ---------- runner ----------

async function start(task) {
  if (control.running) return;
  control.running = task;
  control.stop = false;
  state.task = task;
  state.paused = null;
  await persist();
  render();

  try {
    if (task === 'scan') await scan();
    else await importAll();

    if (control.stop) {
      state.paused = { reason: 'user', message: 'Paused.' };
      log('Paused.');
    } else {
      state.task = null;
    }
  } catch (err) {
    const message = err.message || String(err);
    if (err instanceof NeedsUser) {
      state.paused = { reason: 'blocked', message, itemId: state.current };
      log(`Paused: ${message}`, 'warn');
      showWorker();
    } else {
      state.paused = { reason: 'error', message };
      log(`Stopped: ${message}`, 'err');
    }
  } finally {
    control.running = null;
    state.current = state.paused?.itemId || null;
    await persist();
    render();
  }
}

// ---------- rendering ----------

function counts() {
  const c = { found: 0, selected: 0, done: 0, exists: 0, failed: 0, left: 0 };
  for (const i of state?.items || []) {
    c.found++;
    if (i.status === 'done') c.done++;
    else if (i.status === 'exists') c.exists++;
    else if (i.status === 'failed' && i.attempts >= MAX_ATTEMPTS) c.failed++;
    if (!i.selected) continue;
    c.selected++;
    if (i.status === 'pending' || (i.status === 'failed' && i.attempts < MAX_ATTEMPTS)) c.left++;
  }
  return c;
}

function formatDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function renderLog() {
  if (!state) return;
  $('log').innerHTML = state.log.slice().reverse().map((l) =>
    `<li class="${l.kind}"><time>${new Date(l.t).toLocaleTimeString()}</time>${esc(l.msg)}</li>`).join('');
}

function statusBadge(item) {
  if (item.id === state.current) {
    return state.paused?.reason === 'blocked' ? '<span class="badge working">Paused here</span>' : '<span class="badge working">Importing…</span>';
  }
  switch (item.status) {
    case 'done': return `<span class="badge done">Imported</span><a class="admin" href="${esc(item.adminUrl)}" target="_blank" rel="noopener">Open ↗</a>`;
    case 'exists': return `<span class="badge exists">Already in Shopify</span><a class="admin" href="${esc(item.adminUrl)}" target="_blank" rel="noopener">Open ↗</a>`;
    case 'failed': return `<span class="badge failed">Failed (${item.attempts}/${MAX_ATTEMPTS})</span><span class="err-msg">${esc(item.error)}</span>`;
    default: return '<span class="badge">To import</span>';
  }
}

function visibleItems() {
  const q = $('search').value.trim().toLowerCase();
  const f = $('filter').value;
  return (state?.items || []).filter((i) => {
    if (q && !(i.title || '').toLowerCase().includes(q) && !i.id.includes(q)) return false;
    if (f === 'all') return true;
    if (f === 'unselected') return !i.selected;
    if (f === 'pending') return i.status === 'pending';
    return i.status === f;
  });
}

function renderTable() {
  if (!state?.items.length) {
    $('rows').innerHTML = `<tr><td colspan="5" class="empty">${control.running === 'scan' ? 'Scanning…' : 'Scan the store to see its products here.'}</td></tr>`;
    $('shown').textContent = '';
    return;
  }
  const items = visibleItems();
  const locked = control.running === 'import';
  $('rows').innerHTML = items.map((i) => `
    <tr data-id="${esc(i.id)}" class="${i.selected ? '' : 'unselected'} ${i.id === state.current ? 'current' : ''}">
      <td><input type="checkbox" class="sel" ${i.selected ? 'checked' : ''} ${locked || i.status === 'done' || i.status === 'exists' ? 'disabled' : ''} aria-label="Select"></td>
      <td class="thumb">${i.image ? `<img src="${esc(i.image)}" alt="" loading="lazy">` : ''}</td>
      <td class="title"><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title || 'Untitled product')}</a><small>ID ${esc(i.id)}</small></td>
      <td>${esc(i.price || '—')}</td>
      <td>${statusBadge(i)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">No products match.</td></tr>';
  $('shown').textContent = `${items.length} shown`;
}

function render() {
  const running = control.running;
  const c = counts();
  const hasItems = !!state?.items.length;
  const scanDone = !!state?.scan.done;
  const paused = state?.paused;

  $('scan').hidden = !!running || !!state;
  $('run').hidden = !!running || !scanDone || !!paused || c.left === 0;
  $('pause').hidden = !running;
  $('resume').hidden = !!running || !paused;
  $('rescan').hidden = !!running || !scanDone || !!paused;
  $('retry').hidden = !!running || !state?.items.some((i) => i.status === 'failed');
  $('reset').hidden = !!running || !state;
  ['listUrl', 'minDelay', 'maxDelay', 'maxPages'].forEach((id) => { $(id).disabled = !!running; });
  $('listUrl').disabled = !!running || !!state;
  ['selectAll', 'selectNone'].forEach((id) => { $(id).disabled = running === 'import' || !hasItems; });

  // Banner
  const banner = $('banner');
  banner.classList.toggle('captcha', paused?.reason === 'blocked');
  if (paused && paused.reason !== 'user') {
    banner.hidden = false;
    $('bannerText').textContent = paused.message;
    $('bannerHint').textContent = paused.reason === 'blocked'
      ? 'The Alibaba window has been brought to the front. Solve the slider/captcha there (or check the page loads), then click Resume. The bot will retry this same page; nothing is skipped.'
      : 'Click Resume to try again.';
  } else {
    banner.hidden = true;
  }

  // Phase text
  let phase = 'Not started';
  if (state) {
    if (running === 'scan' || state.task === 'scan') {
      phase = `Scanning list page ${state.scan.page}${state.scan.totalPages ? ` of ${state.scan.totalPages}` : ''} · ${c.found} products found`;
    } else if (running === 'import' || state.task === 'import') {
      const cur = state.items.find((i) => i.id === state.current);
      phase = cur ? `Importing: ${cur.title || cur.id}` : 'Importing products';
    } else if (scanDone && c.left === 0 && (c.done || c.exists)) {
      phase = 'All selected products are in Shopify ✓';
    } else if (scanDone) {
      phase = `Scan complete: ${c.found} products. Review the list, then click "2. Run bot".`;
    }
    if (paused) phase += paused.reason === 'blocked' ? ' (paused, waiting for you)' : ' (paused)';
  }
  $('phase').textContent = phase;

  // Progress bar
  let pct = 0;
  if (state?.task === 'scan' || (state && !scanDone)) {
    pct = state.scan.totalPages ? ((state.scan.page - 1) / state.scan.totalPages) * 100 : 0;
  } else if (state) {
    const target = c.done + c.left + c.failed;
    pct = target ? ((c.done + c.failed) / target) * 100 : 100;
  }
  $('barFill').style.width = `${Math.min(100, pct)}%`;

  $('sFound').textContent = c.found;
  $('sSelected').textContent = c.selected;
  $('sDone').textContent = c.done;
  $('sExists').textContent = c.exists;
  $('sFailed').textContent = c.failed;
  $('sLeft').textContent = c.left;
  const avg = state?.timings?.length ? state.timings.reduce((a, b) => a + b, 0) / state.timings.length : 0;
  const delay = state ? ((state.options.minDelay + state.options.maxDelay) / 2) * 1000 : 0;
  $('sEta').textContent = avg && c.left ? formatDuration(c.left * (avg + delay)) : '—';

  renderTable();
  renderCollections();

  document.title = running === 'import' ? `(${c.done}/${c.done + c.left}) Importify Bot`
    : paused?.reason === 'blocked' ? '⚠ Paused – Importify Bot' : 'Importify Bot';
}

function fillOptions(options) {
  $('minDelay').value = options.minDelay;
  $('maxDelay').value = options.maxDelay;
  $('maxPages').value = options.maxPages || '';
}

// ---------- controls ----------

$('scan').addEventListener('click', async () => {
  const listUrl = $('listUrl').value.trim();
  try {
    if (!/alibaba\.com$/i.test(new URL(listUrl).hostname)) throw new Error();
  } catch (_) {
    alert("Enter the supplier's Alibaba product list URL, e.g. https://poedagar.en.alibaba.com/productlist-1.html");
    return;
  }
  if (!(await loadSettings()).shop) {
    alert('Connect Shopify in Settings first.');
    return;
  }
  state = newState(listUrl, readOptions());
  log(`Scanning ${listUrl}`);
  start('scan');
});

$('run').addEventListener('click', () => {
  state.options = { ...state.options, ...readOptions() };
  log(`Running bot on ${counts().left} products…`);
  start('import');
});

$('rescan').addEventListener('click', () => {
  state.options = { ...state.options, ...readOptions() };
  state.scan = { page: 1, totalPages: null, done: false };
  log('Rescanning the store for new products…');
  start('scan');
});

$('pause').addEventListener('click', () => {
  control.stop = true;
  $('pause').disabled = true;
  log('Pausing after the current product…');
  const wait = setInterval(() => {
    if (!control.running) { clearInterval(wait); $('pause').disabled = false; }
  }, 300);
});

$('resume').addEventListener('click', () => {
  state.options = { ...state.options, ...readOptions() };
  log('Resuming…');
  start(state.task || 'import');
});

$('retry').addEventListener('click', async () => {
  state.items.forEach((i) => { if (i.status === 'failed') { i.status = 'pending'; i.attempts = 0; i.error = null; } });
  await persist();
  render();
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Reset the bot? The product list and progress are cleared. Products already in Shopify are still skipped next time.')) return;
  const listUrl = state.listUrl;
  state = null;
  await chrome.storage.local.remove('botState');
  $('listUrl').value = listUrl;
  $('log').innerHTML = '';
  render();
});

// Product table: selection, search and filter
$('rows').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('sel')) return;
  const item = state.items.find((i) => i.id === e.target.closest('tr').dataset.id);
  item.selected = e.target.checked;
  await persist();
  render();
});
for (const [id, value] of [['selectAll', true], ['selectNone', false]]) {
  $(id).addEventListener('click', async () => {
    visibleItems().forEach((i) => { if (i.status !== 'done' && i.status !== 'exists') i.selected = value; });
    await persist();
    render();
  });
}
$('search').addEventListener('input', renderTable);
$('filter').addEventListener('change', renderTable);

// The "Bulk import" button on a list page sends its URL here when this tab is already open.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'BOT_SET_LIST' && message.listUrl && !state) $('listUrl').value = message.listUrl;
  return false;
});

// ---------- collections picker ----------

const chosenTitles = () => (state ? state.collections : [...pickedTitles]);

async function loadCollections() {
  const res = await chrome.runtime.sendMessage({ type: 'LIST_COLLECTIONS' }).catch((err) => ({ ok: false, error: err.message }));
  if (res?.ok) storeCollections = res.collections;
  else collectionsError = res?.error || 'Could not load collections';
  renderCollections();
}

function renderCollections() {
  const chosen = chosenTitles();
  const hint = $('colHint');
  if (collectionsError) {
    hint.textContent = collectionsError;
    $('colList').innerHTML = '';
    return;
  }
  hint.textContent = chosen.length ? `${chosen.length} selected – every imported product is added to these` : 'None selected';
  if (!storeCollections) return;
  const q = $('colSearch').value.trim().toLowerCase();
  const locked = control.running === 'import';
  const lower = new Set(chosen.map((t) => t.toLowerCase()));
  // Selected titles missing from the store still show, so they can be unticked.
  const all = [...storeCollections.map((c) => c.title), ...chosen.filter((t) => !storeCollections.some((c) => c.title.toLowerCase() === t.toLowerCase()))];
  $('colList').innerHTML = all
    .filter((t) => !q || t.toLowerCase().includes(q))
    .map((t) => `<label><input type="checkbox" data-title="${esc(t)}" ${lower.has(t.toLowerCase()) ? 'checked' : ''} ${locked ? 'disabled' : ''}> ${esc(t)}</label>`)
    .join('') || '<span class="hint">No collections match.</span>';
}

$('colSearch').addEventListener('input', renderCollections);
$('colList').addEventListener('change', async (e) => {
  const title = e.target.dataset.title;
  if (!title) return;
  const set = new Set(chosenTitles());
  if (e.target.checked) set.add(title);
  else [...set].forEach((t) => { if (t.toLowerCase() === title.toLowerCase()) set.delete(t); });
  if (state) {
    state.collections = [...set];
    await persist();
  } else {
    pickedTitles.clear();
    set.forEach((t) => pickedTitles.add(t));
  }
  renderCollections();
});

// ---------- init ----------

(async () => {
  // Stop Chrome from discarding this tab to save memory during a long run.
  const me = await chrome.tabs.getCurrent();
  if (me) chrome.tabs.update(me.id, { autoDiscardable: false }).catch(() => {});

  const { botState } = await chrome.storage.local.get('botState');
  const fromLink = new URLSearchParams(location.search).get('list');
  if (botState?.scan) {
    state = botState;
    if (!Array.isArray(state.collections)) state.collections = [...LEGACY_COLLECTIONS];
    // The previous session ended mid-task: offer to resume it.
    if (state.task && !state.paused) state.paused = { reason: 'user', message: 'Paused.' };
    $('listUrl').value = state.listUrl;
    fillOptions(state.options);
    renderLog();
  } else if (fromLink) {
    $('listUrl').value = fromLink;
  }
  render();
  loadCollections();
})();
