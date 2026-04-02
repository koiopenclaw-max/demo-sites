#!/usr/bin/env node
// Module: demo-scope.js
// Demo Sites v2 — Phase 2: Scope Detection
// Uses Claude to analyze revision instructions BEFORE Codex runs.
// Determines: type (EDIT/CREATE/RESTRUCTURE), confidence, write/read-only files.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Analyze revision instructions and determine scope.
 * 
 * @param {string} instructions - The revision text from the client
 * @param {string[]} existingFiles - Current file manifest (from demo-manifest.js)
 * @param {string} siteName - Name of the site (for context)
 * @returns {{ type: string, confidence: string, writeFiles: string[], readOnlyFiles: string[], newFiles: string[], reasoning: string }}
 */
function analyzeScope(instructions, existingFiles, siteName) {
  try {
    const fileList = existingFiles.join('\n');
    
    const prompt = `You are a scope analyzer for website revisions. Analyze these revision instructions and determine what files need to change.

SITE: ${siteName}
EXISTING FILES:
${fileList}

REVISION INSTRUCTIONS:
${instructions}

Respond in EXACTLY this JSON format (no markdown, no explanation):
{
  "type": "EDIT|CREATE|RESTRUCTURE",
  "confidence": "high|medium|low",
  "writeFiles": ["files that need to be modified"],
  "newFiles": ["new files that need to be created"],
  "readOnlyFiles": ["existing files that should NOT be touched"],
  "reasoning": "one sentence explaining the decision"
}

RULES:
- EDIT = changing content/styling in existing files (e.g. "смени снимката", "промени текста", "оправи бутона")
- CREATE = adding new pages/files (e.g. "създай страница за услуги", "добави галерия")
- RESTRUCTURE = major reorganization affecting navigation, layout, or multiple pages simultaneously (e.g. "преработи целия сайт", "смени темплейта")
- high confidence = clear, specific instruction affecting 1-3 files
- medium confidence = somewhat ambiguous or affects 4+ files
- low confidence = vague instruction, unclear scope, or could mean multiple things
- writeFiles = ONLY files that MUST change to fulfill the instruction
- readOnlyFiles = ALL other existing files (they must NOT be modified)
- If instruction mentions ONLY styling/text changes on homepage → writeFiles: ["index.html"]
- If instruction mentions specific pages → writeFiles: only those pages
- When in doubt, FEWER writeFiles is safer (more conservative scope)`;

    const result = execSync(
      `claude --print --permission-mode bypassPermissions "${prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
      { timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1024 * 1024 }
    ).trim();
    
    // Extract JSON from response (Claude might wrap in markdown)
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[demo-scope] No JSON in Claude response:', result.substring(0, 200));
      return fallbackScope(existingFiles);
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    // Validate required fields
    if (!['EDIT', 'CREATE', 'RESTRUCTURE'].includes(parsed.type)) parsed.type = 'EDIT';
    if (!['high', 'medium', 'low'].includes(parsed.confidence)) parsed.confidence = 'medium';
    if (!Array.isArray(parsed.writeFiles)) parsed.writeFiles = ['index.html'];
    if (!Array.isArray(parsed.readOnlyFiles)) parsed.readOnlyFiles = existingFiles.filter(f => !parsed.writeFiles.includes(f));
    if (!Array.isArray(parsed.newFiles)) parsed.newFiles = [];
    if (!parsed.reasoning) parsed.reasoning = 'No reasoning provided';
    
    // Ensure readOnlyFiles includes everything not in writeFiles
    parsed.readOnlyFiles = existingFiles.filter(f => !parsed.writeFiles.includes(f));
    
    return parsed;
  } catch (e) {
    console.error('[demo-scope] analyzeScope error:', e.message.substring(0, 200));
    return fallbackScope(existingFiles);
  }
}

/**
 * Fallback scope when Claude fails — conservative defaults.
 */
function fallbackScope(existingFiles) {
  return {
    type: 'EDIT',
    confidence: 'low',
    writeFiles: existingFiles.filter(f => f.endsWith('.html')),
    readOnlyFiles: existingFiles.filter(f => !f.endsWith('.html')),
    newFiles: [],
    reasoning: 'Fallback: Claude scope analysis failed. Allowing all HTML files as writable.'
  };
}

/**
 * Determine if the task should proceed automatically or needs human input.
 * 
 * @param {{ type: string, confidence: string }} scope
 * @returns {{ action: string, reason: string }}
 *   action: 'PROCEED' | 'STOP'
 *   STOP = low confidence, needs human clarification
 */
function shouldProceed(scope) {
  if (scope.confidence === 'low') {
    return { action: 'STOP', reason: `Low confidence scope detection (type: ${scope.type}). Needs human clarification.` };
  }
  return { action: 'PROCEED', reason: `${scope.type} with ${scope.confidence} confidence.` };
}

/**
 * Create a sandboxed build directory with ONLY the allowed files.
 * Codex physically cannot access files outside this sandbox.
 * 
 * @param {string} sourceDir - Original project directory
 * @param {string} sandboxDir - Target sandbox directory (will be created)
 * @param {string[]} writeFiles - Files Codex can modify
 * @param {string[]} readOnlyFiles - Files Codex can read (copied as reference)
 * @param {string[]} newFiles - New files Codex should create (just names, empty)
 * @returns {boolean}
 */
function createSandbox(sourceDir, sandboxDir, writeFiles, readOnlyFiles, newFiles) {
  try {
    if (fs.existsSync(sandboxDir)) {
      execSync(`rm -rf "${sandboxDir}"`, { stdio: 'pipe' });
    }
    fs.mkdirSync(sandboxDir, { recursive: true });
    
    // Copy write files (Codex can modify these)
    for (const f of writeFiles) {
      const src = path.join(sourceDir, f);
      const dest = path.join(sandboxDir, f);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
    
    // Copy read-only files into a _readonly/ subdirectory (for reference, not in-place)
    const readonlyDir = path.join(sandboxDir, '_readonly');
    fs.mkdirSync(readonlyDir, { recursive: true });
    for (const f of readOnlyFiles) {
      const src = path.join(sourceDir, f);
      const dest = path.join(readonlyDir, f);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
    
    // Write a SCOPE.md so Codex knows the rules
    const scopeDoc = `# SCOPE LOCK — DO NOT VIOLATE

## Files you CAN modify:
${writeFiles.map(f => `- ${f}`).join('\n')}

## Files you can READ (in _readonly/) but MUST NOT modify:
${readOnlyFiles.map(f => `- _readonly/${f}`).join('\n')}

## New files you may CREATE:
${newFiles.length > 0 ? newFiles.map(f => `- ${f}`).join('\n') : '- (none)'}

## RULES:
- ONLY modify files listed above
- Reference _readonly/ files for CSS, navigation structure, design consistency
- DO NOT recreate or modify _readonly files
- Any new file must match the design language of the existing files
`;
    fs.writeFileSync(path.join(sandboxDir, 'SCOPE.md'), scopeDoc);
    
    return true;
  } catch (e) {
    console.error('[demo-scope] createSandbox error:', e.message.substring(0, 200));
    return false;
  }
}

/**
 * Classify a revision into AUTO / SUPERVISED / MANUAL.
 * Determines who validates and how fast the flow is.
 * 
 * AUTO (~3-5 min): Simple changes. Image model validates automatically.
 * SUPERVISED (~6-10 min): Complex changes. Koi validates personally.
 * MANUAL (hours): Unclear instructions. Stop and ask Крис.
 * 
 * @param {string} instructions - Revision text from client
 * @param {{ type: string, confidence: string, writeFiles: string[], newFiles: string[] }} scope - From analyzeScope()
 * @returns {{ mode: 'AUTO'|'SUPERVISED'|'MANUAL', reason: string }}
 */
function classifyRevision(instructions, scope) {
  if (!instructions || !scope) {
    return { mode: 'MANUAL', reason: 'Missing instructions or scope data' };
  }

  const text = instructions.toLowerCase();
  const fileCount = (scope.writeFiles?.length || 0) + (scope.newFiles?.length || 0);

  // MANUAL: low confidence or RESTRUCTURE type
  if (scope.confidence === 'low') {
    return { mode: 'MANUAL', reason: `Low confidence scope — needs clarification` };
  }
  if (scope.type === 'RESTRUCTURE') {
    return { mode: 'SUPERVISED', reason: `RESTRUCTURE type — Koi validates` };
  }

  // AUTO indicators: simple, specific, single-file changes
  const simplePatterns = [
    /смени (телефон|мейл|email|адрес|час|работно време)/,
    /промени (текст|заглави|цвят|цена|цифр)/,
    /добави (телефон|мейл|адрес)/,
    /оправи (линк|връзк|правопис)/,
    /махни (текст|секци|елемент)/,
    /смени (шрифт|font)/,
    /размер|font.?size|padding|margin/,
  ];

  // SUPERVISED indicators: complex, multi-file, visual changes
  const complexPatterns = [
    /layout|оформлени/,
    /секци|section/,
    /responsive|мобилн/,
    /навигаци|меню|dropdown/,
    /галери|slider|carousel/,
    /цял|redesign|редизайн|преработ/,
    /създай.*страниц|нова страниц|добави.*страниц/,
  ];

  const isSimple = simplePatterns.some(p => p.test(text));
  const isComplex = complexPatterns.some(p => p.test(text));

  // Decision matrix
  if (isComplex || fileCount > 3 || scope.confidence === 'medium') {
    return { mode: 'SUPERVISED', reason: `Complex change (files: ${fileCount}, confidence: ${scope.confidence})` };
  }

  if (isSimple && fileCount <= 3 && scope.confidence === 'high') {
    return { mode: 'AUTO', reason: `Simple ${scope.type} change, ${fileCount} file(s), high confidence` };
  }

  // Default: SUPERVISED (safe)
  return { mode: 'SUPERVISED', reason: `Default — ${scope.type}/${scope.confidence}, ${fileCount} files` };
}

module.exports = { analyzeScope, shouldProceed, createSandbox, fallbackScope, classifyRevision };
