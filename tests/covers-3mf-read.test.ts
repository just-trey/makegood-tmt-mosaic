import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  read3MFIndexed,
  read3MFObjectsByColor,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by vite-node, not bundled)
} from '../scripts/lib/zonebake.mjs';

// The covers file is a whole-assembly CAD export, and the bake tells its reference bodies from its
// cover bodies by colour alone. So the two things this reader can get wrong are both silent: a
// merged body (one object swallowing its neighbour's mesh) and a mis-resolved colour (a reference
// body filed as a cover, which then starts hiding surface nobody asked to hide).
//
// Hand-built XML rather than a fixture file: every case here is a writer variation the shipped
// stubs/dead-zones.3mf happens not to use, which is exactly why nothing caught them.

async function make3MF(resources: string, build = ''): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '3D/3dmodel.model',
    `<?xml version="1.0" encoding="utf-8"?>
<model unit="millimeter" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>${resources}</resources>
  <build>${build}</build>
</model>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A unit cube's worth of mesh at `x0`, as the 8 vertices and 2 triangles a reader must keep apart. */
const mesh = (x0: number): string =>
  `<mesh><vertices>` +
  [0, 1, 2, 3].map((i) => `<vertex x="${x0 + i}" y="${i}" z="0"/>`).join('') +
  `</vertices><triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="2" v3="3"/>` +
  `</triangles></mesh>`;

const group = (id: number, ...colors: string[]): string =>
  `<m:colorgroup id="${id}">${colors.map((c) => `<m:color color="${c}"/>`).join('')}</m:colorgroup>`;

describe('read3MFIndexed', () => {
  // This one already read self-closing objects correctly; read3MFObjectsByColor had drifted from
  // it. Pinned here so the shared scanner both now use cannot regress on the arm only one needed.
  it('does not let a self-closing <object/> merge two bodies into one', async () => {
    const buf = await make3MF(
      `<object id="1" type="model">${mesh(0)}</object>` +
        `<object id="2" type="other"/>` +
        `<object id="3" type="model">${mesh(100)}</object>`,
    );
    const { verts, tris } = await read3MFIndexed(buf);
    // 4 + 4, and the second body's triangles index its OWN vertices: a swallowed body reads as
    // one object with 8 vertices and only the first object's 2 triangles.
    expect(verts).toHaveLength(8);
    expect(tris).toHaveLength(4);
    expect(verts[4][0]).toBe(100);
    expect(tris[2]).toEqual([4, 5, 6]);
  });
});

describe('read3MFObjectsByColor', () => {
  it('resolves a colorgroup whose id is not the last attribute', async () => {
    const buf = await make3MF(
      `<m:colorgroup displaypropertiesid="7" id="2"><m:color color="#aabbccff"/></m:colorgroup>` +
        `<object id="1" pid="2" pindex="0">${mesh(0)}</object>`,
    );
    const objs = await read3MFObjectsByColor(buf, 'x.3mf');
    expect(objs).toHaveLength(1);
    expect(objs[0].color).toBe('#AABBCCFF');
  });

  it('honours pindex when one group holds several colours', async () => {
    const buf = await make3MF(
      group(2, '#111111FF', '#222222FF', '#333333FF') +
        `<object id="1" pid="2" pindex="2">${mesh(0)}</object>` +
        `<object id="3" pid="2" pindex="0">${mesh(100)}</object>` +
        `<object id="5" pid="2">${mesh(200)}</object>`,
    );
    const objs = await read3MFObjectsByColor(buf, 'x.3mf');
    // the third omits pindex, which 3MF defaults to 0
    expect(objs.map((o: { color: string }) => o.color)).toEqual([
      '#333333FF',
      '#111111FF',
      '#111111FF',
    ]);
  });

  it('does not let a self-closing <object/> merge two bodies into one', async () => {
    const buf = await make3MF(
      group(2, '#111111FF') +
        group(4, '#222222FF') +
        `<object id="1" pid="2">${mesh(0)}</object>` +
        `<object id="3" type="other"/>` +
        `<object id="5" pid="4">${mesh(100)}</object>`,
    );
    const objs = await read3MFObjectsByColor(buf, 'x.3mf');
    expect(objs).toHaveLength(2);
    expect(objs.map((o: { color: string }) => o.color)).toEqual(['#111111FF', '#222222FF']);
    expect(objs[1].verts[0][0]).toBe(100);
  });

  it('refuses a body whose pid names no colorgroup, naming the file and the group', async () => {
    const buf = await make3MF(
      group(2, '#111111FF') + `<object id="9" pid="88">${mesh(0)}</object>`,
    );
    await expect(read3MFObjectsByColor(buf, 'covers.3mf')).rejects.toThrow(
      /covers\.3mf.*id=9.*pid="88"/s,
    );
  });

  it('refuses a body with no pid at all rather than filing it as a cover', async () => {
    const buf = await make3MF(group(2, '#111111FF') + `<object id="9">${mesh(0)}</object>`);
    await expect(read3MFObjectsByColor(buf, 'covers.3mf')).rejects.toThrow(
      /covers\.3mf.*id=9.*no pid/s,
    );
  });

  it('refuses a pindex past the end of its group', async () => {
    const buf = await make3MF(
      group(2, '#111111FF', '#222222FF') + `<object id="9" pid="2" pindex="5">${mesh(0)}</object>`,
    );
    await expect(read3MFObjectsByColor(buf, 'covers.3mf')).rejects.toThrow(
      /covers\.3mf.*id=9.*colour 5.*holds 2/s,
    );
  });

  it('refuses a body that colours its triangles individually', async () => {
    const buf = await make3MF(
      group(2, '#111111FF', '#222222FF') +
        `<object id="9" pid="2"><mesh><vertices>` +
        `<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>` +
        `</vertices><triangles>` +
        `<triangle v1="0" v2="1" v3="2" pid="2" p1="1"/>` +
        `</triangles></mesh></object>`,
    );
    await expect(read3MFObjectsByColor(buf, 'covers.3mf')).rejects.toThrow(
      /covers\.3mf.*id=9.*per triangle/s,
    );
  });

  it('still refuses a file whose bodies are placed by transform', async () => {
    const buf = await make3MF(
      group(2, '#111111FF') + `<object id="1" pid="2">${mesh(0)}</object>`,
      `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>`,
    );
    await expect(read3MFObjectsByColor(buf, 'covers.3mf')).rejects.toThrow(/transform/);
  });
});
