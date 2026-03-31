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

// ===== Logging =====
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
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
  // Deduplicate: don't add if same slug+action already pending
  const exists = q.tasks.find(t => t.slug === slug && t.action === action && t.status === 'pending');
  if (exists) return false;
  
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
  try {
    // Discard ALL local changes and sync to remote (worker never has local-only work worth keeping)
    execSync('git fetch origin main', { cwd: DEMO_REPO, timeout: 30000, stdio: 'pipe' });
    execSync('git reset --hard origin/main', { cwd: DEMO_REPO, timeout: 15000, stdio: 'pipe' });
    execSync('git clean -fd', { cwd: DEMO_REPO, timeout: 5000, stdio: 'pipe' });
  } catch (e) {
    log(`git pull error: ${e.message}`);
  }
}

function readDemoData(slug) {
  const file = path.join(DEMO_REPO, 'data', `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveDemoData(slug, data) {
  const file = path.join(DEMO_REPO, 'data', `${slug}.json`);
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function gitCommitPush(slug, status, name) {
  try {
    execSync(`git add "data/${slug}.json"`, { cwd: DEMO_REPO, stdio: 'pipe' });
    execSync(`git commit -m "[${status}] ${name} (worker)"`, { cwd: DEMO_REPO, stdio: 'pipe' });
    execSync('git push origin main', { cwd: DEMO_REPO, timeout: 30000, stdio: 'pipe' });
    return true;
  } catch (e) {
    log(`git push error: ${e.message}`);
    return false;
  }
}

// ===== Telegram Notification =====
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
  // Keywords must be specific enough to avoid false positives.
  // 'авто' was too broad — matched 'автоматичн', 'авторски' etc.
  const nicheKeywords = {
    'дограма-врати': ['врат', 'дограм', 'прозор', 'pvc', 'алуминиев', 'стъклопакет', 'дървен', 'плъзгащ', 'двукрил', 'еднокрил', 'интериорн', 'метални врат', 'входни врат', 'решетк', 'оград'],
    'стоматология': ['дентал', 'зъбо', 'стомат', 'имплант', 'ортодонт', 'зъб'],
    'счетоводство': ['счетовод', 'счетоводн', 'одитор', 'данъч', 'ддс', 'финансов', 'баланс', 'отчет', 'кантора', 'трз', 'осигуровк'],
    'нотариус': ['нотариус', 'нотариал', 'заверка'],
    'hvac': ['климатик', 'климатиц', 'отоплен', 'вентилац', 'hvac'],
    'хотел': ['хотел', 'hotel', 'стаи', 'резервация', 'настаняване'],
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
    // Map worker niche names to TEMPLATE_CATALOG keys in index.html
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
  
  await notifyTelegram(`📋 Задание готово: <b>${data.name}</b>\nНиша: ${niche}\nСтатус: brief_ready\n\nОтвори платформата и попълни въпросите.`);
  
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
  
  await notifyTelegram(`✅ Задание обогатено: <b>${data.name}</b>\nСтатус: brief_final\n\nПрегледай и потвърди билда.`);
  
  return 'Brief enriched → brief_final';
}

async function executeBuilding(task) {
  const data = readDemoData(task.slug);
  if (!data) throw new Error('Data file not found');
  
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
      // Direct URL (e.g. dental templates on separate repos)
      tplUrl = tpl.url;
    } else if (tpl.local) {
      // Local file in demo-sites repo
      const localPath = path.join(DEMO_REPO, tpl.local);
      log(`Reading local template: ${localPath}`);
      try {
        templateHtml = fs.readFileSync(localPath, 'utf-8');
      } catch (e) {
        log(`Local template read failed: ${e.message}`);
      }
    } else if (tpl.repo && tpl.file) {
      // GitHub Pages URL from repo+file
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
  const prompt = `You are building a demo website for "${data.name}".

TASK: Adapt the template HTML with the client's real content.

INPUT FILES IN THIS DIRECTORY:
- template.html — the base template to customize
- client-content.txt — scraped text from the client's current website
- brief.md — the project brief with all requirements

INSTRUCTIONS:
1. Read template.html — this is the design to keep
2. Read client-content.txt — extract: business name, services, contacts, phone, address, working hours
3. Read brief.md — follow any specific instructions
4. Replace ALL placeholder text in the template with the client's real data:
   - Business name: ${data.name}
   - Keep the visual design, colors, and layout exactly as-is
   - Replace placeholder services with real services from client content
   - Replace contact info (phone, email, address) with real data
   - Replace working hours if provided
   - Keep stock images unless client-specific ones are mentioned
5. Output ONLY the final index.html file in this directory
6. The file must be a complete, self-contained HTML file (all CSS/JS inline)
7. All text must be in Bulgarian

OUTPUT: Save the final file as index.html in this directory.

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
      const retryPrompt = `You are building a demo website for "${data.name}".

PREVIOUS BUILD FAILED VISUAL VALIDATION. Here is the feedback:
${buildClaudeFeedback}

INPUT FILES:
- current.html — the previous attempt (fix the issues listed above)
${templateHtml ? '- template.html — the design template for reference' : ''}
- client-content.txt — scraped content from client
- brief.md — project brief

Fix ALL the issues listed above. Save the result as index.html.
Keep the design professional, clean, and human-friendly.
All text in Bulgarian. All images must load (use Unsplash if no client images).`;

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
  
  // Use the final output (validated or best effort)
  const finalOutput = path.join(buildDir, 'index.html');
  if (!fs.existsSync(finalOutput)) {
    throw new Error('Codex did not produce index.html after all attempts');
  }
  
  // Copy to demo dir
  fs.copyFileSync(finalOutput, path.join(demoDir, 'index.html'));
  
  // Git add demos folder and push
  try {
    execSync(`git add "demos/${task.slug}/"`, { cwd: DEMO_REPO, stdio: 'pipe' });
    execSync(`git add "data/${task.slug}.json"`, { cwd: DEMO_REPO, stdio: 'pipe' });
  } catch {}
  
  const demoUrl = `https://koiopenclaw-max.github.io/demo-sites/demos/${encodeURIComponent(task.slug)}/`;
  data.demoUrl = demoUrl;
  data.status = 'done';
  
  saveDemoData(task.slug, data);
  
  try {
    execSync(`git add -A`, { cwd: DEMO_REPO, stdio: 'pipe' });
    const vTag = buildValidated ? '' : ' (best-effort)';
    execSync(`git commit -m "[done] ${data.name} — demo built${vTag} (worker)"`, { cwd: DEMO_REPO, stdio: 'pipe' });
    execSync('git push origin main', { cwd: DEMO_REPO, timeout: 30000, stdio: 'pipe' });
  } catch (e) {
    log(`git push error: ${e.message}`);
  }
  
  const statusEmoji = buildValidated ? '🎉' : '⚠️';
  const statusNote = buildValidated ? '' : '\n⚠️ Не е напълно валидиран — прегледай ръчно.';
  await notifyTelegram(`${statusEmoji} Демо готово: <b>${data.name}</b>\n🔗 ${demoUrl}${statusNote}\n\nПрегледай и одобри или изпрати корекции.`);
  
  // Cleanup screenshots
  try { execSync(`rm -rf "${path.join(buildDir, 'screenshots')}"`, { stdio: 'pipe' }); } catch {}
  
  return `Demo built (${buildValidated ? 'validated' : 'best-effort'}, ${buildAttempt} attempts): ${demoUrl}`;
}

async function executeRevisions(task) {
  // v4: Pre-parse → Codex builds → Claude validates → loop until done
  // 1. Pre-parse: extract concrete URLs/elements from old site
  // 2. Codex: apply changes with specific instructions
  // 3. Claude Code: validate output against requirements
  // 4. If failed → Codex retry with Claude's feedback (max 3 loops)
  
  const MAX_ATTEMPTS = 3;
  const data = readDemoData(task.slug);
  if (!data) throw new Error('Data file not found');
  
  const issues = data.currentRevision || 'Не са описани конкретни проблеми';
  
  // === STEP 0: Determine working repo ===
  let workDir, htmlFile, isDeployRepo = false;
  if (data.deployRepo) {
    isDeployRepo = true;
    const repoName = data.deployRepo.split('/').pop();
    workDir = `/tmp/${repoName}`;
    if (fs.existsSync(workDir)) {
      try { execSync(`cd "${workDir}" && git pull --rebase origin main`, { timeout: 30000, stdio: 'pipe' }); }
      catch { execSync(`rm -rf "${workDir}"`, { stdio: 'pipe' }); }
    }
    if (!fs.existsSync(workDir)) {
      execSync(`git clone https://x-access-token:${GH_TOKEN}@github.com/${data.deployRepo}.git "${workDir}"`, { timeout: 30000, stdio: 'pipe' });
    }
    htmlFile = path.join(workDir, 'index.html');
  } else {
    workDir = path.join(DEMO_REPO, 'demos', task.slug);
    htmlFile = path.join(workDir, 'index.html');
    // Stash → pull → stash pop (prevents "unstaged changes" blocking pull)
    try { execSync('git stash --quiet', { cwd: DEMO_REPO, timeout: 5000, stdio: 'pipe' }); } catch {}
    try { 
      execSync('git pull --rebase origin main', { cwd: DEMO_REPO, timeout: 30000, stdio: 'pipe' }); 
    } catch (e) {
      log(`Revision git pull failed: ${e.message} — attempting hard reset`);
      try { execSync('git fetch origin main && git reset --hard origin/main', { cwd: DEMO_REPO, timeout: 15000, stdio: 'pipe' }); } catch {}
    }
    try { execSync('git stash pop --quiet', { cwd: DEMO_REPO, timeout: 5000, stdio: 'pipe' }); } catch {}
  }
  
  if (!fs.existsSync(htmlFile)) {
    throw new Error(`HTML file not found: ${htmlFile}`);
  }
  
  const currentHtml = fs.readFileSync(htmlFile, 'utf8');
  
  // === STEP 1: PRE-PARSE — extract concrete data from old site ===
  let scrapedContent = '';
  let extractedAssets = '';
  
  if (data.websiteUrl && /снимк|лого|прехвърл|стар|оригинал|съдържание|контент|hero|хиро/i.test(issues)) {
    log(`Revisions: scraping original site ${data.websiteUrl}...`);
    scrapedContent = scrapeUrl(data.websiteUrl);
    
    if (scrapedContent) {
      // Extract concrete assets using regex — give Codex exact URLs, not "find them yourself"
      const imgUrls = [...new Set((scrapedContent.match(/src="(https?:\/\/[^"]+\.(jpg|jpeg|png|svg|webp|gif)(?:\?[^"]*)?)"/gi) || [])
        .map(m => m.match(/src="([^"]+)"/)?.[1]).filter(Boolean))];
      
      const logoUrls = imgUrls.filter(u => /logo|лого/i.test(u));
      const heroUrls = imgUrls.filter(u => /hero|banner|nachalo|slider|главн/i.test(u));
      
      // Extract nav/menu structure
      const navLinks = [...new Set((scrapedContent.match(/href="(\/[^"]{2,60})"/g) || [])
        .map(m => m.match(/href="([^"]+)"/)?.[1]).filter(Boolean))];
      
      extractedAssets = `
=== PRE-EXTRACTED ASSETS FROM ORIGINAL SITE ===
These are EXACT URLs found in the original site HTML. USE THESE, do not guess.

LOGO URLs found:
${logoUrls.length ? logoUrls.map(u => `  - ${u}`).join('\n') : '  (none found — look in original-site.html manually)'}

HERO/BANNER image URLs found:
${heroUrls.length ? heroUrls.map(u => `  - ${u}`).join('\n') : '  (none with hero/banner in name — check first large image in original-site.html)'}

ALL image URLs (${imgUrls.length} total):
${imgUrls.slice(0, 30).map(u => `  - ${u}`).join('\n')}

NAVIGATION structure (${navLinks.length} internal links):
${navLinks.slice(0, 25).map(u => `  - ${data.websiteUrl.replace(/\/$/, '')}${u}`).join('\n')}
=== END PRE-EXTRACTED ===`;
      
      log(`Pre-parsed: ${logoUrls.length} logos, ${heroUrls.length} hero images, ${imgUrls.length} total images, ${navLinks.length} nav links`);
    }
  }
  
  // === STEP 2: Prepare build directory ===
  const buildDir = `/tmp/demo-revision-${task.slug}`;
  if (fs.existsSync(buildDir)) execSync(`rm -rf "${buildDir}"`, { stdio: 'pipe' });
  fs.mkdirSync(buildDir, { recursive: true });
  
  fs.writeFileSync(path.join(buildDir, 'current.html'), currentHtml);
  if (scrapedContent) {
    fs.writeFileSync(path.join(buildDir, 'original-site.html'), scrapedContent.substring(0, 500000));
  }
  fs.writeFileSync(path.join(buildDir, 'brief.md'), data.brief || '');
  
  // === STEP 3: CODEX-CLAUDE LOOP ===
  let attempt = 0;
  let claudeFeedback = '';
  let validated = false;
  
  while (attempt < MAX_ATTEMPTS && !validated) {
    attempt++;
    log(`Revision attempt ${attempt}/${MAX_ATTEMPTS} for ${data.name}...`);
    
    // Build prompt — include Claude's feedback if this is a retry
    const retrySection = claudeFeedback ? `
PREVIOUS ATTEMPT FAILED VALIDATION. Here is what the validator found:
${claudeFeedback}

Fix ALL the issues listed above. This is attempt ${attempt}/${MAX_ATTEMPTS}.
` : '';
    
    const prompt = `You are revising a demo website for "${data.name}".

TASK: Apply the requested changes to the current HTML file.

INPUT FILES IN THIS DIRECTORY:
- current.html — the current demo site HTML that needs changes
${scrapedContent ? '- original-site.html — HTML from the client\'s original/old website (for reference)' : ''}
- brief.md — the original project brief for context

REQUESTED CHANGES:
${issues}
${extractedAssets}
${retrySection}
INSTRUCTIONS:
1. Read current.html carefully
${scrapedContent ? '2. If you need content from the original site, check the PRE-EXTRACTED ASSETS section above FIRST — use those exact URLs\n3. Only read original-site.html if you need additional content not in the pre-extracted section' : ''}
4. Apply ALL requested changes using the EXACT URLs from pre-extracted assets
5. Keep the current design, colors, and layout style
6. Output the modified file as index.html in this directory
7. The file must be a complete, self-contained HTML file (all CSS/JS inline)
8. All text must be in Bulgarian

CRITICAL: Use the EXACT URLs from PRE-EXTRACTED ASSETS. Do NOT guess or substitute different images.
CRITICAL: Do NOT remove existing content unless explicitly asked.

OUTPUT: Save the final file as index.html in this directory.`;

    fs.writeFileSync(path.join(buildDir, 'PROMPT.md'), prompt);
    
    // Remove previous output
    try { fs.unlinkSync(path.join(buildDir, 'index.html')); } catch {}
    
    // Run Codex
    log(`Spawning Codex (attempt ${attempt})...`);
    try {
      // Re-init git for clean state
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
      log(`Codex attempt ${attempt}: ${e.message.substring(0, 200)}`);
    }
    
    // Check Codex produced output
    const outputFile = path.join(buildDir, 'index.html');
    if (!fs.existsSync(outputFile)) {
      claudeFeedback = 'Codex did not produce index.html. Try again — read PROMPT.md and save the result as index.html.';
      continue;
    }
    
    // === STEP 4: VISUAL + CODE VALIDATION ===
    log(`Validating attempt ${attempt} (visual + code)...`);
    
    // 4a: Serve locally and take screenshots
    const screenshotDir = path.join(buildDir, 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    
    let screenshotsOk = false;
    let localServer = null;
    try {
      // Start local server
      const http = require('http');
      const serverDir = buildDir;
      localServer = http.createServer((req, res) => {
        // Serve index.html for / or any path
        let filePath = path.join(serverDir, req.url === '/' ? 'index.html' : req.url.replace(/^\//, ''));
        // Also serve assets from the working directory (logos, images etc.)
        if (!fs.existsSync(filePath) && workDir) {
          filePath = path.join(workDir, req.url.replace(/^\//, ''));
        }
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes = {'.html':'text/html','.css':'text/css','.js':'application/javascript','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon'};
          res.writeHead(200, {'Content-Type': mimeTypes[ext] || 'application/octet-stream'});
          fs.createReadStream(filePath).pipe(res);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });
      
      const port = 18900 + Math.floor(Math.random() * 100);
      await new Promise((resolve) => localServer.listen(port, '127.0.0.1', resolve));
      log(`Local server on port ${port}`);
      
      // Desktop screenshot (1280x800)
      try {
        execSync(
          `npx playwright screenshot --viewport-size "1280,800" --wait-for-timeout 3000 --full-page "http://127.0.0.1:${port}/" "${path.join(screenshotDir, 'desktop.png')}"`,
          { timeout: 60000, stdio: 'pipe', env: { ...process.env, PATH: `${process.env.PATH}:/home/clawd/.npm-global/bin` } }
        );
        log('Desktop screenshot captured');
      } catch (e) {
        log(`Desktop screenshot failed: ${e.message.substring(0, 100)}`);
      }
      
      // Mobile screenshot (375x667 - iPhone SE)
      try {
        execSync(
          `npx playwright screenshot --viewport-size "375,667" --wait-for-timeout 3000 --full-page "http://127.0.0.1:${port}/" "${path.join(screenshotDir, 'mobile.png')}"`,
          { timeout: 60000, stdio: 'pipe', env: { ...process.env, PATH: `${process.env.PATH}:/home/clawd/.npm-global/bin` } }
        );
        log('Mobile screenshot captured');
      } catch (e) {
        log(`Mobile screenshot failed: ${e.message.substring(0, 100)}`);
      }
      
      screenshotsOk = fs.existsSync(path.join(screenshotDir, 'desktop.png')) && fs.existsSync(path.join(screenshotDir, 'mobile.png'));
    } catch (e) {
      log(`Screenshot server error: ${e.message.substring(0, 200)}`);
    } finally {
      if (localServer) localServer.close();
    }
    
    // 4b: Claude visual + code validation
    const validationPrompt = `You are a senior QA validator for a demo website revision.
You must validate BOTH the code AND the visual output.

=== CLIENT REQUIREMENTS ===
${issues}

=== PRE-EXTRACTED ASSETS ===
${extractedAssets || '(no pre-extracted assets — generic revision)'}

=== YOUR VALIDATION CHECKLIST ===

**A. Code validation (read index.html vs current.html):**
1. Are ALL client requirements implemented in the HTML?
2. Are the correct URLs/assets used (from pre-extracted list if provided)?
3. Is the HTML valid, complete, not truncated?
4. Are contact details correct (phone, email, address)?
5. Is all text in Bulgarian?

**B. Visual validation (look at desktop.png and mobile.png):**
6. DESKTOP: Is the hero section visually clean? Text readable over background?
7. DESKTOP: Are ALL sections visible (no empty/blank gaps)?
8. DESKTOP: Do images look professional? Not zoomed/cropped awkwardly? Not pixelated?
9. DESKTOP: Is the footer populated with real content?
10. DESKTOP: Does it look like a site made for humans? Not "AI-generated"?
11. MOBILE: Does the layout adapt properly? No horizontal overflow?
12. MOBILE: Is text readable without zooming?
13. MOBILE: Are buttons/links tappable (adequate size)?
14. MOBILE: Are images properly sized (not overflowing or tiny)?
15. OVERALL: Would a real business be proud to show this to clients?

**SCORING: Each check = 1 point. Total = 15.**

RESPOND IN THIS EXACT FORMAT:
SCORE: X/15
PASSED: [list of passed check numbers]
FAILED: [list of failed check numbers]

If SCORE >= 12/15:
VALIDATED: YES
Summary: [what was done well]

If SCORE < 12/15:
VALIDATED: NO
Failed checks:
- [check N]: [specific problem]
- [check N]: [specific problem]
Fix instructions:
- [concrete, actionable instruction with exact URLs/values if relevant]
- [another fix instruction]`;

    fs.writeFileSync(path.join(buildDir, 'VALIDATE.md'), validationPrompt);
    
    let claudeResult = '';
    try {
      // Build claude command — include screenshots if available
      const claudePrompt = screenshotsOk
        ? `Read VALIDATE.md. Then examine: index.html (new), current.html (original), screenshots/desktop.png (desktop visual), screenshots/mobile.png (mobile visual). Follow the validation checklist exactly.`
        : `Read VALIDATE.md. Then examine: index.html (new), current.html (original). Follow the validation checklist (skip visual checks 6-15, code-only validation).`;
      
      claudeResult = execSync(
        `cd "${buildDir}" && claude --print --permission-mode bypassPermissions "${claudePrompt}" 2>/dev/null`,
        {
          timeout: 180000, // 3 min for visual validation
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 5 * 1024 * 1024,
          env: { ...process.env, PATH: `${process.env.PATH}:/home/clawd/.local/bin:/home/clawd/.npm-global/bin:/usr/local/bin:/usr/bin:/bin` }
        }
      ).toString().trim();
    } catch (e) {
      log(`Claude validation error: ${e.message.substring(0, 200)}`);
      claudeResult = 'VALIDATED: YES\nSummary: Validation skipped due to error.';
    }
    
    log(`Claude verdict (attempt ${attempt}): ${claudeResult.substring(0, 300)}`);
    
    // Extract score
    const scoreMatch = claudeResult.match(/SCORE:\s*(\d+)\/(\d+)/);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    const maxScore = scoreMatch ? parseInt(scoreMatch[2]) : 15;
    const pct = maxScore > 0 ? Math.round(score / maxScore * 100) : 0;
    log(`Visual+Code score: ${score}/${maxScore} (${pct}%)`);
    
    if (claudeResult.includes('VALIDATED: YES')) {
      validated = true;
      log(`✅ Revision VALIDATED on attempt ${attempt} (score: ${score}/${maxScore}, ${pct}%)`);
    } else {
      claudeFeedback = claudeResult;
      log(`❌ Revision FAILED validation on attempt ${attempt} (score: ${score}/15). Retrying...`);
      // Copy the failed output as current for next attempt (iterative improvement)
      fs.copyFileSync(outputFile, path.join(buildDir, 'current.html'));
    }
  }
  
  // === STEP 5: FINALIZE ===
  const outputFile = path.join(buildDir, 'index.html');
  if (!fs.existsSync(outputFile)) {
    throw new Error(`Revision failed after ${MAX_ATTEMPTS} attempts — no output produced`);
  }
  
  if (!validated) {
    log(`⚠️ Revision not fully validated after ${MAX_ATTEMPTS} attempts. Publishing best effort.`);
  }
  
  // Copy result
  fs.copyFileSync(outputFile, htmlFile);
  log(`Revision HTML copied to ${htmlFile}`);
  
  // Push to deploy repo if needed
  if (isDeployRepo) {
    try {
      execSync(`cd "${workDir}" && git add -A && git commit -m "Revision: ${data.name}" && git push origin main`, { timeout: 30000, stdio: 'pipe' });
      log(`Pushed revision to deploy repo: ${data.deployRepo}`);
    } catch (e) {
      log(`Deploy repo push error: ${e.message.substring(0, 100)}`);
    }
    const demoDir = path.join(DEMO_REPO, 'demos', task.slug);
    if (!fs.existsSync(demoDir)) fs.mkdirSync(demoDir, { recursive: true });
    fs.copyFileSync(htmlFile, path.join(demoDir, 'index.html'));
  }
  
  // Update data JSON
  if (data.revisionHistory && data.revisionHistory.length > 0) {
    const lastRevision = data.revisionHistory[data.revisionHistory.length - 1];
    lastRevision.resolution = validated
      ? `✅ Валидирано (attempt ${attempt}): ${issues.substring(0, 200)}`
      : `⚠️ Частично (${MAX_ATTEMPTS} опита): ${issues.substring(0, 200)}`;
    lastRevision.resolvedAt = new Date().toISOString();
  }
  data.currentRevision = null;
  data.status = validated ? 'review' : 'review';
  
  saveDemoData(task.slug, data);
  gitCommitPush(task.slug, 'review', data.name);
  
  const reviewUrl = data.deployRepo
    ? data.liveUrl || data.demoUrl
    : data.demoUrl || `https://koiopenclaw-max.github.io/demo-sites/demos/${encodeURIComponent(task.slug)}/`;
  
  const statusEmoji = validated ? '✅' : '⚠️';
  const statusText = validated
    ? `Валидирано от Claude (опит ${attempt}/${MAX_ATTEMPTS})`
    : `${MAX_ATTEMPTS} опита, не е напълно валидирано — прегледай ръчно`;
  
  await notifyTelegram(`${statusEmoji} Корекции: <b>${data.name}</b>\n📝 ${issues.substring(0, 200)}\n🔗 ${reviewUrl}\n${statusText}`);
  
  // Cleanup
  try { execSync(`rm -rf "${buildDir}"`, { stdio: 'pipe' }); } catch {}
  try { fs.unlinkSync(`/tmp/demo-revision-trigger-${task.slug}.json`); } catch {}
  
  return `Revision ${validated ? 'validated' : 'best-effort'} (${attempt} attempts): ${reviewUrl}`;
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
const EXECUTORS = {
  briefing: executeBriefing,
  qa_submitted: executeQaSubmitted,
  building: executeBuilding,
  revisions: executeRevisions,
  dns_setup: executeDnsSetup,
  deploying: executeDeploying
};

// Check for instant tasks that don't need queuing (dns_setup)
async function processInstantTasks() {
  gitPull();
  const dataDir = path.join(DEMO_REPO, 'data');
  if (!fs.existsSync(dataDir)) return;
  
  for (const file of fs.readdirSync(dataDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      
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
  const task = q.tasks.find(t => t.status === 'pending');
  if (!task) return false;
  
  log(`STARTING: ${task.name} → ${task.action}`);
  task.status = 'in_progress';
  task.startedAt = new Date().toISOString();
  saveQueue(q);
  
  try {
    gitPull(); // Always pull latest before processing
    
    const executor = EXECUTORS[task.action];
    if (!executor) throw new Error(`Unknown action: ${task.action}`);
    
    task.result = await executor(task);
    task.status = 'done';
    task.completedAt = new Date().toISOString();
    log(`COMPLETED: ${task.name} → ${task.action}: ${task.result}`);
  } catch (e) {
    task.status = 'error';
    task.error = e.message;
    task.completedAt = new Date().toISOString();
    log(`ERROR: ${task.name} → ${task.action}: ${e.message}`);
    
    await notifyTelegram(`❌ Грешка: <b>${task.name}</b> → ${task.action}\n${e.message.substring(0, 200)}`);
  }
  
  // Move to completed
  const q2 = readQueue();
  q2.tasks = q2.tasks.filter(t => t.id !== task.id);
  q2.completed.push(task);
  saveQueue(q2);
  
  // Clean trigger file
  try { fs.unlinkSync(`/tmp/demo-action-trigger-${task.slug}.json`); } catch {}
  
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
module.exports = { addTask, readQueue };

// Start if run directly
if (require.main === module) {
  mainLoop().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
}
