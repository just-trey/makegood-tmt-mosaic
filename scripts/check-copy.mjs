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
// measured: see textUnits() for why that was cut. index.html does not share this hole: parse5
// measures its element text directly. Measured 2026-08-26 against the 220 prose strings src/
// admits: 78 are markup, only their attributes are read (23 units), and 62 yield nothing at all --
// including a plain warning in src/svg/parse.ts that counts as markup only because it names an SVG
// element. Reopening this means locating and parsing the markup fragment inside each template
// literal, the same parser treatment index.html already gets.
//
// Thresholds are measured, not picked. The gate admits 220 prose strings from src/. Against that
// set:
//   - MAX_WORDS 20 is CLAUDE.md's existing sentence limit for docs, not a new number. It undercounts
//     a message built from a joined list, since an interpolation is always one word to this gate
//     (see the MAX_WORDS constant below) -- e.g. `join(', ')`, 9 sites in src/, 5 unbounded
//     (2026-08-29)
//   - joins are counted per SENTENCE, not per string: per-string flagged 11, of which 10 were
//     correct multi-sentence copy. Splitting a run-on in two RAISES the per-string count while
//     improving the writing, so the string is the wrong denominator
//   - the comma-splice check needs 4+ words before the comma, or it flags "Thanks, we got it."
//   - the 25-char prose floor (MIN_PROSE_CHARS below) is measured too: widening it to 21 chars
//     takes the gate from 220 strings to 239, and none of the 19 more are defects
//
// Usage:
//   npm run check:copy
import { parse as parseHtml } from 'parse5';
import { sources, read, eachMessage } from './lib/copy-strings.mjs';

const EM_DASH = '—';
// flatten()/flattenAll() (copy-strings.mjs) collapse every interpolation to one token, so a message
// built from a joined list undercounts here. Replicating this gate's own sentences()/words() on `n`
// hex labels: zeroDepthWarning and edgeCutThroughNotice both run 16/20/21/25 words at n=1/5/6/10,
// and 21 words at three "Merged (N)" rows. DEFAULT_RASTER_COLORS is six, so an imported photo
// reaches it. Not a false negative on its own -- the words this gate can see are still real -- but
// the interpolation itself might have pushed the true count over MAX_WORDS.
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
// correct and each uncovered the next. The area was cut rather than patched a fourth time. What
// that costs is measured at the top of this file, next to the other gate thresholds.
// The attributes a user actually reads, wherever they show up: a markup string's own extraction
// below, and htmlTextUnits()' parse5 walk further down. One list, so adding a fourth can't land on
// only one of the two paths.
const READABLE_ATTR_NAMES = ['title', 'aria-label', 'placeholder'];
const READABLE_ATTR = new RegExp(`\\b(?:${READABLE_ATTR_NAMES.join('|')})="([^"]+)"`, 'g');
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
// reverted for src/ markup strings for the same three-round reasons recorded above: it missed
// prose before the first tag and after the last, a quote-aware version leaked past
// `title="depth > 0"`, and a fix for that broke on the apostrophe in "its artwork's shape". A real
// parser has none of those failure modes, because it already knows where a tag starts and ends.
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

function emDashProblems(text) {
  return text.includes(EM_DASH) && !isGlyph(text)
    ? ['em dash. Use commas, colons, parentheses, or separate sentences']
    : [];
}

// For text that structurally cannot still contain a tag: only htmlTextUnits()'s output qualifies,
// because parse5 parsed the real tree and this is what's left over after removing every element.
// It must not be routed back through the isMarkup check below, because parse5 also decodes
// entities — a literal example like "Type &lt;return&gt;" becomes the text "Type <return>" here,
// and isMarkup's regex would match that decoded "<return>" as a tag and silently skip four of the
// five checks. Do not reuse this for the public/templates/*.svg path: that extraction is a plain
// regex on `<text>...</text>` that does not strip a nested tag (a <tspan>, say), so a real one
// still needs the isMarkup fallback problems() provides.
function proseProblems(text) {
  return [...emDashProblems(text), ...shapeProblems(text)];
}

// For text that was pulled out by a regex rather than a real parser, and so might still contain a
// tag: a raw src/**/*.ts string literal (which may be building an innerHTML string), or a
// public/templates/*.svg <text> capture (which does not strip a nested element). Delegates to
// proseProblems() once markup is ruled out, so the em-dash rule lives in one place.
function problems(text) {
  if (isMarkup(text)) {
    const out = [...emDashProblems(text)];
    for (const unit of textUnits(text)) out.push(...shapeProblems(unit));
    return out;
  }
  return proseProblems(text);
}

const hits = [];
const add = (file, line, why, text) => hits.push({ file, line: line + 1, why, text });

for (const file of sources('src/**/*.ts', 'src/*.ts')) {
  const text = read(file);
  if (text === null) continue;
  eachMessage(file, text, (t, node, src) => {
    // Short fragments are ids, keys and selectors, not copy.
    if (!(t && /\s/.test(t) && /[a-z]{3}/.test(t) && t.length > MIN_PROSE_CHARS)) return;
    const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
    for (const why of problems(t)) add(file, line, why, t);
  });
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
