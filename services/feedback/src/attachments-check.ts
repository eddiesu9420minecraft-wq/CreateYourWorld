// Attachment content checks: magic bytes, image metadata (rejected, the client strips it), UTF-8 logs.
import { ApiError } from "./http";

export const MiB = 1024 * 1024;

export const ATTACHMENT_TYPES: Record<string, { max: number }> = {
  "image/png": { max: 4 * MiB },
  "image/jpeg": { max: 4 * MiB },
  "image/webp": { max: 4 * MiB },
  "text/plain": { max: 1 * MiB },
};
export const MAX_ATTACHMENTS = 5;
export const MAX_TOTAL_BYTES = 8 * MiB;

const bad = (msg: string) => new ApiError(400, "bad_attachment", msg);

const ascii = (b: Uint8Array, off: number, len: number) => String.fromCharCode(...b.subarray(off, off + len));
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u32le = (b: Uint8Array, o: number) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + ((b[o + 3] << 24) >>> 0);

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_FORBIDDEN = new Set(["tEXt", "iTXt", "zTXt", "eXIf"]);

export function checkPng(b: Uint8Array): void {
  if (b.length < 8 || PNG_SIG.some((v, i) => b[i] !== v)) throw bad("not a PNG file");
  let off = 8;
  let sawEnd = false;
  while (off < b.length) {
    if (off + 8 > b.length) throw bad("truncated PNG chunk");
    const len = u32be(b, off);
    const type = ascii(b, off + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) throw bad("malformed PNG chunk");
    if (PNG_FORBIDDEN.has(type)) throw bad(`PNG contains a ${type} metadata chunk; remove metadata before uploading`);
    const next = off + 12 + len;
    if (next > b.length) throw bad("truncated PNG chunk");
    off = next;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw bad("PNG has no IEND chunk");
}

export function checkJpeg(b: Uint8Array): void {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) throw bad("not a JPEG file");
  let off = 2;
  while (off < b.length) {
    if (b[off] !== 0xff) throw bad("malformed JPEG segment");
    // skip fill bytes
    while (off < b.length && b[off] === 0xff) off++;
    if (off >= b.length) throw bad("truncated JPEG");
    const marker = b[off];
    off++;
    if (marker === 0xd9) return; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone markers
    if (off + 2 > b.length) throw bad("truncated JPEG segment");
    const len = (b[off] << 8) + b[off + 1];
    if (len < 2 || off + len > b.length) throw bad("truncated JPEG segment");
    if (marker === 0xe1) throw bad("JPEG contains an APP1 (EXIF/XMP) segment; remove metadata before uploading");
    off += len;
    if (marker === 0xda) return; // start of scan: entropy-coded data follows, metadata segments precede it
  }
  throw bad("truncated JPEG");
}

export function checkWebp(b: Uint8Array): void {
  if (b.length < 12 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") throw bad("not a WebP file");
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
  let off = 12;
  while (off + 8 <= riffEnd) {
    const fourcc = ascii(b, off, 4);
    const len = u32le(b, off + 4);
    if (fourcc === "EXIF" || fourcc === "XMP ") {
      throw bad(`WebP contains a ${fourcc.trim()} chunk; remove metadata before uploading`);
    }
    const next = off + 8 + len + (len & 1);
    if (next > riffEnd + 1) throw bad("truncated WebP chunk");
    off = next;
  }
}

/** Decodes a log as strict UTF-8 (a leading BOM is dropped). */
export function decodeUtf8Log(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);
  } catch {
    throw bad("text/plain attachments must be valid UTF-8");
  }
}

export function checkImage(contentType: string, b: Uint8Array): void {
  if (contentType === "image/png") checkPng(b);
  else if (contentType === "image/jpeg") checkJpeg(b);
  else if (contentType === "image/webp") checkWebp(b);
}

/** Cleans an X-Filename value: no path parts, no control characters, ≤ 100 chars. */
export function sanitizeFilename(raw: string | null): string {
  if (raw === null || raw.trim() === "") return "attachment";
  if ([...raw].length > 300) throw new ApiError(400, "too_long", "X-Filename must be at most 100 characters");
  let name = raw;
  try {
    // clients may percent-encode non-ASCII names
    if (/%[0-9A-Fa-f]{2}/.test(name)) name = decodeURIComponent(name);
  } catch {
    /* keep raw */
  }
  // eslint-disable-next-line no-control-regex
  name = name.normalize("NFC").replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.replace(/["<>|:*?]/g, "_").trim();
  if (name === "" || name === "." || name === "..") name = "attachment";
  if ([...name].length > 100) throw new ApiError(400, "too_long", "X-Filename must be at most 100 characters");
  return name;
}
