#!/usr/bin/env node
// Module: demo-slop.js
// Demo Sites v2 — Phase 4: AI Slop Detection
// Programmatic slop scoring — takes image model response text,
// returns structured score/grade/fix prompts.
// The actual image analysis is done by Koi (via image tool) —
// this module handles parsing and scoring.

const fs = require('fs');

const PATTERNS = [
  { id: 'SLOP-01', name: 'Gradient hero', weight: 15 },
  { id: 'SLOP-02', name: '3-col symmetric grid', weight: 15 },
  { id: 'SLOP-03', name: 'Uniform border-radius', weight: 10 },
  { id: 'SLOP-04', name: 'Generic SVG icons', weight: 15 },
  { id: 'SLOP-05', name: 'No personality', weight: 25 },
  { id: 'SLOP-06', name: 'All center-aligned', weight: 10 },
  { id: 'SLOP-07', name: 'No hover/focus', weight: 10 },
];

const FIX_PROMPTS = {
  'SLOP-01': 'Replace gradient hero with solid background color from client\'s brand palette. Use bold typography (48-64px) as visual anchor instead of color transitions.',
  'SLOP-02': 'Replace 3-column symmetric grid with asymmetric layout. Options: 2+1 split, masonry, or single-column with varied card sizes. No three identical cards in a row.',
  'SLOP-03': 'Vary border-radius by element role: data/badges 4px, cards/containers 8px, images/avatars 16px or circle, buttons 6px.',
  'SLOP-04': 'Replace generic SVG icons with specific Font Awesome or Tabler icons relevant to business niche. Each icon must be identifiable at 24x24px. No abstract shapes.',
  'SLOP-05': 'Add ONE creative risk that makes this site unmistakably THIS business. Options: distinctive accent color, unexpected font pairing, asymmetric hero, industry-specific visual metaphor.',
  'SLOP-06': 'Left-align all body text and descriptions. Center-align only: main headings, CTA buttons, footer copyright.',
  'SLOP-07': 'Add hover states: buttons darken 10% + scale(1.02), cards get subtle shadow elevation, links get underline. Transition: 0.2s ease.',
};

/**
 * The prompt to send with a screenshot to the image model.
 * Koi uses this with the `image` tool.
 */
const ANALYSIS_PROMPT = `Analyze this website screenshot for these 7 AI-generated design patterns.
For each pattern, respond with EXACTLY this format (one per line):
SLOP-01: DETECTED|CLEAR - <one sentence explanation>
SLOP-02: DETECTED|CLEAR - <one sentence explanation>
SLOP-03: DETECTED|CLEAR - <one sentence explanation>
SLOP-04: DETECTED|CLEAR - <one sentence explanation>
SLOP-05: DETECTED|CLEAR - <one sentence explanation>
SLOP-06: DETECTED|CLEAR - <one sentence explanation>
SLOP-07: DETECTED|CLEAR - <one sentence explanation>

Patterns:
SLOP-01 (15pts): Gradient hero section? (pastel/soft color transitions in hero area)
SLOP-02 (15pts): 3-column symmetric card grid? (3 identical cards in a row)
SLOP-03 (10pts): Uniform border-radius on everything? (same rounded corners everywhere)
SLOP-04 (15pts): Generic/abstract SVG icons? (unidentifiable at small size)
SLOP-05 (25pts): Generic "clean modern" look without brand personality? (could be any business)
SLOP-06 (10pts): All text center-aligned including body paragraphs?
SLOP-07 (10pts): No visible hover/focus states on interactive elements?

Be strict. If in doubt, mark DETECTED.`;

function getGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 50) return 'C';
  if (score >= 25) return 'D';
  return 'F';
}

/**
 * Parse image model response into structured slop results.
 * 
 * @param {string} response - Raw text from image model analysis
 * @returns {Array<{id: string, name: string, weight: number, detected: boolean, detail: string, fixPrompt: string|null}>}
 */
function parseResponse(response) {
  const results = [];

  for (const pattern of PATTERNS) {
    const regex = new RegExp(`${pattern.id}[:\\s]+(DETECTED|CLEAR)\\s*[-–—:]\\s*(.+)`, 'i');
    const match = response.match(regex);

    if (match) {
      const detected = match[1].toUpperCase() === 'DETECTED';
      results.push({
        id: pattern.id,
        name: pattern.name,
        weight: pattern.weight,
        detected,
        detail: match[2].trim(),
        fixPrompt: detected ? FIX_PROMPTS[pattern.id] : null,
      });
    } else {
      results.push({
        id: pattern.id,
        name: pattern.name,
        weight: pattern.weight,
        detected: true,
        detail: 'Could not parse response — marked DETECTED for safety',
        fixPrompt: FIX_PROMPTS[pattern.id],
      });
    }
  }

  return results;
}

