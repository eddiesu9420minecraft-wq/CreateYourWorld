// Webhook signature, de-duplication, loop prevention, release.published sender rules.
import { beforeAll, describe, expect, it } from "vitest";
import { BOOTSTRAP_MAINTAINER, callJson, createFeedback, env, jsonRes, login, mockGitHub, sendWebhook, type Session } from "../helpers";

const REPO = "eddiesu9420minecraft-wq/PikaraScienceStudio";
let author: Session;
let dev: Session;
let issueNo = 1000 + Math.floor(Math.random() * 100000);

beforeAll(async () => {
  author = await login("user");
  dev = await login("developer");
});

async function linkedFeedback() {
  const fb = await createFeedback(await login("user"));
  const n = issueNo++;
  const calls = mockGitHub((c) => {
    if (c.url.endsWith(`/repos/${REPO}/issues`)) return jsonRes({ number: n, html_url: `https://github.com/${REPO}/issues/${n}` }, 201);
    if (c.url.endsWith(`/issues/${n}/comments`)) return jsonRes({ id: n * 10 + calls.length }, 201);
    return jsonRes({ number: n }, 200);
  });
  const r = await callJson("POST", `/v1/feedback/${fb.id}/github`, { token: dev.token });
  expect(r.status).toBe(200);
  return { fb: r.body.feedback, number: n, calls };
}

