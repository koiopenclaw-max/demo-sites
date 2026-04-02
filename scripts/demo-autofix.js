#!/usr/bin/env node
// Module: demo-autofix.js
// Demo Sites v2 — Phase 4: Auto-Fix Pipeline
// When QA or Slop blocks shipping, this module generates
// a concrete fix prompt and orchestrates the fix cycle.
// No human in the loop — auto-fix up to 3 attempts, then escalate.

const fs = require('fs');
const path = require('path');

const MAX_ATTEMPTS = 3;

/**
 * Generate a fix prompt from QA failures.
 * Translates each failed check into a concrete Codex instruction.
 * 
 * @param {Array<{name: string, passed: boolean, severity: string, detail: string}>} checks - From demo-qa.js
 * @param {object} measurements - Optional measurements from demo-measure.js
 * @returns {string} Codex-ready fix prompt section
 */
function generateQAFixPrompt(checks, measurements = null) {
  const failed = checks.filter(c => !c.passed);
  if (failed.length === 0) return '';

  let prompt = '\n=== QA FIXES REQUIRED ===\n';
  prompt += 'The following automated checks FAILED. Fix ALL of them.\n\n';

  // Group by check type (strip viewport suffix)
  const grouped = {};
  for (const c of failed) {
    const base = c.name.replace(/-(desktop|tablet|mobile)$/, '');
    if (!grouped[base]) grouped[base] = [];
    grouped[base].push(c);
  }

  for (const [name, items] of Object.entries(grouped)) {
    switch (name) {
      case 'no-h-overflow': {
        prompt += `CRITICAL — Horizontal overflow detected:\n`;
        for (const c of items) {
          const vp = c.name.match(/-(desktop|tablet|mobile)$/)?.[1] || '?';
          const match = c.detail.match(/scrollWidth=(\d+)\s*>\s*clientWidth=(\d+)/);
          if (match) {
            const overflow = parseInt(match[1]) - parseInt(match[2]);
            prompt += `  ${vp}: ${c.detail} (${overflow}px overflow)\n`;
          } else {
            prompt += `  ${vp}: ${c.detail}\n`;
          }
        }
        prompt += `FIX: Find the element(s) causing overflow. Common causes:\n`;
        prompt += `  - Fixed-width elements wider than viewport (check tables, images, pre/code blocks)\n`;
        prompt += `  - Negative margins pushing content outside viewport\n`;
        prompt += `  - Missing overflow-x: hidden on container\n`;
        prompt += `  - Padding not included in width (add box-sizing: border-box)\n`;
        prompt += `  Debug: add "* { outline: 1px solid red; }" temporarily to find the culprit.\n`;
        prompt += `  VERIFY: document.documentElement.scrollWidth <= document.documentElement.clientWidth on ALL viewports.\n\n`;
        break;
      }

      case 'images-loaded': {
        const allBroken = new Set();
        for (const c of items) {
          const match = c.detail.match(/broken: (.+)/);
          if (match) match[1].split(', ').forEach(u => allBroken.add(u));
        }
        prompt += `WARNING — Broken images (${allBroken.size}):\n`;
        for (const url of allBroken) {
          prompt += `  ${url}\n`;
        }
        prompt += `FIX: For each broken image:\n`;
        prompt += `  1. If external URL (unsplash, etc.) — replace with a working URL or local image\n`;
        prompt += `  2. If local file — check path is correct relative to HTML file\n`;
        prompt += `  3. Add width/height attributes to prevent layout shift\n\n`;
        break;
      }

      case 'hero-visible': {
        prompt += `CRITICAL — Hero section not visible:\n`;
        for (const c of items) {
          prompt += `  ${c.detail}\n`;
        }
        prompt += `FIX: Ensure hero section is visible on page load:\n`;
        prompt += `  - Remove opacity: 0, display: none, visibility: hidden from hero and its parents\n`;
        prompt += `  - If using reveal animations — set initial state to visible, animate FROM visible\n`;
        prompt += `  - Ensure hero has min-height and content is not clipped\n\n`;
        break;
      }

      case 'no-js-errors': {
        prompt += `WARNING — JavaScript console errors:\n`;
        for (const c of items) prompt += `  ${c.detail}\n`;
        prompt += `FIX: Open browser console, fix all JS errors. Common: missing elements, undefined variables.\n\n`;
        break;
      }

      case 'meta-title': {
        prompt += `WARNING — Title tag issue:\n`;
        for (const c of items) prompt += `  ${c.detail}\n`;
        prompt += `FIX: Title should be 10-60 characters. Format: "Business Name | Short Description"\n\n`;
        break;
      }

      case 'meta-description': {
        prompt += `WARNING — Missing meta description:\n`;
        prompt += `FIX: Add <meta name="description" content="..."> with 120-160 characters describing the business.\n\n`;
        break;
      }

      case 'meta-viewport': {
        prompt += `CRITICAL — Missing viewport meta tag:\n`;
        prompt += `FIX: Add to <head>: <meta name="viewport" content="width=device-width, initial-scale=1.0">\n\n`;
        break;
      }

      case 'internal-links': {
        prompt += `WARNING — Broken internal links:\n`;
        for (const c of items) prompt += `  ${c.detail}\n`;
        prompt += `FIX: Check all <a href="..."> links. Ensure target files exist and paths are correct.\n\n`;
        break;
      }

      case 'footer-exists': {
        prompt += `WARNING — Footer missing or empty:\n`;
        prompt += `FIX: Add a <footer> with business name, copyright year, and contact info.\n\n`;
        break;
      }

      default: {
        prompt += `${items[0].severity.toUpperCase()} — ${name}:\n`;
        for (const c of items) prompt += `  ${c.detail}\n`;
        prompt += '\n';
      }
    }
  }

  // Add measurements if available
  if (measurements) {
    const { generateMeasurePrompt } = require('./demo-measure.js');
    prompt += generateMeasurePrompt(measurements);
  }

  return prompt;
}

