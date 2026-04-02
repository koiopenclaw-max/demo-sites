# Demo Worker Architecture

## PM2 runs from: ~/.openclaw/workspace/scripts/demo-worker.js
## This copy is a VERSION CONTROL BACKUP.

Do NOT edit files here expecting PM2 to pick them up.
Edit in workspace/scripts/ → sync here → commit.

## Modules (all loaded by worker via require('./demo-xxx.js')):
- demo-tags.js — Git tag management
- demo-manifest.js — File manifest generation  
- demo-scope.js — Scope detection + classifyRevision
- demo-diff.js — Post-Codex diff audit
- demo-measure.js — Playwright pixel measurements
- demo-fallback.js — Skeleton generator
- demo-pipeline.js — Pipeline orchestrator (preCodex/postCodex)
- demo-qa.js — Proactive QA checks
- demo-slop.js — AI slop detection + scoring
- demo-autofix.js — Auto-fix prompt generation
- demo-screenshots.js — Before/after screenshots + visual gate v9
