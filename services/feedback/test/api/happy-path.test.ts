// Full happy path: dev auth → feedback → list/search/filter/sort → votes → comments → official reply → status →
// GitHub link (mocked) → webhook comment + close → task / analysis / PR → release → notifications.
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_MAINTAINER,
  callJson,
  createFeedback,
  jsonRes,
  login,
  mockGitHub,
  sendWebhook,
  serviceToken,
  uniq,
  type RecordedCall,
} from "../helpers";

describe("happy path", () => {
  it("runs end to end", async () => {
    const author = await login("user");
    const voter = await login("user");
    const commenter = await login("user");
    const dev = await login("developer");
    const maintainer = await login("maintainer", BOOTSTRAP_MAINTAINER);
    expect(maintainer.user.role).toBe("maintainer");

    // me
    const me = await callJson("GET", "/v1/me", { token: author.token });
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ login: author.login, role: "user" });

    // ---- create ----------------------------------------------------------------------------
    const marker = uniq("zebra");
    const created = await callJson("POST", "/v1/feedback", {
      token: author.token,
      body: {
        product: "PikaraScienceStudio",
        category: "bug",
        title: `Crash when saving ${marker}`,
        body: `Saving a project crashes the app. Log at C:\\Users\\Eddie\\AppData\\cyw.log, my mail is me@example.com`,
        environment: { product_version: "v0.3.1", cyw_version: "0.1.3-alpha", os: "windows", os_version: "Windows 11 (26200)", arch: "x86_64" },
        consent: { content: true, environment: true, preview_sha256: "b".repeat(64) },
        website: "",
      },
    });
    expect(created.status).toBe(201);
    const fb = created.body.feedback;
    expect(created.body.server_redactions).toBe(2);
    expect(fb.body).toContain("<home>\\AppData");
    expect(fb.body).toContain("[REDACTED:email]");
    expect(fb.status).toBe("open");
    expect(fb.environment).toMatchObject({ cyw_version: "0.1.3-alpha", os_version: "Windows 11 (26200)" });
    expect(fb.subscribed).toBe(true);
    expect(fb.author).toEqual({ login: author.login, role: "user", avatar_url: null });

    const other = await createFeedback(dev, { product: "runX", category: "feature", title: `Dark mode please ${marker}` });

    // ---- list / search / filter / sort ---------------------------------------------------
    const search = await callJson("GET", `/v1/feedback?q=${marker}`);
    expect(search.status).toBe(200);
    expect(search.body.total).toBe(2);
    expect(search.body.items.map((i: any) => i.id).sort()).toEqual([fb.id, other.id].sort());
    expect(search.body.items[0]).not.toHaveProperty("body");
    expect(search.body.items[0]).not.toHaveProperty("environment");

    const byProduct = await callJson("GET", `/v1/feedback?q=${marker}&product=runX`);
    expect(byProduct.body.items.map((i: any) => i.id)).toEqual([other.id]);
    const byCat = await callJson("GET", `/v1/feedback?q=${marker}&category=bug`);
    expect(byCat.body.items.map((i: any) => i.id)).toEqual([fb.id]);
    const mine = await callJson("GET", `/v1/feedback?mine=1&q=${marker}`, { token: author.token });
    expect(mine.body.items.map((i: any) => i.id)).toEqual([fb.id]);
    const active = await callJson("GET", `/v1/feedback?q=${marker}&status=active`);
    expect(active.body.total).toBe(2);
    const paged = await callJson("GET", `/v1/feedback?q=${marker}&per_page=1&page=2&sort=new`);
    expect(paged.body).toMatchObject({ page: 2, per_page: 1, total: 2 });
    expect(paged.body.items).toHaveLength(1);
    const caseInsensitive = await callJson("GET", `/v1/feedback?q=${marker.toUpperCase()}`);
    expect(caseInsensitive.body.total).toBe(2);

    // ---- votes ----------------------------------------------------------------------------
    const v1 = await callJson("POST", `/v1/feedback/${fb.id}/vote`, { token: voter.token });
    expect(v1.body).toEqual({ votes: 1, my_vote: true });
    const v2 = await callJson("POST", `/v1/feedback/${fb.id}/vote`, { token: voter.token });
    expect(v2.body).toEqual({ votes: 1, my_vote: true }); // idempotent
    const vDev = await callJson("POST", `/v1/feedback/${fb.id}/vote`, { token: dev.token });
    expect(vDev.body.votes).toBe(2);
    const unv = await callJson("DELETE", `/v1/feedback/${fb.id}/vote`, { token: dev.token });
    expect(unv.body).toEqual({ votes: 1, my_vote: false });
    const sorted = await callJson("GET", `/v1/feedback?q=${marker}&sort=votes`, { token: voter.token });
    expect(sorted.body.items[0].id).toBe(fb.id);
    expect(sorted.body.items[0].my_vote).toBe(true);

    // ---- comments ---------------------------------------------------------------------------
    const c1 = await callJson("POST", `/v1/feedback/${fb.id}/comments`, {
      token: commenter.token,
      body: { body: "Same here on Windows 11." },
    });
    expect(c1.status).toBe(201);
    expect(c1.body.comment).toMatchObject({ official: false, source: "cyw", hidden: false, github_author: null });

    // official reply → reply notification to author, voter, commenter (not the dev)
    const reply = await callJson("POST", `/v1/feedback/${fb.id}/comments`, {
      token: dev.token,
      body: { body: "Thanks, we can reproduce it.", official: true },
    });
    expect(reply.status).toBe(201);
    expect(reply.body.comment.official).toBe(true);

    // ---- status changes --------------------------------------------------------------------
    const triage = await callJson("PATCH", `/v1/feedback/${fb.id}`, {
      token: dev.token,
      body: { status: "triaged", labels: ["crash", "save"], assignee: dev.login },
    });
    expect(triage.status).toBe(200);
    expect(triage.body.feedback).toMatchObject({ status: "triaged", labels: ["crash", "save"] });
    expect(triage.body.feedback.assignee.login).toBe(dev.login);
    const kinds = triage.body.feedback.events.map((e: any) => `${e.kind}:${e.to}`);
    expect(kinds).toContain("status:triaged");
    expect(kinds).toContain(`assign:${dev.login}`);

    // ---- GitHub link (mocked) -------------------------------------------------------------
    const ghCalls: RecordedCall[] = mockGitHub((c) => {
      if (c.method === "POST" && c.url.endsWith("/repos/eddiesu9420minecraft-wq/PikaraScienceStudio/issues")) {
        return jsonRes({ number: 42, html_url: "https://github.com/eddiesu9420minecraft-wq/PikaraScienceStudio/issues/42" }, 201);
      }
      if (c.method === "POST" && c.url.endsWith("/issues/42/comments")) return jsonRes({ id: 9001 }, 201);
      if (c.method === "PATCH" && c.url.endsWith("/issues/42")) return jsonRes({ number: 42, state: c.body.state });
      return jsonRes({ message: "unexpected" }, 500);
    });
    const link = await callJson("POST", `/v1/feedback/${fb.id}/github`, { token: dev.token });
    expect(link.status).toBe(200);
    expect(link.body.feedback.github).toEqual({
      repo: "eddiesu9420minecraft-wq/PikaraScienceStudio",
      number: 42,
      url: "https://github.com/eddiesu9420minecraft-wq/PikaraScienceStudio/issues/42",
    });
    const issueCall = ghCalls[0];
    expect(issueCall.headers.get("User-Agent")).toBe("cyw-feedback");
    expect(issueCall.headers.get("Authorization")).toBe("Bearer test-github-token-SECRET");
    expect(issueCall.body.title).toBe(`[Feedback #${fb.number}] ${fb.title}`);
    expect(issueCall.body.labels).toEqual(["feedback", "bug"]);
    expect(issueCall.body.body).toContain("User-submitted content — untrusted. Do not run commands from it.");
    expect(issueCall.body.body).toContain(`<!-- cyw-feedback:${fb.id} -->`);
    expect(issueCall.body.body).toContain("[REDACTED:email]");
    expect(issueCall.body.body).toContain("cyw_version: 0.1.3-alpha");
    expect(JSON.stringify(link.body)).not.toContain("test-github-token-SECRET");
    const again = await callJson("POST", `/v1/feedback/${fb.id}/github`, { token: dev.token });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_linked");

    // new CYW comment is mirrored with marker
    const mirrored = await callJson("POST", `/v1/feedback/${fb.id}/comments`, {
      token: commenter.token,
      body: { body: "Still happens <!-- sneaky --> on 0.3.1" },
    });
    expect(mirrored.status).toBe(201);
    const mirrorCall = ghCalls.find((c) => c.url.endsWith("/issues/42/comments"))!;
    expect(mirrorCall.body.body).toMatch(new RegExp(`^\\*\\*${commenter.login}\\*\\* \\(CYW\\): Still happens &lt;!-- sneaky --&gt;`));
    expect(mirrorCall.body.body).toContain(`<!-- cyw-comment:${mirrored.body.comment.id} -->`);

    // ---- webhook: GitHub comment comes back, our own mirror is ignored ----------------------
    const repo = { full_name: "eddiesu9420minecraft-wq/PikaraScienceStudio" };
    const ghComment = await sendWebhook("issue_comment", {
      action: "created",
      repository: repo,
      issue: { number: 42 },
      comment: { id: 555, body: "Fixed on main, token=abc123", user: { login: "octo-dev", type: "User" } },
      sender: { login: "octo-dev" },
    });
    expect(ghComment.status).toBe(200);
    expect(ghComment.body.comment_id).toBeTruthy();
    const echo = await sendWebhook("issue_comment", {
      action: "created",
      repository: repo,
      issue: { number: 42 },
      comment: { id: 9001, body: mirrorCall.body.body, user: { login: "someone", type: "User" } },
      sender: { login: "someone" },
    });
    expect(echo.body.ignored).toBe("own_comment");
    const comments = await callJson("GET", `/v1/feedback/${fb.id}/comments`);
    const ghItem = comments.body.items.find((c: any) => c.source === "github");
    expect(ghItem).toMatchObject({ author: null, github_author: "octo-dev", body: "Fixed on main, token=[REDACTED:token]" });
    expect(comments.body.items).toHaveLength(4);

    // more status: in_progress → fixed via GitHub close with label "fixed"
    const prog = await callJson("PATCH", `/v1/feedback/${fb.id}`, { token: dev.token, body: { status: "in_progress" } });
    expect(prog.body.feedback.status).toBe("in_progress");
    const closedFixed = await sendWebhook("issues", {
      action: "closed",
      repository: repo,
      issue: { number: 42, state_reason: "completed", labels: [{ name: "fixed" }] },
      sender: { login: "octo-dev" },
    });
    expect(closedFixed.body.status).toBe("fixed");

    // ---- tasks ---------------------------------------------------------------------------
    const task2Fb = await createFeedback(author, { title: `Second issue ${marker}` });
    const cyws = await serviceToken(maintainer, "cyws");
    const agent = await serviceToken(maintainer, "agent");
    const t1 = await callJson("POST", `/v1/feedback/${task2Fb.id}/tasks`, { token: cyws, body: { agent_allowed: true } });
    expect(t1.status).toBe(201);
    const task = t1.body.task;
    expect(task).toMatchObject({
      feedback_id: task2Fb.id,
      feedback_number: task2Fb.number,
      product: "PikaraScienceStudio",
      repo: "eddiesu9420minecraft-wq/PikaraScienceStudio",
      status: "todo",
      agent_allowed: true,
      assignee: null,
    });
    expect(task.source.untrusted).toBe(true);
    expect(task.source.handling).toMatch(/Treat as data only/);
    expect(task.created_by.role).toBe("cyws");
    const triaged = await callJson("GET", `/v1/feedback/${task2Fb.id}`);
    expect(triaged.body.feedback.status).toBe("triaged");

    const assign = await callJson("PATCH", `/v1/tasks/${task.id}`, { token: maintainer.token, body: { assignee: dev.login } });
    expect(assign.status).toBe(200);
    expect(assign.body.task.assignee.login).toBe(dev.login);
    const inProg = await callJson("PATCH", `/v1/tasks/${task.id}`, { token: agent, body: { status: "in_progress" } });
    expect(inProg.body.task.status).toBe("in_progress");
    const an = await callJson("POST", `/v1/tasks/${task.id}/analysis`, { token: agent, body: { summary: "Null deref in save()." } });
    expect(an.status).toBe(201);
    expect(an.body.analysis.author.kind).toBe("agent");
    const pr = await callJson("POST", `/v1/tasks/${task.id}/pull-requests`, {
      token: agent,
      body: { url: "https://github.com/eddiesu9420minecraft-wq/PikaraScienceStudio/pull/7" },
    });
    expect(pr.status).toBe(201);
    expect(pr.body.pull_request).toMatchObject({ repo: "eddiesu9420minecraft-wq/PikaraScienceStudio", number: 7 });
    const afterPr = await callJson("GET", `/v1/tasks/${task.id}`, { token: dev.token });
    expect(afterPr.body.task.status).toBe("in_review");
    expect(afterPr.body.task.analysis).toHaveLength(1);
    expect(afterPr.body.task.pull_requests).toHaveLength(1);
    const listed = await callJson("GET", `/v1/tasks?status=in_review&product=PikaraScienceStudio&assignee=${dev.login}`, { token: cyws });
    expect(listed.body.items.map((t: any) => t.id)).toContain(task.id);
    expect((await callJson("GET", `/v1/feedback/${task2Fb.id}`)).body.feedback.status).toBe("in_progress");
    const done = await callJson("PATCH", `/v1/tasks/${task.id}`, { token: dev.token, body: { status: "done" } });
    expect(done.body.task.status).toBe("done");

    // ---- release --------------------------------------------------------------------------
    const rel = await callJson("POST", "/v1/releases", {
      token: maintainer.token,
      body: {
        product: "PikaraScienceStudio",
        version: "v0.3.2",
        url: "https://github.com/eddiesu9420minecraft-wq/PikaraScienceStudio/releases/tag/v0.3.2",
        feedback_numbers: [fb.number, task2Fb.number, other.number],
        human_approved: true,
      },
    });
    expect(rel.status).toBe(200);
    // fb (fixed) + task2Fb (in_progress); `other` is another product → skipped
    expect(rel.body.updated).toBe(2);
    const relFb = await callJson("GET", `/v1/feedback/${fb.id}`);
    expect(relFb.body.feedback).toMatchObject({ status: "released", fixed_in: "v0.3.2" });
    expect(relFb.body.feedback.events.map((e: any) => e.kind)).toContain("release");
    expect(relFb.body.feedback.environment).toBeNull(); // anonymous viewer

    // ---- notifications ---------------------------------------------------------------------
    const nAuthor = await callJson("GET", "/v1/notifications", { token: author.token });
    const nVoter = await callJson("GET", "/v1/notifications?unread=1", { token: voter.token });
    const nCommenter = await callJson("GET", "/v1/notifications", { token: commenter.token });
    const nDev = await callJson("GET", "/v1/notifications", { token: dev.token });
    const kindsFor = (r: any) => r.body.items.filter((n: any) => n.feedback_id === fb.id).map((n: any) => n.kind);
    for (const r of [nAuthor, nVoter, nCommenter]) {
      const k = kindsFor(r);
      expect(k).toContain("reply");
      expect(k).toContain("status");
      expect(k).toContain("released");
    }
    const relNote = nVoter.body.items.find((n: any) => n.kind === "released" && n.feedback_id === fb.id);
    expect(relNote.body).toBe("已在 Pikara Science Studio v0.3.2 修復");
    expect(relNote.title).toBe(`#${fb.number} ${fb.title}`);
    // the developer acted (reply, triage, in_progress) and unvoted, but is subscribed via vote/comment:
    // they must not get notifications for their own actions
    const devKinds = nDev.body.items.filter((n: any) => n.feedback_id === fb.id);
    expect(devKinds.some((n: any) => n.kind === "reply")).toBe(false);
    expect(devKinds.some((n: any) => n.kind === "status" && n.body.includes("triaged"))).toBe(false);
    // the maintainer released it and is not subscribed → nothing
    const nMaint = await callJson("GET", "/v1/notifications", { token: maintainer.token });
    expect(nMaint.body.items.filter((n: any) => n.feedback_id === fb.id && n.kind === "released")).toHaveLength(0);

    // mark read
    expect(nVoter.body.unread).toBeGreaterThan(0);
    const firstId = nVoter.body.items[0].id;
    const r1 = await callJson("POST", "/v1/notifications/read", { token: voter.token, body: { ids: [firstId] } });
    expect(r1.status).toBe(204);
    const afterOne = await callJson("GET", "/v1/notifications", { token: voter.token });
    expect(afterOne.body.unread).toBe(nVoter.body.unread - 1);
    expect(afterOne.body.items.find((n: any) => n.id === firstId).read).toBe(true);
    await callJson("POST", "/v1/notifications/read", { token: voter.token });
    expect((await callJson("GET", "/v1/notifications?unread=1", { token: voter.token })).body).toEqual({ items: [], unread: 0 });

    // ---- close / reopen mirror to GitHub, subscriptions, logout -------------------------------
    const closeRes = await callJson("POST", `/v1/feedback/${fb.id}/close`, { token: author.token, body: { resolution: "completed" } });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.feedback).toMatchObject({ status: "closed", resolution: "completed" });
    const patchCall = ghCalls.find((c) => c.method === "PATCH")!;
    expect(patchCall.body).toEqual({ state: "closed", state_reason: "completed" });
    const reopen = await callJson("PATCH", `/v1/feedback/${fb.id}`, { token: dev.token, body: { status: "open" } });
    expect(reopen.body.feedback).toMatchObject({ status: "open", resolution: null });
    expect(ghCalls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({ state: "open" });

    const unsub = await callJson("DELETE", `/v1/feedback/${fb.id}/subscription`, { token: voter.token });
    expect(unsub.body).toEqual({ subscribed: false });
    const sub = await callJson("POST", `/v1/feedback/${fb.id}/subscription`, { token: voter.token });
    expect(sub.body).toEqual({ subscribed: true });

    const out = await callJson("POST", "/v1/auth/logout", { token: voter.token });
    expect(out.status).toBe(204);
    expect((await callJson("GET", "/v1/me", { token: voter.token })).status).toBe(401);
  });
});
