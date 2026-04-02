#!/usr/bin/env node
// Module: demo-measure.js
// Demo Sites v2 — Phase 3: Measure-First Prompts
// Uses Playwright to measure actual pixel values before Codex runs.
// Provides concrete numbers instead of abstract instructions.

const { execSync } = require('child_process');
const fs = require('fs');

/**
 * Measure key layout values from a live URL using Playwright.
 * Returns concrete pixel measurements for Codex prompts.
 * 
 * @param {string} url - Live URL to measure
 * @param {string[]} selectors - CSS selectors to measure (optional, defaults to common elements)
 * @returns {{ viewport: object, measurements: Array<{selector: string, rect: object, styles: object}>, errors: string[] }}
 */
function measureLayout(url, selectors) {
  const defaultSelectors = [
    'header', 'nav', '.hero', 'main', 'footer',
    'h1', '.card', '.container', '.grid', '.section'
  ];
  const sels = selectors && selectors.length > 0 ? selectors : defaultSelectors;
  
  const script = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = { viewport: {}, measurements: [], errors: [] };
  
  for (const vp of [{w: 1200, h: 800, label: 'desktop'}, {w: 390, h: 844, label: 'mobile'}]) {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    try {
      await page.goto('${url.replace(/'/g, "\\'")}', { timeout: 15000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
      
      results.viewport[vp.label] = { width: vp.w, height: vp.h };
      
      for (const sel of ${JSON.stringify(sels)}) {
        try {
          const el = await page.$(sel);
          if (!el) continue;
          
          const rect = await el.boundingBox();
          if (!rect) continue;
          
          const styles = await el.evaluate(el => {
            const cs = window.getComputedStyle(el);
            return {
              padding: cs.padding,
              margin: cs.margin,
              fontSize: cs.fontSize,
              lineHeight: cs.lineHeight,
              width: cs.width,
              height: cs.height,
              display: cs.display
            };
          });
          
          results.measurements.push({
            selector: sel,
            viewport: vp.label,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            styles
          });
        } catch {}
      }
    } catch (e) {
      results.errors.push(vp.label + ': ' + e.message.substring(0, 100));
    }
    await page.close();
  }
  
  await browser.close();
  console.log(JSON.stringify(results));
})();
`;

  try {
    const tmpFile = '/tmp/demo-measure-' + Date.now() + '.js';
    fs.writeFileSync(tmpFile, script);
    const output = execSync(`node "${tmpFile}"`, { 
      timeout: 45000, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
      env: { ...process.env, NODE_PATH: execSync('npm root -g', { encoding: 'utf8' }).trim() }
    }).trim();
    fs.unlinkSync(tmpFile);
    
    return JSON.parse(output);
  } catch (e) {
    console.error('[demo-measure] measureLayout error:', e.message.substring(0, 200));
    return { viewport: {}, measurements: [], errors: [e.message.substring(0, 200)] };
  }
}

/**
 * Generate a Measure-First prompt section from measurements.
 * Provides concrete pixel values for Codex instead of abstract instructions.
 * 
 * @param {object} measurements - Output from measureLayout
 * @returns {string} Prompt section with concrete values
 */
function generateMeasurePrompt(measurements) {
  if (!measurements || measurements.measurements.length === 0) {
    return ''; // No measurements available — skip
  }
  
  let prompt = '\n=== MEASURED VALUES (Playwright) ===\n';
  prompt += 'These are REAL pixel measurements from the live site. Use these exact values.\n\n';
  
  const byViewport = {};
  for (const m of measurements.measurements) {
    if (!byViewport[m.viewport]) byViewport[m.viewport] = [];
    byViewport[m.viewport].push(m);
  }
  
  for (const [vp, items] of Object.entries(byViewport)) {
    prompt += `${vp.toUpperCase()} (${measurements.viewport[vp]?.width || '?'}px):\n`;
    for (const m of items) {
      prompt += `  ${m.selector}: ${m.rect.w}x${m.rect.h}px at (${m.rect.x},${m.rect.y}) | padding: ${m.styles.padding} | font: ${m.styles.fontSize}\n`;
    }
    prompt += '\n';
  }
  
  if (measurements.errors.length > 0) {
    prompt += `Measurement errors: ${measurements.errors.join('; ')}\n`;
  }
  
  return prompt;
}

module.exports = { measureLayout, generateMeasurePrompt };
