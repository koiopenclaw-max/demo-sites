const { execSync } = require('child_process');

function runGit(repoDir, command, timeout = 15000) {
  return execSync(command, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout,
  }).trim();
}

function createTag(repoDir, prefix, slug) {
  try {
    const pattern = `${prefix}-${slug}-*`;
    const output = runGit(repoDir, `git tag -l "${pattern}"`);
    const tags = output ? output.split('\n').map((tag) => tag.trim()).filter(Boolean) : [];
    let maxN = 0;

    for (const tag of tags) {
      const match = tag.match(new RegExp(`^${prefix}-${slug}-(\\d+)$`));
      if (!match) continue;
      const value = Number.parseInt(match[1], 10);
      if (Number.isFinite(value) && value > maxN) {
        maxN = value;
      }
    }

    const tagName = `${prefix}-${slug}-${maxN + 1}`;
    runGit(repoDir, `git tag "${tagName}"`);
    runGit(repoDir, `git push origin "${tagName}"`);
    return tagName;
  } catch (error) {
    console.error(`createTag failed for ${prefix}/${slug}:`, error.message);
    return null;
  }
}

function listTags(repoDir, slug) {
  try {
    const output = runGit(
      repoDir,
      `git tag -l "*-${slug}-*" --sort=-creatordate --format="%(refname:short) %(creatordate:iso)"`
    );

    if (!output) return [];

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const firstSpace = line.indexOf(' ');
        if (firstSpace === -1) {
          return { name: line, date: '' };
        }
        return {
          name: line.slice(0, firstSpace),
          date: line.slice(firstSpace + 1).trim(),
        };
      });
  } catch (error) {
    console.error(`listTags failed for ${slug}:`, error.message);
    return [];
  }
}

function restoreToTag(repoDir, tagName) {
  try {
    runGit(repoDir, `git rev-parse --verify "${tagName}"`);
    runGit(repoDir, `git checkout "${tagName}" -- .`);
    runGit(repoDir, 'git add -A');
    runGit(repoDir, `git commit -m "rollback: restored to ${tagName}"`);
    runGit(repoDir, 'git push origin main');
    return true;
  } catch (error) {
    console.error(`restoreToTag failed for ${tagName}:`, error.message);
    return false;
  }
}

module.exports = { createTag, listTags, restoreToTag };
