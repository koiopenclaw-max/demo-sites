#!/usr/bin/env node
// Demo Sites Worker v1 — Persistent pm2 process
// Polls task queue every 30s, executes tasks, updates demo JSON, notifies
//
// Architecture:
//   demo-sites-processor.js (cron) → detects changes → adds to queue
//   demo-worker.js (pm2) → picks tasks → executes → marks done → next
//
// Tasks: briefing, qa_submitted, building, revisions, dns_setup

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const https = require('https');

const QUEUE_FILE = '/home/clawd/.openclaw/workspace/scripts/demo-queue.json';
const DEMO_REPO = '/home/clawd/Projects/demo-sites';
const GH_TOKEN = fs.readFileSync('/home/clawd/.openclaw/workspace/.secrets/github-token', 'utf8').trim();
const DEMO_BOT_TOKEN = fs.readFileSync('/home/clawd/.openclaw/workspace/.secrets/demo-bot-token', 'utf8').trim();
const OPENCLAW = '/home/clawd/.npm-global/bin/openclaw';
const LOG_FILE = '/tmp/demo-worker.log';
const POLL_INTERVAL = 30000; // 30 seconds

// ===== v2 Modules (Phase 1) — imported with try/catch for safety =====
let demoTags = null;
let demoManifest = null;
try {
  demoTags = require('./demo-tags.js');
  log('[v2] demo-tags.js loaded');
} catch (e) {
  console.error('[v2] demo-tags.js not available:', e.message);
}
try {
  demoManifest = require('./demo-manifest.js');
  log('[v2] demo-manifest.js loaded');
} catch (e) {
  console.error('[v2] demo-manifest.js not available:', e.message);
}
let demoScope = null;
let demoDiff = null;
try {
  demoScope = require('./demo-scope.js');
  log('[v2] demo-scope.js loaded');
} catch (e) {
  console.error('[v2] demo-scope.js not available:', e.message);
}
try {
  demoDiff = require('./demo-diff.js');
  log('[v2] demo-diff.js loaded');
} catch (e) {
  console.error('[v2] demo-diff.js not available:', e.message);
}
let demoMeasure = null;
let demoFallback = null;
try {
  demoMeasure = require('./demo-measure.js');
  log('[v2] demo-measure.js loaded');
} catch (e) {
  console.error('[v2] demo-measure.js not available:', e.message);
}
try {
  demoFallback = require('./demo-fallback.js');
  log('[v2] demo-fallback.js loaded');
} catch (e) {
  console.error('[v2] demo-fallback.js not available:', e.message);
}
let demoPipelineGlobal = null;
try {
  demoPipelineGlobal = require('./demo-pipeline.js');
  log('[v6] demo-pipeline.js loaded');
} catch (e) {
  console.error('[v6] demo-pipeline.js not available:', e.message);
}

// ===== Per-slug Lock (v2) — prevents concurrent tasks on same slug =====
const activeSlugLocks = new Set();

// ===== Logging =====
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ===== Trigger File Status (for failsafe + history) =====
function updateTriggerStatus(slug, processingStatus, action, result) {
  const triggerFile = `/tmp/demo-action-trigger-${slug}.json`;
  try {
    let trigger = {};
    if (fs.existsSync(triggerFile)) {
      trigger = JSON.parse(fs.readFileSync(triggerFile, 'utf8'));
    }
    trigger.processingStatus = processingStatus;
    trigger.processingAction = action;
    trigger.processingUpdatedAt = new Date().toISOString();
    if (result) trigger.processingResult = result.substring(0, 500);
    fs.writeFileSync(triggerFile, JSON.stringify(trigger, null, 2));
  } catch (e) {
    log(`Trigger status update error: ${e.message.substring(0, 100)}`);
  }
}

// ===== Queue Operations =====
function readQueue() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return { tasks: [], completed: [], version: 1 };
  }
}

function saveQueue(q) {
  // Keep only last 100 completed
  if (q.completed.length > 100) q.completed = q.completed.slice(-100);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
  // Sync to repo for dashboard + push
  try {
    const repoQueue = path.join(DEMO_REPO, 'scripts', 'demo-queue.json');
    fs.copyFileSync(QUEUE_FILE, repoQueue);
    execSync('git add scripts/demo-queue.json && git diff --cached --quiet || git commit -m "sync: queue update" && git push origin main', 
      { cwd: DEMO_REPO, timeout: 15000, stdio: 'pipe' });
  } catch {}
}

function addTask(slug, name, action, data) {
  const q = readQueue();
  // Deduplicate: don't add if same slug+action already pending or in_progress
  const exists = q.tasks.find(t => t.slug === slug && t.action === action && (t.status === 'pending' || t.status === 'in_progress'));
  if (exists) {
    // Check if in_progress task is stale (>15 min) — if so, clear it and allow re-queue
    if (exists.status === 'in_progress' && exists.startedAt) {
      const elapsed = Date.now() - new Date(exists.startedAt).getTime();
      if (elapsed > 15 * 60 * 1000) {
        log(`STALE: ${slug} (${action}) stuck in_progress for ${Math.round(elapsed/60000)}min — clearing`);
        exists.status = 'error';
        exists.error = `Stuck in_progress for ${Math.round(elapsed/60000)}min — auto-cleared`;
        exists.completedAt = new Date().toISOString();
        q.completed.push(exists);
        q.tasks = q.tasks.filter(t => t !== exists);
        saveQueue(q);
        // Fall through to add new task
      } else {
        return false;
      }
    } else {
      return false;
    }
  }
  
  q.tasks.push({
    id: Date.now(),
    slug,
    name,
    action,
    status: 'pending',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    error: null,
    result: null
  });
  saveQueue(q);
  log(`QUEUED: ${name} → ${action}`);
  return true;
}

// ===== GitHub Operations =====
function gitPull() {
  // v3: fetch + merge only. NEVER stash, reset, or clean.
  // Local uncommitted/untracked files are ALWAYS preserved.
  try {
    execSync('git fetch origin main', { cwd: DEMO_REPO, timeout: 30000, stdio: 'pipe' });
    // Merge remote changes. If there are local uncommitted tracked changes, merge may fail — that's OK.
    try {
      execSync('git merge origin/main --no-edit', { cwd: DEMO_REPO, timeout: 15000, stdio: 'pipe' });
    } catch (mergeErr) {
      // Merge conflict with uncommitted changes — just log, don't force anything
      log(`[gitPull] merge skipped (local changes): ${mergeErr.message.substring(0, 100)}`);
    }
  } catch (e) {
    log(`[gitPull] fetch error: ${e.message.substring(0, 100)}`);
  }
}

