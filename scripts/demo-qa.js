#!/usr/bin/env node
// Module: demo-qa.js
// Demo Sites v2 — Phase 4: Proactive QA
// Automated quality checks BEFORE shipping any demo site.
// Catches the stuff that slipped through in past incidents.

const { execSync } = require('child_process');
const fs = require('fs');

/**
 * Run full QA suite on a URL. Returns structured results.
 * Each check has: name, passed, severity (critical/warning/info), detail.
 * 
 * @param {string} url - Live URL to test
 * @param {object} opts - { selectors?: string[], timeout?: number }
 * @returns {{ checks: Array<{name: string, passed: boolean, severity: string, detail: string}>, passed: boolean, criticalFails: number, warnings: number }}
 */
function runQA(url, opts = {}) {
  const timeout = opts.timeout || 45000;

  const script = `
const { chromium } = require('playwright');
(async () => {
  const results = [];
  const browser = await chromium.launch({ headless: true });

  const viewports = [
    { width: 1200, height: 800, label: 'desktop' },
    { width: 768, height: 1024, label: 'tablet' },
    { width: 390, height: 844, label: 'mobile' },
  ];

  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    try {
      const response = await page.goto('${url.replace(/'/g, "\\'")}', { timeout: 20000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      // CHECK 1: HTTP status
      const status = response ? response.status() : 0;
      results.push({
        name: 'http-status-' + vp.label,
        passed: status >= 200 && status < 400,
        severity: 'critical',
        detail: 'HTTP ' + status
      });

      // CHECK 2: Horizontal overflow (scrollWidth > clientWidth)
      const overflow = await page.evaluate(() => {
        const body = document.body;
        const html = document.documentElement;
        return {
          scrollWidth: Math.max(body.scrollWidth, html.scrollWidth),
          clientWidth: html.clientWidth,
          overflowing: []
        };
      });
      const hasOverflow = overflow.scrollWidth > overflow.clientWidth + 2;
      results.push({
        name: 'no-h-overflow-' + vp.label,
        passed: !hasOverflow,
        severity: 'critical',
        detail: hasOverflow
          ? 'scrollWidth=' + overflow.scrollWidth + ' > clientWidth=' + overflow.clientWidth
          : 'OK (' + overflow.clientWidth + 'px)'
      });

      // CHECK 3: Images loaded (no broken images)
      const brokenImages = await page.evaluate(() => {
        const broken = [];
        document.querySelectorAll('img').forEach(img => {
          if (!img.complete || img.naturalWidth === 0) {
            broken.push(img.src || img.getAttribute('src') || '(empty src)');
          }
        });
        return broken;
      });
      results.push({
        name: 'images-loaded-' + vp.label,
        passed: brokenImages.length === 0,
        severity: 'warning',
        detail: brokenImages.length === 0
          ? 'All images loaded'
          : brokenImages.length + ' broken: ' + brokenImages.slice(0, 3).join(', ')
      });

      // CHECK 4: Text visible (hero section not empty/invisible)
      const heroVisible = await page.evaluate(() => {
        const hero = document.querySelector('.hero, [class*="hero"], header, section:first-of-type');
        if (!hero) return { found: false, visible: false, text: '' };
        const rect = hero.getBoundingClientRect();
        const text = hero.innerText.trim().substring(0, 100);
        const styles = window.getComputedStyle(hero);
        return {
          found: true,
          visible: rect.height > 0 && styles.opacity !== '0' && styles.display !== 'none',
          text,
          height: Math.round(rect.height)
        };
      });
      results.push({
        name: 'hero-visible-' + vp.label,
        passed: heroVisible.found && heroVisible.visible && heroVisible.text.length > 0,
        severity: 'critical',
        detail: !heroVisible.found ? 'No hero section found'
          : !heroVisible.visible ? 'Hero hidden (display:none or opacity:0 or height:0)'
          : heroVisible.text.length === 0 ? 'Hero has no visible text'
          : 'OK (h=' + heroVisible.height + 'px, text: "' + heroVisible.text.substring(0, 40) + '...")'
      });

      // CHECK 5: No JS console errors
      results.push({
        name: 'no-js-errors-' + vp.label,
        passed: consoleErrors.length === 0,
        severity: 'warning',
        detail: consoleErrors.length === 0
          ? 'No console errors'
          : consoleErrors.length + ' errors: ' + consoleErrors.slice(0, 2).join('; ')
      });

      // CHECK 6: Footer exists and is visible (only desktop — saves time)
      if (vp.label === 'desktop') {
        const footerCheck = await page.evaluate(() => {
          const footer = document.querySelector('footer');
          if (!footer) return { found: false };
          const rect = footer.getBoundingClientRect();
          return { found: true, visible: rect.height > 0, text: footer.innerText.trim().substring(0, 80) };
        });
        results.push({
          name: 'footer-exists',
          passed: footerCheck.found && footerCheck.visible,
          severity: 'warning',
          detail: !footerCheck.found ? 'No <footer> element' : footerCheck.text ? 'OK' : 'Footer empty'
        });
      }

    } catch (e) {
      results.push({
        name: 'page-load-' + vp.label,
        passed: false,
        severity: 'critical',
        detail: e.message.substring(0, 150)
      });
    }

    await page.close();
  }

  // CHECK 7: Meta tags (only once, not per viewport)
  const metaPage = await browser.newPage();
  try {
    await metaPage.goto('${url.replace(/'/g, "\\'")}', { timeout: 15000, waitUntil: 'domcontentloaded' });
    const meta = await metaPage.evaluate(() => {
      const title = document.title || '';
      const desc = document.querySelector('meta[name="description"]');
      const viewport = document.querySelector('meta[name="viewport"]');
      const ogTitle = document.querySelector('meta[property="og:title"]');
      const lang = document.documentElement.lang || '';
      return {
        title,
        hasDescription: !!desc && desc.content.length > 10,
        hasViewport: !!viewport,
        hasOgTitle: !!ogTitle,
        lang
      };
    });

    results.push({
      name: 'meta-title',
      passed: meta.title.length > 5 && meta.title.length < 70,
      severity: 'warning',
      detail: meta.title ? '"' + meta.title.substring(0, 60) + '"' : 'MISSING'
    });
    results.push({
      name: 'meta-description',
      passed: meta.hasDescription,
      severity: 'warning',
      detail: meta.hasDescription ? 'Present' : 'Missing or too short'
    });
    results.push({
      name: 'meta-viewport',
      passed: meta.hasViewport,
      severity: 'critical',
      detail: meta.hasViewport ? 'Present' : 'MISSING - site will not be responsive'
    });
    results.push({
      name: 'html-lang',
      passed: meta.lang.length > 0,
      severity: 'info',
      detail: meta.lang ? 'lang="' + meta.lang + '"' : 'Missing lang attribute'
    });
  } catch (e) {
    results.push({ name: 'meta-check', passed: false, severity: 'warning', detail: e.message.substring(0, 100) });
  }
  await metaPage.close();

  // CHECK 8: Internal links (only desktop)
  const linkPage = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await linkPage.goto('${url.replace(/'/g, "\\'")}', { timeout: 15000, waitUntil: 'domcontentloaded' });
    const links = await linkPage.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors
        .map(a => ({ href: a.href, text: a.innerText.trim().substring(0, 30) }))
        .filter(l => l.href && !l.href.startsWith('javascript:') && !l.href.startsWith('mailto:') && !l.href.startsWith('tel:'));
    });

    // Check internal links only (same origin)
    const origin = new URL('${url}').origin;
    const internalLinks = links.filter(l => {
      try { return new URL(l.href).origin === origin; } catch { return false; }
    });

    let brokenCount = 0;
    const brokenLinks = [];
    for (const link of internalLinks.slice(0, 10)) {
      try {
        const resp = await linkPage.goto(link.href, { timeout: 10000, waitUntil: 'domcontentloaded' });
        if (resp && resp.status() >= 400) {
          brokenCount++;
          brokenLinks.push(link.text + ' → ' + resp.status());
        }
      } catch {
        brokenCount++;
        brokenLinks.push(link.text + ' → timeout');
      }
    }

    results.push({
      name: 'internal-links',
      passed: brokenCount === 0,
      severity: 'warning',
      detail: brokenCount === 0
        ? internalLinks.length + ' internal links, all OK'
        : brokenCount + ' broken: ' + brokenLinks.slice(0, 3).join(', ')
    });
  } catch (e) {
    results.push({ name: 'internal-links', passed: false, severity: 'warning', detail: e.message.substring(0, 100) });
  }
  await linkPage.close();

  await browser.close();
  console.log(JSON.stringify(results));
})();
`;

  try {
    const tmpFile = '/tmp/demo-qa-' + Date.now() + '.js';
    fs.writeFileSync(tmpFile, script);
    const output = execSync(`node "${tmpFile}"`, {
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: execSync('npm root -g', { encoding: 'utf8' }).trim() },
    }).trim();
    fs.unlinkSync(tmpFile);

    const checks = JSON.parse(output);
    const criticalFails = checks.filter(c => !c.passed && c.severity === 'critical').length;
    const warnings = checks.filter(c => !c.passed && c.severity === 'warning').length;
    const passed = criticalFails === 0;

    return { checks, passed, criticalFails, warnings };
  } catch (e) {
    console.error('[demo-qa] runQA error:', e.message.substring(0, 200));
    return {
      checks: [{ name: 'qa-runner', passed: false, severity: 'critical', detail: e.message.substring(0, 200) }],
      passed: false,
      criticalFails: 1,
      warnings: 0,
    };
  }
}

