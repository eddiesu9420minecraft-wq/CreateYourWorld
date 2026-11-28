// Role separation for every privileged endpoint: anon / user / developer / maintainer / agent / cyws.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BOOTSTRAP_MAINTAINER, callJson, createFeedback, jsonRes, login, mockGitHub, serviceToken, uniq, type Session } from "../helpers";

type Who = "anon" | "user" | "developer" | "maintainer" | "agent" | "cyws";
const WHO: Who[] = ["anon", "user", "developer", "maintainer", "agent", "cyws"];

let tokens: Record<Who, string | undefined>;
let author: Session;
let user: Session;
let dev: Session;
let maint: Session;

beforeEach(async () => {
  author = await login("user");
});

beforeAll(async () => {

  user = await login("user");
  dev = await login("developer");
  maint = await login("maintainer", BOOTSTRAP_MAINTAINER);
  tokens = {
    anon: undefined,
    user: user.token,
    developer: dev.token,
    maintainer: maint.token,
    agent: await serviceToken(maint, "agent"),
    cyws: await serviceToken(maint, "cyws"),
  };
});

/** expected: "<status>" or "<status>:<code>" per principal (omitted principals are not checked). */
async function check(
  name: string,
  req: (who: Who) => Promise<{ status: number; body: any }>,
  expected: Partial<Record<Who, string>>,
) {
  for (const who of WHO) {
    const exp = expected[who];
    if (!exp) continue;
    const r = await req(who);
    const [status, code] = exp.split(":");
    expect(r.status, `${name} as ${who}: ${JSON.stringify(r.body)}`).toBe(Number(status));
    if (code) expect(r.body?.error?.code, `${name} as ${who}`).toBe(code);
  }
}

const DENY_ALL_BUT_DEV = {
  anon: "401:unauthenticated",
  user: "403:forbidden",
  agent: "403:agent_forbidden",
  cyws: "403:agent_forbidden",
} as const;

const DENY_ALL_BUT_MAINT = { ...DENY_ALL_BUT_DEV, developer: "403:forbidden" } as const;

describe("feedback endpoints", () => {
  it("create feedback: users yes, services no", async () => {
    await check(
      "POST /v1/feedback",
      (who) =>
        callJson("POST", "/v1/feedback", {
          token: tokens[who],
          body: {
            product: "runX",
            category: "general",
            title: "Role test title",
            body: `role test body ${uniq()}`,
            consent: { content: true, environment: false, preview_sha256: "c".repeat(64) },
          },
        }),
      { anon: "401:unauthenticated", agent: "403:agent_forbidden", cyws: "403:agent_forbidden", user: "201", developer: "201" },
    );
  });

  it("vote and comment: no anon, no services", async () => {
    const fb = await createFeedback(author);
    await check("vote", (who) => callJson("POST", `/v1/feedback/${fb.id}/vote`, { token: tokens[who] }), {
      anon: "401:unauthenticated",
      agent: "403:agent_forbidden",
      cyws: "403:agent_forbidden",
      user: "200",
    });
    await check(
      "comment",
      (who) => callJson("POST", `/v1/feedback/${fb.id}/comments`, { token: tokens[who], body: { body: "hello" } }),
      { anon: "401:unauthenticated", agent: "403:agent_forbidden", cyws: "403:agent_forbidden", user: "201" },
    );
    await check(
      "subscribe",
      (who) => callJson("POST", `/v1/feedback/${fb.id}/subscription`, { token: tokens[who] }),
      { anon: "401:unauthenticated", agent: "403:agent_forbidden", cyws: "403:agent_forbidden", user: "200" },
    );
  });

  it("official reply: developer+ only", async () => {
    const fb = await createFeedback(author);
    await check(
      "official comment",
      (who) => callJson("POST", `/v1/feedback/${fb.id}/comments`, { token: tokens[who], body: { body: "official", official: true } }),
      { ...DENY_ALL_BUT_DEV, developer: "201", maintainer: "201" },
    );
  });

  it("PATCH feedback (status/assignee/labels): developer+ only", async () => {
    const fb = await createFeedback(author);
    await check(
      "PATCH feedback",
      (who) => callJson("PATCH", `/v1/feedback/${fb.id}`, { token: tokens[who], body: { labels: ["x"] } }),
      { ...DENY_ALL_BUT_DEV, developer: "200", maintainer: "200" },
    );
    // the author is a plain user and cannot change status either
    const r = await callJson("PATCH", `/v1/feedback/${fb.id}`, { token: author.token, body: { status: "triaged" } });
    expect(r.status).toBe(403);
  });

  it("GitHub sync: developer+ only", async () => {
    const fb = await createFeedback(author);
    mockGitHub(() => jsonRes({ number: 7, html_url: "https://github.com/eddiesu9420minecraft-wq/PikaraScienceStudio/issues/7" }, 201));
    await check("link github", (who) => callJson("POST", `/v1/feedback/${fb.id}/github`, { token: tokens[who] }), {
      ...DENY_ALL_BUT_DEV,
      developer: "200",
      maintainer: "409:already_linked",
    });
  });

  it("close: author (completed only) or developer+", async () => {
    const fb = await createFeedback(author);
    await check(
      "close",
      (who) => callJson("POST", `/v1/feedback/${fb.id}/close`, { token: tokens[who], body: { resolution: "completed" } }),
      { anon: "401:unauthenticated", user: "403:forbidden", agent: "403:agent_forbidden", cyws: "403:agent_forbidden" },
    );
    const wontFix = await callJson("POST", `/v1/feedback/${fb.id}/close`, { token: author.token, body: { resolution: "wont_fix" } });
    expect(wontFix.status).toBe(403);
    const ok = await callJson("POST", `/v1/feedback/${fb.id}/close`, { token: author.token, body: { resolution: "completed" } });
    expect(ok.status).toBe(200);
    const fb2 = await createFeedback(author);
    const devClose = await callJson("POST", `/v1/feedback/${fb2.id}/close`, { token: dev.token, body: { resolution: "wont_fix" } });
    expect(devClose.status).toBe(200);
    expect(devClose.body.feedback.resolution).toBe("wont_fix");
  });

  it("hide comment: maintainer only; hidden body is empty for non-maintainers", async () => {
    const fb = await createFeedback(author);
    const c = await callJson("POST", `/v1/feedback/${fb.id}/comments`, { token: user.token, body: { body: "rude words" } });
    await check("hide comment", (who) => callJson("DELETE", `/v1/comments/${c.body.comment.id}`, { token: tokens[who] }), {
      ...DENY_ALL_BUT_MAINT,
      maintainer: "204",
    });
    const asUser = await callJson("GET", `/v1/feedback/${fb.id}/comments`, { token: user.token });
    expect(asUser.body.items[0]).toMatchObject({ hidden: true, body: "" });
    const asMaint = await callJson("GET", `/v1/feedback/${fb.id}/comments`, { token: maint.token });
    expect(asMaint.body.items[0]).toMatchObject({ hidden: true, body: "rude words" });
  });
});

