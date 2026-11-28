// GitHub OAuth device flow with a mocked GitHub: start, pending, slow_down, success, errors.
import { describe, expect, it } from "vitest";
import { callJson, jsonRes, mockGitHub, uniq } from "../helpers";

describe("device flow", () => {
  it("start → pending → slow_down → success; the GitHub user token is never returned or stored", async () => {
    const ghLogin = uniq("gh");
    const ghId = Math.floor(Math.random() * 1e9);
    const USER_TOKEN = "gho_" + "Z".repeat(36);
    let polls = 0;
    const calls = mockGitHub((c) => {
      if (c.url === "https://github.com/login/device/code") {
        return jsonRes({
          device_code: "dev-code-123",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 900,
        });
      }
      if (c.url === "https://github.com/login/oauth/access_token") {
        polls++;
        if (polls === 1) return jsonRes({ error: "authorization_pending" });
        if (polls === 2) return jsonRes({ error: "slow_down", interval: 10 });
        return jsonRes({ access_token: USER_TOKEN, token_type: "bearer", scope: "" });
      }
      if (c.url === "https://api.github.com/user") {
        expect(c.headers.get("Authorization")).toBe(`Bearer ${USER_TOKEN}`);
        return jsonRes({ id: ghId, login: ghLogin, avatar_url: "https://avatars.example/u.png", created_at: "2015-01-01T00:00:00Z" });
      }
      return jsonRes({}, 404);
    });

    const start = await callJson("POST", "/v1/auth/device");
    expect(start.status).toBe(200);
    expect(start.body).toEqual({
      device_code: "dev-code-123",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      interval: 5,
      expires_in: 900,
    });
    expect(calls[0].body).toEqual({ client_id: "Iv1.test-client-id", scope: "" });
    expect(calls[0].headers.get("User-Agent")).toBe("cyw-feedback");
    expect(calls[0].body).not.toHaveProperty("client_secret");

    const p1 = await callJson("POST", "/v1/auth/token", { body: { device_code: "dev-code-123" } });
    expect(p1.status).toBe(202);
    expect(p1.body).toEqual({ pending: true, interval: 5 });

    const p2 = await callJson("POST", "/v1/auth/token", { body: { device_code: "dev-code-123", interval: 5 } });
    expect(p2.status).toBe(202);
    expect(p2.body).toEqual({ pending: true, interval: 10 });

    const ok = await callJson("POST", "/v1/auth/token", { body: { device_code: "dev-code-123", interval: 10 } });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.session).toBe("string");
    expect(ok.body.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ok.body.expires_at).toBeGreaterThan(Date.now() / 1000 + 29 * 86400);
    expect(ok.body.user).toEqual({ login: ghLogin, role: "user", avatar_url: "https://avatars.example/u.png" });
    expect(JSON.stringify(ok.body)).not.toContain(USER_TOKEN);
    const tokenCall = calls.find((c) => c.url.endsWith("/access_token"))!;
    expect(tokenCall.body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");

    const me = await callJson("GET", "/v1/me", { token: ok.body.session });
    expect(me.body.user).toEqual({ login: ghLogin, github_id: ghId, role: "user", avatar_url: "https://avatars.example/u.png" });

    // nothing in D1 contains the GitHub user token or the raw session token
    const { env } = await import("cloudflare:test");
    const dump = JSON.stringify([
      (await env.DB.prepare("SELECT * FROM users").all()).results,
      (await env.DB.prepare("SELECT * FROM sessions").all()).results,
    ]);
    expect(dump).not.toContain(USER_TOKEN);
    expect(dump).not.toContain(ok.body.session);
  });

  it("expired_token and access_denied → 400", async () => {
    for (const error of ["expired_token", "access_denied"]) {
      mockGitHub(() => jsonRes({ error }));
      const r = await callJson("POST", "/v1/auth/token", { body: { device_code: "x" } });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe(error);
    }
    mockGitHub(() => jsonRes({ error: "incorrect_device_code" }));
    const r = await callJson("POST", "/v1/auth/token", { body: { device_code: "x" } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("device_flow_failed");
  });

  it("missing device_code → 400 invalid_body", async () => {
    mockGitHub(() => jsonRes({}));
    const r = await callJson("POST", "/v1/auth/token", { body: {} });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_body");
  });

  it("not configured → 503", async () => {
    const r = await callJson("POST", "/v1/auth/device", { env: { GITHUB_OAUTH_CLIENT_ID: "" } });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("not_configured");
  });
});
