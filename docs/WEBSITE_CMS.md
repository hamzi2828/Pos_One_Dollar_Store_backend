# Marketing website + CMS — Oct 2026

The shop's public website (`dollar_marketing`, Next.js) tells people **who we are,
what we do and what you get**, links to (and shows) the shop's Facebook page,
and is shared on Facebook. All its text and pictures are edited by the owner in
the POS admin: **System Settings → Website** (`/admin/website`).

```
pos_frontend /admin/website ──PUT /api/website──► pos_backend (SiteContent, one document)
                                                      │  GET /api/public/website (no login, cached 60 s)
                                                      ▼
                                       dollar_marketing (Next.js, ISR 60 s + instant refresh hook)
```

## 1. Content shape (`SiteContent`, key `main`) — the contract

Every section has `show` (boolean). Text is plain text (paragraphs split by blank
lines; no HTML). Images are URLs (uploaded through the CMS, or `/images/...`
files that ship with the website). Empty strings mean "not set" — the website
hides anything empty (never shows placeholder phone numbers / addresses).

```jsonc
{
  "brand":   { "name": "DOLLAR & Co", "tagline": "Everything you need, at prices you'll love" },
  "hero":    { "heading": "", "subheading": "", "imageUrl": "/images/storefront.png",
               "videoUrl": "",                       // optional mp4 URL (shown below the hero)
               "primaryCta":   { "label": "Visit the shop", "url": "#visit" },
               "secondaryCta": { "label": "Follow us on Facebook", "url": "" } },   // "" = use social.facebookUrl
  "about":   { "show": true, "heading": "Who we are", "body": "", "imageUrl": "" },
  "whatWeDo":   { "show": true, "heading": "What we do",   "intro": "", "items": [ { "icon": "store", "title": "", "text": "" } ] },
  "whatYouGet": { "show": true, "heading": "What you get", "intro": "", "items": [ { "icon": "tag",   "title": "", "text": "" } ] },
  "prices":  { "show": true, "heading": "Simple prices", "intro": "",
               "items": [ { "price": 99, "label": "", "note": "" } ] },          // fixed price points
  "categories": { "show": true, "heading": "What you'll find", "items": [ { "name": "", "text": "", "imageUrl": "" } ] },
  "offers":  { "show": true, "heading": "Offers", "items": [ { "title": "", "text": "", "imageUrl": "", "active": true,
               "startsOn": "", "endsOn": "" } ] },                              // 'YYYY-MM-DD' or "" ; website shows active & in date range (PKT)
  "gallery": { "show": true, "heading": "Inside the shop", "items": [ { "imageUrl": "", "caption": "" } ] },
  "faq":     { "show": true, "heading": "Questions", "items": [ { "q": "", "a": "" } ] },
  "visit":   { "show": true, "heading": "Visit us", "address": "", "city": "", "mapEmbedUrl": "", "mapLinkUrl": "",
               "hours": "", "phone": "", "whatsapp": "", "email": "" },          // whatsapp = number like 923001234567
  "social":  { "facebookUrl": "", "instagramUrl": "", "tiktokUrl": "", "youtubeUrl": "",
               "showFacebookFeed": true },                                       // Facebook Page plugin on the site
  "seo":     { "title": "", "description": "", "ogImageUrl": "", "keywords": "" },
  "siteUrl": "",                                                                 // public address of the website (for "View website")
  "updatedAt": "ISO date", "updatedByName": ""
}
```

Icon keys (fixed set, both apps map them to icons): `store, tag, wallet, gift, sparkles, home,
kitchen, toys, beauty, stationery, cleaning, truck, clock, heart, star, smile, shield, users, package, percent`.

Limits: items lists ≤ 24 each (gallery ≤ 40); strings trimmed; headings ≤ 120, text ≤ 1500,
body ≤ 5000; URLs must be http(s) or start with `/`; `mapEmbedUrl` must be a
`https://www.google.com/maps/embed?...` URL (else rejected — it goes into an iframe);
prices are numbers ≥ 0.

Details as built (backend `services/websiteService.js` is the source of truth):
- One-line fields (≤ 120): headings, `brand.*`, button labels, item titles/names/labels, `visit.city`, `seo.title`.
  Multi-line (≤ 1500): intros, item texts, `hero.subheading`, captions, FAQ `q`/`a`, `visit.address`/`hours`,
  `seo.description`/`keywords`. `about.body` ≤ 5000. Paragraphs = one blank line (3+ newlines collapse to 2).