describe("admin endpoints: maintainer only", () => {
  it("roles, bans, service tokens", async () => {
    const target = uniq("t");
    await check("PUT role", (who) => callJson("PUT", `/v1/admin/roles/${target}`, { token: tokens[who], body: { role: "developer" } }), {
      ...DENY_ALL_BUT_MAINT,
      maintainer: "200",
    });
    await check("ban", (who) => callJson("POST", `/v1/admin/bans/${target}`, { token: tokens[who], body: { reason: "x" } }), {
      ...DENY_ALL_BUT_MAINT,
      maintainer: "200",
    });
    await check("unban", (who) => callJson("DELETE", `/v1/admin/bans/${target}`, { token: tokens[who] }), {
      ...DENY_ALL_BUT_MAINT,
      maintainer: "200",
    });
    await check("create token", (who) => callJson("POST", "/v1/admin/tokens", { token: tokens[who], body: { name: "x", role: "agent" } }), {
      ...DENY_ALL_BUT_MAINT,
      maintainer: "201",
    });
    await check("list tokens", (who) => callJson("GET", "/v1/admin/tokens", { token: tokens[who] }), {
      ...DENY_ALL_BUT_MAINT,
      maintainer: "200",
    });
    const created = await callJson("POST", "/v1/admin/tokens", { token: maint.token, body: { name: "to-revoke", role: "cyws" } });
    await check("revoke token", (who) => callJson("DELETE", `/v1/admin/tokens/${created.body.id}`, { token: tokens[who] }), {
      ...DENY_ALL_BUT_MAINT,
      maintainer: "204",
    });
    // a revoked token no longer authenticates
    const after = await callJson("GET", "/v1/tasks", { token: created.body.token });
    expect(after.status).toBe(401);
    // token listing never exposes the token or its hash
    const list = await callJson("GET", "/v1/admin/tokens", { token: maint.token });
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);
    expect(list.body.items[0]).not.toHaveProperty("token_hash");
  });

  it("bootstrap maintainers cannot be demoted or banned", async () => {
    const other = await login("maintainer");
    const r = await callJson("PUT", `/v1/admin/roles/${BOOTSTRAP_MAINTAINER}`, { token: other.token, body: { role: "user" } });
    expect(r.status).toBe(403);
    const b = await callJson("POST", `/v1/admin/bans/${BOOTSTRAP_MAINTAINER}`, { token: other.token, body: {} });
    expect(b.status).toBe(403);
  });

  it("granting developer takes effect immediately", async () => {
    const u = await login("user");
    expect((await callJson("PATCH", `/v1/feedback/1`, { token: u.token, body: { labels: [] } })).status).toBe(403);
    await callJson("PUT", `/v1/admin/roles/${u.login}`, { token: maint.token, body: { role: "developer" } });
    expect((await callJson("GET", "/v1/me", { token: u.token })).body.user.role).toBe("developer");
  });
});