/**
 * Build a complete auto-fix context for a failed QA/Slop check.
 * This becomes the input for Codex or the revision worker.
 * 
 * @param {object} params
 * @param {string} params.slug - Project slug
 * @param {string} params.siteName - Human-readable site name
 * @param {object} params.qaResult - From demo-qa.js runQA()
 * @param {object} params.slopResult - From demo-slop.js analyzeSlop() (optional)
 * @param {object} params.measurements - From demo-measure.js (optional)
 * @param {string[]} params.writeFiles - Files that can be modified
 * @param {number} params.attempt - Current attempt number (1-3)
 * @param {string} params.previousFeedback - What went wrong on previous attempt (if any)
 * @returns {{ prompt: string, contextFile: string, shouldProceed: boolean, reason: string }}
 */
function buildFixContext(params) {
  const {
    slug, siteName, qaResult, slopResult,
    measurements, writeFiles, attempt = 1, previousFeedback = null
  } = params;

  // Determine if we should even try
  if (attempt > MAX_ATTEMPTS) {
    return {
      prompt: '',
      contextFile: null,
      shouldProceed: false,
      reason: `Max attempts (${MAX_ATTEMPTS}) reached for ${slug}. Escalating to topic 49.`
    };
  }

  let prompt = `# AUTO-FIX: ${siteName} (Attempt ${attempt}/${MAX_ATTEMPTS})\n\n`;
  prompt += `You are fixing quality issues detected by automated QA on this website.\n`;
  prompt += `Fix ONLY the issues listed below. Do NOT rewrite or redesign anything else.\n\n`;

  // Add previous attempt feedback
  if (previousFeedback && attempt > 1) {
    prompt += `=== PREVIOUS ATTEMPT FAILED ===\n`;
    prompt += `Attempt ${attempt - 1} did not resolve these issues:\n`;
    prompt += `${previousFeedback}\n\n`;
    prompt += `DO NOT repeat the same approach. Try a DIFFERENT fix strategy.\n\n`;
  }

  // Files constraint
  prompt += `=== ALLOWED FILES ===\n`;
  prompt += `You may ONLY modify: ${writeFiles.join(', ')}\n\n`;

  // QA fixes
  if (qaResult && !qaResult.passed) {
    prompt += generateQAFixPrompt(qaResult.checks, measurements);
  }

  // Slop fixes
  if (slopResult && !slopResult.canShip) {
    const { generateFixPrompt } = require('./demo-slop.js');
    prompt += generateFixPrompt(slopResult.fixPrompts);
  }

  prompt += `\n=== VALIDATION ===\n`;
  prompt += `After fixing, the site MUST pass these checks:\n`;
  prompt += `1. No horizontal overflow on any viewport (390px, 768px, 1200px)\n`;
  prompt += `2. All images load successfully\n`;
  prompt += `3. Hero section visible on page load\n`;
  prompt += `4. No JavaScript console errors\n`;
  prompt += `5. All internal links work\n`;

  // Save context file
  const contextFile = `/tmp/demo-autofix-${slug}-attempt${attempt}.json`;
  const context = {
    slug,
    siteName,
    attempt,
    maxAttempts: MAX_ATTEMPTS,
    timestamp: new Date().toISOString(),
    writeFiles,
    qaFailed: qaResult ? qaResult.checks.filter(c => !c.passed).map(c => c.name) : [],
    slopFailed: slopResult ? slopResult.fixPrompts.map(f => f.id) : [],
    previousFeedback,
    prompt,
  };

  try {
    fs.writeFileSync(contextFile, JSON.stringify(context, null, 2));
  } catch {}

  return {
    prompt,
    contextFile,
    shouldProceed: true,
    reason: `Attempt ${attempt}/${MAX_ATTEMPTS} — ${qaResult?.criticalFails || 0} critical, ${slopResult ? 'slop ' + slopResult.grade : 'no slop check'}`
  };
}

