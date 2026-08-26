// Em dashes are banned in user-facing copy only. They are fine in code and in code comments, and
// fine as a formatting glyph (a lone dash standing in for an empty value).
//
// What "user-facing copy" means here, and why each needs its own reader:
//   - string literals in src/**/*.ts, parsed with the TypeScript AST, so a comment above a
//     warning is never mistaken for the warning
//   - the visible markup of index.html, with <!-- --> stripped
//   - the visible <text> of public/templates/*.svg, which users download and print
//
// A regex over whole lines cannot draw any of those lines, which is why this parses instead.
//
// Usage:
//   npm run check:em-dashes
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const EM_DASH = '—';
const ADVICE = 'Use commas, colons, parentheses, or separate sentences.';

// A literal that is nothing but a dash is a placeholder standing in for "no value", not prose.
const isFormattingGlyph = (text) => text.trim() === EM_DASH;

// --cached plus --others catches a file that is new and not yet staged; --exclude-standard keeps
// gitignored and vendored trees (node_modules, dist) out. Tracked-only missed a brand-new file
// entirely, which is exactly when a fresh em dash gets written.
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

// Blank out comment bodies rather than dropping them, so line numbers still point at the source.
const blankComments = (text) => text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

const hits = [];
const add = (file, lines, line, why) =>
  hits.push({ file, line: line + 1, why, text: lines[line].trim() });

for (const file of sources('src/**/*.ts', 'src/*.ts')) {
  const text = read(file);
  if (text === null) continue;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const lines = text.split('\n');
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (!isFormattingGlyph(node.text)) {
        // Offset within the raw node, not node.text: a multi-line template's em dash can sit many
        // lines below where the literal starts, and pointing at the opening backtick is useless.
        const raw = node.getText(source);
        let at = raw.indexOf(EM_DASH);
        while (at !== -1) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source) + at);
          add(file, lines, line, 'string shown to a user');
          at = raw.indexOf(EM_DASH, at + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

for (const file of sources('index.html')) {
  const html = read(file);
  if (html === null) continue;
  const lines = html.split('\n');
  blankComments(html)
    .split('\n')
    .forEach((line, i) => {
      if (line.includes(EM_DASH)) add(file, lines, i, 'visible page copy');
    });
}

// Only the visible <text> of a template: the rest of the file is markup and generator comments.
for (const file of sources('public/templates/*.svg')) {
  const svg = read(file);
  if (svg === null) continue;
  const lines = svg.split('\n');
  const stripped = blankComments(svg);
  for (const m of stripped.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)) {
    if (!m[1].includes(EM_DASH)) continue;
    const line = stripped.slice(0, m.index + m[0].indexOf(EM_DASH)).split('\n').length - 1;
    add(file, lines, line, 'text on a template users print');
  }
}

for (const h of hits) {
  console.log(`${h.file}:${h.line}: em dash in ${h.why}`);
  console.log(`     ${h.text}`);
}

if (hits.length) {
  console.log(`\n${hits.length} em dash${hits.length === 1 ? '' : 'es'} found. ${ADVICE}`);
  console.log('Em dashes are fine in code, in comments, and as a lone placeholder glyph.');
  console.log('FAIL');
  process.exitCode = 1;
} else {
  console.log('No em dashes in user-facing copy.');
  console.log('PASS');
}