/**
 * Generate human-readable QA report.
 * 
 * @param {object} qaResult - Output from runQA
 * @param {string} url
 * @returns {string}
 */
function formatQAReport(qaResult, url) {
  let report = `QA REPORT — ${url}\n`;
  report += `${'='.repeat(50)}\n`;
  report += `Result: ${qaResult.passed ? '✅ PASSED' : '❌ FAILED'} | `;
  report += `Critical: ${qaResult.criticalFails} | Warnings: ${qaResult.warnings}\n\n`;

  const groups = {};
  for (const c of qaResult.checks) {
    const base = c.name.replace(/-(desktop|tablet|mobile)$/, '');
    const vp = c.name.match(/-(desktop|tablet|mobile)$/)?.[1] || 'general';
    if (!groups[base]) groups[base] = {};
    groups[base][vp] = c;
  }

  for (const [name, viewports] of Object.entries(groups)) {
    const entries = Object.entries(viewports);
    for (const [vp, c] of entries) {
      const icon = c.passed ? '✅' : c.severity === 'critical' ? '🔴' : c.severity === 'warning' ? '🟡' : 'ℹ️';
      const vpLabel = entries.length > 1 ? ` [${vp}]` : '';
      report += `${icon} ${name}${vpLabel}: ${c.detail}\n`;
    }
  }

  return report;
}

