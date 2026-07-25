// Bump the release version everywhere it doesn't auto-track, so it happens
// identically every time instead of by hand. See .claude/skills/release/SKILL.md.
//
// Three edits, all deterministic:
//   1. package.json "version" -- the only version edit the app itself needs
//      (src/version.ts derives the displayed version from it via vite.config.ts).
//   2. README.md's shields.io version badge -- nothing auto-updates this, and it
//      has been missed before (a separate follow-up PR after 0.1.1). The badge's
//      suffix/color (e.g. "--beta-orange") are preserved as-is, not hardcoded,
//      since they've changed between releases.
//   3. CHANGELOG.md -- move the [Unreleased] entries into a new dated section,
//      leave [Unreleased] empty, and rewrite the compare-link refs at the bottom.
//      The previous version and repo URL are read from the existing [Unreleased]
//      link, never hardcoded.
//
// This script does NOT touch git, tags, or the deploy -- those stay manual and
// user-confirmed (release skill step 2).
//
// Usage:
//   node scripts/bump-version.mjs <new-version>   # e.g. 0.6.0
import fs from 'fs';
import path from 'path';

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error('Usage: node scripts/bump-version.mjs <new-version>  (e.g. 0.6.0)');
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, '..');
const pkgPath = path.join(root, 'package.json');
const readmePath = path.join(root, 'README.md');
const changelogPath = path.join(root, 'CHANGELOG.md');

function fail(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}

// --- 1. package.json ---
const pkgText = fs.readFileSync(pkgPath, 'utf8');
const pkgVersionRe = /^(\s*"version":\s*")([^"]+)(")/m;
const pkgMatch = pkgText.match(pkgVersionRe);
if (!pkgMatch) fail('could not find "version" field in package.json');
const oldVersion = pkgMatch[2];
if (oldVersion === newVersion) fail(`package.json is already at ${newVersion}`);
const newPkgText = pkgText.replace(pkgVersionRe, `$1${newVersion}$3`);

// --- 2. README.md badge ---
const readmeText = fs.readFileSync(readmePath, 'utf8');
const badgeRe = /(version-)([\d.]+)(--[\w-]+-[\w]+\.svg)/;
const badgeMatch = readmeText.match(badgeRe);
if (!badgeMatch) fail('could not find version badge in README.md');
if (badgeMatch[2] !== oldVersion) {
  fail(
    `README badge version (${badgeMatch[2]}) does not match package.json (${oldVersion}) -- already out of sync, fix manually first`,
  );
}
const newReadmeText = readmeText.replace(badgeRe, `$1${newVersion}$3`);

// --- 3. CHANGELOG.md ---
const changelogText = fs.readFileSync(changelogPath, 'utf8');

const unreleasedHeaderRe = /^## \[Unreleased\]\s*$/m;
const unreleasedMatch = changelogText.match(unreleasedHeaderRe);
if (!unreleasedMatch) fail('could not find "## [Unreleased]" header in CHANGELOG.md');

const nextHeaderRe = /^## \[/gm;
nextHeaderRe.lastIndex = unreleasedMatch.index + unreleasedMatch[0].length;
const nextHeaderMatch = nextHeaderRe.exec(changelogText);
if (!nextHeaderMatch)
  fail('could not find the next "## [" section after Unreleased in CHANGELOG.md');

const unreleasedBodyStart = unreleasedMatch.index + unreleasedMatch[0].length;
const unreleasedBody = changelogText.slice(unreleasedBodyStart, nextHeaderMatch.index);
if (!unreleasedBody.trim()) fail('"## [Unreleased]" has no entries -- nothing to release');

const linkRefRe = /^\[Unreleased\]:\s*(https:\/\/\S+?)\/compare\/v([\d.]+)\.\.\.HEAD\s*$/m;
const linkRefMatch = changelogText.match(linkRefRe);
if (!linkRefMatch)
  fail('could not find "[Unreleased]: .../compare/vX.Y.Z...HEAD" link ref in CHANGELOG.md');
const repoUrl = linkRefMatch[1];
const prevVersion = linkRefMatch[2];
if (prevVersion !== oldVersion) {
  fail(
    `CHANGELOG's [Unreleased] link ref (v${prevVersion}) does not match package.json (${oldVersion}) -- already out of sync, fix manually first`,
  );
}

const today = new Date().toISOString().slice(0, 10);
const newSection = `## [Unreleased]\n\n## [${newVersion}] - ${today}\n${unreleasedBody}`;
let newChangelogText =
  changelogText.slice(0, unreleasedMatch.index) +
  newSection +
  changelogText.slice(nextHeaderMatch.index);

newChangelogText = newChangelogText.replace(
  linkRefRe,
  `[Unreleased]: ${repoUrl}/compare/v${newVersion}...HEAD\n[${newVersion}]: ${repoUrl}/compare/v${prevVersion}...v${newVersion}`,
);

// --- write ---
fs.writeFileSync(pkgPath, newPkgText);
fs.writeFileSync(readmePath, newReadmeText);
fs.writeFileSync(changelogPath, newChangelogText);

console.log(`bump-version: ${oldVersion} -> ${newVersion}`);
console.log(`  package.json   version updated`);
console.log(`  README.md      badge updated (suffix/color preserved: ${badgeMatch[3]})`);
console.log(`  CHANGELOG.md   [Unreleased] -> [${newVersion}] - ${today}, link refs rewritten`);
console.log(`\nReview the diff, then continue with release skill step 2 (tag).`);
