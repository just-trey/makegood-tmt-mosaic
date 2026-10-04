import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error untyped .mjs script
import { LIMIT, problems } from '../scripts/check-comments.mjs';

const tmp: string[] = [];
function tree(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-comments-'));
  tmp.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), body);
  return root;
}
const block = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i}`).join('\n');

afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('check-comments', () => {
  it('passes on the real tree against the shipped allowlist', () => {
    const allowlist = JSON.parse(fs.readFileSync('scripts/comment-allowlist.json', 'utf8'));
    expect(problems(process.cwd(), allowlist)).toEqual([]);
  });

  it('fails on a planted 20-line block and names it', () => {
    const errs = problems(tree(`${block(20)}\nexport const x = 1;\n`), {});
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('src/a.ts::// line 0');
    expect(errs[0]).toContain(`20 lines, limit ${LIMIT}`);
  });

  it('counts a JSDoc block and keys it by its first text line', () => {
    const body = `/**\n * Why this exists.\n${' * more\n'.repeat(20)} */\nexport const x = 1;\n`;
    expect(problems(tree(body), {})[0]).toContain('src/a.ts::Why this exists.');
  });

  it('counts a JSDoc that mentions a glob and keys on a short first line', () => {
    const body = `/**\n * ok.\n * see src/**/*.ts\n${' * more\n'.repeat(20)} */\n`;
    const errs = problems(tree(body), {});
    expect(errs[0]).toContain('src/a.ts::ok.');
    expect(errs[0]).toContain('24 lines');
  });

  it('does not join comment runs split by code or a blank line', () => {
    const body = `${block(10)}\n\n${block(10)}\nconst y = 1;\n${block(10)}\n`;
    expect(problems(tree(body), {})).toEqual([]);
  });

  it('passes an allowlisted block at its recorded length', () => {
    const root = tree(`${block(20)}\n`);
    expect(problems(root, { 'src/a.ts::// line 0': 20 })).toEqual([]);
  });

  it('fails when an allowlisted block grows', () => {
    const root = tree(`${block(21)}\n`);
    const errs = problems(root, { 'src/a.ts::// line 0': 20 });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('grew from 20 to 21');
  });

  it('survives lines added above an allowlisted block', () => {
    const root = tree(`const a = 1;\nconst b = 2;\n${block(20)}\n`);
    expect(problems(root, { 'src/a.ts::// line 0': 20 })).toEqual([]);
  });

  it('flags a stale entry and a shrunk one', () => {
    const stale = problems(tree('const a = 1;\n'), { 'src/a.ts::// line 0': 20 });
    expect(stale[0]).toContain('stale entry');
    const shrunk = problems(tree(`${block(17)}\n`), { 'src/a.ts::// line 0': 20 });
    expect(shrunk[0]).toContain('shrank to 17');
  });
});
