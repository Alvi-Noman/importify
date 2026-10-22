// Injects the "Add to Shopify" button and import panel on Alibaba product pages.
(() => {
  if (window.__importifyLoaded) return;
  window.__importifyLoaded = true;

  const Scraper = globalThis.ImportifyScraper;
  const DEFAULTS = globalThis.IMPORTIFY_DEFAULTS;
  const Pricing = globalThis.ImportifyPricing;

  // The bulk-import bot asks this tab for the scraped product data.
  const hasCaptcha = () => {
    const el = document.querySelector('[id^="nc_"][id$="_wrapper"], .nc-container, [id*="baxia"], iframe[src*="punish"], iframe[src*="captcha"]');
    return !!(el && el.getClientRects().length);
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'BOT_CAPTCHA_CHECK') {
      sendResponse({ captcha: hasCaptcha() });
      return false;
    }
    if (message?.type !== 'BOT_SCRAPE') return false;
    (async () => {
      if (hasCaptcha()) return { ok: false, captcha: true };
      const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(null)) };
      return { ok: true, data: await Scraper.scrape(settings) };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  });

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .fab {
      position: fixed; right: 24px; bottom: 24px; z-index: 2147483646;
      display: flex; align-items: center; gap: 8px;
      background: #008060; color: #fff; border: 0; border-radius: 999px;
      padding: 12px 20px; font-size: 15px; font-weight: 600; cursor: pointer;
      box-shadow: 0 6px 20px rgba(0,0,0,.25);
    }
    .fab:hover { background: #006e52; }
    .fab svg { width: 18px; height: 18px; }
    .overlay {
      position: fixed; inset: 0; z-index: 2147483647; background: rgba(15,23,42,.55);
      display: flex; align-items: center; justify-content: center; padding: 16px;
    }
    .overlay[hidden] { display: none; }
    .modal {
      background: #fff; color: #1f2937; width: min(920px, 100%); max-height: calc(100vh - 32px);
      border-radius: 12px; display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,.35); font-size: 14px;
    }
    header, footer { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid #e5e7eb; }
    footer { border-bottom: 0; border-top: 1px solid #e5e7eb; justify-content: flex-end; }
    header h2 { margin: 0; font-size: 17px; flex: 1; }
    header .x { background: none; border: 0; font-size: 24px; line-height: 1; cursor: pointer; color: #6b7280; }
    .body { padding: 16px 20px; overflow: auto; display: flex; flex-direction: column; gap: 18px; }
    .label { display: block; font-weight: 600; margin-bottom: 6px; }
    .hint { color: #6b7280; font-size: 12px; font-weight: 400; margin-left: 6px; }
    input[type=text], input[type=number], select, textarea {
      width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; color: #111827; background: #fff;
    }
    input:focus, select:focus, textarea:focus { outline: 2px solid #008060; outline-offset: -1px; border-color: transparent; }
    textarea { min-height: 160px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
    .warn { background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; padding: 8px 12px; border-radius: 6px; }
    .warn a { color: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; }
    .img { position: relative; aspect-ratio: 1; border: 2px solid #e5e7eb; border-radius: 8px; overflow: hidden; cursor: pointer; background: #f9fafb; padding: 0; }
    .img img { width: 100%; height: 100%; object-fit: cover; display: block; opacity: .35; }
    .img.on { border-color: #008060; }
    .img.on img { opacity: 1; }
    .img .badge { position: absolute; top: 4px; left: 4px; background: #008060; color: #fff; font-size: 11px; border-radius: 4px; padding: 1px 5px; display: none; }
    .img.on .badge { display: block; }
    .rule { display: grid; grid-template-columns: 1.3fr 1fr 1.3fr 1fr auto; gap: 10px; align-items: end; }
    .row-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
    .row-head .label { margin-bottom: 0; }
    .row-head input[type=search] { width: 220px; padding: 5px 8px; }
    button.small { padding: 5px 12px; font-size: 13px; }
    button.btn:disabled { opacity: .6; cursor: progress; }
    textarea:read-only { background: #f9fafb; color: #6b7280; }
    .col-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 4px 12px; max-height: 170px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 10px; }
    .col-list label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; padding: 2px 0; }
    .col-list .hint { margin: 0; }
    .hint.err { color: #b91c1c; }
    .rule label { font-size: 12px; color: #4b5563; }
    .check { display: flex; align-items: center; gap: 6px; white-space: nowrap; padding-bottom: 8px; }
    .cost { margin-bottom: 8px; color: #374151; }
    .table-wrap { max-height: 300px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #f3f4f6; vertical-align: middle; }
    th { position: sticky; top: 0; background: #f9fafb; font-size: 12px; color: #4b5563; z-index: 1; }
    td.thumb img { width: 36px; height: 36px; object-fit: cover; border-radius: 4px; display: block; }
    td input[type=number] { width: 100px; padding: 5px 8px; }
    tr.off td { opacity: .45; }
    .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .meta label { font-size: 12px; color: #4b5563; display: block; margin-bottom: 4px; }
    button.btn { border-radius: 6px; padding: 9px 16px; font-size: 14px; font-weight: 600; cursor: pointer; border: 1px solid #d1d5db; background: #fff; color: #111827; }
    button.primary { background: #008060; border-color: #008060; color: #fff; }
    button.primary:disabled { opacity: .6; cursor: progress; }
    .status { flex: 1; color: #4b5563; }
    .status.err { color: #b91c1c; }
    .center { padding: 48px 20px; text-align: center; color: #4b5563; }
    .center a { color: #008060; font-weight: 600; }
    .spinner { width: 28px; height: 28px; border: 3px solid #e5e7eb; border-top-color: #008060; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 700px) { .rule, .meta { grid-template-columns: 1fr 1fr; } }
  `;

  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

  // ---------- DOM setup ----------

  const host = document.createElement('div');
  host.id = 'importify-root';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style>
    <button class="fab" type="button">${ICON}<span>Add to Shopify</span></button>
    <div class="overlay" hidden></div>`;

  // Keep the page's own keyboard shortcuts from reacting while typing in the panel.
  ['keydown', 'keyup', 'keypress'].forEach((t) => host.addEventListener(t, (e) => e.stopPropagation()));

  const fab = root.querySelector('.fab');
  const overlay = root.querySelector('.overlay');
  fab.addEventListener('click', open);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  host.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });

  let state = null;

  // ---------- utils ----------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const thumb = (url, size) => (/alicdn\.com/i.test(url) ? `${url}_${size}x${size}.jpg` : url);
  const usd = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
  const $ = (sel) => overlay.querySelector(sel);
  const $$ = (sel) => [...overlay.querySelectorAll(sel)];

  async function loadSettings() {
    const stored = await chrome.storage.local.get(null);
    return { ...DEFAULTS, ...stored };
  }

  const priceFor = (cost) => Pricing.priceFor(cost, state.rule);
  const compareAtFor = (price) => Pricing.compareAtFor(price, state.rule);

  // ---------- open / close ----------

  function close() {
    overlay.hidden = true;
    overlay.innerHTML = '';
    state = null;
  }

  async function open() {
    overlay.hidden = false;
    // After the extension is reloaded/updated, scripts in already-open tabs lose access to it.
    if (!chrome.runtime?.id) {
      overlay.innerHTML = `<div class="modal"><div class="center">Importify was updated. Refresh this page (F5) to use it.<br><br><button class="btn primary" data-reload>Refresh page</button></div></div>`;
      $('[data-reload]').addEventListener('click', () => location.reload());
      return;
    }
    overlay.innerHTML = `<div class="modal"><div class="center"><div class="spinner"></div>Reading product…</div></div>`;
    try {
      const settings = await loadSettings();
      const data = await Scraper.scrape(settings);
      // Keys can come from Settings or the .env file, which only the background can read.
      const ai = await chrome.runtime.sendMessage({ type: 'AI_STATUS' }).catch(() => null);
      state = {
        settings,
        data,
        images: data.images.map((url) => ({ url, on: true })),
        rule: Pricing.ruleFromSettings(settings),
        variants: data.variants.map((v) => ({ ...v, include: true, price: '', compareAtPrice: '' })),
        collections: null,                // [{id, title}] once loaded from Shopify
        collectionsError: null,
        selectedCollections: new Set(),   // collection IDs
        aiWriting: false,
        ai: ai?.ok ? ai : { enabled: settings.aiDescription, hasKey: false, provider: settings.aiProvider }
      };
      applyRule();
      render();
      loadCollections();
      if (state.ai.enabled && state.ai.hasKey) writeDescription();
    } catch (err) {
      overlay.innerHTML = `<div class="modal"><div class="center">Couldn't read this product.<br><small>${esc(err.message || err)}</small><br><br><button class="btn" data-close>Close</button></div></div>`;
      $('[data-close]').addEventListener('click', close);
    }
  }

  function applyRule() {
    for (const v of state.variants) {
      v.price = priceFor(v.cost);
      v.compareAtPrice = compareAtFor(v.price);
    }
  }

  // ---------- render ----------

  function render() {
    const { data, settings, rule } = state;
    const configured = settings.shop && (settings.authMode === 'client' ? settings.clientId && settings.clientSecret : settings.accessToken);
    const warnings = [...data.warnings];

    const ladder = data.ladder.length
      ? `<span class="hint">(${data.ladder.map((l) => `${l.min ?? ''}${l.max && l.max !== l.min ? '–' + l.max : l.max == null ? '+' : ''} pcs: ${usd(l.price)}`).join(' · ')})</span>`
      : '';

    const optionHeads = data.options.length
      ? data.options.map((o) => `<th>${esc(o.name)}</th>`).join('')
      : '<th>Variant</th>';

    const rows = state.variants.map((v, i) => `
      <tr data-i="${i}" class="${v.include ? '' : 'off'}">
        <td><input type="checkbox" class="inc" ${v.include ? 'checked' : ''} aria-label="Include variant"></td>
        <td class="thumb">${v.image ? `<img src="${esc(thumb(v.image, 100))}" alt="">` : ''}</td>
        ${data.options.length ? v.values.map((val) => `<td>${esc(val)}</td>`).join('') : '<td>Default</td>'}
        <td>${usd(v.cost)}</td>
        <td><input type="number" class="price" min="0" step="0.01" value="${esc(v.price)}"></td>
        <td><input type="number" class="cap" min="0" step="0.01" value="${esc(v.compareAtPrice)}" placeholder="—"></td>
      </tr>`).join('');

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-label="Add to Shopify">
        <header><h2>Add to Shopify</h2><button class="x" data-close aria-label="Close">×</button></header>
        <div class="body">
          ${configured ? '' : `<div class="warn">Shopify isn't connected yet. <a data-settings>Open settings</a> to add your store.</div>`}
          ${warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}

          <div>
            <span class="label">Title</span>
            <input type="text" id="title" maxlength="255" value="${esc(data.title)}">
          </div>

          <div>
            <span class="label">Images <span class="hint">Click to include/exclude · the first selected image is the main image</span></span>
            <div class="grid">
              ${state.images.map((img, i) => `
                <button type="button" class="img ${img.on ? 'on' : ''}" data-img="${i}" title="${img.on ? 'Included' : 'Excluded'}">
                  <img src="${esc(thumb(img.url, 220))}" alt="" loading="lazy"><span class="badge">✓</span>
                </button>`).join('') || '<span class="hint">No images found</span>'}
            </div>
          </div>

          <div>
            <span class="label">Pricing</span>
            <div class="cost">Alibaba price: <strong>${usd(data.cost)}</strong> ${ladder}</div>
            <div class="rule">
              <div><label>Rule</label>
                <select id="mode">
                  <option value="fixed" ${rule.mode === 'fixed' ? 'selected' : ''}>Fixed price</option>
                  <option value="multiplier" ${rule.mode === 'multiplier' ? 'selected' : ''}>Multiply cost (×)</option>
                  <option value="markup" ${rule.mode === 'markup' ? 'selected' : ''}>Add to cost (+)</option>
                </select>
              </div>
              <div><label>Value</label><input type="number" id="ruleValue" min="0" step="0.01" value="${esc(rule.value)}"></div>
              <div><label>Compare-at</label>
                <select id="compareAtMode">
                  <option value="fixed" ${rule.compareAtMode === 'fixed' ? 'selected' : ''}>Fixed price</option>
                  <option value="multiplier" ${rule.compareAtMode === 'multiplier' ? 'selected' : ''}>Multiply price (×)</option>
                </select>
              </div>
              <div><label>Compare-at value (0 = none)</label><input type="number" id="compareAt" min="0" step="0.01" value="${esc(rule.compareAt)}"></div>
              <label class="check"><input type="checkbox" id="round" ${rule.round ? 'checked' : ''}> End in .99</label>
            </div>
          </div>

          <div>
            <span class="label">Variants <span class="hint" id="variantCount"></span></span>
            <div class="table-wrap">
              <table>
                <thead><tr><th><input type="checkbox" id="incAll" checked aria-label="Include all"></th><th></th>${optionHeads}<th>Alibaba cost</th><th>Price</th><th>Compare-at</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>

          <div>
            <div class="row-head">
              <span class="label">Description <span class="hint" id="descHint">${state.ai.enabled && !state.ai.hasKey ? `Add your ${state.ai.provider === 'claude' ? 'Claude' : 'OpenAI'} API key to .env or Settings to get AI descriptions` : 'HTML – edit freely'}</span></span>
              <button type="button" class="btn small" id="aiWrite">✨ Write with AI</button>
            </div>
            <textarea id="desc">${esc(data.descriptionHtml)}</textarea>
          </div>

          <div>
            <div class="row-head">
              <span class="label">Collections <span class="hint" id="colHint">Loading your collections…</span></span>
              <input type="search" id="colSearch" placeholder="Search collections">
            </div>
            <div class="col-list" id="colList"></div>
          </div>

          <div class="meta">
            <div><label>Vendor</label><input type="text" id="vendor" value="${esc(settings.vendor)}"></div>
            <div><label>Product type</label><input type="text" id="productType" value="${esc(settings.productType)}"></div>
            <div><label>Tags (comma separated)</label><input type="text" id="tags" value="${esc(settings.tags)}"></div>
            <div><label>Status</label>
              <select id="status">
                <option value="DRAFT" ${settings.status === 'DRAFT' ? 'selected' : ''}>Draft</option>
                <option value="ACTIVE" ${settings.status === 'ACTIVE' ? 'selected' : ''}>Active</option>
              </select>
            </div>
          </div>
        </div>
        <footer>
          <span class="status" id="status-msg"></span>
          <button class="btn" data-settings>Settings</button>
          <button class="btn primary" id="upload">Upload to Shopify</button>
        </footer>
      </div>`;

    bind();
    updateCount();
  }

  function updateCount() {
    const n = state.variants.filter((v) => v.include).length;
    $('#variantCount').textContent = `${n} of ${state.variants.length} selected`;
    $('#incAll').checked = n === state.variants.length;
  }

  function refreshPriceInputs() {
    $$('tbody tr').forEach((tr) => {
      const v = state.variants[tr.dataset.i];
      tr.querySelector('.price').value = v.price;
      tr.querySelector('.cap').value = v.compareAtPrice;
    });
  }

  function bind() {
    $$('[data-close]').forEach((b) => b.addEventListener('click', close));
    $$('[data-settings]').forEach((b) => b.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' })));

    $$('[data-img]').forEach((btn) => btn.addEventListener('click', () => {
      const img = state.images[btn.dataset.img];
      img.on = !img.on;
      btn.classList.toggle('on', img.on);
      btn.title = img.on ? 'Included' : 'Excluded';
    }));

    const onRule = () => {
      state.rule = {
        mode: $('#mode').value,
        value: $('#ruleValue').value,
        compareAtMode: $('#compareAtMode').value,
        compareAt: $('#compareAt').value,
        round: $('#round').checked
      };
      applyRule();
      refreshPriceInputs();
    };
    ['#mode', '#compareAtMode', '#round'].forEach((s) => $(s).addEventListener('change', onRule));
    ['#ruleValue', '#compareAt'].forEach((s) => $(s).addEventListener('input', onRule));

    $('tbody').addEventListener('input', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const v = state.variants[tr.dataset.i];
      if (e.target.classList.contains('price')) v.price = e.target.value;
      if (e.target.classList.contains('cap')) v.compareAtPrice = e.target.value;
    });
    $('tbody').addEventListener('change', (e) => {
      if (!e.target.classList.contains('inc')) return;
      const tr = e.target.closest('tr');
      state.variants[tr.dataset.i].include = e.target.checked;
      tr.classList.toggle('off', !e.target.checked);
      updateCount();
    });
    $('#incAll').addEventListener('change', (e) => {
      state.variants.forEach((v) => { v.include = e.target.checked; });
      $$('tbody tr').forEach((tr) => {
        tr.classList.toggle('off', !e.target.checked);
        tr.querySelector('.inc').checked = e.target.checked;
      });
      updateCount();
    });

    $('#upload').addEventListener('click', upload);
    $('#aiWrite').addEventListener('click', writeDescription);
    $('#colSearch').addEventListener('input', renderCollections);
    $('#colList').addEventListener('change', (e) => {
      const id = e.target.dataset.col;
      if (!id) return;
      if (e.target.checked) state.selectedCollections.add(id);
      else state.selectedCollections.delete(id);
      renderCollections();
    });
  }

  // ---------- collections ----------

  async function loadCollections() {
    const current = state;
    const res = await chrome.runtime.sendMessage({ type: 'LIST_COLLECTIONS' }).catch((err) => ({ ok: false, error: err.message }));
    if (state !== current) return; // panel was closed or reopened meanwhile
    if (!res?.ok) {
      state.collectionsError = res?.error || 'Could not load collections';
    } else {
      state.collections = res.collections;
      // Pre-tick the default collections from Settings (if any).
      const defaults = new Set(Pricing.splitLines(state.settings.collections).map((t) => t.toLowerCase()));
      res.collections.forEach((c) => { if (defaults.has(c.title.toLowerCase())) state.selectedCollections.add(c.id); });
    }
    renderCollections();
  }

  function renderCollections() {
    const hint = $('#colHint');
    const list = $('#colList');
    if (!hint || !list) return;
    if (state.collectionsError) {
      hint.textContent = state.collectionsError;
      hint.classList.add('err');
      list.innerHTML = '';
      return;
    }
    if (!state.collections) return;
    const q = $('#colSearch').value.trim().toLowerCase();
    const shown = state.collections.filter((c) => !q || c.title.toLowerCase().includes(q));
    list.innerHTML = shown.map((c) => `
      <label><input type="checkbox" data-col="${esc(c.id)}" ${state.selectedCollections.has(c.id) ? 'checked' : ''}> ${esc(c.title)}</label>`).join('')
      || `<span class="hint">${state.collections.length ? 'No collections match.' : 'Your store has no manual collections.'}</span>`;
    const n = state.selectedCollections.size;
    hint.classList.remove('err');
    hint.textContent = n ? `${n} selected` : 'None selected';
  }

  // ---------- AI description ----------

  async function writeDescription() {
    const current = state;
    const button = $('#aiWrite');
    const hint = $('#descHint');
    const desc = $('#desc');
    state.aiWriting = true;
    button.disabled = true;
    desc.readOnly = true;
    $('#upload').disabled = true;
    hint.classList.remove('err');
    hint.textContent = 'Writing description with AI…';

    const { data } = state;
    const res = await chrome.runtime.sendMessage({
      type: 'GENERATE_DESCRIPTION',
      product: {
        title: $('#title').value.trim() || data.title,
        options: data.options,
        specRows: data.specRows,
        specsHtml: data.specsHtml,
        supplierText: data.supplierText
      }
    }).catch((err) => ({ ok: false, error: err.message }));
    if (state !== current) return;

    state.aiWriting = false;
    button.disabled = false;
    desc.readOnly = false;
    $('#upload').disabled = false;
    if (res?.ok) {
      desc.value = res.html;
      hint.textContent = `Written by AI (${res.model}) – edit freely`;
    } else {
      hint.textContent = `AI description failed: ${res?.error || 'unknown error'}`;
      hint.classList.add('err');
    }
  }

  // ---------- upload ----------

  function setStatus(msg, isError = false) {
    const el = $('#status-msg');
    el.textContent = msg;
    el.classList.toggle('err', isError);
  }

  function buildPayload() {
    const { data, settings } = state;
    const title = $('#title').value.trim();
    if (!title) throw new Error('Title is required.');

    const variants = state.variants.filter((v) => v.include);
    if (!variants.length) throw new Error('Select at least one variant.');
    for (const v of variants) {
      if (!(parseFloat(v.price) > 0)) {
        throw new Error(`Set a price for ${v.values.length ? v.values.join(' / ') : 'the product'}.`);
      }
    }

    // Only keep option values that are actually used by the selected variants.
    const options = data.options.map((o, i) => ({
      name: o.name,
      values: o.values.filter((val) => variants.some((v) => v.values[i] === val))
    }));

    return {
      title,
      descriptionHtml: $('#desc').value,
      vendor: $('#vendor').value.trim(),
      productType: $('#productType').value.trim(),
      tags: $('#tags').value.split(',').map((t) => t.trim()).filter(Boolean),
      status: $('#status').value,
      images: state.images.filter((i) => i.on).map((i) => i.url),
      options,
      variants: variants.map((v) => ({
        values: v.values,
        price: parseFloat(v.price).toFixed(2),
        compareAtPrice: parseFloat(v.compareAtPrice) > parseFloat(v.price) ? parseFloat(v.compareAtPrice).toFixed(2) : null,
        cost: settings.saveCost && v.cost ? Number(v.cost).toFixed(2) : null,
        image: v.image
      })),
      collectionIds: [...state.selectedCollections],
      sourceUrl: data.sourceUrl,
      publishOnline: settings.publishOnline
    };
  }

  async function upload() {
    let payload;
    try {
      payload = buildPayload();
    } catch (err) {
      return setStatus(err.message, true);
    }

    const btn = $('#upload');
    btn.disabled = true;
    setStatus('Uploading to Shopify…');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CREATE_PRODUCT', payload });
      if (!res?.ok) throw new Error(res?.error || 'Unknown error');
      showSuccess(res);
    } catch (err) {
      setStatus(err.message || String(err), true);
      btn.disabled = false;
    }
  }

  function showSuccess(res) {
    overlay.innerHTML = `
      <div class="modal">
        <div class="center">
          <div style="font-size:40px;color:#008060">✓</div>
          <h2 style="margin:8px 0">Added to Shopify</h2>
          <p>${esc(res.product.title)}</p>
          ${(res.warnings || []).map((w) => `<div class="warn" style="margin:8px auto;max-width:520px">${esc(w)}</div>`).join('')}
          <p class="hint">Images can take a minute to finish processing in Shopify.</p>
          <p><a href="${esc(res.adminUrl)}" target="_blank" rel="noopener">Open in Shopify admin →</a></p>
          <button class="btn" data-close>Close</button>
        </div>
      </div>`;
    $('[data-close]').addEventListener('click', close);
  }
})();
