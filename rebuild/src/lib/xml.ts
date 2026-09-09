/**
 * A small XML reader that runs the same in the browser and in node, so the SVG and 3MF readers
 * can be unit-tested without a DOM. It handles what real SVG and 3MF exporters write: elements,
 * attributes, text, comments, CDATA, processing instructions and a DOCTYPE. Entities are limited
 * to the five XML ones plus numeric references, which covers every file we have seen.
 */
export interface XmlNode {
  name: string;
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
  parent: XmlNode | null;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function localName(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#root', local: '#root', attrs: {}, children: [], text: '', parent: null };
  let cur = root;
  let i = 0;
  const n = src.length;
  const attrRe = /([^\s=\/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      cur.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) cur.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      cur.text += src.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end < 0 ? n : end).trim();
      // Tolerate a stray close tag rather than throwing away the whole file.
      let up: XmlNode | null = cur;
      while (up && up.name !== name) up = up.parent;
      if (up && up.parent) cur = up.parent;
      i = end < 0 ? n : end + 1;
      continue;
    }
    // Opening tag: find its end, respecting quoted attribute values.
    let j = lt + 1;
    let quote: string | null = null;
    while (j < n) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const tag = src.slice(lt + 1, j);
    const selfClose = tag.endsWith('/');
    const body = selfClose ? tag.slice(0, -1) : tag;
    const sp = body.search(/[\s\/]/);
    const name = (sp < 0 ? body : body.slice(0, sp)).trim();
    const attrs: Record<string, string> = {};
    if (sp >= 0) {
      attrRe.lastIndex = 0;
      const rest = body.slice(sp);
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(rest))) {
        if (!m[1]) continue;
        attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
      }
    }
    const node: XmlNode = { name, local: localName(name), attrs, children: [], text: '', parent: cur };
    cur.children.push(node);
    if (!selfClose) cur = node;
    i = j + 1;
  }
  return root;
}

export function firstChild(node: XmlNode, local: string): XmlNode | undefined {
  return node.children.find((c) => c.local === local);
}

export function childrenNamed(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter((c) => c.local === local);
}

export function findAll(node: XmlNode, local: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.local === local) out.push(c);
    findAll(c, local, out);
  }
  return out;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string);
}
