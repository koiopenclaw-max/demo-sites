# Task: Create Product Pages + About Page for Стоянов Пласт

## Context
Demo website for Стоянов Пласт — PVC and aluminum window/door manufacturer in Varna, Bulgaria. Current site has only `index.html` (home page) with light theme + teal accent.

The client wants:
1. Logo from original site added to demo
2. "За нас" (About) page with content from original site
3. Product pages for each product category with images, descriptions, prices from original site

## What to Build

### 1. `za-nas.html` — За нас
Content from scraped-products.md → ЗА НАС section. Include full company story, team description, "Защо да изберете нас" list.

### 2. `pvc-dograma.html` — PVC Дограма
Two sections: Bulgarian (VIVA Plast 3/4/5 камерна) + German (REHAU Ecosol/Euro-Design/GENEO). Include all technical specs, benefits, images from original site.

### 3. `al-dograma.html` — Алуминиева Дограма
Altest (Poni + Eskimos systems) + ETEM. Technical specs, images.

### 4. `vrati.html` — Врати
Interiorni vrati Gradde — all colors (5 images from original), specs, base kit description.

### 5. `komarnici.html` — Комарници
All 4 types with images: на панти, плисе, ролетни, плъзгащ.

### 6. `staklopaketi.html` — Стъклопакети и Обков
Glass types (нискоемисийно, орнаментно, ламинирано, калено, армирано, цветно, огледално) + Обков. Images from original.

## Design Rules (CRITICAL — match index.html exactly)

1. **Same light theme**: body bg #FAFAFA, text #1A1A1A, accent teal #0D9488
2. **Same fonts**: Archivo + DM Sans (Google Fonts)
3. **Same navigation**: Copy exact header/nav from index.html, add product pages
4. **Same footer**: Copy from index.html
5. **Use REAL images from pvc-varna.com** (direct URLs in scraped-products.md)
6. **Mobile-first responsive** — same breakpoints as index.html
7. **NO gradient heroes** — solid backgrounds
8. **Varied border-radius**: cards 8px, badges 4px, buttons 6px, images 12px
9. **Left-align body text** (center only headings and CTAs)
10. **Add hover states**: buttons darken + scale(1.02), cards shadow elevation

## Logo Integration

Add the real logo to the header navigation:
```html
<img src="https://pvc-varna.com/wp-content/uploads/2016/11/Logorgb-e1614531383964.jpg" alt="Стоянов Пласт" style="height:40px">
```

## Navigation Update

Update index.html nav to include all new pages. Add same nav to all new pages.

Nav structure:
- Начало (index.html)
- За нас (za-nas.html)
- PVC Дограма (pvc-dograma.html)
- AL Дограма (al-dograma.html)
- Врати (vrati.html)
- Комарници (komarnici.html)
- Стъклопакети (staklopaketi.html)
- Контакти (#contact in index.html)

## SEO Requirements

Each page needs:
- Unique `<title>` with product + "Варна" + "Стоянов Пласт"
- `<meta description>` with products
- Schema.org Product/Service markup
- Schema.org LocalBusiness for company
- Open Graph tags
- H1 → H2 → H3 hierarchy
- Bulgarian language throughout

## Content Source

Read `scraped-products.md` for ALL product details and image URLs.
Transfer EVERYTHING — don't summarize or skip products.

## When Done

```bash
openclaw system event --text "Done: Стоянов Пласт product pages built (6 pages + logo + nav update)" --mode now
```
