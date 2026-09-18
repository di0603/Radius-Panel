/**
 * NT-Password = MD4(password en UTF-16LE), en hexadecimal mayusculas.
 *
 * Node con OpenSSL 3 ya no expone MD4, asi que se implementa aqui (RFC 1320).
 * Solo se usa para el atributo NT-Password de FreeRADIUS (MSCHAPv2).
 */

function toUtf16le(str: string): Buffer {
  const buf = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) buf.writeUInt16LE(str.charCodeAt(i), i * 2);
  return buf;
}

function rotl(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n));
}

function md4(input: Buffer): Buffer {
  const msgLenBits = input.length * 8;
  // padding
  const withOne = Buffer.concat([input, Buffer.from([0x80])]);
  let padLen = (56 - (withOne.length % 64) + 64) % 64;
  const padded = Buffer.concat([withOne, Buffer.alloc(padLen), Buffer.alloc(8)]);
  padded.writeUInt32LE(msgLenBits >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor(msgLenBits / 0x100000000), padded.length - 4);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let off = 0; off < padded.length; off += 64) {
    const x = new Array<number>(16);
    for (let i = 0; i < 16; i++) x[i] = padded.readUInt32LE(off + i * 4);

    const aa = a,
      bb = b,
      cc = c,
      dd = d;

    const f = (X: number, Y: number, Z: number) => (X & Y) | (~X & Z);
    const g = (X: number, Y: number, Z: number) => (X & Y) | (X & Z) | (Y & Z);
    const h = (X: number, Y: number, Z: number) => X ^ Y ^ Z;

    // Ronda 1
    const r1 = [3, 7, 11, 19];
    for (let i = 0; i < 16; i++) {
      const k = i;
      const s = r1[i % 4];
      const sum = (a + f(b, c, d) + x[k]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = rotl(sum, s) >>> 0;
    }
    // Ronda 2
    const r2 = [3, 5, 9, 13];
    const o2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    for (let i = 0; i < 16; i++) {
      const k = o2[i];
      const s = r2[i % 4];
      const sum = (a + g(b, c, d) + x[k] + 0x5a827999) >>> 0;
      a = d;
      d = c;
      c = b;
      b = rotl(sum, s) >>> 0;
    }
    // Ronda 3
    const r3 = [3, 9, 11, 15];
    const o3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    for (let i = 0; i < 16; i++) {
      const k = o3[i];
      const s = r3[i % 4];
      const sum = (a + h(b, c, d) + x[k] + 0x6ed9eba1) >>> 0;
      a = d;
      d = c;
      c = b;
      b = rotl(sum, s) >>> 0;
    }

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0);
  out.writeUInt32LE(b, 4);
  out.writeUInt32LE(c, 8);
  out.writeUInt32LE(d, 12);
  return out;
}

export function ntPasswordHash(plain: string): string {
  return md4(toUtf16le(plain)).toString('hex').toUpperCase();
}
