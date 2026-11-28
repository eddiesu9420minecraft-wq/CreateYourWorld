// Attachments and the environment block: who can read them, sizes, types, metadata, caps.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MiB } from "../../src/attachments-check";
import { BOOTSTRAP_MAINTAINER, call, callJson, createFeedback, login, serviceToken, type Session } from "../helpers";
import { jpeg, png, webp } from "../fixtures/images";

let author: Session;
let stranger: Session;
let dev: Session;
let maint: Session;
let agent: string;
let cyws: string;

beforeEach(async () => {
  author = await login("user");
});

beforeAll(async () => {

  stranger = await login("user");
  dev = await login("developer");
  maint = await login("maintainer", BOOTSTRAP_MAINTAINER);
  agent = await serviceToken(maint, "agent");
  cyws = await serviceToken(maint, "cyws");
});

function upload(token: string | undefined, fbId: string, type: string, data: BodyInit, filename = "file.bin") {
  return callJson("POST", `/v1/feedback/${fbId}/attachments`, {
    token,
    rawBody: data,
    headers: { "Content-Type": type, "X-Filename": filename },
  });
}

describe("environment block and attachments are private to the author and developer+", () => {
  it("environment visibility", async () => {
    const fb = await createFeedback(author);
    const see = async (token?: string) => (await callJson("GET", `/v1/feedback/${fb.id}`, { token })).body.feedback;
    expect((await see(author.token)).environment).not.toBeNull();
    expect((await see(dev.token)).environment).not.toBeNull();
    expect((await see(maint.token)).environment).not.toBeNull();
    for (const t of [undefined, stranger.token, agent, cyws]) {
      const f = await see(t);
      expect(f.environment).toBeNull();
      expect(f.attachments).toEqual([]);
      expect(f.body).toBeTruthy(); // public fields still readable
    }
  });

  it("attachment download: author and developer+ only, with safe headers", async () => {
    const fb = await createFeedback(author);
    const up = await upload(author.token, fb.id, "image/png", png(), encodeURIComponent("截圖 1.png"));
    expect(up.status).toBe(201);
    const id = up.body.attachment.id;
    expect(up.body.attachment).toMatchObject({ filename: "截圖 1.png", content_type: "image/png" });

    const listed = await callJson("GET", `/v1/feedback/${fb.id}`, { token: author.token });
    expect(listed.body.feedback.attachments.map((a: any) => a.id)).toEqual([id]);

    for (const [token, status] of [
      [undefined, 401],
      [stranger.token, 403],
      [agent, 403],
      [cyws, 403],
    ] as const) {
      const r = await call("GET", `/v1/attachments/${id}`, { token });
      expect(r.status).toBe(status);
      await r.body?.cancel();
    }
    for (const token of [author.token, dev.token, maint.token]) {
      const r = await call("GET", `/v1/attachments/${id}`, { token });
      expect(r.status).toBe(200);
      expect(r.headers.get("Content-Type")).toBe("image/png");
      expect(r.headers.get("Content-Disposition")).toMatch(/^attachment; filename="__ 1.png"; filename\*=UTF-8''/);
      expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(r.headers.get("Content-Security-Policy")).toBe("sandbox");
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(png());
    }
    expect((await call("GET", `/v1/attachments/00000000-0000-0000-0000-000000000000`, { token: dev.token })).status).toBe(404);
  });

  it("only the author may upload, and not to a closed feedback", async () => {
    const fb = await createFeedback(author);
    for (const t of [stranger.token, dev.token]) {
      expect((await upload(t, fb.id, "image/png", png())).status).toBe(403);
    }
    for (const t of [agent, cyws]) {
      const r = await upload(t, fb.id, "image/png", png());
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("agent_forbidden");
    }
    expect((await upload(undefined, fb.id, "image/png", png())).status).toBe(401);
    await callJson("POST", `/v1/feedback/${fb.id}/close`, { token: author.token, body: { resolution: "completed" } });
    expect((await upload(author.token, fb.id, "image/png", png())).status).toBe(403);
  });
});