function readDemoData(slug) {
  const file = path.join(DEMO_REPO, 'data', `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveDemoData(slug, data) {
  const file = path.join(DEMO_REPO, 'data', `${slug}.json`);
  
  // STATUS GUARD: Check if file on disk has a more advanced status
  if (fs.existsSync(file) && data.status) {
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      const existingIdx = getStatusIndex(existing.status);
      const newIdx = getStatusIndex(data.status);
      if (existingIdx > newIdx && newIdx !== -1) {
        log(`⛔ SAVE GUARD: Refusing to write "${data.status}" (${newIdx}) — file has "${existing.status}" (${existingIdx}) for ${slug}`);
        return false;
      }
    } catch {}
  }
  
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return true;
}

// Status ordering — higher index = further in the flow
const STATUS_ORDER = [
  'created',               // 0
  'briefing',              // 1
  'brief_ready',           // 2
  'qa_submitted',          // 3
  'brief_final',           // 4
  'building',              // 5
  'done',                  // 6
  'needs_clarification',   // 7
  'revisions',             // 8
  'review',                // 9
  'approved',              // 10
  'dns_setup',             // 11
  'deploying',             // 12
  'live'                   // 13
];

function getStatusIndex(status) {
  const idx = STATUS_ORDER.indexOf(status);
  return idx === -1 ? -1 : idx;
}

function gitCommitPush(slug, newStatus, name) {
  try {
    // GUARD: Pull latest and check if status has already moved forward
    try {
      execSync('git fetch origin main', { cwd: DEMO_REPO, timeout: 15000, stdio: 'pipe' });
      execSync('git merge origin/main --no-edit', { cwd: DEMO_REPO, timeout: 10000, stdio: 'pipe' });
    } catch (e) {
      log(`[gitCommitPush] pull before push: ${e.message.substring(0, 100)}`);
    }
    
    // Re-read the file from disk (after pull) to get current remote status
    const dataFile = path.join(DEMO_REPO, 'data', `${slug}.json`);
    if (fs.existsSync(dataFile)) {
      const currentData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      const currentIdx = getStatusIndex(currentData.status);
      const newIdx = getStatusIndex(newStatus);
      
      if (currentIdx > newIdx && newIdx !== -1) {
        log(`⛔ STATUS GUARD: Refusing to write "${newStatus}" (${newIdx}) — already at "${currentData.status}" (${currentIdx}) for ${name}`);
        return false;
      }
    }
    
    execSync(`git add "data/${slug}.json"`, { cwd: DEMO_REPO, stdio: 'pipe' });
    execSync(`git commit -m "[${newStatus}] ${name} (worker)"`, { cwd: DEMO_REPO, stdio: 'pipe' });
    execSync('git push origin main', { cwd: DEMO_REPO, timeout: 30000, stdio: 'pipe' });
    return true;
  } catch (e) {
    log(`git push error: ${e.message}`);
    return false;
  }
}

// Guard for git add -A pushes (building, revisions) — pull + check status before push
function guardedPush(slug, newStatus, name, commitMsg) {
  try {
    // Pull latest first
    try {
      execSync('git fetch origin main', { cwd: DEMO_REPO, timeout: 15000, stdio: 'pipe' });
      execSync('git merge origin/main --no-edit', { cwd: DEMO_REPO, timeout: 10000, stdio: 'pipe' });
    } catch (e) {
      log(`[guardedPush] pull error: ${e.message.substring(0, 100)}`);
    }
    
    // Check status ordering
    const dataFile = path.join(DEMO_REPO, 'data', `${slug}.json`);
    if (fs.existsSync(dataFile)) {
      const currentData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      const currentIdx = getStatusIndex(currentData.status);
      const newIdx = getStatusIndex(newStatus);
      
      if (currentIdx > newIdx && newIdx !== -1) {
        log(`⛔ STATUS GUARD: Refusing "${newStatus}" (${newIdx}) — already at "${currentData.status}" (${currentIdx}) for ${name}`);
        return false;
      }
    }
    
    execSync('git add -A', { cwd: DEMO_REPO, stdio: 'pipe' });
    execSync(`git commit -m "${commitMsg}"`, { cwd: DEMO_REPO, stdio: 'pipe' });
    execSync('git push origin main', { cwd: DEMO_REPO, timeout: 30000, stdio: 'pipe' });
    return true;
  } catch (e) {
    log(`guardedPush error: ${e.message}`);
    return false;
  }
}

// ===== Telegram Notification =====
function projectUrl(slug) {
  return `https://koiopenclaw-max.github.io/demo-sites/#project/${encodeURIComponent(slug)}`;
}

function notifyTelegram(msg) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: '-1003818348002',
      message_thread_id: 49,
      text: msg,
      parse_mode: 'HTML'
    });
    const req = https.request(`https://api.telegram.org/bot${DEMO_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 15000
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

// ===== Web Scraping =====
function scrapeUrl(url) {
  // Try multiple methods — WordPress/Elementor sites need special handling
  let html = '';
  
  // Method 1: curl with full headers (catches most sites)
  try {
    html = execSync(
      `curl -sL --max-time 20 -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "${url}"`,
      { timeout: 25000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024 }
    ).toString();
  } catch (e) {
    log(`Scrape curl error for ${url}: ${e.message.substring(0, 100)}`);
  }
  
  // Check if we got useful text content (not just JS/CSS boilerplate)
  const textContent = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  if (textContent.length > 200) {
    return html; // Got useful content
  }
  
  // Method 2: Try fetching 404 page (WordPress sites often render full footer/sidebar on 404)
  log(`Scrape: Main page sparse (${textContent.length} chars), trying 404 fallback...`);
  try {
    const fallbackHtml = execSync(
      `curl -sL --max-time 15 -H "User-Agent: Mozilla/5.0" "${url}nonexistent-page-for-scrape/"`,
      { timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024 }
    ).toString();
    
    const fallbackText = fallbackHtml
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    if (fallbackText.length > textContent.length) {
      log(`Scrape: 404 fallback got ${fallbackText.length} chars (vs ${textContent.length})`);
      return fallbackHtml;
    }
  } catch (e) {
    log(`Scrape 404 fallback error: ${e.message.substring(0, 100)}`);
  }
  
  return html; // Return whatever we got
}

// ===== Task Executors =====

async function executeBriefing(task) {
  const data = readDemoData(task.slug);
  if (!data) throw new Error('Data file not found');
  
  // Scrape website
  let siteContent = '';
  if (data.websiteUrl) {
    log(`Scraping ${data.websiteUrl}...`);
    siteContent = scrapeUrl(data.websiteUrl);
  }
  
  // Detect niche — respect manual override from platform
  const allText = `${data.name} ${data.notes || ''} ${siteContent}`.toLowerCase();
  let niche = data.nicheOverride || 'друго';
  const hasManualNiche = !!data.nicheOverride;
  // Order matters! More specific niches FIRST, generic ones LAST.
  const nicheKeywords = {
    'дограма-врати': ['врат', 'дограм', 'прозор', 'pvc', 'алуминиев', 'стъклопакет', 'дървен', 'плъзгащ', 'двукрил', 'еднокрил', 'интериорн', 'метални врат', 'входни врат', 'решетк', 'оград'],
    'стоматология': ['дентал', 'зъбо', 'стомат', 'имплант', 'ортодонт', 'зъб'],
    'счетоводство': ['счетовод', 'счетоводн', 'одитор', 'данъч', 'ддс', 'финансов', 'баланс', 'отчет', 'кантора', 'трз', 'осигуровк'],
    'нотариус': ['нотариус', 'нотариал', 'заверка'],
    'hvac': ['климатик', 'климатиц', 'отоплен', 'вентилац', 'hvac'],
    'хотел': ['хотел', 'hotel', 'резервация', 'настаняване'],
    'хранителни': ['храни', 'месо', 'млечн', 'био', 'органич'],
    'земеделие': ['земедел', 'агро', 'лозе', 'овощ', 'ферма', 'фермер'],
    'строителство': ['строител', 'строеж', 'архитект'],
    'автосервиз': ['автосервиз', 'автомивк', 'автомобилен сервиз', 'ремонт на автомобил', 'ремонт на кол', 'автомобилн', 'гуми', 'автокъща']
  };
  if (!hasManualNiche) {
    for (const [n, keywords] of Object.entries(nicheKeywords)) {
      if (keywords.some(k => allText.includes(k))) { niche = n; break; }
    }
  } else {
    log(`Using manual niche override: ${niche}`);
  }
  
  // Extract text content from HTML (basic)
  const textContent = siteContent
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 3000);
  
  // Build brief
  const brief = `# Задание: ${data.name} — ${data.type === 'redesign' ? 'Редизайн' : 'Нов сайт'}

## За клиента
**${data.name}** — ${niche}
${data.notes || 'Без допълнителни бележки.'}

## Текущо съдържание
${textContent ? textContent.substring(0, 1500) : 'Не е намерено съдържание на текущия сайт.'}

## Препоръки
- Модерен, mobile-first дизайн
- SEO оптимизация (Schema.org, meta tags)
- Бързо зареждане (оптимизирани изображения)
- Ясен CTA (Call to Action)
- Контактна информация на видно място`;

  // Build QA questions
  const qa = [];
  
  // Template selection if niche has templates
  const TEMPLATE_NICHES = ['счетоводство', 'стоматология', 'дограма-врати'];
  if (TEMPLATE_NICHES.includes(niche)) {
    const NICHE_TO_CATALOG = {
      'счетоводство': 'счетоводство',
      'стоматология': 'стоматолог',
      'дограма-врати': 'дограма-врати'
    };
    qa.push({
      question: 'Кой темплейт да използваме за сайта?',
      answer: '',
      type: 'template_select',
      niche: NICHE_TO_CATALOG[niche] || niche,
      status: 'pending'
    });
  }
  
  qa.push(
    { question: 'Има ли бизнесът лого (SVG/PNG с прозрачен фон)?', answer: '', type: 'text' },
    { question: 'Има ли предпочитана цветова гама?', answer: '', type: 'text' },
    { question: 'Има ли снимки на офиса/екипа за използване?', answer: '', type: 'text' },
    { question: 'Има ли Google Business Profile?', answer: '', type: 'text' },
    { question: 'Какво е работното време?', answer: '', type: 'text' },
    { question: 'Има ли допълнителни услуги/акценти извън текущия сайт?', answer: '', type: 'text' }
  );
  
  data.brief = brief;
  data.qa = qa;
  data.niche = niche;
  data.status = 'brief_ready';
  
  saveDemoData(task.slug, data);
  gitCommitPush(task.slug, 'brief_ready', data.name);
  
  await notifyTelegram(`📋 Задание готово: <b>${data.name}</b>\nНиша: ${niche}\nСтатус: brief_ready\n\n<a href="${projectUrl(slug)}">Отвори → попълни въпросите</a>`);
  
  return `Brief готов. Ниша: ${niche}. ${qa.length} въпроса.`;
}

async function executeQaSubmitted(task) {
  const data = readDemoData(task.slug);
  if (!data) throw new Error('Data file not found');
  
  // Enrich brief with QA answers
  let enrichment = '\n\n## Решения от клиента\n';
  
  for (const q of (data.qa || [])) {
    if (!q.answer) continue;
    if (q.type === 'template_select') {
      enrichment += `\n### Темплейт: ${q.answer}\n`;
    } else {
      enrichment += `- **${q.question}:** ${q.answer}\n`;
    }
  }
  
  data.brief = (data.brief || '') + enrichment;
  data.status = 'brief_final';
  
  saveDemoData(task.slug, data);
  gitCommitPush(task.slug, 'brief_final', data.name);
  
  await notifyTelegram(`✅ Задание обогатено: <b>${data.name}</b>\nСтатус: brief_final\n\n<a href="${projectUrl(slug)}">Прегледай и потвърди билда</a>`);
  
  return 'Brief enriched → brief_final';
}

