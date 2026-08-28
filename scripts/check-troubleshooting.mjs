// Gate: every warning docs/troubleshooting.md quotes is still a warning the app ships.
//
// CLAUDE.md wants one section per user-visible warning, and the section is found by searching the
// message you saw on screen. A reworded message leaves the section unreachable: the copy still
// reads correctly, the quote still looks like a message, and nothing fails. It has happened four
// times in one month. #240 alone re-synced 17 quotes across three separate rounds, and the same
// rot broke scripts/export-hubcap-examples.mjs, which matched a fragment no message contained.
//
// The check is a substring test, not a rewrite: a doc quote must appear verbatim inside some
// string src/ ships. Extraction is shared with check-copy.mjs (scripts/lib/copy-strings.mjs) so
// a message one gate can see is a message the other can see.
//
// Usage:
//   npm run check:troubleshooting
import { read, shippedMessages } from './lib/copy-strings.mjs';

const DOC = 'docs/troubleshooting.md';
const ELLIPSIS = '…';

// The doc writes a real example where the app interpolates: a number (0.20 mm, HTTP 429), a bare
// capital standing in for a count ("N filament slots"), a coordinate pair, an ellipsis for a part
// name, or a quoted sample value ("yourfile.png", a list of hex colours). None of those are
// drift, so they split the quote instead of being matched, and what survives between them is
// literal copy that must still ship.
//
// A quoted span goes too, because this app renders an interpolated name in quotes: `"${label}"`.
// It is not free. A quoted UI label the message really does ship ("Cut to artwork shape") is
// stripped the same way, so renaming one in src/ leaves this gate green with the doc stale. That
// is the sixth mismatch this gate first found, and it is now the one thing it cannot re-verify.
// Telling the two apart is not possible from the doc side, since both read as a quoted span, so
// the cost is recorded in docs/tech-debt.md rather than guessed at.
const PLACEHOLDER = new RegExp(
  `\\s*(?:${ELLIPSIS}|\\([a-z], [a-z]\\)|[\\d.]*\\d[\\d.]*|\\b[A-Z]\\b|"[^"]*")\\s*`,
  'g',
);

// Below this a fragment is a phrase like "It was put at", which appears in half the file and
// would pass whatever the app says. Measured by running the gate on 2026-08-28: of the 53 quotes
// the three forms find, 44 have a fragment this long and 9 do not. What that leaves unpinned is
// in docs/tech-debt.md.
const MIN_ANCHOR = 25;

const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** The longest run of literal copy in a quote: what must appear verbatim in a shipped string. */
function anchorOf(quote) {
  return (
    norm(quote)
      .split(PLACEHOLDER)
      .map(norm)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] ?? ''
  );
}

// Three quoting forms, all unambiguous: the section heading, which names the message the section
// is about; the italic "Full text" quote, which is the whole message verbatim and the most
// valuable of the three; and a bold quoted sentence, which is how a message with two arms is
// spelled out. The Full text form wraps across lines and escapes its inner quotes, so it is
// matched against the whole document rather than line by line.
//
// Backticked spans are NOT read. In this file they also hold constant names
// (`HUBCAP_MIN_DIAMETER_MM`), SVG attributes (`viewBox="0 0 755 525"`) and prose fragments, so
// reading them reported defects that were not there. docs/tech-debt.md records what that leaves
// unchecked: the feedback panel's two messages are quoted only in a table.
const DQUOTES = '"“”';
const HEADING_QUOTE = new RegExp(`[${DQUOTES}]([^${DQUOTES}]+)[${DQUOTES}]`, 'g');
const BOLD_QUOTE = new RegExp(`\\*\\*[${DQUOTES}]([^${DQUOTES}]{20,})[${DQUOTES}]\\*\\*`, 'g');

// Lazy to the first closing `"_`, rather than a pattern that understands escaping. The doc writes
// an inner quote both ways, escaped (`\"#ff0000\"`) and bare (`"yourfile.png"`), and an
// escape-aware pattern silently skipped every bare one.
const FULL_TEXT_QUOTE = /_"([\s\S]*?)"_/g;

/**
 * The file split at its `## Troubleshooting:` headings. Every quote is then read inside one
 * section, which is the bound that makes the lazy Full text pattern safe: a dropped closing `_`
 * can swallow the rest of its own section and no further, instead of merging two sections into
 * one quote that belongs to neither. Scoping the match is what removes that class; a cleverer
 * pattern only moves it, which is how the copy gate's markup splitting went three rounds.
 */
