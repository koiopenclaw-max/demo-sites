# Task: Create Remaining Product Pages for Миг Трейд

## Context
metalni-vrati.html is already built. You need to create 3 more product pages matching its style exactly. Also catalog.css, catalog.js, product-pages.css, and product-pages.js already exist.

Read metalni-vrati.html to understand the exact design pattern, then create:

## 1. `vhodni-vrati.html` — Входни метални врати за блокове

Products (from scraped-products.md):
- Входна врата с пощенски кутии (базова) — от 515 лв + 25 лв/кутия
- Входна врата с 24 кутии — от 1015 лв + 560 лв
- Входна врата с 48 кутии — от 1015 лв + 1120 лв
- Входна врата за офис сграда — луксозно изпълнение
- Входна врата за блок (стандартна)

Image URLs from scraped-products.md — use direct URLs from mig-trade.com.

## 2. `metalni-reshetki.html` — Метални решетки

Products:
- 12х12х1.5мм — 35 лв/м²
- 15х15х1.5мм — 40 лв/м²
- 20х20х1.5мм — 45 лв/м²
- Решетки за врати — 200 лв (1х2м)
Include price comparison table at bottom.

Image URLs from scraped-products.md.

## 3. `ogradi-portali.html` — Огради и портали

Services overview page — custom metalwork for fences and gates. The original site has minimal content, so write reasonable Bulgarian copy about:
- Метални огради по поръчка
- Портали (плъзгащи и разтварящи се)
- Парапети и перила
- CTA за безплатен оглед

## Rules
- Use the SAME CSS/JS files that metalni-vrati.html uses
- Same header/nav, same footer
- Same dark theme, same fonts, same layout patterns
- Full product descriptions, prices, images from scraped-products.md
- SEO: Schema.org Product markup, unique title + meta description per page
- All text in Bulgarian

## When Done

```bash
openclaw system event --text "Done: Миг Трейд remaining 3 product pages built" --mode now
```
