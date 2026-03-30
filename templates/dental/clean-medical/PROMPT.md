# Dental Template: Clean Medical

Create `index.html` — a premium dental clinic single-page website. SAME structure and content as the Noir Luxe reference (see `../noir-luxe/index.html`) but with the **Clean Medical** palette.

## Design System

### Palette: Clean Medical
```
--bg-primary: #F8FFFE          (clean minty white)
--bg-secondary: #FFFFFF         (pure white cards)
--bg-elevated: #EFF8F6          (hover, inputs)
--text-primary: #1A1A2E         (near-black text)
--text-secondary: #5A6B7A       (muted text)
--accent: #0D9488               (teal — primary)
--accent-light: #14B8A6         (teal hover)
--accent-dark: #0F766E          (teal active)
--white: #FFFFFF
--success: #4CAF50
```

### Typography
```html
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital,wght@0,400;1,400&family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```
- Headings: `DM Serif Display`, serif
- Body: `DM Sans`, sans-serif

### Icons: Lucide (same CDN as reference)
```html
<script src="https://unpkg.com/lucide@latest"></script>
```
Same icon mapping as Noir Luxe.

## What to copy from Noir Luxe reference
- ALL section structure (hero, trust strip, services, about, trust badges, gallery, testimonials, FAQ, contact, footer)
- ALL text content (Bulgarian, same clinic info)
- ALL images (same Unsplash URLs)
- НЗОК logo: `nhif-logo.png` (copy from ../noir-luxe/)
- Trust badges (Google Reviews + НЗОК) — same inline SVG
- Lucide icons — same mapping
- FAQ accordion, mobile hamburger, scroll header — same behavior
- Copyright: © 2026

## What to CHANGE from Noir Luxe
- ALL colors → Clean Medical palette (light bg, teal accents)
- Typography → DM Serif Display + DM Sans
- Dark cards (#1A1A1A) → white cards with subtle border
- Dark form inputs → light inputs with light bg
- Footer → dark bg still OK (standard pattern)
- Header: transparent → on scroll white bg with shadow
- Hero overlay: adjust for readability on light theme

## Critical Rules
1. NO reveal/opacity animations on content
2. NO emoji as icons
3. NO Font Awesome
4. Single file (CSS + JS inline)
5. Mobile breakpoints: 968px, 390px
6. Solid mobile menu background (not transparent!)
7. Left-align body text. Center only section labels/titles.
8. ALL hover states on interactive elements
9. Bulgarian text throughout

## Output
Create `index.html` in this directory.