function sections(md) {
  const lines = md.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    // Both levels. The fill-warning family documents six messages under `### "..."` sub-headings,
    // and reading only `##` left every one of them unchecked and unreported.
    const heading =
      line.match(/^## Troubleshooting: (.+)$/) ?? line.match(new RegExp(`^### ([${DQUOTES}].+)$`));
    if (heading) out.push({ start: i, title: heading[1], lines: [] });
    if (out.length) out[out.length - 1].lines.push(line);
  });
  return out;
}

// Every form reads the same scope: the title for a heading quote, the section body for the other
// two. Matching one of them line by line instead made a quote that wraps across two lines vanish
// with nothing counting or reporting it, which is the silent hole this gate exists to close.
function quotesIn(section) {
  const out = [];
  const at = (offset) => section.start + offset + 1;
  const lineOf = (body, index) => at(body.slice(0, index).split('\n').length - 1);
  for (const m of section.title.matchAll(HEADING_QUOTE))
    out.push({ line: at(0), quote: m[1], kind: 'heading' });
  const body = section.lines.join('\n');
  for (const m of body.matchAll(BOLD_QUOTE))
    out.push({ line: lineOf(body, m.index), quote: m[1], kind: 'quoted sentence' });
  for (const m of body.matchAll(FULL_TEXT_QUOTE))
    out.push({
      line: lineOf(body, m.index),
      quote: m[1].replace(/\\"/g, '"'),
      kind: 'full-text quote',
    });
  return out;
}

const md = read(DOC);
// Not a quiet pass. This is a required gate, so a renamed or deleted file would otherwise turn it
// green forever, which is the failure mode the gate exists to prevent one directory over.
if (md === null) {
  console.log(`${DOC} is missing, so nothing pins the warnings the app ships.`);
  console.log('FAIL');
  process.exit(1);
}

const shipped = shippedMessages();
const misses = [];
const skipped = [];
const unpinned = [];
let checked = 0;

for (const section of sections(md)) {
  let pinned = 0;
  for (const { line, quote, kind } of quotesIn(section)) {
    const anchor = anchorOf(quote);
    if (anchor.length < MIN_ANCHOR) {
      skipped.push({ line, kind, quote: norm(quote) });
      continue;
    }
    checked++;
    pinned++;
    if (!shipped.some((s) => s.text.includes(anchor)))
      misses.push({ line, kind, quote: norm(quote), anchor });
  }
  if (!pinned) unpinned.push(section);
}

// A gate that passes because it looked at nothing is the failure it exists to prevent, and the
// missing-file branch above guards only one way of getting there. Restyling the section headings
// takes this to zero, and it was silently dropped once already when this loop was restructured.
// A per-form floor was tried and cut: 'quoted sentence' rests on two sentences in one section, so
// a legitimate restyle there would have blocked merge with no way to pass but editing this file.
if (!checked) {
  console.log(`Nothing in ${DOC} could be pinned, so this gate checked nothing.`);
  console.log('FAIL');
  process.exit(1);
}

for (const m of misses) {
  console.log(`${DOC}:${m.line}: no shipped string contains this ${m.kind}`);
  console.log(`     quoted: ${m.quote.slice(0, 110)}`);
  console.log(`     no src/ string contains: ${m.anchor.slice(0, 110)}`);
}

// Named, not just counted. A new section that lands unpinned would otherwise move one number by
// one and pass, so coverage would erode with nothing pointing at where.
for (const s of skipped)
  console.log(`${DOC}:${s.line}: this ${s.kind} is too short to pin: ${s.quote.slice(0, 80)}`);
for (const s of unpinned)
  console.log(`${DOC}:${s.start + 1}: nothing in this section is pinned: ${s.title.slice(0, 80)}`);

console.log(
  `\n${checked} quote${checked === 1 ? '' : 's'} checked against ${shipped.length} shipped strings, ` +
    `${skipped.length} too short to pin, ${unpinned.length} of ${sections(md).length} sections unpinned.`,
);

if (misses.length) {
  console.log(`${misses.length} quote${misses.length === 1 ? '' : 's'} out of date.`);
  console.log('Quote what ships, character for character, or the section cannot be searched for.');
  console.log('If the copy did not change, check whether the message moved to another module:');
  console.log('a suffix is only resolved within the file that defines it.');
  console.log('FAIL');
  process.exitCode = 1;
} else {
  console.log('Every quoted warning still ships.');
  console.log('PASS');
}