describe("webhook signature", () => {
  it("missing or bad X-Hub-Signature-256 → 401", async () => {
    const payload = { action: "created", repository: { full_name: REPO }, issue: { number: 1 }, comment: { id: 1, body: "x" } };
    expect((await sendWebhook("issue_comment", payload, { signature: null })).status).toBe(401);
    expect((await sendWebhook("issue_comment", payload, { signature: "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect((await sendWebhook("issue_comment", payload, { secret: "wrong-secret" })).status).toBe(401);
    expect((await sendWebhook("issue_comment", payload, { signature: "sha1=abc" })).status).toBe(401);
    const ok = await sendWebhook("ping", { zen: "hi" });
    expect(ok.status).toBe(200);
  });

  it("no secret configured → every delivery is rejected", async () => {
    const raw = JSON.stringify({ zen: "x" });
    const r = await callJson("POST", "/v1/github/webhook", {
      rawBody: raw,
      headers: { "X-GitHub-Event": "ping", "X-GitHub-Delivery": crypto.randomUUID(), "X-Hub-Signature-256": "sha256=" },
      env: { GITHUB_WEBHOOK_SECRET: "" },
    });
    expect(r.status).toBe(401);
  });

  it("delivery ids are de-duplicated", async () => {
    const { fb, number } = await linkedFeedback();
    const delivery = crypto.randomUUID();
    const payload = {
      action: "created",
      repository: { full_name: REPO },
      issue: { number },
      comment: { id: number * 1000, body: "hello from GitHub", user: { login: "octo", type: "User" } },
      sender: { login: "octo" },
    };
    const a = await sendWebhook("issue_comment", payload, { delivery });
    const b = await sendWebhook("issue_comment", payload, { delivery });
    expect(a.body.comment_id).toBeTruthy();
    expect(b.body.duplicate).toBe(true);
    const comments = await callJson("GET", `/v1/feedback/${fb.id}/comments`);
    expect(comments.body.items.filter((c: any) => c.source === "github")).toHaveLength(1);
  });
});

describe("loop prevention", () => {
  it("ignores comments with a cyw-comment marker and comments by the bot login or Bot accounts", async () => {
    const { fb, number } = await linkedFeedback();
    const base = { action: "created", repository: { full_name: REPO }, issue: { number } };
    const marker = await sendWebhook("issue_comment", {
      ...base,
      comment: { id: 1, body: "**x** (CYW): hi\n\n<!-- cyw-comment:abc -->", user: { login: "human", type: "User" } },
    });
    expect(marker.body.ignored).toBe("own_comment");
    const bot = await sendWebhook("issue_comment", {
      ...base,
      comment: { id: 2, body: "bot says hi", user: { login: env.GITHUB_BOT_LOGIN, type: "User" } },
    });
    expect(bot.body.ignored).toBe("bot");
    const app = await sendWebhook("issue_comment", {
      ...base,
      comment: { id: 3, body: "app says hi", user: { login: "some-app[bot]", type: "Bot" } },
    });
    expect(app.body.ignored).toBe("bot");
    const comments = await callJson("GET", `/v1/feedback/${fb.id}/comments`);
    expect(comments.body.items).toHaveLength(0);
  });

  it("CYW close → GitHub close → webhook closed is a no-op (no second event, no call back)", async () => {
    const { fb, number, calls } = await linkedFeedback();
    const close = await callJson("POST", `/v1/feedback/${fb.id}/close`, { token: dev.token, body: { resolution: "duplicate" } });
    expect(close.status).toBe(200);
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ state: "closed", state_reason: "not_planned" });
    const before = calls.length;
    const hook = await sendWebhook("issues", {
      action: "closed",
      repository: { full_name: REPO },
      issue: { number, state_reason: "not_planned", labels: [] },
      sender: { login: "cyw-bot" },
    });
    expect(hook.body.ignored).toBe("already_done");
    expect(calls.length).toBe(before); // nothing mirrored back
    const after = await callJson("GET", `/v1/feedback/${fb.id}`);
    expect(after.body.feedback.events.filter((e: any) => e.kind === "status")).toHaveLength(1);
    expect(after.body.feedback.resolution).toBe("duplicate");
  });

  it("issues.closed → closed/completed, issues.reopened → open, without calling GitHub", async () => {
    const { fb, number, calls } = await linkedFeedback();
    const before = calls.length;
    const c = await sendWebhook("issues", {
      action: "closed",
      repository: { full_name: REPO },
      issue: { number, state_reason: "completed", labels: [{ name: "bug" }] },
      sender: { login: "octo" },
    });
    expect(c.body.status).toBe("closed");
    const closed = await callJson("GET", `/v1/feedback/${fb.id}`);
    expect(closed.body.feedback).toMatchObject({ status: "closed", resolution: "completed" });
    const o = await sendWebhook("issues", { action: "reopened", repository: { full_name: REPO }, issue: { number }, sender: { login: "octo" } });
    expect(o.body.status).toBe("open");
    expect(calls.length).toBe(before);
  });

  it("webhooks for unknown repos/issues are ignored", async () => {
    const r = await sendWebhook("issues", {
      action: "closed",
      repository: { full_name: "evil/repo" },
      issue: { number: 1, state_reason: "completed", labels: [] },
      sender: { login: "x" },
    });
    expect(r.body.ignored).toBe("unknown_issue");
  });
});

describe("release.published", () => {
  async function fixedFeedback() {
    const s = await login("user");
    const fb = await createFeedback(s);
    for (const status of ["triaged", "in_progress", "fixed"]) {
      expect((await callJson("PATCH", `/v1/feedback/${fb.id}`, { token: dev.token, body: { status } })).status).toBe(200);
    }
    return fb;
  }
  const release = (fbNumber: number, sender: string, tag = "v9.9.9") => ({
    action: "published",
    repository: { full_name: REPO },
    release: {
      tag_name: tag,
      html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
      body: `## Changes\n- Fixes feedback #${fbNumber}\nFixes feedback #999999999`,
    },
    sender: { login: sender },
  });

  it("from a non-maintainer is ignored", async () => {
    const fb = await fixedFeedback();
    const r = await sendWebhook("release", release(fb.number, "random-contributor"));
    expect(r.body.ignored).toBe("sender_not_maintainer");
    const dev2 = await sendWebhook("release", release(fb.number, dev.login));
    expect(dev2.body.ignored).toBe("sender_not_maintainer");
    expect((await callJson("GET", `/v1/feedback/${fb.id}`)).body.feedback.status).toBe("fixed");
  });

  it("from a maintainer releases the listed feedback", async () => {
    const fb = await fixedFeedback();
    const r = await sendWebhook("release", release(fb.number, BOOTSTRAP_MAINTAINER, "v2.0.0"));
    expect(r.body.updated).toBe(1);
    const after = await callJson("GET", `/v1/feedback/${fb.id}`);
    expect(after.body.feedback).toMatchObject({ status: "released", fixed_in: "v2.0.0" });
    const n = await callJson("GET", "/v1/notifications", { token: author.token });
    expect(n.status).toBe(200);
  });
});
