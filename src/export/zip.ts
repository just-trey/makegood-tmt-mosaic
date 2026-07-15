export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Synchronous STORE-only (uncompressed) ZIP writer. JSZip's generateAsync pumps its worker
 * through nested setTimeout(0) calls, which browsers clamp to a 4ms floor — so a multi-megabyte
 * archive drags out to a minute+ regardless of input form. A 3MF is just a STORE zip, so we
 * assemble the bytes directly in one pass instead. Names are declared UTF-8 (flag bit 11).
 */
export function zipStore(files: ZipEntry[]): Blob {
  const enc = new TextEncoder();
  const LOCAL = 30,
    CENTRAL = 46,
    EOCD = 22,
    FLAG = 0x0800; // language-encoding flag: names are UTF-8
  const entries = files.map((f) => {
    const nameBytes = enc.encode(f.name);
    return { nameBytes, data: f.data, crc: crc32(f.data), offset: 0 };
  });

  let localSize = 0;
  for (const e of entries) localSize += LOCAL + e.nameBytes.length + e.data.length;
  let centralSize = 0;
  for (const e of entries) centralSize += CENTRAL + e.nameBytes.length;
  const total = localSize + centralSize + EOCD;

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let o = 0;

  for (const e of entries) {
    e.offset = o;
    dv.setUint32(o, 0x04034b50, true); // local file header signature
    dv.setUint16(o + 4, 20, true); // version needed
    dv.setUint16(o + 6, FLAG, true);
    dv.setUint16(o + 8, 0, true); // method: STORE
    dv.setUint16(o + 10, 0, true); // mod time
    dv.setUint16(o + 12, 0x21, true); // mod date: 1980-01-01
    dv.setUint32(o + 14, e.crc, true);
    dv.setUint32(o + 18, e.data.length, true); // compressed size
    dv.setUint32(o + 22, e.data.length, true); // uncompressed size
    dv.setUint16(o + 26, e.nameBytes.length, true);
    dv.setUint16(o + 28, 0, true); // extra field length
    o += LOCAL;
    u8.set(e.nameBytes, o);
    o += e.nameBytes.length;
    u8.set(e.data, o);
    o += e.data.length;
  }

  const centralStart = o;
  for (const e of entries) {
    dv.setUint32(o, 0x02014b50, true); // central directory header signature
    dv.setUint16(o + 4, 20, true); // version made by
    dv.setUint16(o + 6, 20, true); // version needed
    dv.setUint16(o + 8, FLAG, true);
    dv.setUint16(o + 10, 0, true); // method: STORE
    dv.setUint16(o + 12, 0, true); // mod time
    dv.setUint16(o + 14, 0x21, true); // mod date
    dv.setUint32(o + 16, e.crc, true);
    dv.setUint32(o + 20, e.data.length, true);
    dv.setUint32(o + 24, e.data.length, true);
    dv.setUint16(o + 28, e.nameBytes.length, true);
    dv.setUint16(o + 30, 0, true); // extra length
    dv.setUint16(o + 32, 0, true); // comment length
    dv.setUint16(o + 34, 0, true); // disk number start
    dv.setUint16(o + 36, 0, true); // internal attributes
    dv.setUint32(o + 38, 0, true); // external attributes
    dv.setUint32(o + 42, e.offset, true); // local header offset
    o += CENTRAL;
    u8.set(e.nameBytes, o);
    o += e.nameBytes.length;
  }

  dv.setUint32(o, 0x06054b50, true); // end of central directory signature
  dv.setUint16(o + 4, 0, true); // disk number
  dv.setUint16(o + 6, 0, true); // disk with central directory
  dv.setUint16(o + 8, entries.length, true);
  dv.setUint16(o + 10, entries.length, true);
  dv.setUint32(o + 12, centralSize, true);
  dv.setUint32(o + 16, centralStart, true);
  dv.setUint16(o + 20, 0, true); // comment length

  return new Blob([buf], { type: 'application/octet-stream' });
}
