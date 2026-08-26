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
// Thresholds are measured, not picked. The gate admits 220 prose strings from src/, of which 142
// get the full shape checks and 78 are markup and get the em dash check only. Against that set:
//   - MAX_WORDS 20 is CLAUDE.md's existing sentence limit for docs, not a new number
//   - joins are counted per SENTENCE, not per string: per-string flagged 11, of which 10 were
//     correct multi-sentence copy. Splitting a run-on in two RAISES the per-string count while
//     improving the writing, so the string is the wrong denominator
//   - markup is exempt from the shape checks because a tag soup has no sentences to measure. That
//     is 78 of the 220, mostly title= tooltips, and it is the widest hole in this gate
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

// A clause opener that turns a comma into a splice when a full sentence precedes it: a pronoun
// subject, or a bare imperative. The verb list is closed on purpose, covering the verbs this
// app's copy actually gives instructions with.
const PRONOUN = 'they|it|this|that|these|those|you|we|there';
const IMPERATIVE =
  'reposition|check|move|use|make|remove|add|try|pick|repair|simplify|turn|load|keep|raise|' +
  'set|increase|reduce|resize|reload|select|drag|slice|assign|import|click|open|save|export|' +
  'choose|enter|type';
const SPLICE = new RegExp(`,\\s+(?:${PRONOUN}|${IMPERATIVE})\\s+\\w`, 'gi');
// A sentence that opens with one of these is a dependent phrase, not a clause, so the comma
// after it is correct: "In the object list, click each part".
const DEPENDENT_OPENER =
  /^(in|on|at|after|before|when|if|while|for|with|to|from|under|once|since|unless|because|although)\b/i;
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
  for (const s of sentences(text)) {
    // Every comma, not just the first: one excused comma used to hide every splice after it.
    for (const m of s.matchAll(SPLICE)) {
      const before = s.slice(0, m.index).trim();
      // The opener only excuses a prefix that is still one phrase. Once the prefix carries its
      // own comma, an "In ..." at the far left no longer says anything about this comma.
      const excused = !before.includes(',') && DEPENDENT_OPENER.test(before);
      if (words(before) >= 4 && !excused) out.push('comma splice. Make it two sentences');
    }
  }
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
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return flatten(n.left) + flatten(n.right);
  if (ts.isParenthesizedExpression(n)) return flatten(n.expression);
  // A non-literal operand is an interpolation like any other, so it collapses to one token. It
  // used to return null, which made visit() skip the whole expression: 23 of 267 prose strings,
  // including every confirm dialog and the blocked-tower warning, were never checked at all.
  return 'X';
}
// Only an expression that actually contains a literal counts. Treating every parenthesized
// expression as stringy made `!(await confirmDialog(\`...\`))` flatten to one token and return,
// so visit() never descended into the call: every confirm dialog went unchecked.
const isStringy = (n) =>
  ts.isStringLiteral(n) ||
  ts.isNoSubstitutionTemplateLiteral(n) ||
  ts.isTemplateExpression(n) ||
  (ts.isBinaryExpression(n) &&
    n.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    (isStringy(n.left) || isStringy(n.right))) ||
  (ts.isParenthesizedExpression(n) && isStringy(n.expression));

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
      // Keep descending. A literal inside a ternary arm (`a + (c ? 'x' : 'y')`) is not part of
      // this chain, so returning here left both arms of the blocked-tower warning unchecked.
      // A literal that IS part of the chain is skipped by the isStringy(parent) guard above.
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}

// The help dialog is long-form explanation rather than a warning, and the full checks flag 26
// problems in it. Rewriting it is a copy pass of its own (docs/tech-debt.md), so for now only the
// em dash check applies. Flip this to false when that pass lands; nothing else needs changing.
const HELP_DIALOG_EM_DASH_ONLY = true;

for (const file of sources('index.html')) {
  const html = read(file);
  if (html === null) continue;
  const stripped = blankComments(html);
  for (const m of stripped.matchAll(/>([^<>]{26,})</g)) {
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (!/\s/.test(text) || !/[a-z]{3}/.test(text)) continue;
    const line = stripped.slice(0, m.index).split('\n').length - 1;
    const why = HELP_DIALOG_EM_DASH_ONLY
      ? text.includes(EM_DASH) && !isGlyph(text)
        ? ['em dash in visible page copy']
        : []
      : problems(text);
    for (const w of why) add(file, line, w, text);
  }
}

for (const file of sources('public/templates/*.svg')) {
  const svg = read(file);
  if (svg === null) continue;
  const stripped = blankComments(svg);
  for (const m of stripped.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)) {
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = stripped.slice(0, m.index).split('\n').length - 1;
    for (const why of problems(text)) add(file, line, why, text);
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
