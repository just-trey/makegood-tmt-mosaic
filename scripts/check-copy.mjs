// Gate on the shape of user-facing copy. The rule underneath all five checks is one thing: a
// warning should be short sentences that each do one job.
//
// This started as an em-dash-only grep. That was a third of the rule and it created the other two
// thirds: sweeping 53 em dashes out by hand produced comma splices, garden paths and lowercase
// words after full stops, because the dash had been holding together a sentence doing two jobs.
// Substituting punctuation moved the defect instead of removing it. So the checks below look at
// sentence shape, and the em dash is only one of the symptoms they catch.
//
// Scope is user-facing copy only. Em dashes and long sentences are fine in code, in comments, and
// in docs/, which are working notes rather than copy anyone reads in the app:
//   - string literals in src/**/*.ts, via the TypeScript AST, so a comment above a warning is
//     never mistaken for the warning
//   - visible markup of index.html, with <!-- --> blanked
//   - visible <text> of public/templates/*.svg, which users download and print
//
// Thresholds are measured, not picked. Against the 127 prose strings this repo ships:
//   - MAX_WORDS 20 is CLAUDE.md's existing sentence limit for docs, not a new number
//   - joins are counted per SENTENCE, not per string: per-string flagged 11, of which 10 were
//     correct multi-sentence copy. Splitting a run-on in two RAISES the per-string count while
//     improving the writing, so the string is the wrong denominator
//   - the comma-splice check needs 4+ words before the comma, or it flags "Thanks, we got it."
//
// Usage:
//   npm run check:copy
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const EM_DASH = '—';
const MAX_WORDS = 20;
const MAX_JOINS = 1;

// A clause opener that turns a comma into a splice when a full sentence precedes it.
const SPLICE = /^(.*?),\s+(they|it|this|that|these|those|you|we|there)\s+\w/;
const JOIN = [/[;:—]/g, /,\s+(and|but|so|or|yet|which|because)\b/g];

const sentences = (t) =>
  t
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
const words = (s) => s.split(/\s+/).filter(Boolean).length;
const joins = (s) => JOIN.reduce((n, re) => n + (s.match(re) ?? []).length, 0);

// Markup is not prose: a template's HTML has no sentences to measure.
const isMarkup = (t) => /<\/?[a-zA-Z][\w-]*[\s>/]/.test(t);
// A literal that is nothing but a dash is a placeholder for "no value", not writing.
const isGlyph = (t) => t.trim() === EM_DASH;

function problems(text) {
  const out = [];
  if (text.includes(EM_DASH) && !isGlyph(text))
    out.push('em dash. Use commas, colons, parentheses, or separate sentences');
  if (isMarkup(text)) return out;
  if (/[.!?]\s+[a-z]/.test(text)) out.push('a sentence starts with a lowercase word');
  const m = text.match(SPLICE);
  if (m && words(m[1]) >= 4) out.push('comma splice. Make it two sentences');
  for (const s of sentences(text)) {
    if (words(s) > MAX_WORDS) out.push(`a ${words(s)}-word sentence (limit ${MAX_WORDS})`);
    if (joins(s) > MAX_JOINS) out.push(`${joins(s)} joins in one sentence (limit ${MAX_JOINS})`);
  }
  return out;
}

// --cached plus --others catches a file that is new and not yet staged; --exclude-standard keeps
// gitignored and vendored trees out. Tracked-only missed a brand-new file entirely, which is
// exactly when fresh copy gets written.
function sources(...patterns) {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...patterns],
    { encoding: 'utf8' },
  );
  return [...new Set(out.split('\n').filter(Boolean))];
}

// git lists index entries, which can name a file that is not on disk (mid-rebase, moved, deleted
// but unstaged). A missing file is nothing to check, not a reason to abort the whole gate chain.
function read(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

const blankComments = (t) => t.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
const hits = [];
const add = (file, line, why, text) => hits.push({ file, line: line + 1, why, text });

// A message is usually assembled: 'a' + `b ${x} c` + 'd'. Checking one fragment at a time cannot
// see a sentence, so flatten the whole expression and collapse each interpolation to one token.
function flatten(n) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n))
    return n.head.text + n.templateSpans.map((s) => 'X' + s.literal.text).join('');
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = flatten(n.left);
    const r = flatten(n.right);
    return l === null || r === null ? null : l + r;
  }
  if (ts.isParenthesizedExpression(n)) return flatten(n.expression);
  return null;
}
const isStringy = (n) =>
  ts.isStringLiteral(n) ||
  ts.isNoSubstitutionTemplateLiteral(n) ||
  ts.isTemplateExpression(n) ||
  (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
  ts.isParenthesizedExpression(n);

for (const file of sources('src/**/*.ts', 'src/*.ts')) {
  const text = read(file);
  if (text === null) continue;
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const visit = (n) => {
    if (isStringy(n) && !(n.parent && isStringy(n.parent))) {
      const t = flatten(n);
      // Short fragments are ids, keys and selectors, not copy. 25 chars is where prose starts.
      if (t && /\s/.test(t) && /[a-z]{3}/.test(t) && t.length > 25) {
        const { line } = src.getLineAndCharacterOfPosition(n.getStart(src));
        for (const why of problems(t)) add(file, line, why, t);
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}

for (const file of sources('index.html')) {
  const html = read(file);
  if (html === null) continue;
  const lines = html.split('\n');
  blankComments(html)
    .split('\n')
    .forEach((line, i) => {
      if (line.includes(EM_DASH)) add(file, i, 'em dash in visible page copy', lines[i].trim());
    });
}

for (const file of sources('public/templates/*.svg')) {
  const svg = read(file);
  if (svg === null) continue;
  const stripped = blankComments(svg);
  for (const m of stripped.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)) {
    if (!m[1].includes(EM_DASH)) continue;
    const line = stripped.slice(0, m.index + m[0].indexOf(EM_DASH)).split('\n').length - 1;
    add(file, line, 'em dash on a template users print', m[1].trim());
  }
}

for (const h of hits) {
  console.log(`${h.file}:${h.line}: ${h.why}`);
  console.log(`     ${h.text.replace(/\n/g, ' ').slice(0, 120)}`);
}

if (hits.length) {
  console.log(`\n${hits.length} problem${hits.length === 1 ? '' : 's'} in user-facing copy.`);
  console.log('Short sentences, one job each. Code, comments and docs are not checked.');
  console.log('FAIL');
  process.exitCode = 1;
} else {
  console.log('User-facing copy is clean.');
  console.log('PASS');
}
