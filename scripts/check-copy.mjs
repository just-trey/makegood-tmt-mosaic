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
//   - visible markup of index.html, parsed with parse5 (see htmlTextUnits()) so nested tags don't
//     fragment a sentence
//   - visible <text> of public/templates/*.svg, which users download and print
//
// A src/**/*.ts string that is itself markup (an innerHTML template literal) gets the em dash
// check, plus the shape checks on each title/aria-label/placeholder. Its element text is not
// measured: see textUnits() for why that was cut, and docs/tech-debt.md for what it leaves
// uncovered. index.html does not share this hole: parse5 measures its element text directly.
//
// Thresholds are measured, not picked. The gate admits 220 prose strings from src/. Against that
// set:
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
import { parse as parseHtml } from 'parse5';

const EM_DASH = '—';
const MAX_WORDS = 20;
const MAX_JOINS = 1;
// Below this, a string is an id, a key or a selector, not prose. Shared by every extraction path
// so retuning it can't move for one kind of copy and not another.
const MIN_PROSE_CHARS = 25;

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

const blankComments = (t) => t.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

// Markup is not prose: a tag soup has no sentences to measure. Its readable parts are pulled out
// and measured on their own by textUnits() below.
const isMarkup = (t) => /<\/?[a-zA-Z][\w-]*[\s>/]/.test(t);
// A literal that is nothing but a dash is a placeholder for "no value", not writing.
const isGlyph = (t) => t.trim() === EM_DASH;

// The readable copy inside a markup string: the attributes a user actually reads, and nothing
// else. The element text between the tags is NOT measured, on purpose.
//
// Splitting markup into text runs was built and reverted. Three review rounds each found a defect
// in it: a `>text<` match missed prose before the first tag and after the last, then a quote-aware
// tag pattern leaked the rest of a tag on `title="depth > 0"`, then the same pattern broke on the
// apostrophe in "its artwork's shape" and measured a whole <!-- --> comment as copy. Each fix was
// correct and each uncovered the next. The area was cut rather than patched a fourth time.
//
// What that costs is in docs/tech-debt.md: the element text of 78 markup strings goes unchecked,
// including a plain warning in src/svg/parse.ts that counts as markup only because it names an
// SVG element.
const READABLE_ATTR = /\b(?:title|aria-label|placeholder)="([^"]+)"/g;
// A readable unit is shorter than a whole string: an attribute is a clause, not a paragraph.
const MIN_UNIT_CHARS = 12;
function textUnits(markup) {
  const out = [];
  // Blanked first, so a title= inside a commented out block is not treated as copy.
  for (const m of blankComments(markup).matchAll(READABLE_ATTR)) out.push(m[1]);
  return out
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= MIN_UNIT_CHARS && /\s/.test(t) && /[a-z]{3}/.test(t));
}

// index.html's element text used to be pulled with a regex (`>text<`), which was built and
// reverted for src/ markup strings for the reasons docs/tech-debt.md records: it missed prose
// before the first tag and after the last, a quote-aware version leaked past `title="depth > 0"`,
// and a fix for that broke on the apostrophe in "its artwork's shape". A real parser has none of
// those failure modes, because it already knows where a tag starts and ends.
//
// parse5 directly, not the jsdom already in devDependencies (jsdom uses parse5 under the hood, so
// this adds no new parsing engine, only a direct import of the one already in node_modules).
// jsdom's DOM has no equivalent of sourceCodeLocationInfo: every finding this script reports needs
// a line number, and jsdom doesn't expose where in the source a node came from.
//
// Only inline, prose-formatting tags fold into their parent's text: a run split across <b> or <a>
// is one sentence to the reader, so it must be one unit here. Anything else (p, li, div, h3...) is
// itself a separate unit, so a paragraph and its heading are never measured as running text.
// `span` is deliberately excluded: index.html uses it only for non-prose chrome (header stats, a
// hint's conditional clause), and folding those into whatever block happens to contain them would
// measure unrelated fragments as one sentence. If a future edit ever wraps a run of help copy in
// `<span>` for styling, that span becomes its own unit instead of joining its paragraph.
const INLINE_TAGS = new Set([
  'a',
  'b',
  'strong',
  'em',
  'i',
  'code',
  'kbd',
  'sub',
  'sup',
  'u',
  'br',
]);

