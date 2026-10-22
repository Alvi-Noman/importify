// Extracts product data (title, images, price, options/variants, description)
// from an Alibaba product-detail page. Alibaba changes its markup often, so
// every field has a structured-data source plus DOM fallbacks.
globalThis.ImportifyScraper = (() => {
  const MAX_OPTIONS = 3;       // Shopify limit
  const MAX_VARIANTS = 2048;   // Shopify limit

  // ---------- helpers ----------

  function requestPageData(timeout = 2500) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve({});
      }, timeout);
      function onMessage(event) {
        const msg = event.data;
        if (event.source !== window || !msg || msg.__importify !== 'response' || msg.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(msg.data || {});
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ __importify: 'request', id }, location.origin);
    });
  }

  // Depth-first search for the first object matching `predicate`.
  function deepFind(root, predicate, maxDepth = 14) {
    const seen = new Set();
    const stack = [[root, 0]];
    while (stack.length) {
      const [node, depth] = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node) || depth > maxDepth) continue;
      seen.add(node);
      try {
        if (!Array.isArray(node) && predicate(node)) return node;
      } catch (_) { /* ignore */ }
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') stack.push([value, depth + 1]);
      }
    }
    return null;
  }

  // First string value whose key matches `keyRegex` and value matches `valueRegex`.
  function deepFindString(root, keyRegex, valueRegex) {
    let found = null;
    deepFind(root, (obj) => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && keyRegex.test(k) && valueRegex.test(v)) {
          found = v;
          return true;
        }
      }
      return false;
    });
    return found;
  }

  function normalizeImageUrl(url) {
    if (!url || typeof url !== 'string') return null;
    url = url.trim();
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//i.test(url)) return null;
    url = url.split('?')[0].replace(/^http:/i, 'https:');
    // Strip alicdn resize/format suffixes: foo.jpg_220x220.jpg, foo.jpg_.webp, foo.png_350x350q80.jpg_.avif
    url = url.replace(/(\.(?:jpe?g|png|webp|gif))_.*$/i, '$1');
    return url;
  }

  function parsePrice(value) {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value === 'object') {
      return parsePrice(value.dollarPrice ?? value.price ?? value.value ?? value.amount ?? value.formatPrice);
    }
    const match = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    const n = match ? parseFloat(match[0]) : null;
    return n && n > 0 ? n : null;
  }

  function uniqueNames(names, fallbackPrefix) {
    const used = new Map();
    return names.map((raw, i) => {
      let name = (raw || '').toString().replace(/\s+/g, ' ').trim().slice(0, 250) || `${fallbackPrefix} ${i + 1}`;
      const key = name.toLowerCase();
      if (used.has(key)) {
        const n = used.get(key) + 1;
        used.set(key, n);
        name = `${name} (${n})`;
      } else {
        used.set(key, 1);
      }
      return name;
    });
  }

  function cartesian(lists) {
    return lists.reduce((acc, list) => acc.flatMap((combo) => list.map((item) => [...combo, item])), [[]]);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- field extractors ----------

  function findProduct(raw) {
    const direct = raw?.detailData?.globalData?.product;
    if (direct && typeof direct === 'object') return direct;
    return deepFind(raw, (o) => typeof o.subject === 'string' && (o.mediaItems || o.sku || o.price)) || {};
  }

  function getTitle(product) {
    const meta = document.querySelector('meta[property="og:title"]')?.content;
    const h1 = document.querySelector('h1')?.textContent;
    const title = product.subject || h1 || meta || document.title || '';
    return title
      .replace(/\s*-\s*Buy .*$/i, '')
      .replace(/\s*(-|\|)\s*Alibaba\.com.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 255);
  }

  function getImages(product) {
    const urls = [];
    const push = (u) => {
      const n = normalizeImageUrl(u);
      if (n && !urls.includes(n)) urls.push(n);
    };

    for (const item of product.mediaItems || []) {
      if (item.type && item.type !== 'image') continue;
      const img = item.imageUrl;
      push(typeof img === 'string' ? img : img?.big || img?.normal || img?.thumb);
    }

    if (!urls.length) {
      const selectors = [
        '[class*="main-image"] img', '[class*="image-list"] img', '[class*="gallery"] img',
        '[class*="slider"] img', '[class*="thumb"] img'
      ];
      document.querySelectorAll(selectors.join(',')).forEach((img) => {
        const src = img.getAttribute('data-src') || img.currentSrc || img.src;
        if (src && /alicdn\.com\/.*kf\//i.test(src)) push(src);
      });
    }
    if (!urls.length) push(document.querySelector('meta[property="og:image"]')?.content);
    return urls;
  }

  function getCost(product) {
    const price = product.price || {};
    const ladderRaw = price.productLadderPrices || price.ladderPrices || price.ladderPriceList || [];
    const ladder = ladderRaw
      .map((l) => ({ min: l.min ?? l.minQuantity ?? null, max: l.max ?? l.maxQuantity ?? null, price: parsePrice(l.dollarPrice ?? l.price ?? l.formatPrice) }))
      .filter((l) => l.price);

    // The smallest-quantity tier (highest unit price) is the realistic cost for single-unit orders.
    let cost = ladder.length ? Math.max(...ladder.map((l) => l.price)) : null;

    if (!cost) {
      const range = price.productRangePrices || price.rangePrice || {};
      cost = parsePrice(range.dollarPriceRangeHigh ?? range.priceRangeHigh ?? range.dollarPriceRangeLow ?? range.priceRangeLow);
    }
    if (!cost) {
      for (const el of document.querySelectorAll('[class*="price"]')) {
        const m = el.textContent.match(/(?:US\s*)?\$\s*([\d,]+(?:\.\d+)?)/);
        if (m) { cost = parsePrice(m[1]); if (cost) break; }
      }
    }
    return { cost: cost || null, ladder };
  }

  function getOptionsAndVariants(product, baseCost, warnings) {
    const sku = product.sku || {};
    const attrs = sku.skuAttrs || sku.skuProps || sku.skuAttributes || [];

    let options = attrs
      .map((a) => ({
        id: a.id ?? a.attrId ?? a.propId,
        name: a.name || a.attrName || a.propName || 'Option',
        values: (a.values || a.attrValues || a.propValues || []).map((v) => ({
          id: v.id ?? v.valueId ?? v.propValueId,
          name: v.name || v.valueName || v.alias || v.propValueName || '',
          image: normalizeImageUrl(v.originImage || v.largeImage || v.bigImage || v.image || v.imageUrl || v.imgUrl)
        }))
      }))
      .filter((o) => o.values.length);

    if (options.length > MAX_OPTIONS) {
      warnings.push(`This product has ${options.length} option types; Shopify supports ${MAX_OPTIONS}. Only the first ${MAX_OPTIONS} were kept.`);
      options = options.slice(0, MAX_OPTIONS);
    }

    const optionNames = uniqueNames(options.map((o) => o.name), 'Option');
    options.forEach((o, i) => {
      o.name = optionNames[i];
      const valueNames = uniqueNames(o.values.map((v) => v.name), o.name);
      o.values.forEach((v, j) => { v.name = valueNames[j]; });
    });

    if (!options.length) {
      return { options: [], variants: [{ values: [], cost: baseCost, image: null }] };
    }

    // Index SKU info by a normalised "attr:value;attr:value" key.
    const infoMap = sku.skuInfoMap || sku.skuInfos || sku.skuMap || {};
    const infoIndex = new Map();
    const addInfo = (key, info) => {
      if (!key) return;
      const norm = String(key).split(/[;,]/).map((s) => s.trim()).filter(Boolean).sort().join(';');
      infoIndex.set(norm, info);
    };
    if (Array.isArray(infoMap)) {
      infoMap.forEach((info) => addInfo(info.skuAttr || info.skuPropIds || info.key, info));
    } else {
      Object.entries(infoMap).forEach(([k, info]) => addInfo(k, info));
    }

    let combos = cartesian(options.map((o) => o.values));
    if (combos.length > MAX_VARIANTS) {
      warnings.push(`${combos.length} variant combinations found; only the first ${MAX_VARIANTS} were kept.`);
      combos = combos.slice(0, MAX_VARIANTS);
    }

    const variants = combos.map((combo) => {
      const key = combo.map((v, i) => `${options[i].id}:${v.id}`).sort().join(';');
      const info = infoIndex.get(key);
      const cost = parsePrice(info?.price ?? info?.dollarPrice ?? info?.skuPrice ?? info?.salePrice ?? info?.priceInfo) || baseCost;
      return {
        values: combo.map((v) => v.name),
        cost,
        image: combo.find((v) => v.image)?.image || null
      };
    });

    return {
      options: options.map((o) => ({ name: o.name, values: o.values.map((v) => v.name) })),
      variants
    };
  }

  const NEGATIVE_VALUE = /^(no|none|n\/?a|null|not included|not available|without.*|0)$/i;

  const keywordList = (csv) => (csv || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  // Applies the specification rules; returns the cleaned value or null to drop the row.
  function cleanAttribute(name, value, nameKeywords, valueKeywords) {
    const lowerName = name.toLowerCase();
    if (nameKeywords.some((k) => lowerName.includes(k))) return null;
    if (NEGATIVE_VALUE.test(value)) return null;
    const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
    const items = parts
      .filter((item) => !valueKeywords.some((k) => item.toLowerCase().includes(k)))
      .filter((item) => !NEGATIVE_VALUE.test(item));
    if (items.length === parts.length) return value; // nothing removed – keep original formatting (e.g. "1,000 mAh")
    return items.length ? items.join(', ') : null;
  }

  function getAttributes(product, settings) {
    const nameKeywords = keywordList(settings.removeAttributes);
    const valueKeywords = keywordList(settings.removeValues);
    const rows = [];
    const seen = new Set();
    const add = (rawName, rawValue) => {
      const name = (rawName || '').toString().replace(/\s+/g, ' ').trim().replace(/:$/, '');
      const value = (rawValue || '').toString().replace(/\s+/g, ' ').trim();
      if (!name || !value || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      const cleaned = cleanAttribute(name, value, nameKeywords, valueKeywords);
      if (cleaned) rows.push([name, cleaned]);
    };

    for (const [key, value] of Object.entries(product)) {
      if (!/propert(y|ies)$/i.test(key) || !Array.isArray(value)) continue;
      for (const attr of value) add(attr.attrName || attr.name, attr.attrValue || attr.value);
    }
    if (!seen.size) {
      // DOM fallback: Alibaba "Key attributes" list
      document.querySelectorAll('[class*="attribute"] [class*="item"], .do-entry-item').forEach((el) => {
        add(el.querySelector('[class*="name"], .attr-name')?.textContent, el.querySelector('[class*="value"], .attr-value')?.textContent);
      });
    }
    const html = rows.length
      ? '<h3>Specifications</h3>\n<table>\n' +
        rows.map(([n, v]) => `  <tr><th>${escapeHtml(n)}</th><td>${escapeHtml(v)}</td></tr>`).join('\n') +
        '\n</table>'
      : '';
    return { rows, html };
  }

  function sanitizeHtml(html, keepImages) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,iframe,link,meta,noscript,object,embed,form,input,button,select,textarea,video,audio,svg,canvas')
      .forEach((n) => n.remove());
    doc.querySelectorAll('a').forEach((a) => a.replaceWith(...a.childNodes));
    doc.querySelectorAll('img').forEach((img) => {
      const src = normalizeImageUrl(img.getAttribute('data-src') || img.getAttribute('data-lazyload-src') || img.getAttribute('src'));
      if (!keepImages || !src) return img.remove();
      img.setAttribute('src', src);
    });
    const keep = { img: ['src', 'alt'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] };
    doc.body.querySelectorAll('*').forEach((el) => {
      const allowed = keep[el.tagName.toLowerCase()] || [];
      [...el.attributes].forEach((attr) => { if (!allowed.includes(attr.name)) el.removeAttribute(attr.name); });
    });
    if (keepImages) doc.querySelectorAll('img').forEach((img) => img.setAttribute('style', 'max-width:100%;height:auto;'));
    return doc.body.innerHTML.replace(/\n\s*\n/g, '\n').trim();
  }

  async function getSupplierDescription(raw, keepImages) {
    const url = deepFindString(raw, /desc.*url|url.*desc/i, /^(https?:)?\/\//i);
    if (url) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'FETCH_TEXT', url: url.startsWith('//') ? 'https:' + url : url });
        if (res?.ok && res.text) {
          let html = res.text;
          // Some endpoints return JSON/JSONP wrapping the HTML.
          const jsonStart = html.indexOf('{');
          if (!/^\s*</.test(html) && jsonStart !== -1) {
            try {
              const obj = JSON.parse(html.slice(jsonStart, html.lastIndexOf('}') + 1));
              let best = '';
              deepFind(obj, (o) => {
                for (const v of Object.values(o)) if (typeof v === 'string' && v.includes('<') && v.length > best.length) best = v;
                return false;
              });
              html = best;
            } catch (_) { /* treat as HTML */ }
          }
          const clean = html ? sanitizeHtml(html, keepImages) : '';
          if (clean.replace(/<[^>]+>/g, '').trim().length > 20 || (keepImages && clean.includes('<img'))) return clean;
        }
      } catch (_) { /* fall through to DOM */ }
    }

    const selectors = ['#product-description', '.detail-desc-decorate-richtext', '[class*="description-layout"]', '[data-module-name*="description" i]', '.richtext'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerHTML.length > 200) return sanitizeHtml(el.innerHTML, keepImages);
    }
    return '';
  }

  // ---------- public ----------

  async function scrape(settings) {
    const warnings = [];
    const raw = await requestPageData();
    const product = findProduct(raw);
    if (!Object.keys(product).length) {
      warnings.push('Could not read Alibaba\'s structured product data; some fields were read from the page and may be incomplete.');
    }

    const title = getTitle(product);
    const images = getImages(product);
    const { cost, ladder } = getCost(product);
    const { options, variants } = getOptionsAndVariants(product, cost, warnings);
    const specs = getAttributes(product, settings);
    // The supplier's text is also fetched when AI writes the description, as source material.
    const supplierHtml = settings.includeSupplierDescription || settings.aiDescription
      ? await getSupplierDescription(raw, settings.includeDescriptionImages)
      : '';
    const supplierText = supplierHtml
      ? new DOMParser().parseFromString(supplierHtml.replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)\b[^>]*>/gi, '$&\n'), 'text/html')
        .body.textContent.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
      : '';

    if (!images.length) warnings.push('No product images were found.');
    if (!cost) warnings.push('Could not detect the Alibaba price – enter prices manually.');

    return {
      sourceUrl: location.href.split(/[?#]/)[0],
      title,
      images,
      cost,
      ladder,
      options,
      variants,
      specRows: specs.rows,
      specsHtml: specs.html,
      supplierText,
      // Without AI: specs table + supplier description (if enabled). With AI this is only the fallback.
      descriptionHtml: [specs.html, settings.includeSupplierDescription && !settings.aiDescription ? supplierHtml : '']
        .filter(Boolean).join('\n\n'),
      warnings
    };
  }

  return { scrape };
})();