describe("tasks", () => {
  it("create: maintainer or cyws; read: developer+/agent/cyws", async () => {
    const fb = await createFeedback(author);
    await check("create task", (who) => callJson("POST", `/v1/feedback/${fb.id}/tasks`, { token: tokens[who], body: {} }), {
      anon: "401:unauthenticated",
      user: "403:forbidden",
      developer: "403:forbidden",
      agent: "403:agent_forbidden",
      cyws: "201",
      maintainer: "201",
    });
    // cyws may create but not assign
    const cywsAssign = await callJson("POST", `/v1/feedback/${fb.id}/tasks`, { token: tokens.cyws, body: { assignee: dev.login } });
    expect(cywsAssign.status).toBe(403);
    expect(cywsAssign.body.error.code).toBe("agent_forbidden");

    await check("list tasks", (who) => callJson("GET", "/v1/tasks", { token: tokens[who] }), {
      anon: "401:unauthenticated",
      user: "403:forbidden",
      developer: "200",
      maintainer: "200",
      agent: "200",
      cyws: "200",
    });
  });

  it("assign: maintainer only; status done/wont_do: developer+ only", async () => {
    const fb = await createFeedback(author);
    const t = await callJson("POST", `/v1/feedback/${fb.id}/tasks`, { token: maint.token, body: { agent_allowed: true } });
    const id = t.body.task.id;
    await check("assign task", (who) => callJson("PATCH", `/v1/tasks/${id}`, { token: tokens[who], body: { assignee: dev.login } }), {
      anon: "401:unauthenticated",
      user: "403:forbidden",
      developer: "403:forbidden",
      agent: "403:agent_forbidden",
      cyws: "403:agent_forbidden",
      maintainer: "200",
    });
    for (const status of ["done", "wont_do"]) {
      await check(`task ${status}`, (who) => callJson("PATCH", `/v1/tasks/${id}`, { token: tokens[who], body: { status } }), {
        anon: "401:unauthenticated",
        user: "403:forbidden",
        agent: "403:agent_forbidden",
        cyws: "403:agent_forbidden",
        developer: "200",
      });
    }
    await check("task in_review", (who) => callJson("PATCH", `/v1/tasks/${id}`, { token: tokens[who], body: { status: "in_review" } }), {
      agent: "200",
      cyws: "200",
      developer: "200",
    });
  });

  it("agents work only on agent_allowed tasks", async () => {
    const fb = await createFeedback(author);
    const t = await callJson("POST", `/v1/feedback/${fb.id}/tasks`, { token: maint.token, body: {} });
    const id = t.body.task.id;
    await check("analysis", (who) => callJson("POST", `/v1/tasks/${id}/analysis`, { token: tokens[who], body: { summary: "x" } }), {
      anon: "401:unauthenticated",
      user: "403:forbidden",
      agent: "403:agent_forbidden",
      cyws: "201",
      developer: "201",
    });
    const st = await callJson("PATCH", `/v1/tasks/${id}`, { token: tokens.agent, body: { status: "in_progress" } });
    expect(st.status).toBe(403);
    expect(st.body.error.code).toBe("agent_forbidden");
  });
});

describe("releases", () => {
  it("POST /v1/releases: maintainer session only, human_approved required", async () => {
    const body = {
      product: "runX",
      version: "v1.0.0",
      url: "https://github.com/eddiesu9420minecraft-wq/runX/releases/tag/v1.0.0",
      feedback_numbers: [],
      human_approved: true,
    };
    await check("release", (who) => callJson("POST", "/v1/releases", { token: tokens[who], body }), {
      ...DENY_ALL_BUT_MAINT,
      maintainer: "200",
    });
    const noApproval = await callJson("POST", "/v1/releases", { token: maint.token, body: { ...body, human_approved: false } });
    expect(noApproval.status).toBe(400);
    const missing = await callJson("POST", "/v1/releases", { token: maint.token, body: { ...body, human_approved: undefined } });
    expect(missing.status).toBe(400);
    const wrongRepo = await callJson("POST", "/v1/releases", {
      token: maint.token,
      body: { ...body, url: "https://github.com/evil/runX/releases/tag/v1.0.0" },
    });
    expect(wrongRepo.status).toBe(400);
  });
});
