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
  publishOnline: true,      // publish to the Online Store sales channel

  // Words/phrases removed from titles and descriptions (comma separated, whole words, any case)
  blockedWords: 'wholesale, wholesaler, wholesalers, wholesales, wholesaling, wholesale price, bulk, in bulk, bulk order, bulk orders, bulk buy, bulk price, bulk purchase, factory, factory price, factory direct, direct factory, factory outlet, factory supply, factories, manufacturer, manufacturers, manufacturing, supplier, suppliers, distributor, distributors, OEM, ODM, MOQ, low MOQ, small MOQ, minimum order, minimum order quantity, B2B, dropship, dropshipping, drop shipping, private label, custom logo, customized logo, customizable logo, trade assurance, low price, lowest price, cheap price, পাইকারি মূল্যে, পাইকারি দাম, পাইকারি, বাল্ক, কারখানা, সরবরাহকারী, প্রস্তুতকারক',

  // AI description (Claude)
  aiDescription: true,      // write the description with AI (needs an API key)
  aiProvider: 'openai',     // 'openai' | 'claude'
  openaiApiKey: '',
  openaiModel: 'gpt-5-mini',
  anthropicApiKey: '',
  aiLanguage: 'English',    // language the AI writes the title and description in
  aiTitle: true,            // let the AI rewrite the Alibaba title too (with the description)
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
// v7: publish every imported product to the Online Store
globalThis.IMPORTIFY_MIGRATIONS[7] = {
  publishOnline: true
};
// v8: keep "wholesale", "bulk" and similar trade words out of titles and descriptions
globalThis.IMPORTIFY_MIGRATIONS[8] = {
  blockedWords: globalThis.IMPORTIFY_DEFAULTS.blockedWords
};
// v9: everything in English; AI rewrites titles too
globalThis.IMPORTIFY_MIGRATIONS[9] = {
  aiLanguage: 'English',
  aiTitle: true
};
globalThis.IMPORTIFY_RULES_VERSION = globalThis.IMPORTIFY_MIGRATIONS.length - 1;
