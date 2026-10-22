// Default settings shared by the content script, background worker and options page.
globalThis.IMPORTIFY_DEFAULTS = {
  // Shopify connection
  shop: '',                 // e.g. my-store.myshopify.com
  authMode: 'token',        // 'token' (Admin API access token) | 'client' (client ID + secret)
  accessToken: '',
  clientId: '',
  clientSecret: '',
  apiVersion: '2026-10',

  // Pricing (in your store's currency)
  priceMode: 'fixed',       // 'multiplier' | 'markup' | 'fixed'
  priceValue: 3650,
  compareAtMode: 'fixed',   // 'fixed' | 'multiplier'
  compareAtValue: 4500,     // 0 = no compare-at price
  roundTo99: false,
  saveCost: false,          // store the Alibaba price (USD) as "Cost per item"

  // Product defaults
  status: 'DRAFT',          // 'DRAFT' | 'ACTIVE'
  vendor: '',
  productType: '',
  tags: 'alibaba-import',
  collections: '',          // default collection titles (pre-ticked in the picker), one per line
  publishOnline: false,     // publish to the Online Store sales channel

  // AI description (Claude)
  aiDescription: true,      // write the description with AI (needs an API key)
  aiProvider: 'openai',     // 'openai' | 'claude'
  openaiApiKey: '',
  openaiModel: 'gpt-5-mini',
  anthropicApiKey: '',
  aiLanguage: 'Bangla (বাংলা)', // language the AI writes the description in
  aiInstructions: '',       // extra guidance for the writer, e.g. tone
  includeSupplierDescription: true,
  includeDescriptionImages: true,

  // Specification filtering (case-insensitive "contains" matches)
  removeAttributes: 'Brand Name, Model Number, Place of Origin, Box, Package, Packing, Packaging, Service, Mould, Mold, Sample, OEM, ODM, Logo, Customiz, Supply Ability, Lead Time, MOQ, Minimum Order, Warranty',
  removeValues: 'Service, OEM, ODM, Customiz, Logo, Mould, Sample'
};

// One-time settings changes, applied in order by the background worker when the extension updates.
// Each entry only touches the keys it lists, so later edits in Settings are kept.
globalThis.IMPORTIFY_MIGRATIONS = [];
globalThis.IMPORTIFY_MIGRATIONS[2] = {
  priceMode: 'fixed',
  priceValue: 3650,
  compareAtMode: 'fixed',
  compareAtValue: 4500,
  roundTo99: false,
  saveCost: false,
  collections: "Men's Fashion & Accessories > Watches\nPoedagar Watch",
  includeSupplierDescription: false,
  includeDescriptionImages: false,
  removeAttributes: globalThis.IMPORTIFY_DEFAULTS.removeAttributes,
  removeValues: globalThis.IMPORTIFY_DEFAULTS.removeValues
};
// v3: full supplier description again (specs table + supplier description with images)
globalThis.IMPORTIFY_MIGRATIONS[3] = {
  includeSupplierDescription: true,
  includeDescriptionImages: true
};
// v4: no more fixed collections (chosen per product in a picker); AI-written descriptions on
globalThis.IMPORTIFY_MIGRATIONS[4] = {
  collections: '',
  aiDescription: true
};
// v5: AI descriptions via OpenAI
globalThis.IMPORTIFY_MIGRATIONS[5] = {
  aiProvider: 'openai'
};
// v6: AI descriptions in Bangla
globalThis.IMPORTIFY_MIGRATIONS[6] = {
  aiLanguage: 'Bangla (বাংলা)'
};
globalThis.IMPORTIFY_RULES_VERSION = globalThis.IMPORTIFY_MIGRATIONS.length - 1;
