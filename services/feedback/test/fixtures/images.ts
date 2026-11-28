// Minimal synthetic image files for attachment tests (structure only; pixel data is irrelevant to the checks).

const enc = new TextEncoder();
export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32be = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u32le = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

function pngChunk(type: string, data: Uint8Array) {
  return concat(u32be(data.length), enc.encode(type), data, new Uint8Array(4) /* CRC (not checked) */);
}

export function png(extraChunks: [string, Uint8Array][] = [], opts: { idatSize?: number } = {}) {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk("IHDR", concat(u32be(1), u32be(1), new Uint8Array([8, 6, 0, 0, 0])));
  const extras = extraChunks.map(([t, d]) => pngChunk(t, d));
  const idat = pngChunk("IDAT", new Uint8Array(opts.idatSize ?? 12));
  return concat(sig, ihdr, ...extras, idat, pngChunk("IEND", new Uint8Array(0)));
}

function jpegSegment(marker: number, data: Uint8Array) {
  const len = data.length + 2;
  return concat(new Uint8Array([0xff, marker, (len >> 8) & 255, len & 255]), data);
}

export function jpeg(opts: { app1?: boolean } = {}) {
  const soi = new Uint8Array([0xff, 0xd8]);
  const app0 = jpegSegment(0xe0, concat(enc.encode("JFIF\0"), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0])));
  const app1 = opts.app1 ? [jpegSegment(0xe1, concat(enc.encode("Exif\0\0"), new Uint8Array(20)))] : [];
  const dqt = jpegSegment(0xdb, new Uint8Array(65));
  const sos = jpegSegment(0xda, new Uint8Array(10));
  const scan = new Uint8Array([0x12, 0x34, 0x56]);
  const eoi = new Uint8Array([0xff, 0xd9]);
  return concat(soi, app0, ...app1, dqt, sos, scan, eoi);
}

function riffChunk(fourcc: string, data: Uint8Array) {
  const pad = data.length & 1 ? new Uint8Array(1) : new Uint8Array(0);
  return concat(enc.encode(fourcc), u32le(data.length), data, pad);
}

export function webp(extra: string[] = []) {
  const chunks = [
    riffChunk("VP8X", new Uint8Array(10)),
    ...extra.map((f) => riffChunk(f, new Uint8Array(7))),
    riffChunk("VP8L", new Uint8Array(9)),
  ];
  const payload = concat(enc.encode("WEBP"), ...chunks);
  return concat(enc.encode("RIFF"), u32le(payload.length), payload);
}
