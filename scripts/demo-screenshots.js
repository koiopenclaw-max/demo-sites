#!/usr/bin/env node
// Module: demo-screenshots.js
// Demo Sites v2 — Phase 5: Before/After Screenshots
// Takes screenshots at key moments for visual comparison and audit trail.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCREENSHOT_DIR = '/tmp/demo-screenshots';

/**
 * Take screenshots of a URL at multiple viewports.
 * @param {string} url - URL to screenshot
 * @param {string} label - Label prefix (e.g. 'before', 'after')
 * @param {string} slug - Site slug for file naming
 * @param {object} opts - { viewports?: Array<{w,h,name}>, timeout?: number }
 * @returns {{ desktop: string|null, mobile: string|null, paths: string[], error: string|null }}
 */
function takeScreenshots(url, label, slug, opts = {}) {
  const viewports = opts.viewports || [
    { w: 1200, h: 800, name: 'desktop' },
    { w: 390, h: 844, name: 'mobile' }
  ];
  const waitTimeout = opts.timeout || 3000;
  
  const dir = path.join(SCREENSHOT_DIR, slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  const result = { desktop: null, mobile: null, paths: [], error: null };
  
  for (const vp of viewports) {
    const filename = `${label}-${vp.name}-${Date.now()}.png`;
    const filepath = path.join(dir, filename);
    
    try {
      execSync(
        `npx playwright screenshot --viewport-size "${vp.w},${vp.h}" --wait-for-timeout ${waitTimeout} --full-page "${url}" "${filepath}"`,
        { timeout: 60000, stdio: 'pipe' }
      );
      
      if (fs.existsSync(filepath) && fs.statSync(filepath).size > 1000) {
        result.paths.push(filepath);
        if (vp.name === 'desktop') result.desktop = filepath;
        if (vp.name === 'mobile') result.mobile = filepath;
      }
    } catch (e) {
      result.error = `Screenshot ${vp.name} failed: ${e.message.substring(0, 100)}`;
    }
  }
  
  return result;
}

/**
 * Compare before/after screenshots using image model prompt.
 * Returns a structured comparison prompt for Claude/image model.
 * 
 * @param {string} beforeDesktop - Path to before desktop screenshot
 * @param {string} afterDesktop - Path to after desktop screenshot
 * @param {string} instructions - What was requested
 * @returns {string} Comparison prompt
 */
function buildComparisonPrompt(beforeDesktop, afterDesktop, instructions) {
  return `Compare these two website screenshots (BEFORE and AFTER a revision).

REVISION INSTRUCTIONS: ${instructions}

Check:
1. Was the requested change implemented? (YES/NO + detail)
2. Is anything ELSE broken or changed that shouldn't be? (regression check)
3. Is the layout still intact on both screenshots?
4. Are there any visual issues (broken images, overlapping text, missing sections)?

Respond:
CHANGE_IMPLEMENTED: YES|NO — explanation
REGRESSION: YES|NO — explanation  
LAYOUT_OK: YES|NO — explanation
VISUAL_ISSUES: NONE|list of issues

VERDICT: PASS|FAIL — summary`;
}

/**
 * Save screenshot references to data JSON for audit trail.
 * @param {string} slug
 * @param {object} before - { desktop, mobile }
 * @param {object} after - { desktop, mobile }
 * @param {string} verdict - PASS/FAIL
 */
function saveAuditTrail(slug, before, after, verdict) {
  return {
    before: { desktop: before.desktop, mobile: before.mobile },
    after: { desktop: after.desktop, mobile: after.mobile },
    verdict,
    timestamp: new Date().toISOString()
  };
}

/**
 * Clean up old screenshots for a slug (keep last 3 sets).
 * @param {string} slug
 */
function cleanup(slug) {
  const dir = path.join(SCREENSHOT_DIR, slug);
  if (!fs.existsSync(dir)) return;
  
  const files = fs.readdirSync(dir)
    .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  
  // Keep last 12 files (3 sets × 2 viewports × 2 before/after)
  const toDelete = files.slice(12);
  for (const f of toDelete) {
    try { fs.unlinkSync(path.join(dir, f.name)); } catch {}
  }
}

/**
 * Visual gate: take AFTER screenshots locally and compare with BEFORE.
 * Returns PASS/FAIL verdict.
 * 
 * @param {object} beforeScreenshots - { desktop: path, mobile: path }
 * @param {string} demoDir - Local directory with the new HTML files
 * @param {string} slug - Site slug
 * @param {string} instructions - What was requested
 * @returns {{ passed: boolean, verdict: string, afterScreenshots: object, error: string|null }}
 */
function visualGate(beforeScreenshots, demoDir, slug, instructions) {
  const result = { passed: false, verdict: '', afterScreenshots: { desktop: null, mobile: null }, error: null };
  
  // Find the main page to screenshot
  const indexFile = path.join(demoDir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    result.error = 'No index.html in demoDir';
    result.passed = true; // Don't block if no index
    result.verdict = 'SKIP — no index.html';
    return result;
  }
  
  // Take AFTER screenshots from local files
  const afterResult = takeScreenshots(`file://${indexFile}`, 'after', slug);
  result.afterScreenshots = { desktop: afterResult.desktop, mobile: afterResult.mobile };
  
  if (!afterResult.desktop || !beforeScreenshots.desktop) {
    result.error = `Missing screenshots: before=${!!beforeScreenshots.desktop} after=${!!afterResult.desktop}`;
    result.passed = false;
    result.verdict = 'FAIL — could not take screenshots for comparison';
    return result;
  }
  
  // Real image comparison using Claude with bypassPermissions
  try {
    const beforeSize = fs.statSync(beforeScreenshots.desktop).size;
    const afterSize = fs.statSync(afterResult.desktop).size;
    
    // If after screenshot is tiny (< 5KB), likely broken page
    if (afterSize < 5000) {
      result.passed = false;
      result.verdict = 'FAIL — after screenshot too small (likely broken page)';
      return result;
    }
    
    // Write comparison prompt to temp file
    const safeInstructions = instructions.replace(/["\\]/g, ' ').substring(0, 300);
    const promptFile = `/tmp/visual-gate-prompt-${slug}-${Date.now()}.md`;
    const promptText = `Look at these two screenshots of a website.

File 1 (BEFORE): ${beforeScreenshots.desktop}
File 2 (AFTER): ${afterResult.desktop}

The requested change was: "${safeInstructions}"

Compare them and answer EXACTLY in this format:

DESIGN_PRESERVED: YES or NO
CHANGE_APPLIED: YES or NO
REGRESSION: list any visual problems in AFTER that weren't in BEFORE (or NONE)
VERDICT: PASS or FAIL

PASS = layout, colors, nav, footer, sections all look the same. Only the requested change is visible.
FAIL = something broke: missing nav, broken layout, different colors, missing sections, etc.
Invisible changes (meta tags, schema) = always PASS.`;
    
    fs.writeFileSync(promptFile, promptText);
    
    const output = execSync(
      `claude --print --permission-mode bypassPermissions "Read ${promptFile} then look at the two image files mentioned in it and answer the questions." 2>/dev/null`,
      { timeout: 90000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PATH: `${process.env.PATH}:/home/clawd/.local/bin:/home/clawd/.npm-global/bin:/usr/local/bin:/usr/bin:/bin` }
      }
    ).toString().trim();
    
    // Cleanup prompt file
    try { fs.unlinkSync(promptFile); } catch {}
    
    result.verdict = output;
    
    // Parse verdict
    const verdictMatch = output.match(/VERDICT:\s*(PASS|FAIL)/i);
    const designMatch = output.match(/DESIGN_PRESERVED:\s*(YES|NO)/i);
    const regressionMatch = output.match(/REGRESSION:\s*(NONE|none)/i);
    
    if (verdictMatch) {
      result.passed = verdictMatch[1].toUpperCase() === 'PASS';
    } else if (designMatch) {
      result.passed = designMatch[1].toUpperCase() === 'YES';
    } else {
      // Can't parse — be conservative, fail
      result.passed = false;
      result.verdict += '\n[PARSE_FAIL — no VERDICT found, defaulting to FAIL]';
    }
    
  } catch (e) {
    result.error = `Visual gate error: ${e.message.substring(0, 200)}`;
    // On error, FAIL (conservative) — don't let broken code through
    result.passed = false;
    result.verdict = 'FAIL — visual gate error, blocking for safety';
  }
  
  return result;
}

module.exports = { takeScreenshots, buildComparisonPrompt, saveAuditTrail, cleanup, visualGate };