function inlineTextContent(node) {
  let out = '';
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#text') out += child.value;
    else if (INLINE_TAGS.has(child.tagName)) out += inlineTextContent(child);
    // A non-inline child (block-ish) contributes nothing here: it gets its own unit below.
  }
  return out;
}

const READABLE_ATTR_NAMES = ['title', 'aria-label', 'placeholder'];

// One unit per non-inline element's visible text, plus one per readable attribute on any element,
// each at the line it starts on. Both come off the same parse5 tree: the tree already carries
// every attribute with its own value and location, so a second pass over the raw string (regex,
// with its own comment-blanking) would only risk disagreeing with what this walk already knows.
// Recurses unconditionally, so a block nested inside another (a <p> inside a <section>) still gets
// its own unit; the outer element's own unit only ever gathers its own direct inline/text runs.
function htmlTextUnits(html) {
  const doc = parseHtml(html, { sourceCodeLocationInfo: true });
  const units = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeName === '#text' || child.nodeName === '#comment') continue;
      if (child.tagName === 'script' || child.tagName === 'style') continue;
      if (!INLINE_TAGS.has(child.tagName)) {
        const text = inlineTextContent(child).replace(/\s+/g, ' ').trim();
        if (text)
          units.push({ text, line: (child.sourceCodeLocation?.startLine ?? 1) - 1, kind: 'text' });
      }
      for (const attr of child.attrs ?? []) {
        if (!READABLE_ATTR_NAMES.includes(attr.name)) continue;
        const text = attr.value.replace(/\s+/g, ' ').trim();
        const loc = child.sourceCodeLocation?.attrs?.[attr.name] ?? child.sourceCodeLocation;
        if (text) units.push({ text, line: (loc?.startLine ?? 1) - 1, kind: 'attr' });
      }
      walk(child);
    }
  };
  walk(doc);
  return units;
}

// The four sentence-shape checks. Kept apart from the em dash check so markup can run these per
// readable unit while the dash is still looked for across the whole string.
function shapeProblems(text) {
  const out = [];
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
    if (words(s) > MAX_WORDS) out.push(`a ${words(s)}-word sentence (limit ${MAX_WORDS})`);
    if (joins(s) > MAX_JOINS) out.push(`${joins(s)} joins in one sentence (limit ${MAX_JOINS})`);
  }
  return out;
}

// For text that is already known to be prose, never a raw markup string: html/svg extraction has
// already isolated it from its tags, so it must not be routed back through the isMarkup check
// below. That check is necessary for the src/**/*.ts path (see problems()), but parse5 decodes
// entities, so a literal example like "Type &lt;return&gt;" becomes the text "Type <return>" here
// — isMarkup's regex would match that decoded "<return>" as a tag and silently skip four of the
// five checks. Text that came from a real parser is never at risk of that misread.
function proseProblems(text) {
  const out = [];
  if (text.includes(EM_DASH) && !isGlyph(text))
    out.push('em dash. Use commas, colons, parentheses, or separate sentences');
  out.push(...shapeProblems(text));
  return out;
}

