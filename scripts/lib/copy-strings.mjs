// The user-facing strings a `src/**/*.ts` file ships, pulled off the TypeScript AST.
//
// Shared by check-copy.mjs (which gates their shape) and check-troubleshooting.mjs (which pins
// the docs' quotes to them). One extractor, so a message the copy gate can see is a message the
// quote gate can see. Two extractors would drift, which is the class of bug both gates exist for.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

// --cached plus --others catches a file that is new and not yet staged; --exclude-standard keeps
// gitignored and vendored trees out. Tracked-only missed a brand-new file entirely, which is
// exactly when fresh copy gets written.
//
// Untracked files count for both consumers on purpose. For check-copy that is strictly stricter.
// For the quote gate it is looser, since an untracked file's strings could satisfy a doc quote
// that CI's clean checkout would not find. That direction is safe: the local run passes and CI
// fails, which is the way round that gets noticed. Splitting the policy per consumer would mean
// the two gates no longer read the same set of files, which is what this module exists to avoid.
export function sources(...patterns) {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...patterns],
    { encoding: 'utf8' },
  );
  return [...new Set(out.split('\n').filter(Boolean))];
}

// git lists index entries, which can name a file that is not on disk (mid-rebase, moved, deleted
// but unstaged). A missing file is nothing to check, not a reason to abort the whole gate chain.
export function read(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

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
// Resolves within one file only, by design: a suffix imported from another module is still one
// token (an unindexed import has no local declaration to walk), and a name bound twice or bound
// with `let` is skipped rather than guessed -- a wrong substitution invents defects that are not
// there. The one place this reads as a false positive rather than a gap: moving a message constant
// to another module, or rebinding it with `let`, collapses it to a token here even though the
// shipped copy is byte-identical, so both gates report drift where there is none. Closing it needs
// a full ts.createProgram, which was rejected as too heavy for what these gates check.
export function stringConsts(src) {
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
export function flatten(n, binds) {
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
// expression as stringy made `!(await confirmDialog(`...`))` flatten to one token and return,
// so visit() never descended into the call: every confirm dialog went unchecked.
export const isStringy = (n) =>
  ts.isStringLiteral(n) ||
  ts.isNoSubstitutionTemplateLiteral(n) ||
  ts.isTemplateExpression(n) ||
  (ts.isBinaryExpression(n) &&
    n.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    (isStringy(n.left) || isStringy(n.right))) ||
  (ts.isParenthesizedExpression(n) && isStringy(n.expression));

// Every wording one message expression can ship, rather than the single flattened reading
// `flatten` gives. A ternary picks one arm at runtime and the docs quote one of them, so
// collapsing it to a token loses the middle of the sentence: the edge-cut notice reads
// "so that region cuts" or "so those regions cut", and neither survives a single flatten.
//
// Bounded, because a message with several ternaries multiplies. Measured across `src/` on
// 2026-08-28: 2210 expressions have one reading, 29 have two, two have four, two have sixteen,
// and one has 384, the `.depth-row` innerHTML template at ui/colorList.ts:371. The cap sits above
// that, because truncating is silent and cuts the later ternary arms first. For check-copy a lost
// reading is one it does not shape-check. For the quote gate it is worse: a doc quoting a reading
// that was cut would be reported as drift that is not there.
const MAX_VARIANTS = 512;
const cross = (as, bs) => {
  const out = [];
  for (const a of as)
    for (const b of bs) {
      if (out.length >= MAX_VARIANTS) return out;
      out.push(a + b);
    }
  return out;
};
export function flattenAll(n, binds) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
  if (ts.isTemplateExpression(n)) {
    let acc = [n.head.text];
    for (const s of n.templateSpans)
      acc = cross(cross(acc, flattenAll(s.expression, binds)), [s.literal.text]);
    return acc;
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return cross(flattenAll(n.left, binds), flattenAll(n.right, binds));
  if (ts.isParenthesizedExpression(n)) return flattenAll(n.expression, binds);
  if (ts.isConditionalExpression(n))
    return [...flattenAll(n.whenTrue, binds), ...flattenAll(n.whenFalse, binds)].slice(
      0,
      MAX_VARIANTS,
    );
  if (ts.isIdentifier(n) && binds.has(n.text)) return [binds.get(n.text)];
  return ['X'];
}

/**
 * Walk one file's top-level string expressions, handing each to `onMessage(text, node, src)`.
 * `allReadings` false gives the single flattened reading, true gives every ternary arm.
 */
export function eachMessage(file, text, onMessage, allReadings = false) {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const binds = stringConsts(src);
  const visit = (n) => {
    if (isStringy(n) && !(n.parent && isStringy(n.parent))) {
      const readings = allReadings ? flattenAll(n, binds) : [flatten(n, binds)];
      for (const t of readings) onMessage(t, n, src);
      // Keep descending. A literal inside a ternary arm (`a + (c ? 'x' : 'y')`) is not part of
      // this chain, so returning here left both arms of the blocked-tower warning unchecked.
      // A literal that IS part of the chain is skipped by the isStringy(parent) guard above.
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}

/** Every reading of every message the app ships, whitespace collapsed. Order is not meaningful. */
export function shippedMessages(patterns = ['src/**/*.ts', 'src/*.ts']) {
  const out = [];
  for (const file of sources(...patterns)) {
    const text = read(file);
    if (text === null) continue;
    eachMessage(
      file,
      text,
      (t) => {
        const one = t.replace(/\s+/g, ' ').trim();
        if (one) out.push({ file, text: one });
      },
      true,
    );
  }
  return out;
}