async function executeBuilding(task) {
  const data = readDemoData(task.slug);
  if (!data) throw new Error('Data file not found');
  
  // v2: Create pre-build tag + ensure file manifest
  if (demoTags) {
    const tag = demoTags.createTag(DEMO_REPO, 'pre-build', task.slug);
    if (tag) log(`[v2] Tag created: ${tag}`);
  }
  if (demoManifest) {
    const manifest = demoManifest.ensureManifest(task.slug);
    if (manifest) log(`[v2] Manifest ensured: ${manifest.length} files`);
  }
  
  // Find selected template
  const templateQ = (data.qa || []).find(q => q.type === 'template_select');
  const templateId = templateQ?.answer || '';
  
  // Map template ID to URL
  const TEMPLATE_MAP = {
    'a-precision': { repo: 'accounting-templates-claude', file: 'template-1-precision.html' },
    'a-trust': { repo: 'accounting-templates-claude', file: 'template-2-trust.html' },
    'a-modern-edge': { repo: 'accounting-templates-claude', file: 'template-3-modern-edge.html' },
    'a-warmth': { repo: 'accounting-templates-claude', file: 'template-4-warmth.html' },
    'a-corporate': { repo: 'accounting-templates-claude', file: 'template-5-corporate.html' },
    'b-precision': { repo: 'accounting-templates-alt', file: 'template-1-precision.html' },
    'b-trust': { repo: 'accounting-templates-alt', file: 'template-2-trust.html' },
    'b-modern-edge': { repo: 'accounting-templates-alt', file: 'template-3-modern-edge.html' },
    'b-warmth': { repo: 'accounting-templates-alt', file: 'template-4-warmth.html' },
    'b-corporate': { repo: 'accounting-templates-alt', file: 'template-5-corporate.html' },
    // Dental templates
    'dt-killer': { url: 'https://koiopenclaw-max.github.io/dental-killer-template/' },
    'dt-noir-luxe': { url: 'https://koiopenclaw-max.github.io/dental-noir-template/' },
    'dt-warm-haven': { url: 'https://koiopenclaw-max.github.io/dental-warm-template/' },
    // Windows & Doors templates (local in demo-sites repo)
    'wd-minimal-premium': { local: 'templates/windows-doors/minimal-premium/index.html' },
    'wd-premium-dark': { local: 'templates/windows-doors/premium-dark/index.html' },
    'wd-eco-modern': { local: 'templates/windows-doors/eco-modern/index.html' },
    'wd-bold-industrial': { local: 'templates/windows-doors/clean-industrial/index.html' },
    'wd-warm-natural': { local: 'templates/windows-doors/warm-natural/index.html' }
  };
  
  const tpl = TEMPLATE_MAP[templateId];
  if (!tpl) {
    log(`No template found for ID: ${templateId}. Building from scratch.`);
  }
  
  // Download template HTML
  let templateHtml = '';
  if (tpl) {
    let tplUrl = '';
    if (tpl.url) {
      tplUrl = tpl.url;
    } else if (tpl.local) {
      const localPath = path.join(DEMO_REPO, tpl.local);
      log(`Reading local template: ${localPath}`);
      try {
        templateHtml = fs.readFileSync(localPath, 'utf-8');
      } catch (e) {
        log(`Local template read failed: ${e.message}`);
      }
    } else if (tpl.repo && tpl.file) {
      tplUrl = `https://koiopenclaw-max.github.io/${tpl.repo}/${tpl.file}`;
    }
    
    if (tplUrl && !templateHtml) {
      log(`Downloading template: ${tplUrl}`);
      try {
        templateHtml = execSync(`curl -sL "${tplUrl}"`, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }).toString();
      } catch (e) {
        log(`Template download failed: ${e.message}`);
      }
    }
  }
  
  // Scrape client website for content
  let clientContent = '';
  if (data.websiteUrl) {
    log(`Scraping client: ${data.websiteUrl}`);
    clientContent = scrapeUrl(data.websiteUrl);
  }
  
  // Extract text from client site
  const clientText = clientContent
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 5000);
  
  // Prepare build dir
  const demoDir = path.join(DEMO_REPO, 'demos', task.slug);
  if (!fs.existsSync(demoDir)) fs.mkdirSync(demoDir, { recursive: true });
  
  // Save template and client content for Codex
  const buildDir = `/tmp/demo-build-${task.slug}`;
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
  
  if (templateHtml) fs.writeFileSync(path.join(buildDir, 'template.html'), templateHtml);
  fs.writeFileSync(path.join(buildDir, 'client-content.txt'), clientText);
  fs.writeFileSync(path.join(buildDir, 'brief.md'), data.brief || '');
  
  // Build prompt for Codex
  // CRITICAL: Template must be preserved 1:1. Only text content changes.
  const prompt = `You are customizing a website template for "${data.name}".

## CRITICAL RULE: COPY TEMPLATE EXACTLY — CHANGE ONLY TEXT

The file template.html contains an APPROVED design. The client has chosen this exact design.
Your job is to produce index.html which is a COPY of template.html with ONLY the text content replaced.

## WHAT YOU MUST NOT CHANGE:
- CSS (no modifications to any styles, colors, variables, fonts, spacing, layout)
- HTML structure (no adding/removing sections, no changing class names or IDs)
- JavaScript (copy as-is)
- Image URLs (keep all Unsplash/stock images as-is)
- SVG icons (copy as-is)
- Animations, transitions, hover effects (copy as-is)

## WHAT YOU MUST CHANGE (text only):
- Business name: Replace the template business name with "${data.name}"
- <title> and <meta description>: Update for "${data.name}"
- Services/products: Replace template service names and descriptions with real ones from client-content.txt
- Contact info: Replace phone, email, address with real data from client-content.txt and brief.md
- Testimonials: Rewrite to match the business type (keep the same format/structure)
- Footer: Update business name, copyright, contact links
- Any other visible text: Adapt to match the client's business

## INPUT FILES:
- template.html — THE APPROVED DESIGN. Copy this file as your starting point.
- client-content.txt — Text scraped from the client's current website. Extract: services, phone numbers, email, address, working hours, pricing.
- brief.md — Project brief with requirements and client answers.

## PROCESS:
1. \`cp template.html index.html\`
2. Read client-content.txt and brief.md to understand the business
3. Edit index.html — find-and-replace ONLY the text content
4. Verify: diff template.html index.html should show ONLY text changes, zero CSS/HTML structure changes

## OUTPUT: Save as index.html in this directory.

When completely finished, run: echo "BUILD_COMPLETE" > /tmp/demo-build-done-${task.slug}`;

  fs.writeFileSync(path.join(buildDir, 'PROMPT.md'), prompt);
  
  // Spawn Codex agent
  log(`Spawning Codex for ${task.name}...`);
  
  // Clean up any previous done marker
  try { fs.unlinkSync(`/tmp/demo-build-done-${task.slug}`); } catch {}
  
  try {
    execSync(
      `cd "${buildDir}" && git init -q && codex exec --full-auto "Read PROMPT.md and follow the instructions exactly." 2>&1 | tail -20`,
      { 
        timeout: 600000, // 10 min max
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PATH: `${process.env.PATH}:/home/clawd/.npm-global/bin` }
      }
    );
  } catch (e) {
    log(`Codex execution: ${e.message.substring(0, 200)}`);
    // Check if build completed despite error
  }
  
  // === VISUAL VALIDATION LOOP ===
  const MAX_BUILD_ATTEMPTS = 3;
  let buildAttempt = 0;
  let buildValidated = false;
  let buildClaudeFeedback = '';
  
  while (buildAttempt < MAX_BUILD_ATTEMPTS && !buildValidated) {
    buildAttempt++;
    
    if (buildAttempt > 1) {
      // Retry: re-run Codex with Claude's feedback
      log(`Build retry ${buildAttempt}/${MAX_BUILD_ATTEMPTS} with feedback...`);
      const retryPrompt = `You are fixing a website for "${data.name}".

PREVIOUS BUILD FAILED VISUAL VALIDATION. Feedback:
${buildClaudeFeedback}

CRITICAL: The design must match template.html EXACTLY (same CSS, layout, structure).
Only fix the specific issues above. Do NOT rewrite CSS or change the layout.

INPUT FILES:
- current.html — the previous attempt (fix the issues listed above)
${templateHtml ? '- template.html — the APPROVED design. current.html must look identical except for text content.' : ''}
- client-content.txt — scraped content from client
- brief.md — project brief

Fix the issues. Save as index.html. All text in Bulgarian.`;

      fs.writeFileSync(path.join(buildDir, 'PROMPT.md'), retryPrompt);
      // Copy previous output as current for iterative fix
      const prevOutput = path.join(buildDir, 'index.html');
      if (fs.existsSync(prevOutput)) {
        fs.copyFileSync(prevOutput, path.join(buildDir, 'current.html'));
        fs.unlinkSync(prevOutput);
      }
      
      try {
        try { execSync(`rm -rf "${buildDir}/.git"`, { stdio: 'pipe' }); } catch {}
        execSync(
          `cd "${buildDir}" && git init -q && codex exec --full-auto "Read PROMPT.md and follow the instructions exactly." 2>&1 | tail -20`,
          {
            timeout: 600000,
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, PATH: `${process.env.PATH}:/home/clawd/.npm-global/bin` }
          }
        );
      } catch (e) {
        log(`Codex retry ${buildAttempt}: ${e.message.substring(0, 200)}`);
      }
    }
    
    // Check for output
    const outputFile = path.join(buildDir, 'index.html');
    if (!fs.existsSync(outputFile)) {
      buildClaudeFeedback = 'Codex did not produce index.html. Read PROMPT.md and save the result as index.html.';
      continue;
    }
    
    // Take screenshots for validation
    const screenshotDir = path.join(buildDir, 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    
    let screenshotsOk = false;
    let localServer = null;
    try {
      const http = require('http');
      localServer = http.createServer((req, res) => {
        let filePath = path.join(buildDir, req.url === '/' ? 'index.html' : req.url.replace(/^\//, ''));
        if (!fs.existsSync(filePath) && demoDir) {
          filePath = path.join(demoDir, req.url.replace(/^\//, ''));
        }
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes = {'.html':'text/html','.css':'text/css','.js':'application/javascript','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.gif':'image/gif'};
          res.writeHead(200, {'Content-Type': mimeTypes[ext] || 'application/octet-stream'});
          fs.createReadStream(filePath).pipe(res);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });
      
      const port = 18800 + Math.floor(Math.random() * 100);
      await new Promise((resolve) => localServer.listen(port, '127.0.0.1', resolve));
      
      // Desktop screenshot
      try {
        execSync(
          `npx playwright screenshot --viewport-size "1280,800" --wait-for-timeout 3000 --full-page "http://127.0.0.1:${port}/" "${path.join(screenshotDir, 'desktop.png')}"`,
          { timeout: 60000, stdio: 'pipe', env: { ...process.env, PATH: `${process.env.PATH}:/home/clawd/.npm-global/bin` } }
        );
      } catch (e) { log(`Desktop screenshot: ${e.message.substring(0, 100)}`); }
      
      // Mobile screenshot
      try {
        execSync(
          `npx playwright screenshot --viewport-size "375,667" --wait-for-timeout 3000 --full-page "http://127.0.0.1:${port}/" "${path.join(screenshotDir, 'mobile.png')}"`,
          { timeout: 60000, stdio: 'pipe', env: { ...process.env, PATH: `${process.env.PATH}:/home/clawd/.npm-global/bin` } }
        );
      } catch (e) { log(`Mobile screenshot: ${e.message.substring(0, 100)}`); }
      
      screenshotsOk = fs.existsSync(path.join(screenshotDir, 'desktop.png')) && fs.existsSync(path.join(screenshotDir, 'mobile.png'));
      log(`Build screenshots: ${screenshotsOk ? 'OK' : 'FAILED'}`);
    } catch (e) {
      log(`Screenshot error: ${e.message.substring(0, 200)}`);
    } finally {
      if (localServer) localServer.close();
    }
    
    // Claude visual + code validation
    const validationPrompt = `You are a senior QA validator for a NEWLY BUILT demo website.
This is the first build for "${data.name}" (${data.type === 'new' ? 'brand new site' : 'redesign'}).

=== PROJECT BRIEF ===
${(data.brief || '').substring(0, 2000)}

=== VALIDATION CHECKLIST (15 points) ===

**Code (read index.html):**
1. Business name "${data.name}" appears correctly
2. Contact info is present (phone, email, address if available)
3. Services/offerings are listed with real descriptions (not lorem ipsum)
4. HTML is valid, complete, not truncated
5. All text is in Bulgarian

**Desktop visual (desktop.png):**
6. Hero section is clean with clear headline and CTA
7. ALL sections are visible (no blank/empty gaps)
8. Images are professional (not zoomed, pixelated, or broken)
9. Footer has real content (contacts, links, copyright)
10. Overall looks professional — a real business would use this

**Mobile visual (mobile.png):**
11. Layout adapts properly, no horizontal scroll/overflow
12. Text is readable without zooming
13. Buttons/links are adequately sized for touch
14. Images fit properly in mobile view
15. Navigation is accessible (hamburger menu or similar)

RESPOND IN THIS EXACT FORMAT:
SCORE: X/15
PASSED: [check numbers]
FAILED: [check numbers]

If SCORE >= 12/15:
VALIDATED: YES
Summary: [brief description]

If SCORE < 12/15:
VALIDATED: NO
Failed checks:
- [check N]: [specific problem]
Fix instructions:
- [concrete fix instruction]`;

    fs.writeFileSync(path.join(buildDir, 'VALIDATE.md'), validationPrompt);
    
    let claudeResult = '';
    try {
      const claudePrompt = screenshotsOk
        ? 'Read VALIDATE.md. Examine index.html, screenshots/desktop.png, screenshots/mobile.png. Follow the checklist exactly.'
        : 'Read VALIDATE.md. Examine index.html. Follow code-only checks (1-5). Skip visual checks.';
      
      claudeResult = execSync(
        `cd "${buildDir}" && claude --print --permission-mode bypassPermissions "${claudePrompt}" 2>/dev/null`,
        {
          timeout: 180000,
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 5 * 1024 * 1024,
          env: { ...process.env, PATH: `${process.env.PATH}:/home/clawd/.local/bin:/home/clawd/.npm-global/bin:/usr/local/bin:/usr/bin:/bin` }
        }
      ).toString().trim();
    } catch (e) {
      log(`Claude validation error: ${e.message.substring(0, 200)}`);
      claudeResult = 'VALIDATED: YES\nSummary: Validation skipped due to error.';
    }
    
    const scoreMatch = claudeResult.match(/SCORE:\s*(\d+)\/(\d+)/);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    const maxScore = scoreMatch ? parseInt(scoreMatch[2]) : 15;
    const pct = maxScore > 0 ? Math.round(score / maxScore * 100) : 0;
    log(`Build validation (attempt ${buildAttempt}): score ${score}/${maxScore} (${pct}%)`);
    log(`Claude: ${claudeResult.substring(0, 300)}`);
    
    if (claudeResult.includes('VALIDATED: YES')) {
      buildValidated = true;
      log(`✅ Build VALIDATED on attempt ${buildAttempt} (score: ${score}/${maxScore}, ${pct}%)`);
    } else {
      buildClaudeFeedback = claudeResult;
      log(`❌ Build FAILED validation (attempt ${buildAttempt}, score: ${score}/15). ${buildAttempt < MAX_BUILD_ATTEMPTS ? 'Retrying...' : 'Publishing best effort.'}`);
    }
  }
  
  // v2: NULA BEST EFFORT — if not validated, STOP. Don't push broken code.
  if (!buildValidated) {
    log(`🛑 [v2] NULA BEST EFFORT: Build NOT validated after ${buildAttempt} attempts. NOT pushing.`);
    await notifyTelegram(`🛑 Build СПРЯН: <b>${data.name}</b>\n${buildAttempt} опита, не мина валидация.\nНе е push-нато. Нужна е намеса.`);
    return `Build STOPPED (not validated after ${buildAttempt} attempts) — nula best effort`;
  }
  
  // Build validated — proceed with push
  const finalOutput = path.join(buildDir, 'index.html');
  if (!fs.existsSync(finalOutput)) {
    throw new Error('Codex did not produce index.html after all attempts');
  }
  
  // Ensure demo dir exists (gitPull may have cleaned it)
  if (!fs.existsSync(demoDir)) fs.mkdirSync(demoDir, { recursive: true });
  
  // Copy to demo dir
  fs.copyFileSync(finalOutput, path.join(demoDir, 'index.html'));
  
  // === LOCK: Save baseline version for future revisions ===
  // baseline.html is the LOCKED approved design — revisions work FROM this, never modify it
  fs.copyFileSync(finalOutput, path.join(demoDir, 'baseline.html'));
  log(`LOCKED baseline: ${path.join(demoDir, 'baseline.html')}`);
  
  // Git add demos folder and push
  try {
    execSync(`git add "demos/${task.slug}/"`, { cwd: DEMO_REPO, stdio: 'pipe' });
    execSync(`git add "data/${task.slug}.json"`, { cwd: DEMO_REPO, stdio: 'pipe' });
  } catch {}
  
  const demoUrl = `https://koiopenclaw-max.github.io/demo-sites/demos/${encodeURIComponent(task.slug)}/`;
  data.demoUrl = demoUrl;
  data.status = 'done';
  
  // v2: Update file manifest after successful build
  if (demoManifest) {
    const manifest = demoManifest.generateManifest(task.slug);
    if (manifest.length > 0) {
      data.files = manifest;
      data.filesUpdatedAt = new Date().toISOString();
      log(`[v2] Post-build manifest updated: ${manifest.length} files`);
    }
  }
  
  saveDemoData(task.slug, data);
  
  {
    const vTag = buildValidated ? '' : ' (best-effort)';
    const pushed = guardedPush(task.slug, 'done', data.name, `[done] ${data.name} — demo built${vTag} (worker)`);
    if (!pushed) {
      log(`⛔ Build push blocked by status guard for ${data.name}`);
    }
  }
  
  const statusEmoji = buildValidated ? '🎉' : '⚠️';
  const statusNote = buildValidated ? '' : '\n⚠️ Не е напълно валидиран — прегледай ръчно.';
  await notifyTelegram(`${statusEmoji} Демо готово: <b>${data.name}</b>\n🔗 ${demoUrl}${statusNote}\n\n<a href="${projectUrl(slug)}">Прегледай и одобри</a>`);
  
  // Cleanup screenshots
  try { execSync(`rm -rf "${path.join(buildDir, 'screenshots')}"`, { stdio: 'pipe' }); } catch {}
  
  return `Demo built (${buildValidated ? 'validated' : 'best-effort'}, ${buildAttempt} attempts): ${demoUrl}`;
}

async function executeRevisions(task) {
  // v7: PIPELINE-DRIVEN revision flow with Koi validation gate
  // Flow: preCodex → [scope stop?] → baseline + scrape → Codex loop → postCodex → STOP → wake Koi → Koi validates → push
  
  // v7: START notification — Крис sees that work has begun
  await notifyTelegram(`🔧 Корекция стартирана: <b>${task.name}</b>\nCodex работи (~5-10 мин)`);
  
  let demoPipeline = null;
  try { demoPipeline = require('./demo-pipeline.js'); } catch (e) {
    log(`[v6] demo-pipeline.js not available: ${e.message.substring(0, 100)} — falling back to v5 logic`);
  }
  
  const MAX_ATTEMPTS = 3;
  const data = readDemoData(task.slug);
  if (!data) throw new Error('Data file not found');
  
  const issues = data.currentRevision || 'Не са описани конкретни проблеми';
  
  // === STEP 0: Determine working repo ===
  let workDir, isDeployRepo = false;
  const demoDir = path.join(DEMO_REPO, 'demos', task.slug);
  
  if (data.deployRepo) {
    isDeployRepo = true;
    const repoName = data.deployRepo.split('/').pop();
    workDir = `/tmp/${repoName}`;
    if (fs.existsSync(workDir)) {
      try { execSync(`cd "${workDir}" && git pull --no-rebase origin main`, { timeout: 30000, stdio: 'pipe' }); }
      catch { execSync(`rm -rf "${workDir}"`, { stdio: 'pipe' }); }
    }
    if (!fs.existsSync(workDir)) {
      execSync(`git clone https://x-access-token:${GH_TOKEN}@github.com/${data.deployRepo}.git "${workDir}"`, { timeout: 30000, stdio: 'pipe' });
    }
  } else {
    workDir = demoDir;
    try { execSync('git stash --quiet', { cwd: DEMO_REPO, timeout: 5000, stdio: 'pipe' }); } catch {}
    try { execSync('git pull --no-rebase origin main', { cwd: DEMO_REPO, timeout: 30000, stdio: 'pipe' }); } catch (e) {
      log(`Revision git pull failed: ${e.message} — fetching only`);
      try { execSync('git fetch origin main', { cwd: DEMO_REPO, timeout: 15000, stdio: 'pipe' }); } catch {}
    }
    try { execSync('git stash pop --quiet', { cwd: DEMO_REPO, timeout: 5000, stdio: 'pipe' }); } catch {}
  }
  
  // === STEP 1: PRE-CODEX PIPELINE (tag → manifest → scope → sandbox → measure) ===
  let pipelineState = null;
  let scopeResult = null;
  let measurePrompt = '';
  
  if (demoPipeline) {
    const liveUrl = data.liveUrl || data.demoUrl || null;
    const pre = demoPipeline.preCodex({
      slug: task.slug,
      siteName: data.name,
      instructions: issues,
      workDir,
      action: 'revision',
      liveUrl,
    });
    pipelineState = pre.state;
    scopeResult = pre.scope;
    measurePrompt = pre.measurePrompt;
    
    log(`[v6] preCodex: proceed=${pre.proceed} scope=${pre.scope?.type}/${pre.scope?.confidence} manifest=${pre.manifest.length} measure=${pre.measurePrompt.length}chars`);
    
    // Handle SCOPE STOP → but let surgical try first for EDIT-type
    if (!pre.proceed) {
      if (scopeResult && scopeResult.type === 'EDIT') {
        log(`[v6] SCOPE STOP (${pre.stopReason}) but type=EDIT — letting surgical path try first`);
        // Don't stop — surgical will attempt below, falls back to Codex if it can't
      } else {
        log(`🛑 [v6] SCOPE STOP: ${pre.stopReason}`);
        const clarification = demoPipeline.handleScopeStop({
          slug: task.slug,
          siteName: data.name,
          instructions: issues,
          manifest: pre.manifest,
          stopReason: pre.stopReason,
        });
        
        // Update data JSON with clarification questions
        Object.assign(data, clarification.dataUpdate);
        data.updatedAt = new Date().toISOString();
        saveDemoData(task.slug, data);
        gitCommitPush(task.slug, 'needs_clarification', data.name);
        
        const qList = clarification.questions.map(q => '• ' + q).join('\n');
        await notifyTelegram(`❓ Уточнение: <b>${data.name}</b>\nИнструкцията е неясна: "${issues.substring(0, 100)}"\n\n<a href="${projectUrl(task.slug)}">Отговори на ${clarification.questions.length} въпроса</a>`);
        return `Revision needs clarification — ${clarification.questions.length} questions sent to client`;
      }
    }
    
    // Save scope to data
    if (scopeResult) {
      if (!data.v2) data.v2 = {};
      data.v2.lastScope = scopeResult;
      data.v2.lastScopeAt = new Date().toISOString();
      saveDemoData(task.slug, data);
    }
  }
  
  // === STEP 1b: CLASSIFY REVISION (AUTO / SUPERVISED / MANUAL) ===
  let revisionMode = 'SUPERVISED'; // default safe
  try {
    const demoScope = require('./demo-scope.js');
    const classification = demoScope.classifyRevision(issues, scopeResult);
    revisionMode = classification.mode;
    log(`[v8] Classification: ${revisionMode} — ${classification.reason}`);
    
    // Shadow mode: log classification but always run as SUPERVISED
    // After 7 days of shadow data, analyze accuracy and enable AUTO
    if (!data.v2) data.v2 = {};
    if (!data.v2.classificationLog) data.v2.classificationLog = [];
    data.v2.classificationLog.push({
      mode: revisionMode,
      reason: classification.reason,
      instructions: issues.substring(0, 200),
      scope: scopeResult ? { type: scopeResult.type, confidence: scopeResult.confidence, fileCount: (scopeResult.writeFiles?.length || 0) } : null,
      timestamp: new Date().toISOString(),
      shadow: true // shadow mode — logged but overridden to SUPERVISED
    });
    // Keep last 20 classification logs
    if (data.v2.classificationLog.length > 20) data.v2.classificationLog = data.v2.classificationLog.slice(-20);
    saveDemoData(task.slug, data);
    
    // SHADOW MODE: override to SUPERVISED until proven accurate
    if (revisionMode === 'AUTO') {
      log(`[v8] Shadow mode: AUTO → SUPERVISED (shadow logging only)`);
      revisionMode = 'SUPERVISED';
    }
  } catch (e) {
    log(`[v8] Classification error: ${e.message.substring(0, 100)} — defaulting to SUPERVISED`);
  }
  
  // === STEP 1c: BEFORE SCREENSHOTS ===
  let beforeScreenshots = { desktop: null, mobile: null };
  let demoScreenshots = null;
  try {
    demoScreenshots = require('./demo-screenshots.js');
    const liveUrl = data.liveUrl || data.demoUrl;
    if (liveUrl) {
      log(`[v8] Taking BEFORE screenshots: ${liveUrl}`);
      beforeScreenshots = demoScreenshots.takeScreenshots(liveUrl, 'before', task.slug);
      log(`[v8] Before screenshots: ${beforeScreenshots.paths.length} captured`);
    }
  } catch (e) {
    log(`[v8] Before screenshots error: ${e.message.substring(0, 100)}`);
  }
  
  // === STEP 2: Baseline + scrape (unchanged — worker-specific logic) ===
  const baselinePath = path.join(demoDir, 'baseline.html');
  const currentPath = path.join(workDir, 'index.html');
  
  if (!fs.existsSync(baselinePath)) {
    if (fs.existsSync(currentPath)) {
      if (!fs.existsSync(demoDir)) fs.mkdirSync(demoDir, { recursive: true });
      fs.copyFileSync(currentPath, baselinePath);
      log(`Created baseline from current index.html`);
    } else {
      throw new Error(`No baseline.html and no index.html found for ${task.slug}`);
    }
  }
  
  const baselineHtml = fs.readFileSync(baselinePath, 'utf8');
  log(`Baseline loaded: ${baselinePath} (${baselineHtml.length} bytes)`);
  
  // Deep scrape
  let scrapedPages = {};
  let scrapeSummary = '';
  if (data.websiteUrl) {
    const baseUrl = data.websiteUrl.replace(/\/$/, '');
    log(`Deep scraping: ${baseUrl}...`);
    const homepageHtml = scrapeUrl(baseUrl + '/');
    if (homepageHtml) {
      scrapedPages['/'] = homepageHtml;
      const domain = new URL(baseUrl).hostname;
      const linkRegex = new RegExp(`href="((?:https?://${domain.replace('.', '\\.')})?/[^"]{2,80})"`, 'gi');
      const allLinks = [...new Set((homepageHtml.match(linkRegex) || [])
        .map(m => { const match = m.match(/href="([^"]+)"/); if (!match) return null; let url = match[1]; if (url.startsWith('/')) url = baseUrl + url; try { return new URL(url).pathname; } catch { return null; } })
        .filter(p => p && p !== '/' && !p.match(/\.(jpg|png|gif|svg|css|js|xml|json|pdf|zip|rss|feed)/i) && !p.includes('wp-'))
      )];
      for (const pagePath of allLinks.slice(0, 10)) {
        try { const pageHtml = scrapeUrl(baseUrl + pagePath); if (pageHtml && pageHtml.length > 500) { scrapedPages[pagePath] = pageHtml; } } catch {}
      }
    }
    for (const [pagePath, html] of Object.entries(scrapedPages)) {
      const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, '\n').replace(/\s+/g, ' ').trim().substring(0, 3000);
      scrapeSummary += `\n=== PAGE: ${pagePath} ===\n${text}\n`;
    }
    log(`Deep scrape: ${Object.keys(scrapedPages).length} pages`);
  }
  
  // === STEP 3: Build directory + Codex loop ===
  const buildDir = `/tmp/demo-revision-${task.slug}`;
  if (fs.existsSync(buildDir)) execSync(`rm -rf "${buildDir}"`, { stdio: 'pipe' });
  fs.mkdirSync(buildDir, { recursive: true });
  
  fs.writeFileSync(path.join(buildDir, 'baseline.html'), baselineHtml);
  if (scrapeSummary) fs.writeFileSync(path.join(buildDir, 'scraped-content.txt'), scrapeSummary);
  for (const [pagePath, html] of Object.entries(scrapedPages)) {
    const safeName = pagePath.replace(/\//g, '_').replace(/^_/, '') || 'home';
    fs.writeFileSync(path.join(buildDir, `original-page-${safeName}.html`), html.substring(0, 500000));
  }
  fs.writeFileSync(path.join(buildDir, 'brief.md'), data.brief || '');
  
  const needsMultiPage = /страниц|pages|допълнителн|създа.*страниц|прехвърл.*съдържание/i.test(issues);
  const scrapedPageCount = Object.keys(scrapedPages).length;
  
  // === STEP 2.5: SURGICAL EDIT PATH (skip Codex for micro-edits) ===
  let surgicalDone = false;
  let surgicalFiles = [];
  
  if (scopeResult && scopeResult.type === 'EDIT' && !needsMultiPage) {
    try {
      const demoSurgical = require('./demo-surgical.js');
      const allSiteFiles = fs.readdirSync(workDir).filter(f => f.endsWith('.html') || f.endsWith('.css'));
      const writeFiles = scopeResult.writeFiles && scopeResult.writeFiles.length > 0 ? scopeResult.writeFiles : allSiteFiles;
      
      log(`[surgical] Analyzing: scope=EDIT, writeFiles=${writeFiles.join(',')}`);
      const analysis = demoSurgical.analyzeSurgical({
        instructions: issues,
        scope: scopeResult,
        workDir,
        writeFiles: allSiteFiles, // Give ALL site files so Claude can find the pattern everywhere
      });
      
      if (analysis && analysis.surgical && analysis.edits && analysis.edits.length > 0) {
        // Sanity check: too many edits per file = Claude overscoped
        const uniqueFiles = [...new Set(analysis.edits.map(e => e.file))];
        const editsPerPrimaryFile = analysis.edits.filter(e => e.file === 'index.html' || e.file === allSiteFiles[0]).length;
        log(`[surgical] Plan: ${analysis.edits.length} edits (${editsPerPrimaryFile} on primary) across ${uniqueFiles.length} files`);
        log(`[surgical] Reasoning: ${analysis.reasoning}`);
        
        // Multi-file sites: CSS/font changes replicate across all files = high edit count is EXPECTED
        // Only reject if edits-per-file is unreasonable (>15) — not the old limit of 5
        const MAX_EDITS_PER_PRIMARY = uniqueFiles.length > 3 ? 15 : 8;
        if (editsPerPrimaryFile > MAX_EDITS_PER_PRIMARY) {
          log(`[surgical] ⚠️ REJECTED: ${editsPerPrimaryFile} edits on primary file (limit: ${MAX_EDITS_PER_PRIMARY} for ${uniqueFiles.length} files) — Claude overscoped. Falling through to Codex.`);
          analysis.surgical = false;
        }
      }
      
      if (analysis && analysis.surgical && analysis.edits && analysis.edits.length > 0) {
        
        // Backup files before editing
        const backupDir = path.join(buildDir, '_surgical_backup');
        fs.mkdirSync(backupDir, { recursive: true });
        for (const f of [...new Set(analysis.edits.map(e => e.file))]) {
          const src = path.join(workDir, f);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, f));
        }
        
        // Apply edits
        const result = demoSurgical.applySurgical(analysis.edits, workDir);
        log(`[surgical] Applied: ${result.applied}/${analysis.edits.length}, failed: ${result.failed.length}, files: ${result.files.join(',')}`);
        
        if (result.failed.length > 0) {
          for (const f of result.failed) log(`[surgical] FAILED: ${f.file} — ${f.description}: ${f.error}`);
        }
        
        // Validate — diff should be minimal
        const validation = demoSurgical.validateSurgical(analysis.edits, workDir, backupDir);
        
        if (result.applied > 0 && result.failed.length === 0 && validation.valid) {
          log(`[surgical] ✅ All edits applied and validated. Skipping Codex.`);
          surgicalDone = true;
          surgicalFiles = result.files.filter(f => f !== 'baseline.html'); // Don't push baseline changes
          
          // Surgical edits are minimal and validated — push directly (no Koi gate needed)
          log(`[surgical] Pushing ${surgicalFiles.length} files directly (surgical = safe)...`);
          try {
            for (const f of surgicalFiles) {
              execSync(`git add "demos/${task.slug}/${f}"`, { cwd: DEMO_REPO, timeout: 5000, stdio: 'pipe' });
            }
            execSync(`git commit -m "surgical(${task.slug}): ${issues.substring(0, 60).replace(/"/g, "'")}"`, { cwd: DEMO_REPO, timeout: 10000, stdio: 'pipe' });
            execSync('git push origin main', { cwd: DEMO_REPO, timeout: 30000, stdio: 'pipe' });
            log(`[surgical] ✅ Pushed to GitHub`);
          } catch (gitErr) {
            log(`[surgical] Git push failed: ${gitErr.message.substring(0, 200)}`);
          }
          
          // Update status to review
          const resolution = `✅ Surgical: ${result.applied} edits across ${surgicalFiles.length} files. ${analysis.reasoning?.substring(0, 100) || ''}`;
          data.status = 'review';
          if (!data.revisionHistory) data.revisionHistory = [];
          const lastRev = data.revisionHistory[data.revisionHistory.length - 1];
          if (lastRev && !lastRev.resolvedAt) {
            lastRev.resolvedAt = new Date().toISOString();
            lastRev.resolution = resolution;
          }
          data.currentRevision = null;
          data.updatedAt = new Date().toISOString();
          saveDemoData(task.slug, data);
          gitCommitPush(task.slug, 'review', data.name);
          
          // Notify
          const reviewUrl = data.demoUrl || `https://koiopenclaw-max.github.io/demo-sites/demos/${encodeURIComponent(task.slug)}/`;
          await notifyTelegram(`✅ Surgical корекция: <b>${data.name}</b>\n📝 ${issues.substring(0, 150)}\n🔗 ${reviewUrl}\n${result.applied} edits, ${surgicalFiles.length} файла, 0 грешки`);
          
          return `Surgical revision completed: ${result.applied} edits, ${surgicalFiles.length} files`;
        
        } else {
          log(`[surgical] ❌ Validation failed or partial edits — rolling back, falling through to Codex`);
          if (validation.issues.length > 0) log(`[surgical] Issues: ${validation.issues.join('; ')}`);
          // Rollback
          for (const f of [...new Set(analysis.edits.map(e => e.file))]) {
            const backup = path.join(backupDir, f);
            if (fs.existsSync(backup)) fs.copyFileSync(backup, path.join(workDir, f));
          }
        }
      } else {
        log(`[surgical] Not surgical: ${analysis?.reasoning || 'analysis returned null'}`);
      }
    } catch (e) {
      log(`[surgical] Error: ${e.message.substring(0, 200)} — falling through to Codex`);
    }
  }
  
  let attempt = 0;
  let claudeFeedback = '';
  let validated = surgicalDone;
  
  // Skip Codex loop entirely if surgical edit succeeded
  if (surgicalDone) {
    attempt = 1; // For the done trigger
    log(`[surgical] Surgical path completed — skipping Codex loop`);
  }
  
  while (attempt < MAX_ATTEMPTS && !validated) {
    attempt++;
    log(`Revision attempt ${attempt}/${MAX_ATTEMPTS} for ${data.name}...`);
    
    const retrySection = claudeFeedback ? `\nPREVIOUS ATTEMPT FAILED VALIDATION. Fix these issues:\n${claudeFeedback}\nThis is attempt ${attempt}/${MAX_ATTEMPTS}.\n` : '';
    
    const multiPageInstructions = needsMultiPage ? `\nMULTI-PAGE INSTRUCTIONS:\nCreate SEPARATE HTML files for each page. Original site has ${scrapedPageCount} pages.\n${Object.keys(scrapedPages).filter(p => p !== '/').map(p => `- ${p.replace(/\//g, '').replace(/^$/, 'home')}.html`).join('\n')}\nEach page: same design as baseline.html, real content, working nav links.\n` : '';
    
    const scopeSection = scopeResult ? `\n=== SCOPE LOCK ===\nType: ${scopeResult.type} | You may ONLY modify: ${scopeResult.writeFiles.join(', ')}\n${scopeResult.newFiles?.length > 0 ? 'You may CREATE: ' + scopeResult.newFiles.join(', ') + '\n' : ''}ALL other files are READ-ONLY.\n` : '';

    const prompt = `You are revising a demo website for "${data.name}".

=== CRITICAL RULE ===
baseline.html is the LOCKED approved design. Preserve its visual appearance.
DO NOT change the design unless the revision explicitly asks for it.
${scopeSection}${measurePrompt}
=== REVISION INSTRUCTIONS ===
${issues}

=== INPUT FILES ===
- baseline.html — LOCKED approved design
${scrapeSummary ? '- scraped-content.txt — content from original site' : ''}
- brief.md — project brief
${retrySection}${multiPageInstructions}
=== INSTRUCTIONS ===
1. Read baseline.html — approved design to keep
2. Apply the revision instructions
3. ${scrapeSummary ? 'Use scraped-content.txt for content' : 'Make targeted changes only'}
4. All CSS identical to baseline. All text in Bulgarian.

OUTPUT: Save all HTML files in this directory.`;

    fs.writeFileSync(path.join(buildDir, 'PROMPT.md'), prompt);
    
    // Clean previous outputs
    try { for (const f of fs.readdirSync(buildDir).filter(f => f.endsWith('.html') && f !== 'baseline.html' && !f.startsWith('original-page-'))) { fs.unlinkSync(path.join(buildDir, f)); } } catch {}
    
    // Run Codex
    log(`Spawning Codex (attempt ${attempt})...`);
    try {
      try { execSync(`rm -rf "${buildDir}/.git"`, { stdio: 'pipe' }); } catch {}
      execSync(`cd "${buildDir}" && git init -q && codex exec --full-auto "Read PROMPT.md and follow the instructions exactly." 2>&1 | tail -20`, {
        timeout: 600000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PATH: `${process.env.PATH}:/home/clawd/.npm-global/bin` }
      });
    } catch (e) { log(`Codex attempt ${attempt}: ${e.message.substring(0, 200)}`); }
    
    const outputFiles = fs.readdirSync(buildDir).filter(f => f.endsWith('.html') && f !== 'baseline.html' && !f.startsWith('original-page-'));
    if (!outputFiles.includes('index.html')) { claudeFeedback = 'No index.html produced.'; continue; }
    log(`Codex produced: ${outputFiles.join(', ')}`);
    
    // Claude validation
    log(`Validating attempt ${attempt}...`);
    const validationPrompt = `Compare baseline.html (locked design) against output files (${outputFiles.join(', ')}).
Revision instructions: ${issues.substring(0, 500)}
Check: 1) Design preserved? 2) Instructions fulfilled? 3) HTML valid, Bulgarian text?
Reply: VALIDATED: YES or VALIDATED: NO with PROBLEMS and FIX_INSTRUCTIONS.`;

    let claudeResult = '';
    try {
      fs.writeFileSync(path.join(buildDir, 'VALIDATE.md'), validationPrompt);
      claudeResult = execSync(`cd "${buildDir}" && claude --print --permission-mode bypassPermissions "Read VALIDATE.md and validate the output files against baseline.html." 2>/dev/null`, {
        timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env, PATH: `${process.env.PATH}:/home/clawd/.local/bin:/home/clawd/.npm-global/bin:/usr/local/bin:/usr/bin:/bin` }
      }).toString().trim();
    } catch (e) {
      claudeResult = 'VALIDATED: NO\nPROBLEMS:\n- Validation error\nFIX_INSTRUCTIONS:\n- Re-read PROMPT.md';
    }
    
    log(`Claude verdict (attempt ${attempt}): ${claudeResult.substring(0, 300)}`);
    if (claudeResult.includes('VALIDATED: YES')) { validated = true; log(`✅ VALIDATED on attempt ${attempt}`); }
    else { claudeFeedback = claudeResult; log(`❌ FAILED attempt ${attempt}`); }
  }
  
  // === STEP 4: POST-CODEX PIPELINE (diff → copy → push → QA → autofix) ===
  // Filename filter: skip files with invalid names (URLs, special chars, too long)
  const isValidFilename = (f) => f.length < 100 && !/[?#:&=]/.test(f) && !f.includes('googleapis') && !f.includes('http') && !f.includes('www.');
  
  // For surgical edits, files are already in workDir — use surgicalFiles
  const finalFiles = surgicalDone ? surgicalFiles : fs.readdirSync(buildDir).filter(f => f.endsWith('.html') && f !== 'baseline.html' && !f.startsWith('original-page-') && !f.startsWith('_') && isValidFilename(f));
  const skippedFiles = surgicalDone ? [] : fs.readdirSync(buildDir).filter(f => f.endsWith('.html') && f !== 'baseline.html' && !f.startsWith('original-page-') && !f.startsWith('_') && !isValidFilename(f));
  if (skippedFiles.length > 0) log(`⚠️ Skipped ${skippedFiles.length} invalid filenames: ${skippedFiles.join(', ')}`);
  
  if (finalFiles.length === 0) {
    throw new Error(`Revision failed after ${MAX_ATTEMPTS} attempts — no HTML files produced`);
  }
  
  if (!validated) {
    log(`🛑 NULA BEST EFFORT: Not validated after ${MAX_ATTEMPTS} attempts. NOT pushing.`);
    await notifyTelegram(`🛑 Ревизия СПРЯНА: <b>${data.name}</b>\n${MAX_ATTEMPTS} опита, не мина валидация.\nНе е push-нато. Нужна е намеса.`);
    return `Revision STOPPED (not validated after ${MAX_ATTEMPTS} attempts)`;
  }
  
  // Diff audit via pipeline
  if (demoPipeline && scopeResult) {
    const postResult = demoPipeline.postCodex({
      state: pipelineState || { slug: task.slug, action: 'revision', phases: {} },
      slug: task.slug,
      siteName: data.name,
      sandboxDir: buildDir,
      workDir,
      scope: scopeResult,
      liveUrl: null,  // QA runs after deploy below
    });
    if (postResult.diffAudit) {
      log(`[v6] Diff audit: passed=${postResult.diffAudit.passed} reverted=${postResult.diffAudit.reverted?.length || 0}`);
      if (!data.v2) data.v2 = {};
      data.v2.lastDiffAudit = { passed: postResult.diffAudit.passed, stats: postResult.diffAudit.stats, reverted: postResult.diffAudit.reverted };
    }
  }
  
  // Copy output files to local dirs (NOT pushed yet — Koi validates first)
  // For surgical: files are already edited in-place in workDir, just need to sync demoDir if different
  if (!fs.existsSync(demoDir)) fs.mkdirSync(demoDir, { recursive: true });
  for (const f of finalFiles) {
    if (surgicalDone) {
      // Surgical edits were applied directly to workDir
      // If workDir !== demoDir, sync to demoDir
      if (workDir !== demoDir && fs.existsSync(path.join(workDir, f))) {
        fs.copyFileSync(path.join(workDir, f), path.join(demoDir, f));
      }
      log(`Surgical: ${f} (edited in-place)`);
    } else {
      fs.copyFileSync(path.join(buildDir, f), path.join(demoDir, f));
      if (isDeployRepo) fs.copyFileSync(path.join(buildDir, f), path.join(workDir, f));
      log(`Copied: ${f}`);
    }
  }
  if (!fs.existsSync(path.join(demoDir, 'baseline.html'))) {
    fs.copyFileSync(path.join(buildDir, 'baseline.html'), path.join(demoDir, 'baseline.html'));
  }
  
  // === v9: VISUAL GATE — automatic before/after comparison ===
  // Takes AFTER screenshots locally, compares with BEFORE via image model.
  // If design is broken → revert files, notify, stop. No push.
  // If design is OK → continue to Koi validation trigger.
  let visualGateResult = null;
  if (beforeScreenshots.desktop && demoScreenshots) {
    try {
      log(`[v9] Visual gate: comparing before/after for ${task.slug}...`);
      visualGateResult = demoScreenshots.visualGate(beforeScreenshots, demoDir, task.slug, issues);
      log(`[v9] Visual gate result: passed=${visualGateResult.passed} verdict=${(visualGateResult.verdict || '').substring(0, 150)}`);
      
      if (!visualGateResult.passed) {
        // REVERT: restore original files from baseline/before state
        log(`[v9] 🛑 VISUAL GATE FAILED — design regression detected. Reverting files.`);
        
        // Git checkout to restore original files in demoDir
        try {
          execSync(`cd "${DEMO_REPO}" && git checkout -- "demos/${task.slug}/"`, { timeout: 15000, stdio: 'pipe' });
          log(`[v9] Files reverted via git checkout`);
        } catch (revertErr) {
          log(`[v9] Git revert failed: ${revertErr.message.substring(0, 100)}`);
        }
        
        // Also revert workDir if deploy repo
        if (isDeployRepo && workDir !== demoDir) {
          try {
            execSync(`cd "${workDir}" && git checkout -- .`, { timeout: 15000, stdio: 'pipe' });
            log(`[v9] Deploy repo files reverted`);
          } catch (revertErr) {
            log(`[v9] Deploy repo revert failed: ${revertErr.message.substring(0, 100)}`);
          }
        }
        
        // Save visual audit trail
        if (!data.v2) data.v2 = {};
        data.v2.lastVisualGate = {
          passed: false,
          verdict: (visualGateResult.verdict || '').substring(0, 500),
          beforeDesktop: beforeScreenshots.desktop,
          afterDesktop: visualGateResult.afterScreenshots?.desktop,
          timestamp: new Date().toISOString()
        };
        saveDemoData(task.slug, data);
        
        // Notify and stop
        await notifyTelegram(`🛑 <b>${data.name}</b> — дизайн regression!\nVisual gate FAIL. Файловете са revert-нати.\n\nПричина: ${(visualGateResult.verdict || '').substring(0, 200)}\n\nКорекцията НЕ е приложена.`);
        
        // Cleanup
        try { execSync(`rm -rf "${buildDir}"`, { stdio: 'pipe' }); } catch {}
        try { fs.unlinkSync(`/tmp/demo-revision-trigger-${task.slug}.json`); } catch {}
        
        return `VISUAL GATE FAILED: Design regression detected. Files reverted. Verdict: ${(visualGateResult.verdict || '').substring(0, 200)}`;
      }
      
      // Gate PASSED — save audit trail and continue
      if (!data.v2) data.v2 = {};
      data.v2.lastVisualGate = {
        passed: true,
        verdict: (visualGateResult.verdict || '').substring(0, 500),
        beforeDesktop: beforeScreenshots.desktop,
        afterDesktop: visualGateResult.afterScreenshots?.desktop,
        timestamp: new Date().toISOString()
      };
      saveDemoData(task.slug, data);
      log(`[v9] ✅ Visual gate PASSED — design preserved`);
      
    } catch (vgError) {
      log(`[v9] Visual gate error: ${vgError.message.substring(0, 200)} — continuing to Koi validation`);
      // On error, don't block — let Koi validate manually
    }
  } else {
    log(`[v9] Visual gate skipped — no before screenshots or module not loaded`);
  }

  // === v7: KOI VALIDATION GATE ===
  // Worker STOPS here. Writes done trigger + wakes Koi.
  // Koi validates visually (screenshot before/after), then pushes.
  const reviewUrl = data.deployRepo ? data.liveUrl || data.demoUrl : data.demoUrl || `https://koiopenclaw-max.github.io/demo-sites/demos/${encodeURIComponent(task.slug)}/`;
  
  const doneTrigger = {
    slug: task.slug,
    name: data.name,
    status: 'revision-pending-validation',
    issues: issues.substring(0, 500),
    finalFiles,
    demoDir,
    workDir,
    isDeployRepo,
    deployRepo: data.deployRepo || null,
    reviewUrl,
    buildDir,
    attempt,
    revisionMode,
    beforeScreenshots: { desktop: beforeScreenshots.desktop, mobile: beforeScreenshots.mobile },
    pipelineState: pipelineState ? { slug: pipelineState.slug, action: pipelineState.action } : null,
    scopeResult: scopeResult ? { type: scopeResult.type, confidence: scopeResult.confidence, writeFiles: scopeResult.writeFiles } : null,
    visualGate: visualGateResult ? { passed: visualGateResult.passed, verdict: (visualGateResult.verdict || '').substring(0, 300) } : null,
    timestamp: new Date().toISOString()
  };
  const triggerPath = `/tmp/demo-revision-done-${task.slug.replace(/[^a-zA-Z0-9а-яА-Я-]/g, '_')}.json`;
  fs.writeFileSync(triggerPath, JSON.stringify(doneTrigger, null, 2));
  log(`[v7] Koi validation trigger written: ${triggerPath}`);
  
  // Wake Koi (Layer 1: system event)
  try {
    execSync(OPENCLAW + ` system event --text "REVISION_DONE: ${data.name} — Codex finished (${finalFiles.length} files, attempt ${attempt}/${MAX_ATTEMPTS}). Validate and push." --mode now`, {
      timeout: 10000, stdio: 'pipe'
    });
    log(`[v7] Koi wake event sent`);
  } catch (e) {
    log(`[v7] Koi wake event FAILED: ${e.message.substring(0, 100)} — trigger file remains for heartbeat pickup`);
  }
  
  await notifyTelegram(`📸 Codex свърши: <b>${data.name}</b>\nKoi проверява резултата (~1 мин)...`);
  
  // Cleanup build dir (output already copied to demoDir/workDir)
  try { execSync(`rm -rf "${buildDir}"`, { stdio: 'pipe' }); } catch {}
  try { fs.unlinkSync(`/tmp/demo-revision-trigger-${task.slug}.json`); } catch {}
  
  return `Codex done (attempt ${attempt}/${MAX_ATTEMPTS}, ${finalFiles.length} files). Awaiting Koi validation. Trigger: ${triggerPath}`;
  
  // === BELOW IS NOW DEAD CODE — Koi handles push + QA + notify ===
  // Kept for reference / rollback. Will be cleaned up after v7 is stable.
  
  /* v6 ORIGINAL: direct push + QA (no Koi validation)
  // Push to deploy repo
  if (isDeployRepo) {
    try { execSync(`cd "${workDir}" && git add -A && git commit -m "Revision: ${data.name}" && git push origin main`, { timeout: 30000, stdio: 'pipe' }); log(`Pushed to deploy repo`); } catch (e) { log(`Deploy push error: ${e.message.substring(0, 100)}`); }
  }
  
  // Push to demo-sites repo
  if (data.revisionHistory?.length > 0) {
    const lastRevision = data.revisionHistory[data.revisionHistory.length - 1];
    lastRevision.resolution = `✅ Валидирано (attempt ${attempt}): ${finalFiles.length} файла — ${finalFiles.join(', ')}`;
    lastRevision.resolvedAt = new Date().toISOString();
  }
  data.currentRevision = null;
  data.status = 'review';
  
  if (demoManifest) {
    const manifest = demoManifest.generateManifest(task.slug);
    if (manifest.length > 0) { data.files = manifest; data.filesUpdatedAt = new Date().toISOString(); }
  }
  saveDemoData(task.slug, data);
  guardedPush(task.slug, 'review', data.name, `[review] ${data.name} — revision v6 (pipeline)`);
  
  const reviewUrlOld = data.deployRepo ? data.liveUrl || data.demoUrl : data.demoUrl || `https://koiopenclaw-max.github.io/demo-sites/demos/${encodeURIComponent(task.slug)}/`;
  
  // === STEP 5: POST-DEPLOY QA + AUTOFIX ===
  let qaReport = '';
  if (demoPipeline && reviewUrlOld) {
    log(`[v6] Running post-deploy QA on ${reviewUrlOld}...`);
    // Wait for GitHub Pages deploy
    await new Promise(r => setTimeout(r, 15000));
    
    const postDeploy = demoPipeline.postCodex({
      state: pipelineState || { slug: task.slug, action: 'revision', phases: {} },
      slug: task.slug,
      siteName: data.name,
      sandboxDir: null,
      workDir: null,
      scope: scopeResult,
      liveUrl: reviewUrl,
    });
    
    if (postDeploy.qaResult) {
      qaReport = demoPipeline.formatQA(postDeploy.qaResult, reviewUrl);
      log(`[v6] QA: passed=${postDeploy.qaResult.passed} critical=${postDeploy.qaResult.criticalFails} warnings=${postDeploy.qaResult.warnings}`);
      log(`[v6] Ship decision: ${postDeploy.shipDecision.action} — ${postDeploy.shipDecision.reason}`);
      
      // AUTO-FIX LOOP
      if (postDeploy.shipDecision.action === 'AUTOFIX' && postDeploy.autoFixContext?.shouldProceed) {
        log(`[v6] 🔧 Starting auto-fix loop...`);
        let prevQA = postDeploy.qaResult;
        
        for (let fixAttempt = 1; fixAttempt <= 3; fixAttempt++) {
          const fixCtx = demoPipeline.prepareAutoFix({
            slug: task.slug,
            siteName: data.name,
            prevQA,
            liveUrl: reviewUrl,
            writeFiles: scopeResult?.writeFiles || ['index.html'],
            attempt: fixAttempt,
            previousFeedback: fixAttempt > 1 ? `Attempt ${fixAttempt - 1} did not resolve all issues.` : null,
          });
          
          if (!fixCtx.shouldProceed) { log(`[v6] Auto-fix stopped: ${fixCtx.reason}`); break; }
          
          // Write fix prompt and run Codex
          const fixDir = `/tmp/demo-autofix-build-${task.slug}`;
          if (fs.existsSync(fixDir)) execSync(`rm -rf "${fixDir}"`, { stdio: 'pipe' });
          fs.mkdirSync(fixDir, { recursive: true });
          
          // Copy current files to fix dir
          const sourceForFix = isDeployRepo ? workDir : demoDir;
          for (const f of fs.readdirSync(sourceForFix).filter(f => !f.startsWith('.') && f !== 'baseline.html')) {
            const src = path.join(sourceForFix, f);
            if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(fixDir, f));
          }
          
          fs.writeFileSync(path.join(fixDir, 'PROMPT.md'), fixCtx.prompt);
          
          log(`[v6] Auto-fix attempt ${fixAttempt}: running Codex...`);
          try {
            try { execSync(`rm -rf "${fixDir}/.git"`, { stdio: 'pipe' }); } catch {}
            execSync(`cd "${fixDir}" && git init -q && codex exec --full-auto "Read PROMPT.md and fix the issues." 2>&1 | tail -10`, {
              timeout: 300000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024,
              env: { ...process.env, PATH: `${process.env.PATH}:/home/clawd/.npm-global/bin` }
            });
          } catch (e) { log(`[v6] Auto-fix Codex error: ${e.message.substring(0, 100)}`); }
          
          // Copy fixed files back
          for (const f of fs.readdirSync(fixDir).filter(f => f.endsWith('.html') || f.endsWith('.css'))) {
            fs.copyFileSync(path.join(fixDir, f), path.join(isDeployRepo ? workDir : demoDir, f));
          }
          
          // Push fixed files
          if (isDeployRepo) {
            try { execSync(`cd "${workDir}" && git add -A && git commit -m "Auto-fix ${fixAttempt}: ${data.name}" && git push origin main`, { timeout: 30000, stdio: 'pipe' }); } catch {}
          } else {
            guardedPush(task.slug, 'review', data.name, `[auto-fix ${fixAttempt}] ${data.name}`);
          }
          
          // Wait for deploy + re-test
          await new Promise(r => setTimeout(r, 15000));
          const { runQA } = require('./demo-qa.js');
          const newQA = runQA(reviewUrl);
          
          const evalResult = demoPipeline.evaluateAutoFix({ prevQA, newQA });
          log(`[v6] Auto-fix ${fixAttempt} result: fixed=${evalResult.fixed} improved=${evalResult.improved}`);
          
          if (evalResult.fixed) {
            log(`[v6] ✅ Auto-fix resolved all issues on attempt ${fixAttempt}`);
            qaReport = demoPipeline.formatQA(newQA, reviewUrl);
            break;
          }
          
          prevQA = newQA;
          try { execSync(`rm -rf "${fixDir}"`, { stdio: 'pipe' }); } catch {}
        }
      }
      
      // Save QA data
      if (!data.v2) data.v2 = {};
      data.v2.lastQA = { passed: postDeploy.qaResult.passed, criticalFails: postDeploy.qaResult.criticalFails, warnings: postDeploy.qaResult.warnings, shipDecision: postDeploy.shipDecision.action };
      data.v2.lastQAAt = new Date().toISOString();
      saveDemoData(task.slug, data);
    }
  }
  
  // Notify
  const pagesInfo = finalFiles.length > 1 ? `\n📄 Страници: ${finalFiles.join(', ')}` : '';
  const qaInfo = qaReport ? `\n📊 QA: ${data.v2?.lastQA?.passed ? '✅' : '⚠️'} ${data.v2?.lastQA?.criticalFails || 0} critical, ${data.v2?.lastQA?.warnings || 0} warnings` : '';
  await notifyTelegram(`✅ Корекции: <b>${data.name}</b>\n📝 ${issues.substring(0, 200)}${pagesInfo}\n🔗 ${reviewUrl}\nВалидирано (опит ${attempt}/${MAX_ATTEMPTS})${qaInfo}\n\n<a href="${projectUrl(task.slug)}">Прегледай</a>`);
  
  // Cleanup
  try { execSync(`rm -rf "${buildDir}"`, { stdio: 'pipe' }); } catch {}
  try { fs.unlinkSync(`/tmp/demo-revision-trigger-${task.slug}.json`); } catch {}
  
  return `Revision validated (${attempt} attempts, ${finalFiles.length} files): ${reviewUrlOld}`;
  END OF DEAD CODE */
}

async function executeDnsSetup(task) {
  const data = readDemoData(task.slug);
  if (!data) throw new Error('Data file not found');
  
  const domain = data.deployDomain;
  if (!domain) throw new Error('No deploy domain set');
  
  // Generate DNS records — status stays dns_setup but with records filled
  // Mark as worker-processed so processor doesn't re-queue
  data.workerProcessedAction = 'dns_setup';
  data.dnsRecords = [
    {
      type: 'CNAME',
      name: domain.startsWith('www.') ? domain : `www.${domain}`,
      value: 'koiopenclaw-max.github.io',
      note: 'Насочва към GitHub Pages'
    },
    {
      type: 'A',
      name: domain.replace(/^www\./, ''),
      value: '185.199.108.153',
      note: 'GitHub Pages IP (основен)'
    },
    {
      type: 'A', 
      name: domain.replace(/^www\./, ''),
      value: '185.199.109.153',
      note: 'GitHub Pages IP (резервен 1)'
    },
    {
      type: 'A',
      name: domain.replace(/^www\./, ''),
      value: '185.199.110.153',
      note: 'GitHub Pages IP (резервен 2)'
    },
    {
      type: 'A',
      name: domain.replace(/^www\./, ''),
      value: '185.199.111.153',
      note: 'GitHub Pages IP (резервен 3)'
    }
  ];
  
  saveDemoData(task.slug, data);
  gitCommitPush(task.slug, 'dns_setup', data.name);
  
  await notifyTelegram(`🌐 DNS данни готови: <b>${data.name}</b>\nДомейн: ${domain}\n\nОтвори платформата за DNS записите.`);
  
  return `DNS records generated for ${domain}`;
}

async function executeDeploying(task) {
  const data = readDemoData(task.slug);
  if (!data) throw new Error('Data file not found');
  
  const domain = data.deployDomain;
  const demoDir = path.join(DEMO_REPO, 'demos', task.slug);
  
  if (!fs.existsSync(path.join(demoDir, 'index.html'))) {
    throw new Error('Demo HTML not found — build first');
  }
  
  // Create separate GitHub repo for custom domain (like uspeh-konsult → demo53.add.bg)
  // Use domain as repo name (latin, no dots issues) or transliterate slug
  const repoName = domain.replace(/\./g, '-');
  
  log(`Creating deploy repo: ${repoName} → ${domain}`);
  
  // 1. Create repo via API
  try {
    const createPayload = JSON.stringify({ name: repoName, description: data.name, homepage: 'https://' + domain, auto_init: false, private: false });
    execSync(`curl -s -X POST -H "Authorization: token ${GH_TOKEN}" -H "Content-Type: application/json" "https://api.github.com/user/repos" -d '${createPayload.replace(/'/g, "")}'`,
      { timeout: 15000, stdio: 'pipe' });
  } catch {} // May already exist
  
  // 2. Clone, copy files, add CNAME, push
  const deployDir = '/tmp/deploy-' + task.slug + '-' + Date.now();
  fs.mkdirSync(deployDir, { recursive: true });
  
  try {
    execSync(`cd "${deployDir}" && git init && git remote add origin https://github.com/koiopenclaw-max/${repoName}.git`, { timeout: 15000, stdio: 'pipe' });
    try { execSync(`cd "${deployDir}" && git pull origin main --quiet`, { timeout: 15000, stdio: 'pipe' }); } catch {}
    
    // Copy demo files
    execSync(`cp -r "${demoDir}/"* "${deployDir}/"`, { stdio: 'pipe' });
    
    // CNAME for custom domain
    fs.writeFileSync(path.join(deployDir, 'CNAME'), domain);
    
    // Push
    execSync(`cd "${deployDir}" && git add -A && git commit -m "Deploy ${data.name} to ${domain}" && git branch -M main && git push -u origin main --force`,
      { timeout: 30000, stdio: 'pipe', env: { ...process.env, GIT_ASKPASS: 'echo', GIT_USERNAME: 'x-access-token', GIT_PASSWORD: GH_TOKEN, 
        GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', 
        GIT_CONFIG_KEY_1: 'url.https://x-access-token:' + GH_TOKEN + '@github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'https://github.com/' } });
    log(`Pushed to repo: ${repoName}`);
    
    // Enable GitHub Pages
    execSync(`curl -s -X POST -H "Authorization: token ${GH_TOKEN}" -H "Content-Type: application/json" -H "Accept: application/vnd.github.v3+json" "https://api.github.com/repos/koiopenclaw-max/${repoName}/pages" -d '{"source":{"branch":"main","path":"/"}}'`,
      { timeout: 15000, stdio: 'pipe' });
    log(`GitHub Pages enabled for ${repoName}`);
    
    // Enforce HTTPS (SSL certificate auto-generated by GitHub)
    execSync(`curl -s -X PUT -H "Authorization: token ${GH_TOKEN}" -H "Accept: application/vnd.github.v3+json" "https://api.github.com/repos/koiopenclaw-max/${repoName}/pages" -d '{"https_enforced":true}'`,
      { timeout: 15000, stdio: 'pipe' });
    log(`HTTPS enforced for ${repoName}`);
  } catch (e) {
    log(`Deploy error: ${e.message}`);
    throw new Error('Deploy failed: ' + e.message.substring(0, 200));
  } finally {
    try { execSync(`rm -rf "${deployDir}"`, { stdio: 'pipe' }); } catch {}
  }
  
  // Remove CNAME from demos subdir (wrong place)
  try { fs.unlinkSync(path.join(demoDir, 'CNAME')); } catch {}
  
  data.status = 'live';
  data.liveUrl = 'https://' + domain;
  data.deployRepo = 'koiopenclaw-max/' + repoName;
  saveDemoData(task.slug, data);
  gitCommitPush(task.slug, 'live', data.name);
  
  await notifyTelegram('🎉 На живо: <b>' + data.name + '</b>\n🌐 https://' + domain + '\n\nСайтът е deploy-нат!');
  
  return 'Deployed to ' + domain + ' (repo: ' + repoName + ')';
}

// ===== Task Dispatcher =====

// === KOI-REVISION EXECUTOR ===
// Koi wrote the assignment. Worker just executes Codex and notifies Koi for validation.
async function executeKoiRevision(task) {
  // v7: START notification — Крис sees that work has begun
  await notifyTelegram(`🔧 Корекция стартирана: <b>${task.name}</b>\nCodex работи (~5-10 мин)`);

  const ctx = JSON.parse(fs.readFileSync(task.contextFile, 'utf8'));
  const slug = task.slug;
  gitPull();
  const dataFile = path.join(DEMO_REPO, 'data', slug + '.json');
  if (!fs.existsSync(dataFile)) throw new Error('No data file for ' + slug);
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  // v2: Create pre-revision tag
  if (demoTags) {
    const tag = demoTags.createTag(DEMO_REPO, 'pre-rev', slug);
    if (tag) log(`[v2] Tag created: ${tag}`);
  }

  const isDeployRepo = !!data.deployRepo;
  const demoDir = path.join(DEMO_REPO, 'demos', slug);
  let workDir = demoDir;
  
  if (isDeployRepo) {
    workDir = path.join('/tmp', data.deployRepo.split('/').pop());
    if (!fs.existsSync(workDir)) {
      execSync(`git clone https://${GH_TOKEN}@github.com/${data.deployRepo}.git "${workDir}"`, { timeout: 30000, stdio: 'pipe' });
    } else {
      execSync(`cd "${workDir}" && git pull --no-rebase origin main`, { timeout: 15000, stdio: 'pipe' });
    }
  }

  // Build directory
  const buildDir = path.join('/tmp', 'koi-revision-' + slug.replace(/[^a-zA-Z0-9а-яА-Я-]/g, '_'));
  if (fs.existsSync(buildDir)) execSync('rm -rf "' + buildDir + '"', { stdio: 'pipe' });
  fs.mkdirSync(buildDir, { recursive: true });

  // Copy affected files
  for (const f of ctx.affectedFiles || []) {
    const src = path.join(workDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(buildDir, f));
  }
  // Also copy all HTML files as context
  if (fs.existsSync(workDir)) {
    for (const f of fs.readdirSync(workDir).filter(f => f.endsWith('.html'))) {
      const dest = path.join(buildDir, f);
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(workDir, f), dest);
    }
  }

  // Copy client screenshots if any
  if (ctx.clientImages) {
    const imgDir = path.join(buildDir, 'screenshots');
    fs.mkdirSync(imgDir, { recursive: true });
    for (let i = 0; i < ctx.clientImages.length; i++) {
      const imgPath = ctx.clientImages[i];
      if (fs.existsSync(imgPath)) {
        fs.copyFileSync(imgPath, path.join(imgDir, 'client-' + (i+1) + '.jpg'));
      }
    }
  }

  // Write Koi's exact assignment as PROMPT.md
  fs.writeFileSync(path.join(buildDir, 'PROMPT.md'), ctx.myAssignment);

  // Run Codex
  log('[KOI-REVISION] Spawning Codex with Koi assignment...');
  try {
    try { execSync('rm -rf "' + buildDir + '/.git"', { stdio: 'pipe' }); } catch {}
    execSync(
      'cd "' + buildDir + '" && git init -q && codex exec --full-auto "Read PROMPT.md and follow the instructions exactly." 2>&1 | tail -20',
      {
        timeout: 600000,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PATH: process.env.PATH + ':/home/clawd/.npm-global/bin' }
      }
    );
  } catch (e) {
    log('[KOI-REVISION] Codex error: ' + e.message.substring(0, 200));
  }

  // v2: Diff audit on Codex output BEFORE copying back
  // Filename filter: skip files with invalid names (URLs, special chars, too long)
  const isValidFilename = (f) => f.length < 100 && !/[?#:&=]/.test(f) && !f.includes('googleapis') && !f.includes('http') && !f.includes('www.');
  const outputFiles = fs.readdirSync(buildDir).filter(f => f.endsWith('.html') && !f.startsWith('original-') && isValidFilename(f));
  const skippedKoi = fs.readdirSync(buildDir).filter(f => f.endsWith('.html') && !f.startsWith('original-') && !isValidFilename(f));
  if (skippedKoi.length > 0) log(`⚠️ [KOI-REVISION] Skipped ${skippedKoi.length} invalid filenames: ${skippedKoi.join(', ')}`);
  if (demoDiff && ctx.affectedFiles) {
    const auditResult = demoDiff.auditAndRevert(buildDir, workDir, ctx.affectedFiles, []);
    log(`[v2] KOI-REVISION diff audit: passed=${auditResult.passed} modified=${auditResult.stats.modified} unauthorized=${auditResult.stats.unauthorized} reverted=${auditResult.reverted.length}`);
    if (auditResult.reverted.length > 0) {
      log(`[v2] Reverted: ${auditResult.reverted.join(', ')}`);
    }
  }

  // Copy output files back to working dir (but do NOT push yet — Koi validates first)
  for (const f of outputFiles) {
    fs.copyFileSync(path.join(buildDir, f), path.join(workDir, f));
    if (isDeployRepo && workDir !== demoDir) {
      if (!fs.existsSync(demoDir)) fs.mkdirSync(demoDir, { recursive: true });
      fs.copyFileSync(path.join(buildDir, f), path.join(demoDir, f));
    }
  }
  log('[KOI-REVISION] Output files: ' + outputFiles.join(', '));

  // Write done trigger for Koi to pick up
  const doneTrigger = {
    slug,
    name: data.name,
    status: 'revision-done',
    contextFile: task.contextFile,
    outputFiles,
    workDir,
    buildDir,
    timestamp: new Date().toISOString()
  };
  fs.writeFileSync('/tmp/demo-revision-done-' + slug.replace(/[^a-zA-Z0-9а-яА-Я-]/g, '_') + '.json', JSON.stringify(doneTrigger, null, 2));

  // Wake Koi for validation
  try {
    execSync(OPENCLAW + ' system event --text "REVISION_DONE: ' + data.name + ' — Codex finished, awaiting Koi validation" --mode now', {
      timeout: 10000, stdio: 'pipe'
    });
  } catch {}

  return 'Codex done, awaiting Koi validation. Output: ' + outputFiles.join(', ');
}

const EXECUTORS = {
  briefing: executeBriefing,
  qa_submitted: executeQaSubmitted,
  building: executeBuilding,
  revisions: executeRevisions,      // v7: executeRevisions now has Koi validation gate built in
  'koi-revision': executeKoiRevision,
  dns_setup: executeDnsSetup,
  deploying: executeDeploying
};
log('EXECUTORS keys at startup: ' + Object.keys(EXECUTORS).join(', '));

// Check for instant tasks that don't need queuing (dns_setup)
async function processInstantTasks() {
  gitPull();
  const dataDir = path.join(DEMO_REPO, 'data');
  if (!fs.existsSync(dataDir)) return;
  
  for (const file of fs.readdirSync(dataDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      
      // v2: approved → create bookmark tag (golden standard for rollback)
      if (data.status === 'approved' && demoTags && !data.v2?.approvedTag) {
        log(`[v2] BOOKMARK: ${data.name} approved — creating tag`);
        const tag = demoTags.createTag(DEMO_REPO, 'approved', data.slug);
        if (tag) {
          if (!data.v2) data.v2 = {};
          data.v2.approvedTag = tag;
          data.v2.approvedAt = new Date().toISOString();
          fs.writeFileSync(path.join(dataDir, file), JSON.stringify(data, null, 2));
          gitCommitPush(data.slug, 'approved', data.name);
          log(`[v2] Bookmark created: ${tag}`);
        }
        // Also create tag in deploy repo if exists
        if (data.deployRepo) {
          try {
            const deployDir = path.join('/tmp', data.deployRepo.split('/').pop());
            if (!fs.existsSync(deployDir)) {
              execSync(`git clone https://x-access-token:${GH_TOKEN}@github.com/${data.deployRepo}.git "${deployDir}"`, { timeout: 30000, stdio: 'pipe' });
            }
            const deployTag = demoTags.createTag(deployDir, 'approved', data.slug);
            if (deployTag) log(`[v2] Deploy repo bookmark: ${deployTag}`);
          } catch (e) {
            log(`[v2] Deploy repo bookmark error: ${e.message.substring(0, 100)}`);
          }
        }
      }
      
      // dns_setup: generate DNS records if not already done
      if (data.status === 'dns_setup' && data.deployDomain && !data.dnsRecords?.length) {
        log(`INSTANT: ${data.name} → dns_setup (${data.deployDomain})`);
        
        const domain = data.deployDomain;
        data.dnsRecords = [
          { type: 'CNAME', name: domain, value: 'koiopenclaw-max.github.io', note: 'Насочва към GitHub Pages' },
          { type: 'A', name: domain, value: '185.199.108.153', note: 'GitHub Pages IP' },
          { type: 'A', name: domain, value: '185.199.109.153', note: 'GitHub Pages IP (резервен)' },
          { type: 'A', name: domain, value: '185.199.110.153', note: 'GitHub Pages IP (резервен)' },
          { type: 'A', name: domain, value: '185.199.111.153', note: 'GitHub Pages IP (резервен)' }
        ];
        data.updatedAt = new Date().toISOString();
        
        fs.writeFileSync(path.join(dataDir, file), JSON.stringify(data, null, 2));
        gitCommitPush(data.slug, 'dns_setup', data.name);
        
        await notifyTelegram(`🌐 DNS данни готови: <b>${data.name}</b>\nДомейн: ${domain}\n\nОтвори платформата за DNS записите.`);
      }
    } catch {}
  }
}

async function processNextTask() {
  const q = readQueue();
  // v2: Skip tasks whose slug is already being processed (per-slug lock)
  const task = q.tasks.find(t => t.status === 'pending' && !activeSlugLocks.has(t.slug));
  if (!task) return false;
  
  // v2: Acquire slug lock
  activeSlugLocks.add(task.slug);
  log(`STARTING: ${task.name} → ${task.action} [lock: ${task.slug}]`);
  task.status = 'in_progress';
  task.startedAt = new Date().toISOString();
  saveQueue(q);
  
  // Update trigger file with processing status (for failsafe + history)
  updateTriggerStatus(task.slug, 'in_progress', task.action);
  
  try {
    gitPull(); // Always pull latest before processing
    
    const executor = EXECUTORS[task.action];
    if (!executor) throw new Error(`Unknown action: ${task.action}`);
    
    task.result = await executor(task);
    task.status = 'done';
    task.completedAt = new Date().toISOString();
    log(`COMPLETED: ${task.name} → ${task.action}: ${task.result}`);
    
    // Update trigger file with done status (keeps history)
    updateTriggerStatus(task.slug, 'done', task.action, task.result);
  } catch (e) {
    task.status = 'error';
    task.error = e.message;
    task.completedAt = new Date().toISOString();
    log(`ERROR: ${task.name} → ${task.action}: ${e.message}`);
    
    // Update trigger file with error status (keeps history)
    updateTriggerStatus(task.slug, 'failed', task.action, e.message.substring(0, 500));
    
    await notifyTelegram(`❌ Грешка: <b>${task.name}</b> → ${task.action}\n${e.message.substring(0, 200)}`);
  }
  
  // v2: Release slug lock
  activeSlugLocks.delete(task.slug);
  
  // Move to completed
  const q2 = readQueue();
  q2.tasks = q2.tasks.filter(t => t.id !== task.id);
  q2.completed.push(task);
  saveQueue(q2);
  
  return true;
}

// ===== Main Loop =====
async function mainLoop() {
  log('Worker started. Polling every 30s...');
  
  while (true) {
    try {
      // Check instant tasks first (dns_setup — no queue needed)
      await processInstantTasks();
      
      const processed = await processNextTask();
      if (processed) {
        // If we processed something, immediately check for more
        continue;
      }
    } catch (e) {
      log(`Loop error: ${e.message}`);
    }
    
    // Wait before next poll
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// ===== Also export addTask for processor to use =====

// === KOI-DRIVEN REVISION: Koi writes the assignment, worker executes + notifies back ===
function addRevisionTask(slug, name, contextFile) {
  // contextFile is /tmp/demo-revision-context-<slug>.json written by Koi
  // Contains: myAssignment, affectedFiles, checkpoints, beforeScreenshots
  const q = readQueue();
  const exists = q.tasks.find(t => t.slug === slug && t.action === 'koi-revision' && t.status === 'pending');
  if (exists) return;
  q.tasks.push({
    slug,
    name,
    action: 'koi-revision',
    status: 'pending',
    contextFile,
    addedAt: new Date().toISOString()
  });
  saveQueue(q);
  log(`[KOI-REVISION] Task queued: ${slug} (context: ${contextFile})`);
}

module.exports = { addTask, readQueue, addRevisionTask };

// Start if run directly
if (require.main === module) {
  mainLoop().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
}
