// Runs on supplier product-list pages (e.g. poedagar.en.alibaba.com/productlist-1.html).
// Adds a "Bulk import" button and answers the bot's requests for product links.
(() => {
  if (window.__importifyListLoaded) return;
  window.__importifyListLoaded = true;

  const Pricing = globalThis.ImportifyPricing;

  function isProductLink(href) {
    return /\/product-detail\/|\/product\/\d{6,}/i.test(href);
  }

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function imageUrl(img) {
    let src = img?.getAttribute('data-src') || img?.getAttribute('data-lazy-src') || img?.currentSrc || img?.getAttribute('src') || '';
    if (src.startsWith('//')) src = 'https:' + src;
    return /^https?:\/\//.test(src) && !/^data:/.test(src) ? src : '';
  }

  // Product card around a link: the nearest ancestor that contains an image.
  function cardFor(a) {
    let el = a;
    for (let i = 0; i < 6 && el && el !== document.body; i++, el = el.parentElement) {
      if (el.querySelector('img') && clean(el.textContent).length > 10) return el;
    }
    return a.parentElement || a;
  }

  function collectLinks() {
    const byId = new Map();
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href;
      if (!isProductLink(href)) return;
      const id = Pricing.productIdFromUrl(href);
      if (!id) return;
      const entry = byId.get(id) || { id, url: href.split(/[?#]/)[0], title: '', image: '', price: '' };
      const card = cardFor(a);
      // A card has several links to the product (image, title, badges like "Certified"),
      // so keep the longest candidate: that's the product name.
      const candidates = [
        a.getAttribute('title'),
        a.textContent,
        a.querySelector('img')?.alt,
        card.querySelector('[class*="title"], [class*="subject"], h2, h3, h4')?.textContent,
        card.querySelector('img')?.alt
      ].map(clean).filter((t) => t.length < 300);
      for (const text of candidates) {
        if (text.length > (entry.title || '').length) entry.title = text;
      }
      if (!entry.image) entry.image = imageUrl(a.querySelector('img') || card.querySelector('img'));
      if (!entry.price) entry.price = (card.textContent.match(/(?:US\s*)?\$\s*[\d.,]+(?:\s*-\s*\$?\s*[\d.,]+)?/) || [''])[0].replace(/\s+/g, '');
      byId.set(id, entry);
    });
    return [...byId.values()];
  }

  function totalPages() {
    let max = 0;
    document.querySelectorAll('a[href*="productlist-"], a[href*="productgrouplist-"]').forEach((a) => {
      const m = a.href.match(/(?:productlist|productgrouplist-\d+)-(\d+)\.html/) || a.href.match(/productlist-(\d+)\.html/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    // Text like "1/46" or "Page 1 of 46" in the pagination bar
    const pager = document.querySelector('[class*="pagination"], [class*="pager"], [class*="page-nav"]');
    const text = pager?.textContent || '';
    const m = text.match(/\/\s*(\d+)/) || text.match(/of\s+(\d+)/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
    return max || null;
  }

  function hasCaptcha() {
    const el = document.querySelector('[id^="nc_"][id$="_wrapper"], .nc-container, [id*="baxia"], iframe[src*="punish"], iframe[src*="captcha"]');
    return !!(el && el.getClientRects().length);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Scrolls through the page so lazily-loaded products render, until the link count stops growing.
  async function gatherLinks() {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 30 && stable < 3; i++) {
      window.scrollTo(0, document.body.scrollHeight * ((i % 5) + 1) / 5);
      await wait(700);
      const count = collectLinks().length;
      stable = count === last && count > 0 ? stable + 1 : 0;
      last = count;
    }
    window.scrollTo(0, 0);
    return collectLinks();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'BOT_CAPTCHA_CHECK') {
      sendResponse({ captcha: hasCaptcha() });
      return false;
    }
    if (message?.type !== 'BOT_LIST_LINKS') return false;
    (async () => {
      if (hasCaptcha()) return { ok: false, captcha: true };
      const links = await gatherLinks();
      return { ok: true, links, totalPages: totalPages() };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  });

  // ---------- "Bulk import" button ----------

  const host = document.createElement('div');
  host.id = 'importify-list-root';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      button {
        position: fixed; right: 24px; bottom: 24px; z-index: 2147483646;
        background: #008060; color: #fff; border: 0; border-radius: 999px;
        padding: 12px 20px; font: 600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.25);
      }
      button:hover { background: #006e52; }
    </style>
    <button type="button">Bulk import this store to Shopify</button>`;
  root.querySelector('button').addEventListener('click', () => {
    // After the extension is reloaded/updated, scripts in already-open tabs lose access to it.
    if (!chrome.runtime?.id) {
      if (confirm('Importify was updated. Refresh this page to use it?')) location.reload();
      return;
    }
    chrome.runtime.sendMessage({ type: 'OPEN_BOT', listUrl: location.href });
  });
})();
