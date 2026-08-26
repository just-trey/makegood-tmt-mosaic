// CLAUDE.md bans the em dash in user-facing copy. This gates the two places that copy lives:
// index.html in full, and *string literals only* in src/**/*.ts.
//
// Comments are deliberately out of scope. A regex over whole lines cannot tell a warning string
// from the prose above it, and the repo carries ~1900 em dashes in comments, docs and tests that
// no user ever sees. Parsing with the TypeScript AST is what lets the scope be this narrow and
// still be honest: it looks at the strings that reach a person, and nothing else.
//
// Usage:
//   npm run check:em-dashes
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const EM_DASH = '—';
const ADVICE = 'Use commas, colons, parentheses, or separate sentences.';

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

const hits = [];

for (const file of sources('src/**/*.ts', 'src/*.ts')) {
  const text = readFileSync(file, 'utf8');
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
      // Offset within the raw node, not node.text: a multi-line template's em dash can sit many
      // lines below where the literal starts, and pointing at the opening backtick is useless.
      const raw = node.getText(source);
      let at = raw.indexOf(EM_DASH);
      while (at !== -1) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source) + at);
        hits.push({ file, line: line + 1, text: lines[line].trim() });
        at = raw.indexOf(EM_DASH, at + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

for (const file of sources('index.html')) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (line.includes(EM_DASH)) hits.push({ file, line: i + 1, text: line.trim() });
    });
}

for (const h of hits) {
  console.log(`${h.file}:${h.line}: em dash in user-facing copy`);
  console.log(`     ${h.text}`);
}

if (hits.length) {
  console.log(`\n${hits.length} em dash${hits.length === 1 ? '' : 'es'} found. ${ADVICE}`);
  console.log('FAIL');
  process.exitCode = 1;
} else {
  console.log('No em dashes in user-facing copy.');
  console.log('PASS');
}