describe("attachment checks", () => {
  it("wrong type → 415", async () => {
    const fb = await createFeedback(author);
    for (const type of ["image/gif", "application/pdf", "text/html", "image/svg+xml", "", "application/octet-stream"]) {
      const r = await upload(author.token, fb.id, type, png());
      expect(r.status, type).toBe(415);
      expect(r.body.error.code).toBe("unsupported_type");
    }
  });

  it("magic bytes must match the declared type → 400 bad_attachment", async () => {
    const fb = await createFeedback(author);
    expect((await upload(author.token, fb.id, "image/png", jpeg())).body.error.code).toBe("bad_attachment");
    expect((await upload(author.token, fb.id, "image/jpeg", png())).body.error.code).toBe("bad_attachment");
    expect((await upload(author.token, fb.id, "image/webp", new TextEncoder().encode("<svg onload=alert(1)>"))).body.error.code).toBe(
      "bad_attachment",
    );
  });

  it("image metadata → 400 bad_attachment", async () => {
    const fb = await createFeedback(author);
    const enc = new TextEncoder();
    for (const chunk of ["tEXt", "iTXt", "zTXt", "eXIf"]) {
      const r = await upload(author.token, fb.id, "image/png", png([[chunk, enc.encode("GPS\0 25.03N 121.56E")]]));
      expect(r.status, chunk).toBe(400);
      expect(r.body.error.code).toBe("bad_attachment");
    }
    expect((await upload(author.token, fb.id, "image/jpeg", jpeg({ app1: true }))).body.error.code).toBe("bad_attachment");
    expect((await upload(author.token, fb.id, "image/webp", webp(["EXIF"]))).body.error.code).toBe("bad_attachment");
    expect((await upload(author.token, fb.id, "image/webp", webp(["XMP "]))).body.error.code).toBe("bad_attachment");
    // clean files are fine
    expect((await upload(author.token, fb.id, "image/jpeg", jpeg())).status).toBe(201);
    expect((await upload(author.token, fb.id, "image/webp", webp())).status).toBe(201);
  });

  it("too big → 413 (4 MiB images, 1 MiB logs)", async () => {
    const fb = await createFeedback(author);
    const bigPng = png([], { idatSize: 4 * MiB });
    const r = await upload(author.token, fb.id, "image/png", bigPng);
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("too_large");
    const bigLog = new Uint8Array(1 * MiB + 1).fill(0x61);
    expect((await upload(author.token, fb.id, "text/plain", bigLog)).status).toBe(413);
  });

  it("logs must be UTF-8 and are re-redacted before storing", async () => {
    const fb = await createFeedback(author);
    const bad = await upload(author.token, fb.id, "text/plain", new Uint8Array([0x68, 0x69, 0xff, 0xfe]));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("bad_attachment");
    const secret = "ghp_" + "L".repeat(36);
    const log = `2026-11-28 12:30:45 INFO start\nGITHUB_TOKEN=${secret}\nhome C:\\Users\\Eddie\\AppData\n錯誤：存檔失敗\n`;
    const up = await upload(author.token, fb.id, "text/plain; charset=utf-8", log, "cyw.log");
    expect(up.status).toBe(201);
    const dl = await call("GET", `/v1/attachments/${up.body.attachment.id}`, { token: dev.token });
    expect(dl.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const text = await dl.text();
    expect(text).not.toContain(secret);
    expect(text).toContain("GITHUB_TOKEN=[REDACTED:token]");
    expect(text).toContain("home <home>\\AppData");
    expect(text).toContain("2026-11-28 12:30:45 INFO start");
    expect(text).toContain("錯誤：存檔失敗");
    expect(up.body.attachment.size).toBe(new TextEncoder().encode(text).length);
  });

  it("at most 5 attachments per feedback", async () => {
    const fb = await createFeedback(author);
    for (let i = 0; i < 5; i++) expect((await upload(author.token, fb.id, "image/png", png(), `${i}.png`)).status).toBe(201);
    const r = await upload(author.token, fb.id, "image/png", png());
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("bad_attachment");
  });

  it("at most 8 MiB in total per feedback → 413", async () => {
    const fb = await createFeedback(author);
    const near4 = png([], { idatSize: 4 * MiB - 200 });
    expect((await upload(author.token, fb.id, "image/png", near4)).status).toBe(201);
    expect((await upload(author.token, fb.id, "image/png", near4)).status).toBe(201);
    const r = await upload(author.token, fb.id, "image/png", png([], { idatSize: 1024 }));
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("too_large");
  });

  it("filename limits", async () => {
    const fb = await createFeedback(author);
    const r = await upload(author.token, fb.id, "image/png", png(), "x".repeat(101) + ".png");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("too_long");
    const p = await upload(author.token, fb.id, "image/png", png(), "../../etc/passwd");
    expect(p.body.attachment.filename).toBe("passwd");
  });
});
