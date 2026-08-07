// Print one version's CHANGELOG section, for use as GitHub Release notes.
// Release creation is automated (deploy.yml's `release` job on a `v*` tag, and
// backfill-releases.yml), and both feed the notes from here so the Release body
// is exactly the CHANGELOG entry -- no second, drifting copy of the notes.
//
// Usage:
//   node scripts/changelog-extract.mjs v0.6.0   # leading "v" optional
//
// Prints the section body to stdout. Exits non-zero (nothing on stdout) if the
// version has no section, so a release step fails loudly instead of publishing
// empty notes.
import fs from 'fs';
import path from 'path';

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: node scripts/changelog-extract.mjs <version>  (e.g. v0.6.0)');
  process.exit(1);
}
const version = raw.replace(/^v/, '');

const changelogPath = path.join(path.resolve(import.meta.dirname, '..'), 'CHANGELOG.md');
const lines = fs.readFileSync(changelogPath, 'utf8').split('\n');

// A version heading looks like: ## [0.6.0] - 2026-07-26
const headingRe = new RegExp(`^##\\s+\\[${version.replace(/\./g, '\\.')}\\]`);
const start = lines.findIndex((l) => headingRe.test(l));
if (start === -1) {
  console.error(`changelog-extract: no "## [${version}]" section in CHANGELOG.md`);
  process.exit(1);
}

// The body runs until the next section heading, or the link-reference block at
// the bottom ("[0.6.0]: https://...compare..."), whichever comes first.
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i]) || /^\[[^\]]+\]:\s+https?:/.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim();
if (!body) {
  console.error(`changelog-extract: "## [${version}]" section is empty`);
  process.exit(1);
}
process.stdout.write(body + '\n');
