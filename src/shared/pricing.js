// Pricing rules and payload building shared by the import panel and the bulk-import bot.
globalThis.ImportifyPricing = (() => {
  function roundPrice(p, to99) {
    if (!(p > 0)) return '';
    if (to99) return (Math.max(1, Math.ceil(p)) - 0.01).toFixed(2);
    return (Math.round(p * 100) / 100).toFixed(2);
  }

  function ruleFromSettings(settings) {
    return {
      mode: settings.priceMode,
      value: settings.priceValue,
      compareAtMode: settings.compareAtMode,
      compareAt: settings.compareAtValue,
      round: settings.roundTo99
    };
  }

  function priceFor(cost, rule) {
    const v = parseFloat(rule.value);
    if (!(v > 0)) return '';
    if (rule.mode === 'fixed') return roundPrice(v, rule.round);
    if (!(cost > 0)) return '';
    return roundPrice(rule.mode === 'multiplier' ? cost * v : cost + v, rule.round);
  }

  function compareAtFor(price, rule) {
    const v = parseFloat(rule.compareAt);
    const p = parseFloat(price);
    if (!(v > 0) || !(p > 0)) return '';
    if (rule.compareAtMode === 'fixed') return v > p ? roundPrice(v, false) : '';
    return v > 1 ? roundPrice(p * v, rule.round) : '';
  }

  const splitLines = (text) => (text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const splitCommas = (text) => (text || '').split(',').map((s) => s.trim()).filter(Boolean);

  // Alibaba product ID from a product URL (…_1600123456789.html or /product/1600123456789-…)
  function productIdFromUrl(url) {
    const match = String(url || '').match(/(?:_|\/product\/)(\d{8,})/) || String(url || '').match(/(\d{10,})/);
    return match ? match[1] : null;
  }

  // Builds a Shopify payload from scraped data using the saved settings (no manual edits).
  // `extra` can override the description and the collection titles.
  function buildAutoPayload(data, settings, extra = {}) {
    if (!data.title) throw new Error('No title found');
    const rule = ruleFromSettings(settings);
    const variants = data.variants.map((v) => {
      const price = priceFor(v.cost, rule);
      if (!price) throw new Error('Could not determine a price (no Alibaba price found)');
      const compareAt = compareAtFor(price, rule);
      return {
        values: v.values,
        price,
        compareAtPrice: compareAt || null,
        cost: settings.saveCost && v.cost ? Number(v.cost).toFixed(2) : null,
        image: v.image
      };
    });
    return {
      title: extra.title || data.title,
      descriptionHtml: extra.descriptionHtml ?? data.descriptionHtml,
      vendor: (settings.vendor || '').trim(),
      productType: (settings.productType || '').trim(),
      tags: splitCommas(settings.tags),
      status: settings.status,
      images: data.images,
      options: data.options,
      variants,
      collections: extra.collections ?? splitLines(settings.collections),
      sourceUrl: data.sourceUrl,
      publishOnline: settings.publishOnline
    };
  }

  // The API key for the selected AI provider ('' when none is set).
  function aiKeyFor(settings) {
    return ((settings.aiProvider === 'openai' ? settings.openaiApiKey : settings.anthropicApiKey) || '').trim();
  }

  // ---------- blocked words (wholesale, bulk, …) ----------

  // Comma-separated words/phrases from settings. Whole-word, case-insensitive; works for Bangla too.
  function blockedWords(settings) {
    const list = splitCommas(settings?.blockedWords ?? globalThis.IMPORTIFY_DEFAULTS?.blockedWords);
    return list.sort((a, b) => b.length - a.length); // longest first: "wholesale price" before "wholesale"
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function blockedRegex(words) {
    if (!words.length) return null;
    const body = words.map((w) => escapeRe(w).replace(/\s+/g, '[\\s-]+')).join('|');
    // Letters/marks/digits around the match mean it's part of a longer word ("bulky" stays).
    return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${body})(?![\\p{L}\\p{M}\\p{N}])`, 'giu');
  }

  // Tidies what's left after removing words: doubled spaces/separators, dangling "for"/"and", empty brackets.
  function tidy(text) {
    let t = text;
    for (let i = 0; i < 3; i++) {
      t = t
        .replace(/\(\s*\)|\[\s*\]/g, ' ')
        .replace(/\s+([,;:.!?।])/g, '$1')
        .replace(/([,;:/|\-–—])(\s*[,;:/|\-–—])+/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^[\s,;:/|\-–—]+|[\s,;:/|\-–—]+$/g, '')
        .replace(/(?:^|\s)(?:for|and|with|or|of|in|to|&)\s*$/i, '')
        .replace(/^\s*(?:for|and|with|or|of|&)\s+/i, '');
    }
    return t.trim();
  }

  // Title: just remove the words.
  function cleanTitle(title, settings) {
    const re = blockedRegex(blockedWords(settings));
    if (!re || !title) return title || '';
    return tidy(String(title).replace(re, ' ')).replace(/\s+/g, ' ');
  }

  // Description HTML: text only (tags, links and image URLs untouched). A sentence that mentions a
  // blocked word ("We accept bulk orders.") is dropped; in short fragments only the word is removed.
  function cleanHtml(html, settings) {
    const re = blockedRegex(blockedWords(settings));
    if (!re || !html) return html || '';
    const has = (s) => { re.lastIndex = 0; return re.test(s); };

    let out = String(html).split(/(<[^>]*>)/).map((part) => {
      if (part.startsWith('<') || !has(part)) return part;
      const sentences = part.split(/(?<=[.!?।])\s+/);
      if (sentences.length > 1 || part.trim().split(/\s+/).length > 8) {
        const kept = sentences.filter((s) => !has(s));
        const joined = kept.join(' ');
        return joined.trim() ? joined : '';
      }
      const lead = part.match(/^\s*/)[0];
      const trail = part.match(/\s*$/)[0];
      const rest = tidy(part.replace(re, ' '));
      // "Custom logo available" → "available" says nothing; drop fragments that lose their meaning.
      const before = part.trim().split(/\s+/).length;
      const after = rest ? rest.split(/\s+/).length : 0;
      if (after < 2 && before > after) return '';
      return lead + rest + trail;
    }).join('');

    // Remove elements left empty, and spec rows whose name was removed.
    for (let i = 0; i < 2; i++) {
      out = out
        .replace(/<tr>\s*<th>\s*<\/th>[\s\S]*?<\/tr>\s*/gi, '')
        .replace(/<tr>\s*<th>[^<]*<\/th>\s*<td>\s*<\/td>\s*<\/tr>\s*/gi, '')
        .replace(/<(li|p|h[1-6]|strong|b|em|span)(\s[^>]*)?>\s*<\/\1>\s*/gi, '')
        .replace(/<ul(\s[^>]*)?>\s*<\/ul>\s*/gi, '');
    }
    return out.trim();
  }

  return { roundPrice, ruleFromSettings, priceFor, compareAtFor, splitLines, productIdFromUrl, buildAutoPayload, aiKeyFor, blockedWords, cleanTitle, cleanHtml };
})();
