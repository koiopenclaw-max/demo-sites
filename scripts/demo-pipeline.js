#!/usr/bin/env node
// Module: demo-pipeline.js
// Demo Sites v2 — Phase 5: Pipeline Orchestrator
// Coordinates ALL v2 modules in sequence for build and revision flows.
// Called by demo-worker.js — replaces scattered v2 module calls with one pipeline.
//
// Flow: manifest → scope → sandbox → measure → [codex] → diff → deploy → QA → slop → ship/autofix
//
// The [codex] step is handled by the CALLER (worker) — pipeline provides
// pre-codex setup and post-codex validation.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Import v2 modules (all optional — degrade gracefully)
let demoTags, demoManifest, demoScope, demoDiff, demoMeasure, demoFallback, demoSlop, demoQA, demoAutofix;
try { demoTags = require('./demo-tags.js'); } catch {}
try { demoManifest = require('./demo-manifest.js'); } catch {}
try { demoScope = require('./demo-scope.js'); } catch {}
try { demoDiff = require('./demo-diff.js'); } catch {}
try { demoMeasure = require('./demo-measure.js'); } catch {}
try { demoFallback = require('./demo-fallback.js'); } catch {}
try { demoSlop = require('./demo-slop.js'); } catch {}
try { demoQA = require('./demo-qa.js'); } catch {}
try { demoAutofix = require('./demo-autofix.js'); } catch {}

const DEMO_REPO = '/home/clawd/Projects/demo-sites';

// ========================================================
// CLARIFICATION: When scope is too vague, ask smart questions
// ========================================================

/**
 * Generate clarification questions for vague revision instructions.
 * Uses Claude to produce specific, actionable questions in Bulgarian.
 * 
 * @param {string} instructions - The vague revision text
 * @param {string} siteName - Site name for context
 * @param {string[]} manifest - Current file list
 * @returns {{ questions: string[], category: string }}
 */