/**
 * Calculate score and grade from parsed patterns.
 * 
 * @param {Array} patterns - Output from parseResponse
 * @param {string[]} overrides - Patterns to exclude from scoring, e.g. ["SLOP-01: gradient requested by client"]
 * @returns {{ score: number, grade: string, detectedCount: number, fixPrompts: Array }}
 */
function calculateScore(patterns, overrides = []) {
  const overrideIds = new Set(overrides.map(o => o.split(':')[0].trim()));

  let deducted = 0;
  let detectedCount = 0;
  const fixPrompts = [];

  for (const p of patterns) {
    if (p.detected) {
      detectedCount++;
      if (!overrideIds.has(p.id)) {
        deducted += p.weight;
      }
      fixPrompts.push({ id: p.id, name: p.name, prompt: p.fixPrompt });
    }
  }

  const score = 100 - deducted;
  const grade = getGrade(score);

  return { score, grade, detectedCount, fixPrompts };
}

/**
 * Full slop analysis pipeline: parse + score + report.
 * 
 * @param {string} response - Raw image model response
 * @param {object} meta - { slug, url, screenshotPath }
 * @param {string[]} overrides - Optional overrides
 * @returns {{ patterns: Array, score: number, grade: string, detectedCount: number, fixPrompts: Array, canShip: boolean, report: string }}
 */
function analyzeSlop(response, meta = {}, overrides = []) {
  const patterns = parseResponse(response);
  const { score, grade, detectedCount, fixPrompts } = calculateScore(patterns, overrides);
  const canShip = grade === 'A' || grade === 'B';

  // Human-readable report
  let report = `AI SLOP REPORT — Score: ${score}/100 (${grade})\n`;
  report += `${'='.repeat(50)}\n\n`;

  for (const p of patterns) {
    const status = p.detected ? '🔴 DETECTED' : '🟢 CLEAR';
    report += `${p.id} [${p.weight}pt] ${p.name}: ${status}\n`;
    report += `  ${p.detail}\n`;
    if (p.fixPrompt) report += `  FIX: ${p.fixPrompt}\n`;
    report += '\n';
  }

  report += canShip
    ? `✅ Grade ${grade} — OK to ship${grade === 'B' ? ' (fix recommended before final delivery)' : ''}\n`
    : `❌ Grade ${grade} — DO NOT SHIP. Fix required.\n`;

  // Save report to file if slug provided
  if (meta.slug) {
    const reportPath = `/tmp/slop-report-${meta.slug}-${Date.now()}.json`;
    const reportData = {
      timestamp: new Date().toISOString(),
      slug: meta.slug,
      url: meta.url || null,
      screenshot: meta.screenshotPath || null,
      patterns,
      score,
      grade,
      detectedCount,
      overrides,
      fixPrompts,
      canShip,
    };
    try {
      fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
      report += `Report saved: ${reportPath}\n`;
    } catch {}
  }

  return { patterns, score, grade, detectedCount, fixPrompts, canShip, report };
}

/**
 * Generate Codex fix prompt from slop results.
 * Combines all detected patterns into one actionable prompt section.
 * 
 * @param {Array} fixPrompts - From analyzeSlop().fixPrompts
 * @returns {string} Prompt section for Codex
 */
function generateFixPrompt(fixPrompts) {
  if (!fixPrompts || fixPrompts.length === 0) return '';

  let prompt = '\n=== AI SLOP FIXES REQUIRED ===\n';
  prompt += 'The following AI-generated design patterns were detected. Fix ALL of them:\n\n';

  for (const fp of fixPrompts) {
    prompt += `${fp.id} (${fp.name}):\n  ${fp.prompt}\n\n`;
  }

  prompt += 'IMPORTANT: Fix these patterns while maintaining the overall design and content.\n';
  prompt += 'Do NOT do a full rewrite — make targeted fixes for each pattern.\n';

  return prompt;
}

module.exports = {
  PATTERNS,
  FIX_PROMPTS,
  ANALYSIS_PROMPT,
  parseResponse,
  calculateScore,
  analyzeSlop,
  generateFixPrompt,
  getGrade,
};
