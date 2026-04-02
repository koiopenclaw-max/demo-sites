const fs = require('fs');
const path = require('path');

const DEMO_REPO = '/home/clawd/Projects/demo-sites';
const ALLOWED_EXTENSIONS = new Set([
  '.html',
  '.css',
  '.js',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.ico',
  '.json',
]);
const EXCLUDED_FILES = new Set(['.DS_Store', 'PROMPT.md', 'baseline.html', 'original-index.html']);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);

function shouldIncludeFile(name) {
  if (EXCLUDED_FILES.has(name) || name.startsWith('.')) return false;
  return ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function generateManifest(slug, workDir) {
  try {
    const dir = workDir || path.join(DEMO_REPO, 'demos', slug);
    if (!fs.existsSync(dir)) return [];

    const files = [];

    function scan(currentDir, prefix) {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const entryName = entry.name;
        const rel = prefix ? `${prefix}/${entryName}` : entryName;
        const fullPath = path.join(currentDir, entryName);

        if (entry.isDirectory()) {
          if (entryName.startsWith('.') || EXCLUDED_DIRECTORIES.has(entryName)) continue;
          scan(fullPath, rel);
          continue;
        }

        if (shouldIncludeFile(entryName)) {
          files.push(rel);
        }
      }
    }

    scan(dir, '');
    files.sort((a, b) => a.localeCompare(b, 'bg'));
    return files;
  } catch (error) {
    console.error(`generateManifest failed for ${slug}:`, error.message);
    return [];
  }
}

function updateManifest(slug, files) {
  try {
    const dataFile = path.join(DEMO_REPO, 'data', `${slug}.json`);
    if (!fs.existsSync(dataFile)) return false;

    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    data.files = Array.isArray(files) ? files : [];
    data.filesUpdatedAt = new Date().toISOString();
    fs.writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    console.error(`updateManifest failed for ${slug}:`, error.message);
    return false;
  }
}

function ensureManifest(slug, workDir) {
  try {
    const dataFile = path.join(DEMO_REPO, 'data', `${slug}.json`);
    if (!fs.existsSync(dataFile)) return null;

    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (Array.isArray(data.files) && data.files.length > 0) {
      return data.files;
    }

    const files = generateManifest(slug, workDir);
    if (files.length === 0) return null;

    data.files = files;
    data.filesUpdatedAt = new Date().toISOString();
    fs.writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return files;
  } catch (error) {
    console.error(`ensureManifest failed for ${slug}:`, error.message);
    return null;
  }
}

module.exports = { generateManifest, updateManifest, ensureManifest };