function generateClarificationQuestions(instructions, siteName, manifest) {
  try {
    const prompt = `You are helping a web design client clarify vague feedback about their demo website "${siteName}".

The client wrote: "${instructions}"

Current site files: ${manifest.join(', ')}

Generate 3-5 SHORT, SPECIFIC questions in Bulgarian that will help us understand EXACTLY what they want changed.
Each question should offer concrete options so the client can just pick one.

Format: one question per line, no numbering, no bullet points.
Example good question: "Цветовете ли не ви харесват? Предпочитате по-тъмна, по-светла или изцяло различна цветова схема?"
Example bad question: "Какво точно не ви харесва?" (too vague)

RESPOND WITH ONLY THE QUESTIONS, nothing else.`;

    const result = execSync(
      `claude --print --permission-mode bypassPermissions "${prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
      { timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1024 * 1024 }
    ).trim();

    const questions = result.split('\n').map(q => q.trim()).filter(q => q.length > 10 && q.includes('?'));

    // Determine category from original instruction
    let category = 'general';
    if (/цвят|цветов|тъм|свет|шарен/i.test(instructions)) category = 'colors';
    else if (/снимк|изображен|картин|фото/i.test(instructions)) category = 'images';
    else if (/текст|надпис|загл|съдърж/i.test(instructions)) category = 'content';
    else if (/мобил|телефон|респонс/i.test(instructions)) category = 'responsive';
    else if (/меню|навигац|линк/i.test(instructions)) category = 'navigation';
    else if (/бавн|зарежд|скорост/i.test(instructions)) category = 'performance';

    return { questions: questions.slice(0, 5), category };
  } catch (e) {
    // Fallback: generic but still useful questions
    return {
      questions: [
        'Кое конкретно не ви харесва — цветове, подредба, снимки или текстове?',
        'На коя страница виждате проблема — начална, услуги, контакти?',
        'Имате ли пример за сайт, който ви харесва, за да разберем стила?',
        'Проблемът на компютър ли е или на телефон?'
      ],
      category: 'general'
    };
  }
}

/**
 * Handle the STOP decision from scope detection.
 * Instead of doing nothing, generates questions and updates the data JSON.
 * 
 * @param {object} params
 * @param {string} params.slug
 * @param {string} params.siteName
 * @param {string} params.instructions
 * @param {string[]} params.manifest
 * @param {string} params.stopReason
 * @returns {{ questions: string[], category: string, dataUpdate: object }}
 */
function handleScopeStop(params) {
  const { slug, siteName, instructions, manifest, stopReason } = params;

  const { questions, category } = generateClarificationQuestions(instructions, siteName, manifest);

  const dataUpdate = {
    status: 'needs_clarification',
    clarification: {
      questions,
      category,
      originalInstruction: instructions,
      reason: stopReason,
      askedAt: new Date().toISOString(),
    },
  };

  return { questions, category, dataUpdate };
}

/**
 * Pipeline state — tracks progress through each phase.
 * Persisted to /tmp so Koi can inspect on wake.
 */
function createState(slug, action) {
  return {
    slug,
    action,
    startedAt: new Date().toISOString(),
    phases: {},
    errors: [],
    currentPhase: null,
  };
}

function logPhase(state, phase, result) {
  state.phases[phase] = {
    ...result,
    completedAt: new Date().toISOString(),
  };
  state.currentPhase = phase;
  // Persist state
  try {
    const statePath = `/tmp/demo-pipeline-${state.slug.replace(/[^a-zA-Z0-9а-яА-Я-]/g, '_')}.json`;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {}
}

// ========================================================
// PRE-CODEX: Setup everything before Codex runs
// ========================================================

/**
 * Pre-Codex pipeline: tag → manifest → scope → sandbox → measure
 * 
 * @param {object} params
 * @param {string} params.slug
 * @param {string} params.siteName
 * @param {string} params.instructions - Revision instructions or build brief
 * @param {string} params.workDir - Current working directory for the project
 * @param {string} params.action - 'revision' | 'build'
 * @param {string} params.liveUrl - Live URL for measurements (optional)
 * @returns {{ state: object, scope: object|null, sandboxDir: string|null, measurePrompt: string, manifest: string[], proceed: boolean, stopReason: string|null }}
 */
function preCodex(params) {
  const { slug, siteName, instructions, workDir, action, liveUrl } = params;
  const state = createState(slug, action);
  const result = {
    state,
    scope: null,
    sandboxDir: null,
    measurePrompt: '',
    manifest: [],
    proceed: true,
    stopReason: null,
  };

  // Phase 1a: Git tag (pre-revision snapshot)
  if (demoTags) {
    try {
      const prefix = action === 'revision' ? 'pre-rev' : 'pre-build';
      const tag = demoTags.createTag(DEMO_REPO, prefix, slug);
      logPhase(state, 'tag', { tag, success: !!tag });
    } catch (e) {
      logPhase(state, 'tag', { success: false, error: e.message.substring(0, 100) });
    }
  }

  // Phase 1b: File manifest
  if (demoManifest) {
    try {
      const manifest = demoManifest.generateManifest(slug, workDir);
      result.manifest = manifest;
      logPhase(state, 'manifest', { fileCount: manifest.length, files: manifest });
    } catch (e) {
      logPhase(state, 'manifest', { fileCount: 0, error: e.message.substring(0, 100) });
    }
  }

  // Phase 2a: Scope detection (revision only)
  if (demoScope && action === 'revision' && result.manifest.length > 0) {
    try {
      const scope = demoScope.analyzeScope(instructions, result.manifest, siteName);
      result.scope = scope;
      logPhase(state, 'scope', {
        type: scope.type,
        confidence: scope.confidence,
        writeFiles: scope.writeFiles,
        newFiles: scope.newFiles,
        reasoning: scope.reasoning,
      });

      // Check if we should proceed
      const decision = demoScope.shouldProceed(scope);
      if (decision.action === 'STOP') {
        result.proceed = false;
        result.stopReason = decision.reason;
        logPhase(state, 'scope-decision', { action: 'STOP', reason: decision.reason });
        return result;
      }
    } catch (e) {
      logPhase(state, 'scope', { error: e.message.substring(0, 200) });
      // Continue without scope — fallback to full access
    }
  }

  // Phase 2b: Create sandbox (revision only, if scope available)
  if (demoScope && result.scope && action === 'revision') {
    try {
      const sandboxDir = `/tmp/demo-sandbox-${slug.replace(/[^a-zA-Z0-9а-яА-Я-]/g, '_')}`;
      const ok = demoScope.createSandbox(
        workDir, sandboxDir,
        result.scope.writeFiles,
        result.scope.readOnlyFiles,
        result.scope.newFiles || []
      );
      if (ok) {
        result.sandboxDir = sandboxDir;
        logPhase(state, 'sandbox', { dir: sandboxDir, success: true });
      }
    } catch (e) {
      logPhase(state, 'sandbox', { success: false, error: e.message.substring(0, 100) });
    }
  }

  // Phase 3a: Measure layout (if live URL available)
  if (demoMeasure && liveUrl) {
    try {
      const selectors = result.scope?.writeFiles?.some(f => f.includes('uslugi') || f.includes('services'))
        ? ['header', 'nav', '.hero', 'main', '.services', '.card', 'footer']
        : ['header', 'nav', '.hero', 'main', 'h1', '.card', '.container', '.grid', '.section', 'footer'];

      const measurements = demoMeasure.measureLayout(liveUrl, selectors);
      result.measurePrompt = demoMeasure.generateMeasurePrompt(measurements);
      logPhase(state, 'measure', {
        elementCount: measurements.measurements.length,
        errors: measurements.errors,
      });
    } catch (e) {
      logPhase(state, 'measure', { error: e.message.substring(0, 100) });
    }
  }

  return result;
}

// ========================================================
// POST-CODEX: Validate, QA, Slop, AutoFix
// ========================================================

/**
 * Post-Codex pipeline: diff audit → QA → slop → ship decision → auto-fix if needed
 * 
 * @param {object} params
 * @param {object} params.state - State from preCodex
 * @param {string} params.slug
 * @param {string} params.siteName
 * @param {string} params.sandboxDir - Where Codex worked (or buildDir)
 * @param {string} params.workDir - Original source directory
 * @param {object} params.scope - Scope result from preCodex (optional)
 * @param {string} params.liveUrl - Live URL for QA (after deploy)
 * @param {string} params.screenshotPath - Path to screenshot for slop check (optional)
 * @param {string} params.slopResponse - Image model response for slop analysis (optional)
 * @param {string[]} params.slopOverrides - Slop overrides (optional)
 * @returns {{ state: object, diffAudit: object|null, qaResult: object|null, slopResult: object|null, shipDecision: object, autoFixContext: object|null }}
 */
function postCodex(params) {
  const {
    state, slug, siteName, sandboxDir, workDir, scope,
    liveUrl, screenshotPath, slopResponse, slopOverrides
  } = params;

  const result = {
    state,
    diffAudit: null,
    qaResult: null,
    slopResult: null,
    shipDecision: { action: 'SHIP', reason: 'No checks configured', warnings: [] },
    autoFixContext: null,
  };

  // Phase 2c: Diff audit (if scope + sandbox available)
  if (demoDiff && scope && sandboxDir && workDir) {
    try {
      const audit = demoDiff.auditAndRevert(
        sandboxDir, workDir,
        scope.writeFiles,
        scope.newFiles || []
      );
      result.diffAudit = audit;
      logPhase(state, 'diff-audit', {
        passed: audit.passed,
        stats: audit.stats,
        reverted: audit.reverted,
        violationCount: audit.violations.length,
      });
    } catch (e) {
      logPhase(state, 'diff-audit', { error: e.message.substring(0, 100) });
    }
  }

  // Phase 4a: QA (needs live URL — run after deploy)
  if (demoQA && liveUrl) {
    try {
      const qa = demoQA.runQA(liveUrl);
      result.qaResult = qa;
      logPhase(state, 'qa', {
        passed: qa.passed,
        criticalFails: qa.criticalFails,
        warnings: qa.warnings,
        checks: qa.checks.filter(c => !c.passed).map(c => ({ name: c.name, severity: c.severity, detail: c.detail })),
      });
    } catch (e) {
      logPhase(state, 'qa', { error: e.message.substring(0, 200) });
    }
  }

  // Phase 4b: Slop check (needs image model response from caller)
  if (demoSlop && slopResponse) {
    try {
      const slop = demoSlop.analyzeSlop(
        slopResponse,
        { slug, url: liveUrl, screenshotPath },
        slopOverrides || []
      );
      result.slopResult = slop;
      logPhase(state, 'slop', {
        score: slop.score,
        grade: slop.grade,
        canShip: slop.canShip,
        detectedCount: slop.detectedCount,
        detected: slop.patterns.filter(p => p.detected).map(p => p.id),
      });
    } catch (e) {
      logPhase(state, 'slop', { error: e.message.substring(0, 100) });
    }
  }

  // Phase 4c: Ship decision
  if (demoQA && result.qaResult) {
    result.shipDecision = demoQA.shipDecision(result.qaResult, result.slopResult);
    logPhase(state, 'ship-decision', result.shipDecision);
  }

  // Phase 4d: Auto-fix context (if AUTOFIX needed)
  if (demoAutofix && result.shipDecision.action === 'AUTOFIX') {
    try {
      const writeFiles = scope?.writeFiles || ['index.html'];
      const fixCtx = demoAutofix.buildFixContext({
        slug,
        siteName,
        qaResult: result.qaResult,
        slopResult: result.slopResult,
        measurements: null, // Caller can add measurements
        writeFiles,
        attempt: 1,
      });
      result.autoFixContext = fixCtx;
      logPhase(state, 'autofix-context', {
        shouldProceed: fixCtx.shouldProceed,
        reason: fixCtx.reason,
        contextFile: fixCtx.contextFile,
      });
    } catch (e) {
      logPhase(state, 'autofix-context', { error: e.message.substring(0, 100) });
    }
  }

  // Final state
  state.completedAt = new Date().toISOString();
  state.result = result.shipDecision.action;
  logPhase(state, 'complete', {
    action: result.shipDecision.action,
    reason: result.shipDecision.reason,
    warnings: result.shipDecision.warnings,
  });

  return result;
}

// ========================================================
// AUTO-FIX LOOP: Retry cycle when AUTOFIX is triggered
// ========================================================

/**
 * Run one auto-fix iteration: re-measure → build fix prompt → return for Codex.
 * Caller runs Codex, then calls evaluateAutoFix() with new QA results.
 * 
 * @param {object} params
 * @param {string} params.slug
 * @param {string} params.siteName
 * @param {object} params.prevQA - Previous QA result
 * @param {object} params.prevSlop - Previous slop result (optional)
 * @param {string} params.liveUrl - For fresh measurements
 * @param {string[]} params.writeFiles
 * @param {number} params.attempt - Current attempt (1-3)
 * @param {string} params.previousFeedback - What failed last time
 * @returns {{ prompt: string, contextFile: string|null, shouldProceed: boolean, reason: string, measurements: object|null }}
 */
function prepareAutoFix(params) {
  const { slug, siteName, prevQA, prevSlop, liveUrl, writeFiles, attempt, previousFeedback } = params;

  // Fresh measurements before fix
  let measurements = null;
  if (demoMeasure && liveUrl) {
    try {
      measurements = demoMeasure.measureLayout(liveUrl);
    } catch {}
  }

  if (!demoAutofix) {
    return { prompt: '', contextFile: null, shouldProceed: false, reason: 'demo-autofix.js not available', measurements };
  }

  const fixCtx = demoAutofix.buildFixContext({
    slug,
    siteName,
    qaResult: prevQA,
    slopResult: prevSlop,
    measurements,
    writeFiles,
    attempt,
    previousFeedback,
  });

  return { ...fixCtx, measurements };
}

/**
 * Evaluate auto-fix results after Codex ran.
 * 
 * @param {object} params
 * @param {object} params.prevQA - QA before fix
 * @param {object} params.newQA - QA after fix
 * @param {object} params.prevSlop - Slop before fix (optional)
 * @param {object} params.newSlop - Slop after fix (optional)
 * @returns {{ fixed: boolean, improved: boolean, feedback: string, remainingIssues: string[] }}
 */
function evaluateAutoFix(params) {
  if (!demoAutofix) return { fixed: false, improved: false, feedback: 'demo-autofix.js not available', remainingIssues: [] };
  return demoAutofix.evaluateFix(params.prevQA, params.newQA, params.prevSlop, params.newSlop);
}

// ========================================================
// CONVENIENCE: Full info for a slug
// ========================================================

/**
 * Get full pipeline status for a slug (for debugging/reporting).
 */
function getStatus(slug) {
  const safeName = slug.replace(/[^a-zA-Z0-9а-яА-Я-]/g, '_');
  const statePath = `/tmp/demo-pipeline-${safeName}.json`;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Generate human-readable pipeline report.
 */
function formatReport(state) {
  if (!state) return 'No pipeline state found.';

  let report = `Pipeline: ${state.slug} (${state.action})\n`;
  report += `Started: ${state.startedAt}\n`;
  if (state.completedAt) report += `Completed: ${state.completedAt}\n`;
  report += `Result: ${state.result || 'in progress'}\n\n`;

  const phaseOrder = ['tag', 'manifest', 'scope', 'scope-decision', 'sandbox', 'measure', 'diff-audit', 'qa', 'slop', 'ship-decision', 'autofix-context', 'complete'];

  for (const phase of phaseOrder) {
    const p = state.phases[phase];
    if (!p) continue;
    const icon = p.error ? '❌' : p.passed === false ? '🔴' : '✅';
    report += `${icon} ${phase}: ${JSON.stringify(p, null, 0).substring(0, 200)}\n`;
  }

  return report;
}

// ========================================================
// SLOP PROMPT (for caller to use with image tool)
// ========================================================

/**
 * Get the slop analysis prompt for the image tool.
 */
function getSlopPrompt() {
  return demoSlop ? demoSlop.ANALYSIS_PROMPT : null;
}

/**
 * Get QA report formatter.
 */
function formatQA(qaResult, url) {
  return demoQA ? demoQA.formatQAReport(qaResult, url) : 'QA module not available';
}

module.exports = {
  preCodex,
  postCodex,
  prepareAutoFix,
  evaluateAutoFix,
  getStatus,
  formatReport,
  getSlopPrompt,
  formatQA,
  generateClarificationQuestions,
  handleScopeStop,
};
