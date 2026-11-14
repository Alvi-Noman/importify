// Service worker: talks to the Shopify Admin GraphQL API on behalf of the content script.
importScripts('shared/defaults.js', 'shared/pricing.js');

const DEFAULTS = globalThis.IMPORTIFY_DEFAULTS;

// ---------- settings & auth ----------

// Reads KEY=VALUE pairs from the .env file in the extension folder (missing file → {}).
async function loadEnv() {
  try {
    const res = await fetch(chrome.runtime.getURL('.env'), { cache: 'no-store' });
    if (!res.ok) return {};
    const env = {};
    for (const line of (await res.text()).split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    return env;
  } catch (_) {
    return {};
  }
}

// Saved settings over defaults; AI keys left empty in Settings fall back to .env.
async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  const settings = { ...DEFAULTS, ...stored };
  const env = await loadEnv();
  settings.openaiApiKey ||= env.OPENAI_API_KEY || '';
  settings.anthropicApiKey ||= env.ANTHROPIC_API_KEY || '';
  settings.openaiModel = (stored.openaiModel || '').trim() || env.OPENAI_MODEL || DEFAULTS.openaiModel;
  return settings;
}

function normalizeShop(input) {
  let shop = (input || '').trim().toLowerCase();
  shop = shop.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const adminMatch = (input || '').match(/admin\.shopify\.com\/store\/([^/?#]+)/i);
  if (adminMatch) shop = adminMatch[1].toLowerCase();
  if (shop && !shop.includes('.')) shop += '.myshopify.com';
  // Common typo: "store.shopify.com" instead of "store.myshopify.com"
  shop = shop.replace(/^([a-z0-9-]+)\.shopify\.com$/, '$1.myshopify.com');
  if (shop && !/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    throw new Error(`"${shop}" isn't a .myshopify.com domain. Use your-store.myshopify.com (see the address bar in your Shopify admin: admin.shopify.com/store/your-store).`);
  }
  return shop;
}

async function getAccessToken(settings, shop) {
  if (settings.authMode !== 'client') {
    if (!settings.accessToken) throw new Error('No Shopify access token set. Open the Importify settings.');
    return settings.accessToken.trim();
  }

  if (!settings.clientId || !settings.clientSecret) {
    throw new Error('Client ID and secret are required. Open the Importify settings.');
  }

  const { tokenCache } = await chrome.storage.session.get('tokenCache');
  if (tokenCache && tokenCache.shop === shop && tokenCache.clientId === settings.clientId && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  // Client credentials grant (apps created in the Shopify Dev Dashboard and installed on your own store).
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: settings.clientId.trim(),
      client_secret: settings.clientSecret.trim()
    })
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  if (!res.ok || !json.access_token) {
    throw new Error(`Could not get an access token (${res.status}): ${json.error_description || json.error || text.slice(0, 200)}`);
  }

  const expiresIn = Number(json.expires_in) || 3600;
  await chrome.storage.session.set({
    tokenCache: { shop, clientId: settings.clientId, token: json.access_token, expiresAt: Date.now() + expiresIn * 1000 }
  });
  return json.access_token;
}

async function shopifyGraphQL(query, variables = {}, attempt = 0) {
  const settings = await getSettings();
  const shop = normalizeShop(settings.shop);
  if (!shop) throw new Error('No Shopify store set. Open the Importify settings.');
  const token = await getAccessToken(settings, shop);

  const res = await fetch(`https://${shop}/admin/api/${settings.apiVersion || DEFAULTS.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables })
  });

  if (res.status === 401 && settings.authMode === 'client' && attempt === 0) {
    await chrome.storage.session.remove('tokenCache');
    return shopifyGraphQL(query, variables, attempt + 1);
  }
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    return shopifyGraphQL(query, variables, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    if (json.errors.some((e) => e.extensions?.code === 'THROTTLED') && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return shopifyGraphQL(query, variables, attempt + 1);
    }
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  return { data: json.data, shop };
}

// ---------- product creation ----------

const PRODUCT_SET = `
  mutation ImportifyProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product {
        id title handle
        variants(first: 250) { nodes { sku } }
      }
      userErrors { field message code }
    }
  }`;

const PUBLICATIONS = `
  query ImportifyPublications {
    publications(first: 50) { nodes { id catalog { title } } }
  }`;

const PUBLISH = `
  mutation ImportifyPublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }`;

const COLLECTIONS = `
  query ImportifyCollections($after: String) {
    collections(first: 250, after: $after) {
      nodes { id title ruleSet { appliedDisjunctively } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

async function fetchAllCollections() {
  const all = [];
  let after = null;
  do {
    const { data } = await shopifyGraphQL(COLLECTIONS, { after });
    all.push(...data.collections.nodes);
    after = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (after);
  return all;
}

const normTitle = (t) => t.replace(/[‘’`´]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

// Resolves collection titles to IDs. Throws if any are missing or are smart (automated) collections.
async function resolveCollections(titles) {
  if (!titles?.length) return [];
  const all = await fetchAllCollections();
  const ids = [];
  const missing = [];
  const smart = [];
  for (const title of titles) {
    const match = all.find((c) => normTitle(c.title) === normTitle(title));
    if (!match) missing.push(title);
    else if (match.ruleSet) smart.push(title);
    else ids.push(match.id);
  }
  if (missing.length) throw new Error(`Collection not found in Shopify: ${missing.map((t) => `"${t}"`).join(', ')}. Check the exact titles in Importify settings.`);
  if (smart.length) throw new Error(`${smart.map((t) => `"${t}"`).join(', ')} is an automated (smart) collection; products can't be added to it manually. Remove it from settings or make it a manual collection.`);
  return ids;
}

// ---------- SKUs ----------
// Modern SKU format: TYPE-CODE[-OPT1[-OPT2[-OPT3]]], e.g. HDP-7K2MQX-RED-XL
//   TYPE  3-letter product type code ("Headphones" → HDP)
//   CODE  6-char product code derived from the Alibaba ID (same product → same code), Crockford
//         base32 so it never contains the look-alike letters I, L, O, U
//   OPT   short standard codes per option value (Black → BLK, Extra Large → XL, 128GB → 128GB)
// Uppercase A–Z/0–9 and hyphens only; no spaces, no supplier IDs exposed.

const SKU_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const SKU_COLORS = {
  black: 'BLK', white: 'WHT', red: 'RED', blue: 'BLU', navy: 'NVY', 'navy blue': 'NVY', 'sky blue': 'SKY',
  'light blue': 'LBL', 'dark blue': 'DBL', 'royal blue': 'RBL', green: 'GRN', 'dark green': 'DGN', 'light green': 'LGN',
  'army green': 'ARM', olive: 'OLV', yellow: 'YLW', orange: 'ORG', pink: 'PNK', 'light pink': 'LPK', 'hot pink': 'HPK',
  purple: 'PUR', violet: 'VIO', brown: 'BRN', 'dark brown': 'DBR', beige: 'BGE', khaki: 'KHK', grey: 'GRY', gray: 'GRY',
  'dark grey': 'DGY', 'dark gray': 'DGY', 'light grey': 'LGY', 'light gray': 'LGY', silver: 'SLV', gold: 'GLD',
  'rose gold': 'RGD', transparent: 'CLR', clear: 'CLR', multicolor: 'MLT', multicolour: 'MLT', 'multi color': 'MLT',
  'multi colour': 'MLT', camel: 'CML', burgundy: 'BUR', wine: 'WIN', 'wine red': 'WIN', coffee: 'COF', cream: 'CRM',
  ivory: 'IVR', teal: 'TEL', cyan: 'CYN', apricot: 'APR', champagne: 'CHP', mint: 'MNT', 'mint green': 'MNT',
  lavender: 'LAV', rose: 'RSE', 'rose red': 'RSR', maroon: 'MRN', turquoise: 'TRQ', fuchsia: 'FUC', coral: 'CRL',
  tan: 'TAN', charcoal: 'CHR', natural: 'NAT', wood: 'WOD', bronze: 'BRZ', copper: 'CPR'
};

const SKU_SIZES = {
  'extra small': 'XS', small: 'S', medium: 'M', large: 'L', 'extra large': 'XL',
  'one size': 'OS', 'free size': 'OS', freesize: 'OS', 'one-size': 'OS'
};

const SKU_NOISE = new Set(['new', 'hot', 'sale', 'best', 'top', 'high', 'quality', 'custom', 'wholesale', 'factory',
  'cheap', 'premium', 'professional', 'portable', 'mini', 'set', 'pcs', 'piece', 'pieces', 'pack', 'style', 'design',
  'fashion', 'product', 'products', 'item', 'oem', 'odm', 'logo', 'supplier']);

const skuClean = (str) => String(str ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/(\d)[.,](\d)/g, '$1p$2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// "headphones" → HDP, "bottle" → BTL, "mug" → MUG: first letter + following consonants.
function skuAbbr(word, len = 3) {
  const w = word.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (w.length <= len) return w;
  let out = w[0];
  for (const ch of w.slice(1)) {
    if (out.length >= len) break;
    if (!'AEIOU'.includes(ch) && ch !== out[out.length - 1]) out += ch;
  }
  for (const ch of w.slice(1)) { if (out.length >= len) break; if (!out.includes(ch)) out += ch; }
  return out.slice(0, len);
}

// Product type code from the Shopify product type, else the main noun of the title.
function skuTypeCode(p) {
  const source = skuClean(p.productType) || skuClean(String(p.title || '').split(/\b(?:with|for|and|in|of|to|by)\b|[,|(/]|\s[-–—]\s/i)[0].replace(/(\w)-(\w)/g, '$1$2'));
  const words = source.split(' ').filter((w) => /^[a-z]{3,}$/.test(w) && !SKU_NOISE.has(w));
  return words.length ? skuAbbr(words[words.length - 1]) : 'PRD';
}

// 6-char product code: FNV-1a hash of the Alibaba ID (stable), or of title + time when there's no ID.
function skuProductCode(p) {
  const id = globalThis.ImportifyPricing.productIdFromUrl(p.sourceUrl);
  const seed = id || `${p.title || ''}|${Date.now()}|${Math.random()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let code = '';
  for (let i = 0; i < 6; i++) { code += SKU_ALPHABET[h % 32]; h = Math.floor(h / 32); }
  return code;
}

// Option value → short code, e.g.
//   Black → BLK · Matte Black → MBLK · Extra Large → XL · 2XL → 2XL · 750 ML → 750ML
//   iPhone 15 Pro Max → I15PM · EU 42 → EU42 · Leather → LTH · With Charger → WC
function skuOptionCode(value) {
  const v = skuClean(value);
  if (!v) return '';
  if (SKU_COLORS[v]) return SKU_COLORS[v];
  if (SKU_SIZES[v]) return SKU_SIZES[v];
  const compact = v.replace(/ /g, '').toUpperCase();
  if (/^(X{0,4}S|M|X{0,4}L|\dX{1,2}L|\dXS)$/.test(compact)) return compact;
  if (/^\d+(\.\d+)?\s?[a-z]{1,4}$/.test(v)) return compact.slice(0, 8); // 750 ML → 750ML, 1.5L → 1P5L
  const words = v.split(' ');
  if (words.length === 1) return /\d/.test(v) ? compact.slice(0, 8) : skuAbbr(v);
  // "matte black" → modifier initials + colour code
  const colourAt = words.findIndex((w, i) => SKU_COLORS[words.slice(i).join(' ')]);
  if (colourAt > 0) return (words.slice(0, colourAt).map((w) => w[0]).join('') + SKU_COLORS[words.slice(colourAt).join(' ')]).toUpperCase().slice(0, 6);
  // Words with digits and 1–2 letter words (EU, S24) stay whole; other words become initials.
  return words.map((w) => (/\d/.test(w) || w.length <= 2 ? w : w[0])).join('').toUpperCase().slice(0, 8);
}

// One unique SKU per variant. A SKU already set on a variant (v.sku) is kept if it's unique.
function generateSkus(p) {
  const base = `${skuTypeCode(p)}-${skuProductCode(p)}`;
  if (p.variants.length <= 1) return p.variants.map((v) => (v.sku || '').trim() || base);

  const counts = {};
  p.variants.forEach((v) => { const s = (v.sku || '').trim(); if (s) counts[s] = (counts[s] || 0) + 1; });

  const used = new Set();
  return p.variants.map((v, i) => {
    const own = (v.sku || '').trim();
    if (own && counts[own] === 1 && !used.has(own)) { used.add(own); return own; }

    const parts = (v.values || []).map(skuOptionCode).filter(Boolean);
    const candidate = `${base}-${parts.length ? parts.join('-') : String(i + 1).padStart(2, '0')}`;
    let sku = candidate;
    for (let n = 2; used.has(sku); n++) sku = `${candidate}-${n}`;
    used.add(sku);
    return sku;
  });
}

function buildProductSetInput(p, collectionIds = []) {
  const imageUrls = [...new Set([...p.images, ...p.variants.map((v) => v.image).filter(Boolean)])];
  const hasOptions = p.options.length > 0;
  const skus = generateSkus(p);

  const productOptions = hasOptions
    ? p.options.map((o, i) => ({ name: o.name, position: i + 1, values: o.values.map((name) => ({ name })) }))
    : [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }];

  const variants = p.variants.map((v, idx) => {
    const variant = {
      optionValues: hasOptions
        ? v.values.map((name, i) => ({ optionName: p.options[i].name, name }))
        : [{ optionName: 'Title', name: 'Default Title' }],
      price: v.price,
      inventoryItem: { tracked: false, sku: skus[idx] }
    };
    if (v.compareAtPrice) variant.compareAtPrice = v.compareAtPrice;
    if (v.cost) variant.inventoryItem.cost = v.cost;
    if (v.image && hasOptions) variant.file = { originalSource: v.image, contentType: 'IMAGE', alt: v.values.join(' / ') };
    return variant;
  });

  const input = {
    title: p.title,
    descriptionHtml: p.descriptionHtml || '',
    status: p.status === 'ACTIVE' ? 'ACTIVE' : 'DRAFT',
    productOptions,
    variants,
    files: imageUrls.map((url) => ({ originalSource: url, contentType: 'IMAGE', alt: p.title.slice(0, 250) }))
  };
  if (p.vendor) input.vendor = p.vendor;
  if (p.productType) input.productType = p.productType;
  if (p.tags?.length) input.tags = p.tags;
  if (collectionIds.length) input.collections = collectionIds;
  if (p.sourceUrl) {
    input.metafields = [{ namespace: 'importify', key: 'source_url', type: 'url', value: p.sourceUrl }];
  }
  return input;
}

async function publishToOnlineStore(productId) {
  const { data } = await shopifyGraphQL(PUBLICATIONS);
  const online = data.publications.nodes.find((n) => /online store/i.test(n.catalog?.title || ''));
  if (!online) throw new Error('Online Store sales channel not found.');
  const { data: pub } = await shopifyGraphQL(PUBLISH, { id: productId, input: [{ publicationId: online.id }] });
  const errors = pub.publishablePublish.userErrors;
  if (errors.length) throw new Error(errors.map((e) => e.message).join('; '));
}

async function createProduct(payload) {
  // The panel's collection picker sends IDs; the bot sends titles.
  const collectionIds = payload.collectionIds?.length ? payload.collectionIds : await resolveCollections(payload.collections);

  // Final pass: no "wholesale", "bulk", … in what reaches Shopify (covers manual edits and the bot).
  const settings = await getSettings();
  const cleanTitle = globalThis.ImportifyPricing.cleanTitle(payload.title, settings);
  payload = {
    ...payload,
    title: cleanTitle.length >= 3 ? cleanTitle : payload.title,
    descriptionHtml: globalThis.ImportifyPricing.cleanHtml(payload.descriptionHtml, settings)
  };

  const input = buildProductSetInput(payload, collectionIds);
  const { data, shop } = await shopifyGraphQL(PRODUCT_SET, { input, synchronous: true });
  const result = data.productSet;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => `${(e.field || []).join('.')}: ${e.message}`).join('; '));
  }

  const product = result.product;
  const warnings = [];

  // Verify Shopify actually stored a SKU on every variant.
  const saved = product.variants?.nodes || [];
  const missing = saved.filter((v) => !v.sku).length;
  if (missing) warnings.push(`${missing} of ${saved.length} variant(s) were saved without a SKU.`);
  if (payload.publishOnline) {
    try {
      await publishToOnlineStore(product.id);
    } catch (err) {
      warnings.push(`Product created, but publishing to the Online Store failed: ${err.message} (needs the read_publications and write_publications scopes).`);
    }
  }

  const numericId = product.id.split('/').pop();
  const adminUrl = `https://${shop}/admin/products/${numericId}`;
  await rememberImport(payload.sourceUrl, adminUrl);
  return { ok: true, product, warnings, adminUrl };
}

// Manual collections only: products can't be added to automated (smart) collections by hand.
async function listCollections() {
  const all = await fetchAllCollections();
  return all
    .filter((c) => !c.ruleSet)
    .map((c) => ({ id: c.id, title: c.title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

// ---------- AI description (Claude) ----------

const CLAUDE_MODEL = 'claude-opus-5-5';

const DESCRIPTION_SYSTEM = `You write product descriptions for an online store's Shopify product pages. The store resells products sourced from Alibaba suppliers, so the source material is messy: the supplier's text often talks about the factory, the company or other products instead of this one.

Write a description that helps a shopper decide to buy this product.

Output format: HTML only (no Markdown, no code fences, no text before or after the HTML), except that when the request asks for a title, the very first line is the title (see below):
<p>An opening paragraph of 2–3 sentences about the product and who it's for.</p>
<h3>Key Features</h3>
<ul><li>4–7 short, concrete feature bullets</li></ul>
Do not add a specifications table; the store appends its own below your text.

Rules:
- Use only facts present in the title, options, specifications or supplier text. Never invent materials, measurements, certifications, warranties or performance claims.
- Leave out everything about the supplier: company history, factory, employees, markets, MOQ, OEM/ODM, samples, mould making, customization, shipping, payment, lead times, contact details, and "why choose us" text.
- Don't mention Alibaba, suppliers, wholesale, prices, boxes or packaging.
- If the supplier text describes other products, ignore it and rely on the title, options and specifications.
- Write everything, including the "Key Features" heading, in the language the request asks for. Keep brand names, model numbers and units (mm, g, BAR) as they are.

Title (only when the request asks for one): put it on the first line as "TITLE: <title>", then the HTML on the next line.
- A clean store product title, 40–80 characters, Title Case, in the requested language.
- Structure: [Brand, only if a real brand is in the source] + product type + 1–3 key attributes (material, size, feature, audience). Example: "Poedagar Men's Quartz Watch, Waterproof Luminous Stainless Steel".
- No keyword stuffing or repeated words, no years, no "New Arrival", "Hot Sale", "Best", "Top", "High Quality", no ALL CAPS (except brand names and model codes), no emojis, no quotes.
- Never invent a brand; never use "Generic" or "Unbranded".`;

// Splits the AI output into an optional "TITLE: …" first line and the HTML description.
function parseAiOutput(text) {
  let rest = String(text || '').replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let title = null;
  const m = rest.match(/^\s*(?:\*\*)?TITLE:?(?:\*\*)?\s*(.+?)\s*(?:\r?\n|$)/i);
  if (m) {
    title = m[1].replace(/<[^>]+>/g, '').replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 255) || null;
    rest = rest.slice(m[0].length).trim();
  }
  return { title, html: rest };
}

function describeProductForPrompt(p, instructions, language, wantTitle) {
  const parts = [`Product title: ${p.title}`];
  if (wantTitle) parts.push('Also write a new product title (first line, "TITLE: …").');
  if (p.options?.length) {
    parts.push('Options:\n' + p.options.map((o) => `- ${o.name}: ${o.values.join(', ')}`).join('\n'));
  }
  if (p.specRows?.length) {
    parts.push('Specifications:\n' + p.specRows.map(([n, v]) => `- ${n}: ${v}`).join('\n'));
  }
  if (p.supplierText) {
    parts.push(`Supplier's description (raw; may contain irrelevant factory or company text):\n<supplier_text>\n${p.supplierText}\n</supplier_text>`);
  }
  if (instructions?.trim()) parts.push(`Store's instructions for the writer:\n${instructions.trim()}`);
  parts.push(`Write the ${wantTitle ? 'title and description' : 'description'} in: ${(language || '').trim() || 'English'}`);
  return parts.join('\n\n');
}

async function callClaude(apiKey, body, attempt = 0) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey.trim(),
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });

  // Rate limits, overload and server errors are worth retrying.
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    const wait = (Number(res.headers.get('retry-after')) || 2 ** attempt * 3) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
    return callClaude(apiKey, body, attempt + 1);
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error(`Claude API key was rejected (${message}). Check it in Importify settings.`);
    throw new Error(`Claude API error: ${message}`);
  }
  return json;
}

// Returns the full description HTML: AI-written intro + features, followed by the specs table.
async function writeWithClaude(settings, prompt) {
  const message = await callClaude(settings.anthropicApiKey, {
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    fallbacks: 'default',
    system: DESCRIPTION_SYSTEM,
    messages: [{ role: 'user', content: prompt }]
  });
  if (message.stop_reason === 'refusal') throw new Error('Claude declined to write this description.');
  if (message.stop_reason === 'max_tokens') throw new Error('The AI description was cut off.');
  return { text: (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), model: message.model || CLAUDE_MODEL };
}

async function writeWithOpenAI(settings, prompt, attempt = 0) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.openaiApiKey.trim()}` },
    body: JSON.stringify({
      model: (settings.openaiModel || '').trim() || globalThis.IMPORTIFY_DEFAULTS.openaiModel,
      max_completion_tokens: 8000,
      messages: [
        { role: 'system', content: DESCRIPTION_SYSTEM },
        { role: 'user', content: prompt }
      ]
    })
  });
  const json = await res.json().catch(() => ({}));

  // Rate limits and server errors are worth retrying – but not an exhausted quota.
  const quota = json.error?.code === 'insufficient_quota';
  if ((res.status === 429 || res.status >= 500) && !quota && attempt < 3) {
    const wait = (Number(res.headers.get('retry-after')) || 2 ** attempt * 3) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
    return writeWithOpenAI(settings, prompt, attempt + 1);
  }
  if (!res.ok) {
    const message = json.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error(`OpenAI API key was rejected (${message}). Check it in Importify settings.`);
    if (quota) throw new Error(`OpenAI API key has no credit left (${message}). Add billing at platform.openai.com.`);
    throw new Error(`OpenAI API error: ${message}`);
  }

  const choice = json.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`OpenAI declined to write this description: ${choice.message.refusal}`);
  if (choice?.finish_reason === 'length') throw new Error('The AI description was cut off.');
  return { text: choice?.message?.content || '', model: json.model || settings.openaiModel };
}

// Returns the full description HTML: AI-written intro + features, followed by the specs table.
async function generateDescription(product) {
  const settings = await getSettings();
  const openai = settings.aiProvider === 'openai';
  if (!globalThis.ImportifyPricing.aiKeyFor(settings)) {
    throw new Error(`No ${openai ? 'OpenAI' : 'Claude'} API key set. Add it to the .env file (then reload the extension) or in Importify settings.`);
  }

  const blocked = globalThis.ImportifyPricing.blockedWords(settings);
  const instructions = [settings.aiInstructions, blocked.length ? `Never use these words or phrases (or translations of them): ${blocked.join(', ')}.` : '']
    .filter((s) => s && s.trim()).join('\n');
  const wantTitle = settings.aiTitle !== false;
  const prompt = describeProductForPrompt(product, instructions, settings.aiLanguage, wantTitle);
  const { text, model } = openai ? await writeWithOpenAI(settings, prompt) : await writeWithClaude(settings, prompt);
  const parsed = parseAiOutput(text);
  if (!parsed.html) throw new Error('The AI returned an empty description.');

  // Title: cleaned of blocked words; ignored if the AI's attempt is unusably short.
  let title = wantTitle && parsed.title ? globalThis.ImportifyPricing.cleanTitle(parsed.title, settings) : null;
  if (title && title.length < 10) title = null;

  return {
    html: globalThis.ImportifyPricing.cleanHtml([parsed.html, product.specsHtml].filter(Boolean).join('\n\n'), settings),
    title,
    model
  };
}

// ---------- import history (used by the bot to skip products already in Shopify) ----------

async function rememberImport(sourceUrl, adminUrl) {
  const id = globalThis.ImportifyPricing.productIdFromUrl(sourceUrl);
  if (!id) return;
  const { importedIds = {} } = await chrome.storage.local.get('importedIds');
  importedIds[id] = adminUrl;
  await chrome.storage.local.set({ importedIds });
  // Keep the duplicate-check cache current without rescanning Shopify.
  const { shopifyIdsCache } = await chrome.storage.session.get('shopifyIdsCache');
  if (shopifyIdsCache) {
    shopifyIdsCache.ids[id] = adminUrl;
    await chrome.storage.session.set({ shopifyIdsCache });
  }
}

// Alibaba product IDs of products that are in Shopify right now (deleted ones aren't), cached for 10 minutes.
async function shopifyImportedIds(fresh = false) {
  const { shopifyIdsCache } = await chrome.storage.session.get('shopifyIdsCache');
  if (!fresh && shopifyIdsCache && shopifyIdsCache.at > Date.now() - 10 * 60_000) return shopifyIdsCache.ids;
  const ids = {};
  let after = null;
  do {
    const { data, shop } = await shopifyGraphQL(SOURCE_URLS, { after });
    for (const node of data.products.nodes) {
      const id = globalThis.ImportifyPricing.productIdFromUrl(node.metafield?.value);
      if (id && !ids[id]) ids[id] = `https://${shop}/admin/products/${node.id.split('/').pop()}`;
    }
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);
  await chrome.storage.session.set({ shopifyIdsCache: { at: Date.now(), ids } });
  return ids;
}

// For the import panel: is this Alibaba product already in the Shopify store?
async function checkImported(sourceUrl) {
  const id = globalThis.ImportifyPricing.productIdFromUrl(sourceUrl);
  if (!id) return { imported: false };
  const ids = await shopifyImportedIds();
  return ids[id] ? { imported: true, adminUrl: ids[id] } : { imported: false };
}

const SOURCE_URLS = `
  query ImportifySourceUrls($after: String) {
    products(first: 250, after: $after) {
      nodes { id metafield(namespace: "importify", key: "source_url") { value } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

// Alibaba product IDs already imported: local history merged with what's actually in Shopify.
async function getImportedIds() {
  const { importedIds = {} } = await chrome.storage.local.get('importedIds');
  return { ...(await shopifyImportedIds(true)), ...importedIds };
}

// ---------- messaging ----------

async function handle(message) {
  switch (message?.type) {
    case 'CREATE_PRODUCT':
      return createProduct(message.payload);

    case 'TEST_CONNECTION': {
      const { data, shop } = await shopifyGraphQL('{ shop { name currencyCode } }');
      const settings = await getSettings();
      const titles = (settings.collections || '').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
      let collectionError = null;
      try { await resolveCollections(titles); } catch (err) { collectionError = err.message; }
      return { ok: true, shop, name: data.shop.name, currency: data.shop.currencyCode, collections: titles.length, collectionError };
    }

    case 'FETCH_TEXT': {
      const url = new URL(message.url);
      if (!/(^|\.)(alibaba\.com|alicdn\.com)$/i.test(url.hostname)) throw new Error('Host not allowed');
      const res = await fetch(url.href, { credentials: 'omit' });
      return { ok: res.ok, text: res.ok ? await res.text() : '' };
    }

    case 'LIST_COLLECTIONS':
      return { ok: true, collections: await listCollections() };

    // Whether an AI key is available (from Settings or .env), so the panel knows to auto-write.
    case 'AI_STATUS': {
      const settings = await getSettings();
      return { ok: true, enabled: !!settings.aiDescription, hasKey: !!globalThis.ImportifyPricing.aiKeyFor(settings), provider: settings.aiProvider };
    }

    case 'GENERATE_DESCRIPTION':
      return { ok: true, ...(await generateDescription(message.product)) };

    case 'GET_IMPORTED_IDS':
      return { ok: true, ids: await getImportedIds() };

    case 'CHECK_IMPORTED':
      return { ok: true, ...(await checkImported(message.sourceUrl)) };

    // Timers in a background tab get throttled to once a minute; the service worker's don't.
    case 'SLEEP':
      await new Promise((r) => setTimeout(r, Math.min(Number(message.ms) || 0, 120_000)));
      return { ok: true };

    case 'OPEN_BOT': {
      const url = chrome.runtime.getURL('src/bot/bot.html') + (message.listUrl ? `?list=${encodeURIComponent(message.listUrl)}` : '');
      const existing = await chrome.tabs.query({ url: chrome.runtime.getURL('src/bot/bot.html') + '*' });
      if (existing.length) {
        // Don't reload it – a run may be in progress. The page fills in the URL if it's idle.
        await chrome.tabs.update(existing[0].id, { active: true });
        await chrome.windows.update(existing[0].windowId, { focused: true });
        chrome.runtime.sendMessage({ type: 'BOT_SET_LIST', listUrl: message.listUrl }).catch(() => {});
      } else {
        await chrome.tabs.create({ url });
      }
      return { ok: true };
    }

    case 'OPEN_OPTIONS':
      await chrome.runtime.openOptionsPage();
      return { ok: true };

    default:
      throw new Error(`Unknown message: ${message?.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true; // keep the channel open for the async response
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Apply each pending one-time settings change (see IMPORTIFY_MIGRATIONS in shared/defaults.js).
  const { rulesVersion = 0 } = await chrome.storage.local.get('rulesVersion');
  for (let v = rulesVersion + 1; v <= globalThis.IMPORTIFY_RULES_VERSION; v++) {
    await chrome.storage.local.set({ ...(globalThis.IMPORTIFY_MIGRATIONS[v] || {}), rulesVersion: v });
  }
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