- Picture/video URLs (`*imageUrl`, `videoUrl`, `ogImageUrl`): http(s) or a site path `/...` (not `//`).
- Button URLs (`primaryCta.url`, `secondaryCta.url`): also `#section` anchors (e.g. `#visit`), `mailto:`, `tel:`.
- Social links, `visit.mapLinkUrl`, `siteUrl`: full http(s) only. `javascript:` / `data:` always rejected.
- `mapEmbedUrl`: the whole `<iframe ...>` code may be pasted; its `src` is kept.
- `whatsapp`: digits only, 8–15 (`0300 1234567` is stored as `923001234567`). `email` checked. `phone` digits/space/+-()/,.
- Item icon missing → `star`; unknown icon → rejected. New offer without `active` → `true`. Offer `endsOn` ≥ `startsOn`.
- Unknown keys are dropped. Errors: 400 `{ success:false, code:'INVALID_CONTENT', message:'Questions, item 2, Answer: too long (…)' }`.

### Default content (first load, also the website's offline fallback)
Both apps carry the same defaults (backend `src/constants/websiteDefaults.js`; website
`lib/defaults.ts` — keep them identical). Truthful only:
- Shop: DOLLAR & Co, a modern fixed-price store. Fixed price points **Rs 99, 150, 199, 280, 499, 999**.
- Categories: Kitchen & Dining, Home Decor, Storage & Organisers, Cleaning, Bath, Stationery,
  Toys, Beauty & Personal Care, Gifts, Plastic Ware, Seasonal.
- Promises we really keep: clear fixed prices, new stock regularly, quality checked, bill on every
  purchase (POS), easy to find (racks A–D), gifts & offers (spend Rs 5,000+ → 10% off is a POS rule
  that exists — mention as "offers like 10% off on bigger shopping, see in store").
- NO address, phone, hours, Facebook URL by default (owner fills them).
- Hero image `/images/storefront.png` (the real night photo of the shop).

## 2. API (pos_backend)

| Route | Access | Does |
|---|---|---|
| `GET /api/public/website` | none (public) | `{ success, data: content }` without internal ids/users. `Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=300`. Never 500 on missing doc: returns defaults. |
| `GET /api/website` | permission `website` view | `{ success, data: content, meta: { icons: [...], defaults, limits: { line:120, text:1500, body:5000, url:2000, items:24, galleryItems:40 } } }` |
| `PUT /api/website` | `website` edit | Body = whole content (sections may be omitted = unchanged; fields left out of a sent section are unchanged too; item lists are replaced as sent). Validates (§1 limits), saves, records `updatedBy`, returns `{ success, data: content, meta: { refresh: 'done'\|'failed'\|'skipped' } }`. Fires the refresh hook (below) before answering, never failing the save if the hook fails. |
| `POST /api/website/upload` | `website` edit | multipart field `file`: one image (jpg/png/webp, ≤ 5 MB; SVG/GIF refused) → 201 `{ success, data: { url } }` (Vercel Blob URL in production; local dev returns the full `http://host/uploads/...` address). |
| `POST /api/website/reset` | `website` edit | Body `{ section }` (`brand, hero, about, whatWeDo, whatYouGet, prices, categories, offers, gallery, faq, visit, social, seo, siteUrl`) → that section back to defaults; same response as PUT. |

Refresh hook: if env `MARKETING_SITE_URL` and `MARKETING_REVALIDATE_SECRET` are set, after a
save POST `${MARKETING_SITE_URL}/api/revalidate` with header `x-revalidate-secret` and JSON body
`{ "path": "/" }` (timeout 4 s). Otherwise the website refreshes by itself within 60 s.
Note: `s-maxage=60` lets the Vercel CDN in front of the backend keep the public JSON up to 60 s,
so a rebuild right after a save can still read the old copy. The website should fetch
`/api/public/website` with a changing query (e.g. `?v=<minute or revalidate time>`) or accept up to ~1 min delay.
`/api/public/*` requests are not written to the Activity Log.

Permission: new key `website` (actions view, edit) in a new section "Website" in
`src/constants/rolePermissions.js` — owner/Admin only by default (not in Manager/Cashier defaults).

## 3. Website (dollar_marketing)

Next.js 15 App Router + TypeScript + Tailwind 3, deploy target Vercel. Env:
`NEXT_PUBLIC_API_URL` (backend, e.g. https://pos-one-dollar-store-backend.vercel.app),
`REVALIDATE_SECRET`. Fetch `GET /api/public/website` server-side with `revalidate: 60`;
on any error use `lib/defaults.ts`. `/api/revalidate` route checks the secret and calls
`revalidatePath('/')`.
