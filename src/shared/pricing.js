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
      title: data.title,
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

  return { roundPrice, ruleFromSettings, priceFor, compareAtFor, splitLines, productIdFromUrl, buildAutoPayload, aiKeyFor };
})();
