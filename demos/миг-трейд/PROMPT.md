# Task: Create Product Category Pages for Миг Трейд

## Context
You're working on a demo website for Миг Трейд — a metal door, grille, fence and portal manufacturer in Sofia, Bulgaria. The current site has only `index.html` (home page) with dark theme + gold accents.

The client wants **separate product pages** for each product category, with ALL content (text, descriptions, prices, images) from the original site transferred to the new design.

## What to Build

Create these HTML files in the SAME directory as index.html:

### 1. `metalni-vrati.html` — Метални врати за апартаменти
Products (ALL must be included with full descriptions, prices, images):
- Еднопластова за мазе — 170 лв
- Еднопластова с касова брава
- Еднопластова със секретна брава
- Еднопластова с брава + бронировка — 230 лв
- Двупластова с една брава — 365 лв
- Двупластова с две брави — 395 лв
- Двупластова с декоративно фолио — 415 лв
- Двупластова с цяла каса — 495 лв

### 2. `vhodni-vrati.html` — Входни метални врати за блокове
Products:
- Входна врата с пощенски кутии (базова) — от 515 лв + 25 лв/кутия
- Входна врата с 24 кутии — от 1015 лв + 560 лв
- Входна врата с 48 кутии — от 1015 лв + 1120 лв
- Входна врата за офис сграда — луксозно изпълнение
- Входна врата за блок (стандартна)

### 3. `metalni-reshetki.html` — Метални решетки
Products:
- 12х12х1.5мм — 35 лв/м²
- 15х15х1.5мм — 40 лв/м²
- 20х20х1.5мм — 45 лв/м²
- Решетки за врати — 200 лв (1х2м)
Include price table at bottom.

### 4. `ogradi-portali.html` — Огради и портали
- Lighter page — services overview, benefits, CTA to contact
- Original site has minimal content here, so write reasonable copy about custom metalwork for fences and gates

## Design Rules (CRITICAL — match index.html exactly)

1. **Same dark theme**: --bg: #0A0A0A, --accent: #C9A96E, etc.
2. **Same fonts**: Playfair Display + DM Sans (Google Fonts)
3. **Same navigation**: Copy the exact header/nav from index.html, add product pages to it
4. **Same footer**: Copy from index.html
5. **Each product** gets: image(s) from mig-trade.com (use direct URLs), title, price, full description, specs list, CTA button
6. **Mobile-first responsive** — same breakpoints as index.html
7. **NO gradient heroes** — use solid backgrounds or subtle patterns
8. **Varied border-radius**: cards 8px, badges 4px, buttons 6px, images 12px
9. **Left-align body text** (center only headings and CTAs)
10. **Add hover states**: buttons darken + scale(1.02), cards get shadow elevation

## Image Sources (use DIRECT URLs from mig-trade.com)

All product images are at `https://mig-trade.com/images/metalni-vrati/` and `https://mig-trade.com/images/metalni-reshetki/`

Full image list is in `scraped-products.md` — use the actual image URLs, do NOT use placeholder images.

## SEO Requirements

Each page needs:
- Unique `<title>` with product + "София" + "Миг Трейд"
- `<meta description>` with products and prices
- Schema.org Product markup for each product (name, description, price, image)
- Schema.org LocalBusiness for the company
- Open Graph tags
- H1 → H2 → H3 proper hierarchy
- Bulgarian language throughout

## Navigation Update

Update index.html navigation to include links to all new pages. Also add navigation to all new pages pointing to each other and back to index.html.

Nav structure:
- Начало (index.html)
- Метални врати (metalni-vrati.html)
- Входни врати (vhodni-vrati.html)
- Решетки (metalni-reshetki.html)
- Огради (ogradi-portali.html)
- Контакти (#contact section in index.html)

## Content Source

Read `scraped-products.md` for ALL product details, prices, descriptions, and image URLs.
Transfer EVERYTHING — don't summarize or skip products.

## When Done

```bash
openclaw system event --text "Done: Миг Трейд product pages built (4 pages + nav update)" --mode now
```
