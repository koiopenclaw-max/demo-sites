#!/usr/bin/env node
// Module: demo-diff.js
// Demo Sites v2 — Phase 2: Diff Audit
// Post-Codex check: compares what Codex changed against allowed scope.
// Selectively reverts unauthorized changes.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Audit changes in a sandbox directory against the allowed scope.
 * Compares sandbox files with original source to detect unauthorized changes.
 * 
 * @param {string} sandboxDir - The sandbox where Codex worked
 * @param {string} sourceDir - The original project directory
 * @param {string[]} writeFiles - Files Codex was allowed to modify
 * @param {string[]} newFiles - Files Codex was allowed to create
 * @returns {{ passed: boolean, violations: Array<{file: string, type: string, detail: string}>, stats: {modified: number, created: number, unauthorized: number} }}
 */
function auditDiff(sandboxDir, sourceDir, writeFiles, newFiles) {
  try {
    const violations = [];
    let modified = 0;
    let created = 0;
    let unauthorized = 0;
    
    // Scan sandbox for all non-system files
    const sandboxFiles = scanDir(sandboxDir).filter(f => 
      !f.startsWith('_readonly/') && 
      f !== 'SCOPE.md' && 
      f !== 'PROMPT.md' &&
      !f.startsWith('.git/')
    );
    
    for (const f of sandboxFiles) {
      const sandboxPath = path.join(sandboxDir, f);
      const sourcePath = path.join(sourceDir, f);
      
      if (fs.existsSync(sourcePath)) {
        // File existed before — check if it was in writeFiles
        if (!writeFiles.includes(f)) {
          // Check if content is actually different (may have been reverted to original)
          const oldContent = fs.readFileSync(sourcePath, 'utf8');
          const newContent = fs.readFileSync(sandboxPath, 'utf8');
          if (oldContent !== newContent) {
            // Unauthorized modification of existing file
            violations.push({ file: f, type: 'UNAUTHORIZED_MODIFY', detail: `Modified file not in scope: ${f}` });
            unauthorized++;
          }
          // If content is identical → no violation (file was reverted or not changed)
        } else {
          // Allowed modification — check diff size
          const oldContent = fs.readFileSync(sourcePath, 'utf8');
          const newContent = fs.readFileSync(sandboxPath, 'utf8');
          if (oldContent !== newContent) {
            modified++;
            
            // Check for suspicious large diffs
            const diffLines = Math.abs(oldContent.split('\n').length - newContent.split('\n').length);
            const oldLen = oldContent.length;
            const newLen = newContent.length;
            const changePct = Math.abs(newLen - oldLen) / Math.max(oldLen, 1) * 100;
            
            if (changePct >= 70) {
              violations.push({ 
                file: f, 
                type: 'SUSPICIOUS_REWRITE', 
                detail: `File changed by ${changePct.toFixed(0)}% (${oldLen}→${newLen} chars). Possible full rewrite.` 
              });
            }
          }
        }
      } else {
        // New file — check if it was explicitly in newFiles
        const isAllowedNew = newFiles.includes(f) || newFiles.some(nf => f.startsWith(nf));
        
        if (!isAllowedNew) {
          violations.push({ file: f, type: 'UNAUTHORIZED_CREATE', detail: `Created unexpected file: ${f}` });
          unauthorized++;
        } else {
          created++;
        }
      }
    }
    
    const passed = violations.filter(v => v.type !== 'SUSPICIOUS_REWRITE').length === 0;
    
    return {
      passed,
      violations,
      stats: { modified, created, unauthorized }
    };
  } catch (e) {
    console.error('[demo-diff] auditDiff error:', e.message.substring(0, 200));
    return { passed: false, violations: [{ file: '*', type: 'ERROR', detail: e.message }], stats: { modified: 0, created: 0, unauthorized: 0 } };
  }
}

/**
 * Selectively revert unauthorized changes by restoring original files.
 * 
 * @param {string} sandboxDir
 * @param {string} sourceDir
 * @param {Array<{file: string, type: string}>} violations
 * @returns {string[]} List of reverted files
 */
function revertViolations(sandboxDir, sourceDir, violations) {
  const reverted = [];
  
  for (const v of violations) {
    if (v.type === 'UNAUTHORIZED_MODIFY') {
      // Restore original file
      const src = path.join(sourceDir, v.file);
      const dest = path.join(sandboxDir, v.file);
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, dest);
          reverted.push(v.file);
        } catch (e) {
          console.error(`[demo-diff] revert failed for ${v.file}: ${e.message}`);
        }
      }
    } else if (v.type === 'UNAUTHORIZED_CREATE') {
      // Remove unauthorized file
      const dest = path.join(sandboxDir, v.file);
      try {
        fs.unlinkSync(dest);
        reverted.push(v.file);
      } catch (e) {
        console.error(`[demo-diff] remove failed for ${v.file}: ${e.message}`);
      }
    }
  }
  
  return reverted;
}

/**
 * Full audit + revert pipeline.
 * Returns clean result after reverting violations.
 * 
 * @param {string} sandboxDir
 * @param {string} sourceDir
 * @param {string[]} writeFiles
 * @param {string[]} newFiles
 * @returns {{ passed: boolean, violations: Array, reverted: string[], stats: object }}
 */
function auditAndRevert(sandboxDir, sourceDir, writeFiles, newFiles) {
  const audit = auditDiff(sandboxDir, sourceDir, writeFiles, newFiles);
  
  if (audit.passed) {
    return { ...audit, reverted: [] };
  }
  
  // Separate hard violations (UNAUTHORIZED) from soft (SUSPICIOUS_REWRITE)
  const hardViolations = audit.violations.filter(v => 
    v.type === 'UNAUTHORIZED_MODIFY' || v.type === 'UNAUTHORIZED_CREATE'
  );
  const softViolations = audit.violations.filter(v => v.type === 'SUSPICIOUS_REWRITE');
  
  // Auto-revert hard violations
  const reverted = revertViolations(sandboxDir, sourceDir, hardViolations);
  
  // Re-check after revert
  const reaudit = auditDiff(sandboxDir, sourceDir, writeFiles, newFiles);
  
  return {
    passed: reaudit.violations.filter(v => v.type !== 'SUSPICIOUS_REWRITE').length === 0,
    violations: reaudit.violations,
    reverted,
    stats: reaudit.stats
  };
}

/**
 * Recursively scan directory and return relative file paths.
 */
function scanDir(dir, prefix = '') {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...scanDir(path.join(dir, entry.name), rel));
      } else {
        results.push(rel);
      }
    }
  } catch {}
  return results;
}

module.exports = { auditDiff, revertViolations, auditAndRevert };