// For a raw src/**/*.ts string literal, which may or may not itself contain markup (a template
// literal building an innerHTML string, for instance). Never use this on text a parser already
// extracted from real markup — see proseProblems() above for why.
function problems(text) {
  const out = [];
  if (text.includes(EM_DASH) && !isGlyph(text))
    out.push('em dash. Use commas, colons, parentheses, or separate sentences');
  if (isMarkup(text)) {
    for (const unit of textUnits(text)) out.push(...shapeProblems(unit));
    return out;
  }
  out.push(...shapeProblems(text));
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

const hits = [];
const add = (file, line, why, text) => hits.push({ file, line: line + 1, why, text });

// Every `const NAME = 'literal'` in one file, so a message finished by a shared suffix can be
// measured whole. Same file only: both defects this closes were same-file, and resolving across
// files needs a full ts.createProgram, which is a far heavier gate for the reach it adds.
//
// Two deliberate narrowings, because a wrong substitution invents defects that are not there:
//   - `const` only. A `let` is reassigned later, so its initializer is not what ships. Several
//     are `let x = ''` accumulators, and substituting the empty seed measures the wrong string.
//   - a name introduced any OTHER way in the file is dropped rather than guessed. This is one
//     flat map with no scope tracking, so two functions with their own `const label`, or a
//     parameter named `tail` shadowing a file-level one, would otherwise resolve to whichever
//     was seen last and report joins against a string that never exists.
const DECLARES_A_NAME = [
  ts.isParameter,
  ts.isBindingElement,
  ts.isImportSpecifier,
  ts.isImportClause,
  ts.isNamespaceImport,
  ts.isVariableDeclaration,
  ts.isFunctionDeclaration,
  ts.isClassDeclaration,
];
function stringConsts(src) {
  const binds = new Map();
  const ambiguous = new Set();
  const walk = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const isConst = !!(ts.getCombinedNodeFlags(n) & ts.NodeFlags.Const);
      const i = n.initializer;
      if (isConst && (ts.isStringLiteral(i) || ts.isNoSubstitutionTemplateLiteral(i))) {
        if (binds.has(n.name.text) && binds.get(n.name.text) !== i.text) ambiguous.add(n.name.text);
        binds.set(n.name.text, i.text);
        ts.forEachChild(n, walk);
        return;
      }
    }
    if (DECLARES_A_NAME.some((is) => is(n)) && n.name && ts.isIdentifier(n.name))
      ambiguous.add(n.name.text);
    ts.forEachChild(n, walk);
  };
  walk(src);
  for (const name of ambiguous) binds.delete(name);
  return binds;
}

// A message is usually assembled: 'a' + `b ${x} c` + 'd'. Checking one fragment at a time cannot
// see a sentence, so flatten the whole expression and collapse each interpolation to one token.
function flatten(n, binds) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n))
    return (
      n.head.text +
      n.templateSpans.map((s) => flatten(s.expression, binds) + s.literal.text).join('')
    );
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return flatten(n.left, binds) + flatten(n.right, binds);
  if (ts.isParenthesizedExpression(n)) return flatten(n.expression, binds);
  // A shared suffix is part of the sentence, so substitute it. Collapsing it to a token measured
  // every such message in halves, which is how a two-join sentence and a dangling clause both
  // shipped past this gate.
  if (ts.isIdentifier(n) && binds.has(n.text)) return binds.get(n.text);
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
  const binds = stringConsts(src);
  const visit = (n) => {
    if (isStringy(n) && !(n.parent && isStringy(n.parent))) {
      const t = flatten(n, binds);
      // Short fragments are ids, keys and selectors, not copy.
      if (t && /\s/.test(t) && /[a-z]{3}/.test(t) && t.length > MIN_PROSE_CHARS) {
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

for (const file of sources('index.html')) {
  const html = read(file);
  if (html === null) continue;
  // Element text and attributes, both off the one parse5 tree (see htmlTextUnits()). Element text
  // keeps the same 25-char floor as the src/ path; an attribute is a clause, not a paragraph, so
  // it keeps no floor beyond having a space and a real word, matching this gate's original reach
  // into title=/aria-label= before parse5 replaced the regex extraction.
  for (const { text, line, kind } of htmlTextUnits(html)) {
    if (!/\s/.test(text) || !/[a-z]{3}/.test(text)) continue;
    if (kind === 'text' && text.length <= MIN_PROSE_CHARS) continue;
    for (const w of proseProblems(text)) add(file, line, w, text);
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
    for (const why of proseProblems(text)) add(file, line, why, text);
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
