// Input abuse: consent, honeypot, links, duplicates, rate limits, bans, oversized bodies, production mode.
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/crypto";
import { BOOTSTRAP_MAINTAINER, call, callJson, createFeedback, env, feedbackBody, login, randomIp, uniq } from "../helpers";

describe("dev auth", () => {
  it("POST /v1/auth/dev is 404 when ENVIRONMENT=production (and for any other value)", async () => {
    for (const ENVIRONMENT of ["production", "staging", ""]) {
      const r = await callJson("POST", "/v1/auth/dev", { body: { login: uniq(), role: "maintainer" }, env: { ENVIRONMENT } });
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("not_found");
    }
  });
});

describe("feedback creation rules", () => {
  it("consent.content missing or false → 400 consent_required", async () => {
    for (const consent of [undefined, null, {}, { content: false, preview_sha256: "a".repeat(64) }, { content: "true", preview_sha256: "a".repeat(64) }]) {
      const s = await login(); // each attempt counts against feedback.create (5/hour)
      const r = await callJson("POST", "/v1/feedback", { token: s.token, body: feedbackBody({ consent }) });
      expect(r.status, JSON.stringify(consent)).toBe(400);
      expect(r.body.error.code).toBe("consent_required");
    }
    const s = await login();
    const noHash = await callJson("POST", "/v1/feedback", { token: s.token, body: feedbackBody({ consent: { content: true, environment: true } }) });
    expect(noHash.body.error.code).toBe("consent_required");
  });

  it("environment without consent.environment → 400; omitted environment is stored as null", async () => {
    const s = await login();
    const r = await callJson("POST", "/v1/feedback", {
      token: s.token,
      body: feedbackBody({ consent: { content: true, environment: false, preview_sha256: "a".repeat(64) } }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("consent_required");
    const ok = await callJson("POST", "/v1/feedback", {
      token: s.token,
      body: feedbackBody({ environment: null, consent: { content: true, environment: false, preview_sha256: "a".repeat(64) } }),
    });
    expect(ok.status).toBe(201);
    expect(ok.body.feedback.environment).toBeNull();
  });

  it("honeypot website → 400 invalid_body", async () => {
    const s = await login();
    const r = await callJson("POST", "/v1/feedback", { token: s.token, body: feedbackBody({ website: "http://spam.example" }) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_body");
  });

  it("more than 5 links → 400 too_many_links (5 is fine)", async () => {
    const s = await login();
    const links = (n: number) => Array.from({ length: n }, (_, i) => `https://l${i}.example`).join(" ");
    const bad = await callJson("POST", "/v1/feedback", { token: s.token, body: feedbackBody({ body: `see ${links(6)}` }) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("too_many_links");
    const ok = await callJson("POST", "/v1/feedback", { token: s.token, body: feedbackBody({ body: `see ${links(5)}` }) });
    expect(ok.status).toBe(201);
  });

  it("same normalised body by the same user within 24 h → 409 duplicate", async () => {
    const s = await login();
    const body = `Duplicate body text ${uniq()}`;
    expect((await callJson("POST", "/v1/feedback", { token: s.token, body: feedbackBody({ body }) })).status).toBe(201);
    const dup = await callJson("POST", "/v1/feedback", { token: s.token, body: feedbackBody({ body: `  ${body.toUpperCase()}\n` }) });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("duplicate");
    // another user may send the same text
    const other = await login();
    expect((await callJson("POST", "/v1/feedback", { token: other.token, body: feedbackBody({ body }) })).status).toBe(201);
  });

  it("unknown product, bad category, short/long fields → 400", async () => {
    const s = await login();
    const cases: [Record<string, unknown>, string][] = [
      [{ product: "NotAProduct" }, "invalid_body"],
      [{ product: "__proto__" }, "invalid_body"],
      [{ category: "rant" }, "invalid_body"],
      [{ title: "hey" }, "invalid_body"],
      [{ title: "x".repeat(121) }, "too_long"],
      [{ body: "short" }, "invalid_body"],
      [{ body: "x".repeat(8001) }, "too_long"],
    ];
    for (const [o, code] of cases) {
      const u = await login(); // each attempt counts against feedback.create (5/hour)
      const r = await callJson("POST", "/v1/feedback", { token: u.token, body: feedbackBody(o) });
      expect(r.status, JSON.stringify(o)).toBe(400);
      expect(r.body.error.code).toBe(code);
    }
  });

  it("GitHub accounts younger than 7 days: 1 feedback per day", async () => {
    const s = await login("user", undefined, { github_created_at: Math.floor(Date.now() / 1000) - 2 * 86400 });
    expect((await callJson("POST", "/v1/feedback", { token: s.token, body: feedbackBody() })).status).toBe(201);
    const second = await callJson("POST", "/v1/feedback", { token: s.token, body: feedbackBody() });
    expect(second.status).toBe(429);
    expect(Number(second.res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("server re-redacts secrets a malicious client sent unredacted", async () => {
    const s = await login();
    const secret = "ghp_" + "Q".repeat(36);
    const r = await callJson("POST", "/v1/feedback", {
      token: s.token,
      body: feedbackBody({
        title: `Leak ${secret}`,
        body: `my token ${secret}\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\npassword=hunter2 ssh C:\\Users\\Bob\\.ssh\\id_rsa ip 192.168.0.12`,
        environment: { os_version: "Windows 11 user bob@example.com" },
      }),
    });
    expect(r.status).toBe(201);
    const json = JSON.stringify(r.body);
    expect(json).not.toContain(secret);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(json).not.toContain("id_rsa");
    expect(json).not.toContain("192.168.0.12");
    expect(json).not.toContain("bob@example.com");
    expect(r.body.server_redactions).toBe(7);
    expect(r.body.feedback.title).toBe("Leak [REDACTED:token]");
    // comments too
    const c = await callJson("POST", `/v1/feedback/${r.body.feedback.id}/comments`, { token: s.token, body: { body: `again ${secret}` } });
    expect(c.body.comment.body).toBe("again [REDACTED:token]");
  });

  it("control characters are stripped and text is NFC-normalised", async () => {
    const s = await login();
    const r = await callJson("POST", "/v1/feedback", {
      token: s.token,
      body: feedbackBody({ title: "Cafe\u0301 \u0007bell\u202e title", body: `body\u0000 with\u001b[31m escape ${uniq()}` }),
    });
    expect(r.status).toBe(201);
    expect(r.body.feedback.title).toBe("Caf\u00e9 bell\u202e title");
    expect(r.body.feedback.body).not.toMatch(/[\u0000\u001b]/);
  });
});

describe("rate limits → 429 + Retry-After", () => {
  it("feedback.create: 5 per hour", async () => {
    const s = await login();
    for (let i = 0; i < 5; i++) await createFeedback(s);
    const r = await callJson("POST", "/v1/feedback", { token: s.token, body: feedbackBody() });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("rate_limited");
    expect(Number(r.res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("auth: 20 per 10 minutes per IP", async () => {
    const ip = randomIp();
    for (let i = 0; i < 20; i++) {
      expect((await callJson("POST", "/v1/auth/dev", { ip, body: { login: uniq() } })).status).toBe(200);
    }
    const r = await callJson("POST", "/v1/auth/dev", { ip, body: { login: uniq() } });
    expect(r.status).toBe(429);
    expect(Number(r.res.headers.get("Retry-After"))).toBeGreaterThan(0);
    // another IP is unaffected
    expect((await callJson("POST", "/v1/auth/dev", { body: { login: uniq() } })).status).toBe(200);
  });

  it("comment: 30 per hour", async () => {
    const s = await login();
    const fb = await createFeedback(s);
    for (let i = 0; i < 30; i++) {
      expect((await callJson("POST", `/v1/feedback/${fb.id}/comments`, { token: s.token, body: { body: `c${i}` } })).status).toBe(201);
    }
    const r = await callJson("POST", `/v1/feedback/${fb.id}/comments`, { token: s.token, body: { body: "one more" } });
    expect(r.status).toBe(429);
    expect(r.res.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  it("read: 600 per 10 minutes per IP", async () => {
    // Seed the fixed-window counter to 595 (600 sequential requests could straddle a window boundary).
    const ip = randomIp();
    const ipKey = (await sha256Hex(`cyw-feedback-ip:${ip}`)).slice(0, 32);
    const start = Math.floor(Date.now() / 1000 / 600) * 600;
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 595)")
      .bind(`read:600:ip:${ipKey}`, start)
      .run();
    for (let i = 0; i < 5; i++) expect((await call("GET", "/v1/feedback?per_page=1", { ip })).status).toBe(200);
    const r = await call("GET", "/v1/feedback?per_page=1", { ip });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(Number(r.headers.get("Retry-After"))).toBeLessThanOrEqual(600);
    // other IPs are unaffected
    expect((await call("GET", "/v1/feedback?per_page=1")).status).toBe(200);
  });
});

describe("bans and body limits", () => {
  it("banned users get 403 banned on every write, reads still work", async () => {
    const maint = await login("maintainer", BOOTSTRAP_MAINTAINER);
    const victim = await login();
    const fb = await createFeedback(victim);
    expect((await callJson("POST", `/v1/admin/bans/${victim.login}`, { token: maint.token, body: { reason: "spam" } })).status).toBe(200);
    const writes = [
      callJson("POST", "/v1/feedback", { token: victim.token, body: feedbackBody() }),
      callJson("POST", `/v1/feedback/${fb.id}/vote`, { token: victim.token }),
      callJson("POST", `/v1/feedback/${fb.id}/comments`, { token: victim.token, body: { body: "hi" } }),
      callJson("POST", `/v1/feedback/${fb.id}/close`, { token: victim.token, body: { resolution: "completed" } }),
      callJson("POST", `/v1/feedback/${fb.id}/subscription`, { token: victim.token }),
      call("POST", `/v1/feedback/${fb.id}/attachments`, { token: victim.token, rawBody: "log", headers: { "Content-Type": "text/plain" } }).then(
        async (r) => ({ status: r.status, body: await r.json<any>() }),
      ),
    ];
    for (const r of await Promise.all(writes)) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("banned");
    }
    expect((await callJson("GET", `/v1/feedback/${fb.id}`, { token: victim.token })).status).toBe(200);
    await callJson("DELETE", `/v1/admin/bans/${victim.login}`, { token: maint.token });
    expect((await callJson("POST", `/v1/feedback/${fb.id}/vote`, { token: victim.token })).status).toBe(200);
  });

  it("JSON bodies over 64 KiB → 413 too_large", async () => {
    const s = await login();
    const big = JSON.stringify(feedbackBody({ body: "x".repeat(70 * 1024) }));
    const r = await callJson("POST", "/v1/feedback", { token: s.token, rawBody: big, headers: { "Content-Type": "application/json" } });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("too_large");
    // also without a Content-Length header (streamed body)
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const r2 = await callJson("POST", "/v1/feedback", { token: s.token, rawBody: stream, headers: { "Content-Type": "application/json" } });
    expect(r2.status).toBe(413);
  });

  it("invalid JSON / non-object → 400; bad token → 401; unknown route → 404", async () => {
    const s = await login();
    expect((await callJson("POST", "/v1/feedback", { token: s.token, rawBody: "{not json" })).status).toBe(400);
    expect((await callJson("POST", "/v1/feedback", { token: s.token, rawBody: "[1,2]" })).status).toBe(400);
    expect((await callJson("GET", "/v1/me", { token: "x".repeat(43) })).status).toBe(401);
    expect((await callJson("GET", "/v1/feedback", { headers: { Authorization: "Basic abc" } })).status).toBe(401);
    expect((await callJson("GET", "/v1/nope")).status).toBe(404);
    expect((await callJson("PUT", "/v1/feedback")).status).toBe(405);
  });

  it("responses are JSON with security headers", async () => {
    const r = await call("GET", "/v1/feedback");
    expect(r.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });
});
