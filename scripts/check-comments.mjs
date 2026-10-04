// Gate: no comment block in src/**/*.ts grows past LIMIT lines without a ratchet-allowlist entry.
//
// CLAUDE.md "Comments" caps docstrings at 2-4 lines; this stops long blocks growing back after a
// trim. LIMIT is 15 so the allowlist stays small: on 2026-10-04, `--print N` listed 91 blocks over
// 8, 28 over 12 and 11 over 15 (`node scripts/check-comments.mjs --print 8`).
//
// A block is a run of consecutive `//` lines or one `/* */` comment. The allowlist is keyed by
// file plus the block's first text line, not a line number, so unrelated edits don't invalidate it;
// rewording that first line means renaming the entry.
//
// Approximation: it is a line scan, not a parser. A blank line or directive inside a `//` run
// splits it in two, and a `//` line inside a template literal counts as a comment. Only src/**/*.ts
// is scanned, not CSS or scripts.
//
// Usage:
//   npm run check:comments
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMIT = 15;
export const ALLOWLIST = 'scripts/comment-allowlist.json';

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out.sort();
}

export function blocksIn(text) {
  const blocks = [];
  let first = null;
  let len = 0;
  let inBlock = false;
  let keyed = false;
  const end = () => {
    if (len) blocks.push({ first, len });
    len = 0;
  };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      const text = t.replace(/^\*\s?/, '');
      if (!keyed && text && text !== '/') {
        first = text.slice(0, 80);
        keyed = true;
      }
      len++;
      if (t.endsWith('*/')) {
        inBlock = false;
        end();
      }
    } else if (t.startsWith('/*')) {
      end();
      first = t.slice(0, 80);
      keyed = first.length > 3;
      len = 1;
      if (t.endsWith('*/')) end();
      else inBlock = true;
    } else if (t.startsWith('//')) {
      if (!len) first = t.slice(0, 80);
      len++;
    } else end();
  }
  end();
  return blocks;
}

// Same first line twice in one file gets #2, #3 in file order.
export function longBlocks(root, limit = LIMIT) {
  const found = new Map();
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const seen = new Map();
    for (const b of blocksIn(fs.readFileSync(file, 'utf8'))) {
      if (b.len <= limit) continue;
      const base = `${rel}::${b.first}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      found.set(n === 1 ? base : `${base}#${n}`, b.len);
    }
  }
  return found;
}

export function problems(root, allowlist, limit = LIMIT) {
  const out = [];
  const found = longBlocks(root, limit);
  for (const [key, len] of found) {
    const allowed = allowlist[key];
    if (allowed === undefined) {
      out.push(
        `${key}\n  ${len} lines, limit ${limit}. Cut it to the decision and the constraint, or move the history to the commit message. A block this long must hold several distinct constraints.`,
      );
    } else if (len > allowed) {
      out.push(
        `${key}\n  grew from ${allowed} to ${len} lines (limit ${limit}). Trim it back to ${allowed} or fewer.`,
      );
    } else if (len < allowed) {
      out.push(`${key}\n  shrank to ${len} lines. Lower its entry in ${ALLOWLIST} to ${len}.`);
    }
  }
  for (const key of Object.keys(allowlist)) {
    if (!found.has(key)) {
      out.push(
        `${key}\n  stale entry: no block over ${limit} lines matches. Remove it from ${ALLOWLIST}, or rename it if the block's first line was reworded.`,
      );
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const printAt = process.argv.indexOf('--print');
  if (printAt > 0) {
    const limit = Number(process.argv[printAt + 1] ?? LIMIT);
    console.log(JSON.stringify(Object.fromEntries(longBlocks(root, limit)), null, 2));
    process.exit(0);
  }
  const allowlist = JSON.parse(fs.readFileSync(path.join(root, ALLOWLIST), 'utf8'));
  const errs = problems(root, allowlist);
  if (errs.length) {
    console.error(`check:comments: ${errs.length} problem(s)\n\n${errs.join('\n\n')}`);
    process.exit(1);
  }
  console.log(
    `check:comments: ok (limit ${LIMIT} lines, ${Object.keys(allowlist).length} allowlisted)`,
  );
}
