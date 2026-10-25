/** ZIP archives (stored and deflated entries) without dependencies: a central-directory reader and RFC 1951 inflate. */

export function unzip(buf: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // end of central directory: the last "PK\x05\x06"
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip archive');
  const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    const lnl = dv.getUint16(off + 26, true), lxl = dv.getUint16(off + 28, true);
    const data = buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
    if (method === 0) out.set(name, data.slice());
    else if (method === 8) out.set(name, inflateRaw(data, usize));
    else throw new Error(`${name}: zip method ${method} not supported`);
  }
  return out;
}

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huff { counts: Uint16Array; symbols: Uint16Array }
function huff(lengths: ArrayLike<number>, n: number): Huff {
  const counts = new Uint16Array(16), offs = new Uint16Array(16), symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

/** Raw DEFLATE decompression (no zlib header). */
export function inflateRaw(src: Uint8Array, sizeHint = 0): Uint8Array {
  let out = new Uint8Array(Math.max(1024, sizeHint || src.length * 4)), op = 0;
  let bp = 0, bitbuf = 0, bitcnt = 0;
  const need = (n: number) => { while (bitcnt < n) { if (bp >= src.length) throw new Error('inflate: unexpected end of data'); bitbuf |= src[bp++] << bitcnt; bitcnt += 8; } };
  const bits = (n: number) => { need(n); const v = bitbuf & ((1 << n) - 1); bitbuf >>>= n; bitcnt -= n; return v; };
  const ensure = (n: number) => { if (op + n <= out.length) return; let len = out.length * 2; while (len < op + n) len *= 2; const o = new Uint8Array(len); o.set(out.subarray(0, op)); out = o; };
  const decode = (h: Huff) => { let code = 0, first = 0, index = 0; for (let len = 1; len < 16; len++) { code |= bits(1); const c = h.counts[len]; if (code - c < first) return h.symbols[index + (code - first)]; index += c; first += c; first <<= 1; code <<= 1; } throw new Error('inflate: bad code'); };
  let fixedL: Huff | null = null, fixedD: Huff | null = null;
  for (;;) {
    const last = bits(1), type = bits(2);
    if (type === 0) {
      bitbuf = 0; bitcnt = 0;
      const len = src[bp] | (src[bp + 1] << 8); bp += 4;
      ensure(len); out.set(src.subarray(bp, bp + len), op); op += len; bp += len;
    } else {
      let lh: Huff, dh: Huff;
      if (type === 1) {
        if (!fixedL) { const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288); fixedL = huff(l, 288); const d = new Uint8Array(30).fill(5); fixedD = huff(d, 30); }
        lh = fixedL; dh = fixedD!;
      } else if (type === 2) {
        const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        const cl = new Uint8Array(19); for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
        const ch = huff(cl, 19);
        const lens = new Uint8Array(nlen + ndist);
        for (let i = 0; i < nlen + ndist;) {
          const sym = decode(ch);
          if (sym < 16) lens[i++] = sym;
          else { let rep = 0, val = 0; if (sym === 16) { if (!i) throw new Error('inflate: repeat with no length'); val = lens[i - 1]; rep = 3 + bits(2); } else if (sym === 17) rep = 3 + bits(3); else rep = 11 + bits(7); while (rep--) lens[i++] = val; }
        }
        lh = huff(lens.subarray(0, nlen), nlen); dh = huff(lens.subarray(nlen), ndist);
      } else throw new Error('inflate: bad block type');
      for (;;) {
        const sym = decode(lh);
        if (sym < 256) { ensure(1); out[op++] = sym; }
        else if (sym === 256) break;
        else {
          const s = sym - 257; const len = LBASE[s] + bits(LEXT[s]);
          const ds = decode(dh); const dist = DBASE[ds] + bits(DEXT[ds]);
          ensure(len); for (let k = 0; k < len; k++) { out[op] = out[op - dist]; op++; }
        }
      }
    }
    if (last) break;
  }
  return out.subarray(0, op);
}
