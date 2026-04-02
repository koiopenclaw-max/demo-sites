#!/usr/bin/env node
// Module: demo-fallback.js
// Demo Sites v2 — Phase 3: Codex Fallback
// When Codex fails 3 times on CREATE tasks, generate a skeleton HTML
// that Codex can then fill with content (two-phase approach).

const fs = require('fs');
const path = require('path');

/**
 * Generate a skeleton HTML page based on a baseline template.
 * The skeleton has the same CSS/structure but placeholder content.
 * 
 * @param {string} baselineHtml - The baseline HTML to base the skeleton on
 * @param {string} pageName - Name of the new page (e.g. "kontakti")
 * @param {string} pageTitle - Title for the page (e.g. "Контакти")
 * @param {string} siteName - Site name for the title tag
 * @returns {string} Skeleton HTML
 */
function generateSkeleton(baselineHtml, pageName, pageTitle, siteName) {
  try {
    // Extract <head> section (CSS, meta, fonts)
    const headMatch = baselineHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    const headContent = headMatch ? headMatch[1] : '';
    
    // Extract navigation (usually <nav> or <header>)
    const navMatch = baselineHtml.match(/<(?:nav|header)[^>]*>[\s\S]*?<\/(?:nav|header)>/i);
    const navHtml = navMatch ? navMatch[0] : '';
    
    // Extract footer
    const footerMatch = baselineHtml.match(/<footer[^>]*>[\s\S]*?<\/footer>/i);
    const footerHtml = footerMatch ? footerMatch[0] : '';
    
    // Extract CSS variables and key styles
    const styleMatch = baselineHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    const styles = styleMatch ? styleMatch.join('\n') : '';
    
    // Update title
    const updatedHead = headContent.replace(/<title>[^<]*<\/title>/i, `<title>${pageTitle} | ${siteName}</title>`);
    
    const skeleton = `<!DOCTYPE html>
<html lang="bg">
<head>
${updatedHead}
</head>
<body>
${navHtml}

<main>
  <section class="hero" style="padding: 60px 20px; text-align: center;">
    <h1>${pageTitle}</h1>
    <p><!-- PLACEHOLDER: Add page description here --></p>
  </section>
  
  <section class="content" style="max-width: 1200px; margin: 0 auto; padding: 40px 20px;">
    <!-- PLACEHOLDER: Add page content here -->
    <p>Съдържание за страница "${pageTitle}"</p>
  </section>
</main>

${footerHtml}

</body>
</html>`;
    
    return skeleton;
  } catch (e) {
    console.error('[demo-fallback] generateSkeleton error:', e.message);
    return `<!DOCTYPE html><html lang="bg"><head><title>${pageTitle}</title></head><body><h1>${pageTitle}</h1><p>Skeleton generation failed</p></body></html>`;
  }
}

/**
 * Generate skeletons for multiple pages based on a scope result.
 * 
 * @param {string} baselineHtml - Baseline HTML template
 * @param {string[]} newFiles - Array of new file names from scope detection
 * @param {string} siteName - Site name
 * @param {string} buildDir - Directory to write skeletons to
 * @returns {string[]} List of created skeleton files
 */
function generateSkeletons(baselineHtml, newFiles, siteName, buildDir) {
  const created = [];
  
  for (const file of newFiles) {
    if (!file.endsWith('.html')) continue;
    
    const pageName = file.replace('.html', '');
    // Convert filename to readable title
    const pageTitle = pageName
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
    
    const skeleton = generateSkeleton(baselineHtml, pageName, pageTitle, siteName);
    const outPath = path.join(buildDir, file);
    
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, skeleton);
    created.push(file);
  }
  
  return created;
}

module.exports = { generateSkeleton, generateSkeletons };
