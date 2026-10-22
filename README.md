# Importify – Alibaba → Shopify

A Chrome extension that adds an **Add to Shopify** button to Alibaba product pages. Click it, review the title, images, variants and description, set your prices, and the product is created in your Shopify store with its images and variants.

## 1. Connect Shopify

You need an app installed on your store with the `write_products` and `read_products` scopes. To publish to the Online Store automatically, also add `read_publications` and `write_publications`.

**Option A: Dev Dashboard app with a client ID and secret (for new setups)**
1. In the Shopify Dev Dashboard, create an app.
2. Add the scopes above to an app version, release it, and install the app on your store.
3. Copy the app's **Client ID** and **Client secret**.
4. In Importify settings, choose **Client ID + secret**. The extension uses them to get short-lived access tokens (client credentials grant).

**Option B: An existing custom app with an Admin API access token**
If you already have a custom app made in the Shopify admin, paste its `shpat_…` Admin API access token and choose **Admin API access token**.

## 2. Install the extension

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. The settings page opens. Enter your store domain (`your-store.myshopify.com`) and your credentials, then click **Test connection**.

You can reopen settings at any time by clicking the extension's toolbar icon.

## 3. Import a product

1. Open any `alibaba.com/product-detail/...` page.
2. Click the green **Add to Shopify** button in the bottom-right corner.
3. Check the details:
   - **Title**: edit as needed.
   - **Images**: click to include or exclude. The first selected image becomes the main image.
   - **Pricing**: multiply the Alibaba price, add a fixed amount, or set a fixed price. You can add an optional compare-at multiplier and round prices to end in .99. Every variant's price can also be edited by hand.
   - **Variants**: untick the ones you don't want.
   - **Description**: written by AI (Claude) when a Claude API key is set in Settings: an intro and a Key Features list, followed by the Specifications table. Click **Write with AI** to rewrite it, or edit the HTML freely. Without AI it's the Specifications table plus, optionally, the supplier's description.
   - **Collections**: tick any of your store's manual collections. Defaults from Settings are pre-ticked.
   - Vendor, product type, tags, and Draft or Active status.
4. Click **Upload to Shopify**. You'll get a link to the new product in your admin.

The Alibaba page URL is saved on the product as the metafield `importify.source_url`.

## 4. Bulk-import a whole store (bot)

1. Open the supplier's product list, e.g. `https://poedagar.en.alibaba.com/productlist-1.html`.
2. Click **Bulk import this store to Shopify**. You can also open the bot from the Settings page.
3. Click **1. Scan products**. The bot reads every list page and shows every product in a table (image, title, price, status). Products already in Shopify are marked and won't be imported again.
4. Review the table. Search, filter, and untick anything you don't want.
5. Click **2. Run bot**. It opens each selected product in its own Chrome window, one at a time, and creates it in Shopify using your saved settings (price, compare-at, collections, specs-only description, status). It waits a few seconds between products.
6. **Verification:** if Alibaba shows a slider or captcha, or a page doesn't load properly, the bot **pauses on that product** and brings the Alibaba window to the front. Solve it, then click **Resume**. The bot retries the same product; nothing is skipped.
7. Progress is saved after every product. If the bot tab is closed or Chrome restarts, reopen the bot and click **Resume**. Shopify upload errors are retried up to 3 times; **Retry failed** tries them again. **Rescan store** later picks up new products the supplier has added.

## How it works

| File | Role |
| --- | --- |
| `src/content/bridge.js` | Runs in the page context and reads Alibaba's embedded data (`window.detailData`). |
| `src/content/scraper.js` | Turns that data into title, images, price tiers, options, variants and description, with fallbacks that read the page itself. |
| `src/content/ui.js` | The floating button and import panel (Shadow DOM, so it's isolated from Alibaba's CSS). |
| `src/background.js` | Shopify Admin GraphQL calls. One `productSet` mutation creates the product, options, variants, images and variant images. |
| `src/options/` | Settings page. |

## Limitations

- Alibaba changes its page structure often. If a field comes out empty, the panel shows a warning and you can fill it in by hand. The scraper is the part most likely to need updating.
- Shopify allows at most 3 option types and 2048 variants per product. Anything beyond that is dropped, with a warning.
- Alibaba prices are in USD. "Cost per item" assumes your store currency is USD (you can turn this off in settings).
- Shopify downloads images from Alibaba's CDN in the background, so they can take a minute to appear.
- Your credentials are stored in `chrome.storage.local` on this computer only.
