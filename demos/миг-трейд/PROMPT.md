# Task: Fix Navigation Bar — Миг Трейд

Fix the navigation in ALL HTML files in this directory. The client says the font is ugly and doesn't match the theme, and the nav layout is cluttered and ugly.

## Current State (BROKEN)
- Nav has 6 links + CTA crammed in one row: Начало, Врати за апартаменти, Входни врати, Метални решетки, Огради и портали, Галерия, + CTA "Заявете оглед"
- Nav links use inherited `DM Sans` (body font) at `0.9rem` — looks generic and small
- `nav { display: flex; align-items: center; gap: 32px; }` — items overflow on smaller desktops
- No meaningful hover states

## Required Fix

### 1. Consolidate nav items with a dropdown
Replace the 6 separate links with:
- **Начало** → `index.html`
- **Продукти** (dropdown containing):
  - Врати за апартаменти → `metalni-vrati.html`
  - Входни врати → `vhodni-vrati.html`
  - Метални решетки → `metalni-reshetki.html`
  - Огради и портали → `ogradi-i-portali.html`
- **Галерия** → `galeriia.html`
- **Заявете оглед** (CTA button) → `index.html#contact` (or `zaiavka-za-ogled.html`)

### 2. Nav font styling
```css
nav a, .nav-dropdown-toggle {
  font-family: var(--font-heading); /* Playfair Display — matches logo */
  font-size: 1rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--text);
  transition: color 0.3s;
}
```

### 3. Nav layout
```css
nav { display: flex; align-items: center; gap: 28px; }
```

### 4. Dropdown CSS
```css
.nav-dropdown { position: relative; }
.nav-dropdown-toggle {
  display: flex; align-items: center; gap: 6px;
  cursor: pointer; background: none; border: none;
  font-family: var(--font-heading);
  font-size: 1rem; font-weight: 500;
  color: var(--text);
  padding: 0;
}
.nav-dropdown-toggle:hover { color: var(--accent); }
.nav-dropdown-toggle svg { width: 14px; height: 14px; transition: transform 0.3s; }
.nav-dropdown:hover .nav-dropdown-toggle svg { transform: rotate(180deg); }

.nav-dropdown-menu {
  position: absolute; top: calc(100% + 8px); left: 50%; 
  transform: translateX(-50%) translateY(4px);
  min-width: 220px; 
  background: rgba(20,20,20,0.97);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(201,169,110,0.2);
  border-radius: 8px;
  padding: 8px 0;
  opacity: 0; visibility: hidden;
  transition: opacity 0.25s, visibility 0.25s, transform 0.25s;
  z-index: 1001;
}
.nav-dropdown:hover .nav-dropdown-menu {
  opacity: 1; visibility: visible;
  transform: translateX(-50%) translateY(0);
}
.nav-dropdown-menu a {
  display: block; padding: 10px 20px;
  font-family: var(--font-body);
  font-size: 0.9rem; font-weight: 400;
  color: var(--text-muted);
  transition: background 0.2s, color 0.2s;
  white-space: nowrap;
}
.nav-dropdown-menu a:hover {
  background: rgba(201,169,110,0.1);
  color: var(--accent);
}
```

### 5. CTA button
```css
.cta-btn {
  display: inline-block; padding: 10px 24px;
  background: var(--accent); color: var(--bg);
  font-weight: 600; font-size: 0.9rem;
  border: none; cursor: pointer;
  border-radius: 999px;
  letter-spacing: 0.5px;
  transition: background 0.3s, transform 0.2s;
  text-decoration: none;
}
.cta-btn:hover { background: #B8954F; transform: scale(1.03); }
```

### 6. Hover states for regular nav links
```css
nav > a { position: relative; }
nav > a::after {
  content: ''; position: absolute; bottom: -4px; left: 0; width: 0; height: 2px;
  background: var(--accent); transition: width 0.3s;
}
nav > a:hover::after { width: 100%; }
nav > a:hover { color: var(--accent); }
nav > a.active { color: var(--accent); }
nav > a.active::after { width: 100%; }
```

## HTML Structure (for <nav id="mainNav">)
```html
<nav id="mainNav">
  <a href="index.html">Начало</a>
  <div class="nav-dropdown">
    <button class="nav-dropdown-toggle">
      Продукти
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="nav-dropdown-menu">
      <a href="metalni-vrati.html">Врати за апартаменти</a>
      <a href="vhodni-vrati.html">Входни врати</a>
      <a href="metalni-reshetki.html">Метални решетки</a>
      <a href="ogradi-i-portali.html">Огради и портали</a>
    </div>
  </div>
  <a href="galeriia.html">Галерия</a>
  <a href="index.html#contact" class="cta-btn">Заявете оглед</a>
</nav>
```

## Active page highlighting
On product subpages (metalni-vrati.html, vhodni-vrati.html, metalni-reshetki.html, ogradi-i-portali.html), the Продукти dropdown toggle should have `color: var(--accent)`.
On galeriia.html, the Галерия link should have class `active`.
On index.html, the Начало link should have class `active`.

## Files to modify
ALL .html files in this directory. Each has its own `<style>` block and `<nav id="mainNav">`.
DO NOT modify the mobile overlay nav (`.mobile-overlay`).
DO NOT change any content outside the `<style>` nav CSS rules and the `<nav id="mainNav">` HTML block.
DO NOT change hero images, section content, or footer.

## Completion
When completely finished, run this command:
```
openclaw system event --text "Done: Миг Трейд nav fix — dropdown + font + hover across all HTML files" --mode now
```
