import { describe, expect, it } from "vitest";
import { checkJpeg, checkPng, checkWebp, decodeUtf8Log, sanitizeFilename } from "../../src/attachments-check";
import { ApiError } from "../../src/http";
import { jpeg, png, webp } from "../fixtures/images";

const enc = new TextEncoder();
function code(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : "other";
  }
}

describe("PNG", () => {
  it("accepts a clean PNG", () => expect(code(() => checkPng(png()))).toBeNull());
  it("accepts harmless ancillary chunks", () => expect(code(() => checkPng(png([["pHYs", new Uint8Array(9)]])))).toBeNull());
  for (const t of ["tEXt", "iTXt", "zTXt", "eXIf"]) {
    it(`rejects ${t}`, () => expect(code(() => checkPng(png([[t, enc.encode("Author\0me")]])))).toBe("400:bad_attachment"));
  }
  it("rejects wrong magic", () => expect(code(() => checkPng(jpeg()))).toBe("400:bad_attachment"));
  it("rejects truncated", () => expect(code(() => checkPng(png().slice(0, 30)))).toBe("400:bad_attachment"));
});

describe("JPEG", () => {
  it("accepts JFIF without APP1", () => expect(code(() => checkJpeg(jpeg()))).toBeNull());
  it("rejects APP1 (EXIF/XMP)", () => expect(code(() => checkJpeg(jpeg({ app1: true })))).toBe("400:bad_attachment"));
  it("rejects wrong magic", () => expect(code(() => checkJpeg(png()))).toBe("400:bad_attachment"));
});

describe("WebP", () => {
  it("accepts a clean WebP", () => expect(code(() => checkWebp(webp()))).toBeNull());
  it("rejects EXIF", () => expect(code(() => checkWebp(webp(["EXIF"])))).toBe("400:bad_attachment"));
  it("rejects XMP", () => expect(code(() => checkWebp(webp(["XMP "])))).toBe("400:bad_attachment"));
  it("rejects wrong magic", () => expect(code(() => checkWebp(enc.encode("RIFF0000WAVEfmt ")))).toBe("400:bad_attachment"));
});

describe("logs and filenames", () => {
  it("valid UTF-8 (incl. Chinese) decodes", () => expect(decodeUtf8Log(enc.encode("錯誤：crash"))).toBe("錯誤：crash"));
  it("invalid UTF-8 is rejected", () =>
    expect(code(() => decodeUtf8Log(new Uint8Array([0x61, 0xff, 0xfe])))).toBe("400:bad_attachment"));
  it("filenames lose path parts and control characters", () => {
    expect(sanitizeFilename("..\\..\\evil\u0007.png")).toBe("evil.png");
    expect(sanitizeFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeFilename(null)).toBe("attachment");
    expect(sanitizeFilename("%E6%88%AA%E5%9C%96.png")).toBe("截圖.png");
    expect(code(() => sanitizeFilename("a".repeat(101)))).toBe("400:too_long");
  });
});
