// Shared data access and serialisation for feedback, users, events and notifications.
import { effectiveRole, isDevPlus, type Principal } from "./auth";
import type { Env } from "./env";
import { products } from "./env";
import * as gh from "./github";
import { ApiError } from "./http";
import { now } from "./ratelimit";
import type { Status } from "./validate";

export interface UserView {
  login: string;
  role: string;
  avatar_url: string | null;
}

export interface FeedbackRow {
  id: string;
  number: number;
  product: string;
  category: string;
  title: string;
  body: string;
  body_hash: string;
  environment: string | null;
  consent: string;
  author_id: string;
  status: Status;
  resolution: string | null;
  votes: number;
  comments: number;
  assignee_id: string | null;
  labels: string;
  duplicate_of: string | null;
  fixed_in: string | null;
  github_repo: string | null;
  github_number: number | null;
  github_url: string | null;
  created_at: number;
  updated_at: number;
}

export const viewerUserId = (p: Principal) => (p.kind === "user" ? p.user.id : null);

/** Loads public user views by id. */
export async function loadUsers(env: Env, ids: Iterable<string | null | undefined>): Promise<Map<string, UserView>> {
  const unique = [...new Set([...ids].filter((x): x is string => typeof x === "string"))];
  const out = new Map<string, UserView>();
  for (let i = 0; i < unique.length; i += 90) {
    const chunk = unique.slice(i, i + 90);
    const rows = await env.DB.prepare(
      `SELECT u.id, u.login, u.login_lc, u.avatar_url, r.role AS db_role
         FROM users u LEFT JOIN roles r ON r.login_lc = u.login_lc
        WHERE u.id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<{ id: string; login: string; login_lc: string; avatar_url: string | null; db_role: string | null }>();
    for (const r of rows.results) {
      out.set(r.id, { login: r.login, role: effectiveRole(env, r.login_lc, r.db_role), avatar_url: r.avatar_url });
    }
  }
  return out;
}

export async function findUserByLogin(env: Env, login: string): Promise<{ id: string; login: string } | null> {
  return env.DB.prepare("SELECT id, login FROM users WHERE login_lc = ?").bind(login.toLowerCase()).first();
}

/** `:id` may be the feedback id or its number. */
export async function getFeedback(env: Env, idOrNumber: string): Promise<FeedbackRow> {
  let row: FeedbackRow | null = null;
  if (/^\d{1,9}$/.test(idOrNumber)) {
    row = await env.DB.prepare("SELECT * FROM feedback WHERE number = ?").bind(Number(idOrNumber)).first<FeedbackRow>();
  } else if (idOrNumber.length <= 64) {
    row = await env.DB.prepare("SELECT * FROM feedback WHERE id = ?").bind(idOrNumber).first<FeedbackRow>();
  }
  if (!row) throw new ApiError(404, "not_found", "Feedback not found");
  return row;
}

export function canSeePrivate(p: Principal, fb: FeedbackRow): boolean {
  return isDevPlus(p) || (p.kind === "user" && p.user.id === fb.author_id);
}

export function summary(fb: FeedbackRow, users: Map<string, UserView>, myVote: boolean) {
  return {
    id: fb.id,
    number: fb.number,
    product: fb.product,
    category: fb.category,
    title: fb.title,
    status: fb.status,
    resolution: fb.resolution,
    votes: fb.votes,
    comments: fb.comments,
    author: users.get(fb.author_id) ?? null,
    created_at: fb.created_at,
    updated_at: fb.updated_at,
    github:
      fb.github_number !== null && fb.github_repo
        ? { repo: fb.github_repo, number: fb.github_number, url: fb.github_url }
        : null,
    fixed_in: fb.fixed_in,
    my_vote: myVote,
  };
}

export async function fullFeedback(env: Env, p: Principal, fb: FeedbackRow) {
  const viewer = viewerUserId(p);
  const priv = canSeePrivate(p, fb);
  const [eventsRes, attRes, voteRow, subRow] = await Promise.all([
    env.DB.prepare("SELECT * FROM events WHERE feedback_id = ? ORDER BY created_at, rowid").bind(fb.id).all<{
      id: string;
      kind: string;
      actor_id: string | null;
      from_value: string | null;
      to_value: string | null;
      note: string | null;
      created_at: number;
    }>(),
    priv
      ? env.DB.prepare(
          "SELECT id, filename, content_type, size, created_at FROM attachments WHERE feedback_id = ? ORDER BY created_at, rowid",
        )
          .bind(fb.id)
          .all()
      : Promise.resolve(null),
    viewer
      ? env.DB.prepare("SELECT 1 AS x FROM votes WHERE feedback_id = ? AND user_id = ?").bind(fb.id, viewer).first()
      : Promise.resolve(null),
    viewer
      ? env.DB.prepare("SELECT 1 AS x FROM subscriptions WHERE feedback_id = ? AND user_id = ?").bind(fb.id, viewer).first()
      : Promise.resolve(null),
  ]);
  const users = await loadUsers(env, [fb.author_id, fb.assignee_id, ...eventsRes.results.map((e) => e.actor_id)]);
  return {
    ...summary(fb, users, voteRow !== null),
    body: fb.body,
    environment: priv && fb.environment ? JSON.parse(fb.environment) : null,
    attachments: priv && attRes ? attRes.results : [],
    events: eventsRes.results.map((e) => ({
      id: e.id,
      kind: e.kind,
      actor: e.actor_id ? (users.get(e.actor_id) ?? null) : null,
      from: e.from_value,
      to: e.to_value,
      note: e.note,
      created_at: e.created_at,
    })),
    assignee: fb.assignee_id ? (users.get(fb.assignee_id) ?? null) : null,
    labels: JSON.parse(fb.labels) as string[],
    duplicate_of: fb.duplicate_of,
    subscribed: subRow !== null,
  };
}

export function eventStmt(
  env: Env,
  feedbackId: string,
  kind: "status" | "assign" | "github_linked" | "release" | "task",
  actorId: string | null,
  from: string | null,
  to: string | null,
  note: string | null,
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO events (id, feedback_id, kind, actor_id, from_value, to_value, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), feedbackId, kind, actorId, from, to, note, now());
}

export function subscribeStmt(env: Env, feedbackId: string, userId: string): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT OR IGNORE INTO subscriptions (feedback_id, user_id, created_at) VALUES (?, ?, ?)",
  ).bind(feedbackId, userId, now());
}

/** Notifies every subscriber except the actor. Returns how many notifications were created. */
export async function notifySubscribers(
  env: Env,
  feedbackId: string,
  actorUserId: string | null,
  kind: "reply" | "status" | "released",
  title: string,
  body: string,
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO notifications (id, user_id, feedback_id, kind, title, body, created_at, read_at)
     SELECT lower(hex(randomblob(16))), s.user_id, s.feedback_id, ?, ?, ?, ?, NULL
       FROM subscriptions s
      WHERE s.feedback_id = ? AND (? IS NULL OR s.user_id <> ?)`,
  )
    .bind(kind, title, body, now(), feedbackId, actorUserId, actorUserId)
    .run();
  return res.meta.changes ?? 0;
}

export const notificationTitle = (fb: FeedbackRow) => `#${fb.number} ${fb.title}`;

export function productName(env: Env, id: string): string {
  return products(env)[id]?.name ?? id;
}

/**
 * Applies a status change (already validated by the caller), records the event, notifies subscribers
 * and, if requested, mirrors close/reopen to the linked GitHub issue.
 */
export async function applyStatus(
  env: Env,
  fb: FeedbackRow,
  to: Status,
  opts: {
    actorUserId: string | null;
    resolution?: string | null;
    note?: string | null;
    mirrorToGitHub: boolean;
    extra?: D1PreparedStatement[];
  },
): Promise<number> {
  const from = fb.status;
  const resolution = to === "closed" ? (opts.resolution ?? "completed") : null;
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE feedback SET status = ?, resolution = ?, updated_at = ? WHERE id = ?").bind(
      to,
      resolution,
      t,
      fb.id,
    ),
    eventStmt(env, fb.id, "status", opts.actorUserId, from, to, opts.note ?? (resolution ? `resolution: ${resolution}` : null)),
    ...(opts.extra ?? []),
  ]);
  fb.status = to;
  fb.resolution = resolution;
  fb.updated_at = t;
  const label = resolution ? `${to} (${resolution})` : to;
  const notified = await notifySubscribers(env, fb.id, opts.actorUserId, "status", notificationTitle(fb), `狀態：${from} → ${label}`);
  if (opts.mirrorToGitHub && fb.github_number !== null && fb.github_repo && env.GITHUB_TOKEN) {
    try {
      if (to === "closed") {
        await gh.setIssueState(
          env.GITHUB_TOKEN,
          fb.github_repo,
          fb.github_number,
          "closed",
          resolution === "completed" ? "completed" : "not_planned",
        );
      } else if (from === "closed" && to === "open") {
        await gh.setIssueState(env.GITHUB_TOKEN, fb.github_repo, fb.github_number, "open");
      }
    } catch (e) {
      console.error("GitHub issue state mirror failed", e instanceof Error ? e.message : "error");
    }
  }
  return notified;
}

/** Escapes HTML comment openers so user text cannot hide content or fake our markers on GitHub. */
export function neutralizeForGitHub(text: string): string {
  return text.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
}
