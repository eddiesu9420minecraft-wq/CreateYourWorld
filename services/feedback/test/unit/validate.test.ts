import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/http";
import {
  charLength,
  countLinks,
  LOGIN_RE,
  normalizeForDuplicate,
  normalizeText,
  parseEnvironment,
  parseLabels,
  requireString,
} from "../../src/validate";

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : "other";
  }
}

describe("normalizeText", () => {
  it("NFC-normalises", () => {
    expect(normalizeText("Café")).toBe("Café");
  });
  it("strips control characters except \\n and \\t in multiline text", () => {
    expect(normalizeText("a\u0000b\u0007c\u001bd\u007fe\u0085f", { multiline: true })).toBe("abcdef");
    expect(normalizeText("line1\r\nline2\tx", { multiline: true })).toBe("line1\nline2\tx");
  });
  it("single-line text folds newlines", () => {
    expect(normalizeText("a\nb\tc")).toBe("a b c");
  });
});

describe("requireString", () => {
  it("length limits in code points", () => {
    expect(code(() => requireString({ t: "abcd" }, "t", 5, 120))).toBe("400:invalid_body");
    expect(code(() => requireString({ t: "x".repeat(121) }, "t", 5, 120))).toBe("400:too_long");
    expect(requireString({ t: "  當機了！！  " }, "t", 5, 120)).toBe("當機了！！");
    expect(charLength("😀😀😀😀😀")).toBe(5);
    expect(code(() => requireString({ t: 5 }, "t", 1, 2))).toBe("400:invalid_body");
  });
});

describe("misc", () => {
  it("counts links", () => {
    expect(countLinks("see https://a.test and http://b.test and www.c.test")).toBe(3);
    expect(countLinks("no links here")).toBe(0);
  });
  it("duplicate normalisation", () => {
    expect(normalizeForDuplicate("  Hello\n\nWORLD  ")).toBe("hello world");
  });
  it("environment: known string fields only", () => {
    expect(parseEnvironment({ os: "windows", extra: "x", arch: "x86_64" })).toEqual({ os: "windows", arch: "x86_64" });
    expect(code(() => parseEnvironment({ os: 5 }))).toBe("400:invalid_body");
    expect(code(() => parseEnvironment("windows"))).toBe("400:invalid_body");
    expect(code(() => parseEnvironment({ os: "x".repeat(101) }))).toBe("400:too_long");
  });
  it("labels", () => {
    expect(parseLabels(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(code(() => parseLabels(new Array(21).fill("x")))).toBe("400:invalid_body");
    expect(code(() => parseLabels([""]))).toBe("400:invalid_body");
  });
  it("GitHub login syntax", () => {
    expect(LOGIN_RE.test("eddiesu9420minecraft-wq")).toBe(true);
    expect(LOGIN_RE.test("-bad")).toBe(false);
    expect(LOGIN_RE.test("a--b")).toBe(false);
    expect(LOGIN_RE.test("x".repeat(40))).toBe(false);
    expect(LOGIN_RE.test("../etc")).toBe(false);
  });
});
