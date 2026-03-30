# Dental Template: Warm Haven (Family)

Create `index.html` — a premium dental clinic single-page website. SAME structure and content as the Noir Luxe reference (see `../noir-luxe/index.html`) but with the **Warm Haven** palette.

## Design System

### Palette: Warm Haven (family/cozy)
```
--bg-primary: #FFF8F0          (warm cream)
--bg-secondary: #FFFFFF         (white cards)
--bg-elevated: #FFF0E0          (warm hover)
--text-primary: #2D2D2D         (dark text)
--text-secondary: #6B5B4D       (warm muted)
--accent: #C4704A               (terracotta)
--accent-light: #D4845E         (terracotta hover)
--accent-dark: #A85C3A          (terracotta active)
--warm: #E8D5C0                 (warm neutral)
--white: #FFFFFF
```

### Typography
```html
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@300;400;600;700;800&family=Source+Sans+3:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```
- Headings: `Nunito`, sans-serif — friendly, rounded
- Body: `Source Sans 3`, sans-serif — clean readability

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
- Trust badges (Google Reviews + НЗОК) — same inline SVG but adjust card bg for light theme
- Lucide icons — same mapping
- FAQ accordion, mobile hamburger, scroll header — same behavior
- Copyright: © 2026

## What to CHANGE from Noir Luxe
- ALL colors → Warm Haven palette (cream bg, terracotta accents)
- Typography → Nunito + Source Sans 3
- Dark cards → warm white/cream cards with subtle warm border
- Service icon boxes → terracotta gradient background
- Header: transparent → on scroll warm white with shadow
- Hero overlay: warm tint, not cold dark
- Footer: warm dark (#2D2D2D or #3A2E24)
- Trust badges: adapt card bg for light context
- Overall vibe: welcoming, family-friendly, warm — think cozy dental practice

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
