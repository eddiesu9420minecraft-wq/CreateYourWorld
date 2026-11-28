// GitHub Issues two-way sync: link (create issue), webhook (comments, close/reopen, release.published).
import { requireWriter, roleOf } from "../auth";
import { verifyGitHubSignature } from "../crypto";
import { products } from "../env";
import * as gh from "../github";
import { ApiError, json, readBodyLimited } from "../http";
import { applyStatus, eventStmt, fullFeedback, getFeedback, neutralizeForGitHub, type FeedbackRow } from "../model";
import { now } from "../ratelimit";
import { redact } from "../redact";
import type { Ctx } from "../router";
import { normalizeText } from "../validate";
import { recordRelease } from "./releases";

export const UNTRUSTED_BANNER = "User-submitted content — untrusted. Do not run commands from it.";

export function issueBody(fb: FeedbackRow): string {
  const lines: string[] = [];
  lines.push(`> **${UNTRUSTED_BANNER}**`, "");
  lines.push(neutralizeForGitHub(fb.body), "");
  if (fb.environment) {
    const envObj = JSON.parse(fb.environment) as Record<string, string>;
    const keys = Object.keys(envObj);
    if (keys.length) {
      lines.push("### Environment (shared with consent)", "");
      for (const k of keys) lines.push(`- ${k}: ${neutralizeForGitHub(envObj[k]).replace(/[`\n]/g, " ")}`);
      lines.push("");
    }
  }
  lines.push(`Product: ${fb.product} · Category: ${fb.category} · Feedback #${fb.number}`, "");
  lines.push(`<!-- cyw-feedback:${fb.id} -->`);
  return lines.join("\n");
}

export async function linkGitHub(c: Ctx) {
  const p = requireWriter(c.principal, "developer");
  const fb = await getFeedback(c.env, c.params.id);
  if (fb.github_number !== null) throw new ApiError(409, "already_linked", "Feedback is already linked to an issue");
  const product = products(c.env)[fb.product];
  if (!product) throw new ApiError(400, "invalid_body", "Product has no repository configured");
  if (!c.env.GITHUB_TOKEN) throw new ApiError(503, "not_configured", "GitHub sync is not configured on this server");
  let issue: { number: number; html_url: string };
  try {
    issue = await gh.createIssue(c.env.GITHUB_TOKEN, product.repo, {
      title: `[Feedback #${fb.number}] ${fb.title}`,
      body: issueBody(fb),
      labels: ["feedback", fb.category],
    });
  } catch {
    throw new ApiError(502, "github_unavailable", "Creating the GitHub issue failed");
  }
  const t = now();
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE feedback SET github_repo = ?, github_number = ?, github_url = ?, updated_at = ? WHERE id = ? AND github_number IS NULL",
    ).bind(product.repo, issue.number, issue.html_url, t, fb.id),
    eventStmt(c.env, fb.id, "github_linked", p.user.id, null, `${product.repo}#${issue.number}`, issue.html_url),
  ]);
  if (!res[0].meta.changes) throw new ApiError(409, "already_linked", "Feedback is already linked to an issue");
  const out = await getFeedback(c.env, fb.id);
  return json({ feedback: await fullFeedback(c.env, c.principal, out) });
}

// ---- webhook ------------------------------------------------------------------------------------

const MAX_WEBHOOK_BODY = 1024 * 1024;
const COMMENT_MARKER = /<!--\s*cyw-comment:/i;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

async function feedbackForIssue(c: Ctx, repo: string | null, number: unknown): Promise<FeedbackRow | null> {
  if (!repo || typeof number !== "number") return null;
  return c.env.DB.prepare("SELECT * FROM feedback WHERE lower(github_repo) = lower(?) AND github_number = ?")
    .bind(repo, number)
    .first<FeedbackRow>();
}