/**
 * Evaluate fix results after a Codex run.
 * Compares before/after QA to determine success.
 * 
 * @param {object} beforeQA - QA result before fix
 * @param {object} afterQA - QA result after fix
 * @param {object} beforeSlop - Slop result before fix (optional)
 * @param {object} afterSlop - Slop result after fix (optional)
 * @returns {{ fixed: boolean, improved: boolean, feedback: string, remainingIssues: string[] }}
 */
function evaluateFix(beforeQA, afterQA, beforeSlop = null, afterSlop = null) {
  const remainingIssues = [];

  // Check QA improvement
  const beforeCritical = beforeQA.criticalFails;
  const afterCritical = afterQA.criticalFails;
  const beforeWarnings = beforeQA.warnings;
  const afterWarnings = afterQA.warnings;

  // Collect remaining failures
  for (const c of afterQA.checks) {
    if (!c.passed && c.severity === 'critical') {
      remainingIssues.push(`[CRITICAL] ${c.name}: ${c.detail}`);
    }
  }

  // Check slop improvement
  if (afterSlop && !afterSlop.canShip) {
    for (const p of afterSlop.patterns) {
      if (p.detected) {
        remainingIssues.push(`[SLOP] ${p.id}: ${p.detail}`);
      }
    }
  }

  const fixed = afterQA.passed && (!afterSlop || afterSlop.canShip);
  const improved = afterCritical < beforeCritical ||
    (afterSlop && beforeSlop && afterSlop.score > beforeSlop.score);

  let feedback = '';
  if (!fixed) {
    feedback = `Still failing after fix. `;
    feedback += `Critical: ${beforeCritical} → ${afterCritical}. `;
    feedback += `Warnings: ${beforeWarnings} → ${afterWarnings}. `;
    if (beforeSlop && afterSlop) {
      feedback += `Slop: ${beforeSlop.score} → ${afterSlop.score}. `;
    }
    feedback += `Remaining: ${remainingIssues.join('; ')}`;
  }

  return { fixed, improved, feedback, remainingIssues };
}

module.exports = {
  generateQAFixPrompt,
  buildFixContext,
  evaluateFix,
  MAX_ATTEMPTS,
};