/**
 * Ship decision: combines QA + slop results.
 * 
 * Logic:
 * - Critical QA fails → AUTOFIX (not block, not escalate)
 * - Slop < B → AUTOFIX
 * - Warnings → SHIP with warnings listed (don't block)
 * 
 * @param {object} qaResult - From runQA
 * @param {object} slopResult - From demo-slop.js analyzeSlop (optional)
 * @returns {{ action: 'SHIP'|'AUTOFIX', reason: string, warnings: string[] }}
 */
function shipDecision(qaResult, slopResult = null) {
  // Collect warnings for report (never block on warnings)
  const warnings = qaResult.checks
    .filter(c => !c.passed && c.severity === 'warning')
    .map(c => `${c.name}: ${c.detail}`);

  if (qaResult.criticalFails > 0) {
    return { action: 'AUTOFIX', reason: `${qaResult.criticalFails} critical QA failures — auto-fixing`, warnings };
  }

  if (slopResult && !slopResult.canShip) {
    return { action: 'AUTOFIX', reason: `Slop grade ${slopResult.grade} (${slopResult.score}/100) — auto-fixing`, warnings };
  }

  const slopNote = slopResult ? ` | Slop: ${slopResult.grade} (${slopResult.score}/100)` : '';
  return { action: 'SHIP', reason: `QA passed${slopNote}`, warnings };
}

module.exports = { runQA, formatQAReport, shipDecision };