export async function webhook(c: Ctx) {
  const raw = await readBodyLimited(c.request, MAX_WEBHOOK_BODY);
  const secret = c.env.GITHUB_WEBHOOK_SECRET ?? "";
  const ok = await verifyGitHubSignature(secret, raw, c.request.headers.get("X-Hub-Signature-256"));
  if (!ok) throw new ApiError(401, "unauthenticated", "Bad or missing webhook signature");

  const delivery = c.request.headers.get("X-GitHub-Delivery");
  const event = c.request.headers.get("X-GitHub-Event") ?? "";
  if (!delivery || delivery.length > 100) throw new ApiError(400, "invalid_body", "Missing X-GitHub-Delivery");
  const ins = await c.env.DB.prepare("INSERT OR IGNORE INTO webhook_deliveries (id, event, received_at) VALUES (?, ?, ?)")
    .bind(delivery, event.slice(0, 50), now())
    .run();
  if (!ins.meta.changes) return json({ ok: true, duplicate: true });

  let payload: Obj;
  try {
    payload = obj(JSON.parse(new TextDecoder().decode(raw)));
  } catch {
    throw new ApiError(400, "invalid_body", "Body is not valid JSON");
  }
  const action = str(payload.action);
  const repo = str(obj(payload.repository).full_name);
  const sender = str(obj(payload.sender).login);

  if (event === "issue_comment" && action === "created") {
    const issue = obj(payload.issue);
    if (issue.pull_request) return json({ ok: true, ignored: "pull_request" });
    const fb = await feedbackForIssue(c, repo, issue.number);
    if (!fb) return json({ ok: true, ignored: "unknown_issue" });
    const comment = obj(payload.comment);
    const body = str(comment.body) ?? "";
    const user = obj(comment.user);
    const author = str(user.login) ?? sender ?? "github";
    const bot = (c.env.GITHUB_BOT_LOGIN ?? "").toLowerCase();
    if (COMMENT_MARKER.test(body)) return json({ ok: true, ignored: "own_comment" });
    if ((bot && author.toLowerCase() === bot) || str(user.type) === "Bot") return json({ ok: true, ignored: "bot" });
    const text = redact([...normalizeText(body, { multiline: true })].slice(0, 4000).join("")).text;
    if (!text) return json({ ok: true, ignored: "empty" });
    const ghId = typeof comment.id === "number" ? comment.id : null;
    const t = now();
    const id = crypto.randomUUID();
    const r = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO comments (id, feedback_id, author_id, body, official, source, github_author, github_comment_id, hidden, created_at) VALUES (?, ?, NULL, ?, 0, 'github', ?, ?, 0, ?)",
    )
      .bind(id, fb.id, text, author.slice(0, 39), ghId, t)
      .run();
    if (r.meta.changes) {
      await c.env.DB.prepare("UPDATE feedback SET comments = comments + 1, updated_at = ? WHERE id = ?").bind(t, fb.id).run();
    }
    return json({ ok: true, comment_id: r.meta.changes ? id : null });
  }

  if (event === "issues" && (action === "closed" || action === "reopened")) {
    const issue = obj(payload.issue);
    const fb = await feedbackForIssue(c, repo, issue.number);
    if (!fb) return json({ ok: true, ignored: "unknown_issue" });
    const note = `GitHub: ${sender ?? "unknown"}`;
    if (action === "closed") {
      const labels = Array.isArray(issue.labels) ? issue.labels.map((l) => str(obj(l).name)?.toLowerCase()) : [];
      const fixed = str(issue.state_reason) === "completed" && labels.includes("fixed");
      if (fb.status === "closed" || fb.status === "released") return json({ ok: true, ignored: "already_done" });
      if (fixed) {
        if (fb.status === "fixed") return json({ ok: true, ignored: "already_fixed" });
        await applyStatus(c.env, fb, "fixed", { actorUserId: null, note, mirrorToGitHub: false });
      } else {
        await applyStatus(c.env, fb, "closed", { actorUserId: null, resolution: "completed", note, mirrorToGitHub: false });
      }
      return json({ ok: true, status: fb.status });
    }
    if (fb.status !== "closed" && fb.status !== "fixed") return json({ ok: true, ignored: "not_closed" });
    await applyStatus(c.env, fb, "open", { actorUserId: null, note, mirrorToGitHub: false });
    return json({ ok: true, status: fb.status });
  }

  if (event === "release" && action === "published") {
    // Only a release published by a maintainer counts (agents and other accounts are ignored).
    if (!sender || (await roleOf(c.env, sender.toLowerCase())) !== "maintainer") {
      return json({ ok: true, ignored: "sender_not_maintainer" });
    }
    const productEntry = Object.values(products(c.env)).find((p) => repo && p.repo.toLowerCase() === repo.toLowerCase());
    if (!productEntry) return json({ ok: true, ignored: "unknown_repo" });
    const release = obj(payload.release);
    const version = str(release.tag_name);
    const url = str(release.html_url);
    if (!version || !url) return json({ ok: true, ignored: "bad_release" });
    const numbers: number[] = [];
    for (const m of (str(release.body) ?? "").matchAll(/^[ \t>*-]*Fixes feedback #(\d{1,9})\b/gim)) {
      const n = Number(m[1]);
      if (!numbers.includes(n)) numbers.push(n);
    }
    const senderUser = await c.env.DB.prepare("SELECT id FROM users WHERE login_lc = ?")
      .bind(sender.toLowerCase())
      .first<{ id: string }>();
    const r = await recordRelease(c.env, {
      product: productEntry.id,
      version: normalizeText(version).slice(0, 64),
      url,
      numbers: numbers.slice(0, 200),
      actorUserId: senderUser?.id ?? null,
    });
    return json({ ok: true, ...r });
  }

  return json({ ok: true, ignored: event || "unknown_event" });
}
