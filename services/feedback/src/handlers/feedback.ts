// Feedback, votes, comments, subscriptions and attachments.
import { atLeast, isDevPlus, requireSession, requireWriter } from "../auth";
import {
  ATTACHMENT_TYPES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_BYTES,
  checkImage,
  decodeUtf8Log,
  sanitizeFilename,
} from "../attachments-check";
import { sha256Hex } from "../crypto";
import { products } from "../env";
import * as gh from "../github";
import { ApiError, json, noContent, readBodyLimited, readJson } from "../http";
import {
  applyStatus,
  canSeePrivate,
  eventStmt,
  findUserByLogin,
  fullFeedback,
  getFeedback,
  loadUsers,
  neutralizeForGitHub,
  notificationTitle,
  notifySubscribers,
  subscribeStmt,
  summary,
  viewerUserId,
  type FeedbackRow,
} from "../model";
import { count, now } from "../ratelimit";
import { redact, totalRedactions } from "../redact";
import type { Ctx } from "../router";
import {
  CATEGORIES,
  RESOLUTIONS,
  STATUSES,
  charLength,
  countLinks,

  normalizeForDuplicate,
  normalizeText,
  optionalString,
  parseEnvironment,
  parseIntParam,
  parseLabels,
  requireEnum,
  requireLogin,
  requireString,
  type Status,
} from "../validate";
import { canTransition } from "../transitions";

const MAX_LINKS = 5;
const NEW_ACCOUNT_AGE = 7 * 86400;

// ---- create -------------------------------------------------------------------------------------

export async function createFeedback(c: Ctx) {
  const p = requireWriter(c.principal);
  const body = await readJson(c.request);

  // Honeypot: real clients always send an empty `website`.
  if (body.website !== undefined && body.website !== null && body.website !== "") {
    await count(c.env.DB, `spam:user:${p.user.id}`);
    throw new ApiError(400, "invalid_body", "Invalid submission");
  }

  const consent = body.consent;
  if (typeof consent !== "object" || consent === null || Array.isArray(consent)) {
    throw new ApiError(400, "consent_required", "consent is required");
  }
  const cons = consent as Record<string, unknown>;
  if (cons.content !== true) throw new ApiError(400, "consent_required", "consent.content must be true");
  if (typeof cons.preview_sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(cons.preview_sha256)) {
    throw new ApiError(400, "consent_required", "consent.preview_sha256 must be the SHA-256 hex of the previewed payload");
  }
  const envConsent = cons.environment === true;

  const catalog = products(c.env);
  const product = body.product;
  if (typeof product !== "string" || !Object.hasOwn(catalog, product)) {
    throw new ApiError(400, "invalid_body", "Unknown product");
  }
  const category = requireEnum(body.category, CATEGORIES, "category");
  const rawTitle = requireString(body, "title", 5, 120);
  const rawBody = requireString(body, "body", 10, 8000, { multiline: true });

  let environment: Record<string, string> | null = null;
  if (body.environment !== undefined && body.environment !== null) {
    if (!envConsent) {
      throw new ApiError(400, "consent_required", "environment may only be sent with consent.environment = true");
    }
    environment = parseEnvironment(body.environment);
  }

  // Server-side redaction (same rules as the client).
  const t1 = redact(rawTitle);
  const b1 = redact(rawBody);
  let redactions = totalRedactions(t1.counts) + totalRedactions(b1.counts);
  if (environment) {
    for (const k of Object.keys(environment)) {
      const r = redact(environment[k]);
      environment[k] = r.text;
      redactions += totalRedactions(r.counts);
    }
  }
  const title = t1.text;
  const text = b1.text;

  if (countLinks(rawTitle) + countLinks(rawBody) > MAX_LINKS) {
    await count(c.env.DB, `spam:user:${p.user.id}`);
    throw new ApiError(400, "too_many_links", `At most ${MAX_LINKS} links`);
  }

  const t = now();
  const bodyHash = await sha256Hex(normalizeForDuplicate(text));
  const dup = await c.env.DB.prepare(
    "SELECT id FROM feedback WHERE author_id = ? AND body_hash = ? AND created_at > ? LIMIT 1",
  )
    .bind(p.user.id, bodyHash, t - 86400)
    .first<{ id: string }>();
  if (dup) throw new ApiError(409, "duplicate", "You already sent this feedback in the last 24 hours");

  // GitHub accounts younger than 7 days: 1 feedback per day.
  if (p.user.github_created_at > 0 && p.user.github_created_at > t - NEW_ACCOUNT_AGE) {
    const recent = await c.env.DB.prepare(
      "SELECT MIN(created_at) AS first, COUNT(*) AS n FROM feedback WHERE author_id = ? AND created_at > ?",
    )
      .bind(p.user.id, t - 86400)
      .first<{ first: number | null; n: number }>();
    if (recent && recent.n >= 1) {
      const retry = Math.max(1, (recent.first ?? t) + 86400 - t);
      throw new ApiError(429, "rate_limited", "New GitHub accounts can send one feedback per day", {
        "Retry-After": String(retry),
      });
    }
  }

  const id = crypto.randomUUID();
  const consentJson = JSON.stringify({
    content: true,
    environment: envConsent,
    preview_sha256: (cons.preview_sha256 as string).toLowerCase(),
    at: t,
  });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO feedback (id, number, product, category, title, body, body_hash, environment, consent, author_id,
                             status, labels, created_at, updated_at)
       SELECT ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, 'open', '[]', ?, ? FROM feedback`,
    ).bind(id, product, category, title, text, bodyHash, environment ? JSON.stringify(environment) : null, consentJson, p.user.id, t, t),
    subscribeStmt(c.env, id, p.user.id),
  ]);
  const fb = await getFeedback(c.env, id);
  return json({ feedback: await fullFeedback(c.env, c.principal, fb), server_redactions: redactions }, 201);
}

// ---- list / read --------------------------------------------------------------------------------

export async function listFeedback(c: Ctx) {
  const q = c.url.searchParams;
  const where: string[] = [];
  const args: (string | number)[] = [];

  const text = q.get("q");
  if (text !== null && text !== "") {
    const s = normalizeText(text);
    if (charLength(s) > 100) throw new ApiError(400, "too_long", "q must be at most 100 characters");
    if (s !== "") {
      const like = `%${s.toLowerCase().replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
      where.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(body) LIKE ? ESCAPE '\\')");
      args.push(like, like);
    }
  }
  const product = q.get("product");
  if (product) {
    where.push("product = ?");
    args.push(product);
  }
  const category = q.get("category");
  if (category) {
    where.push("category = ?");
    args.push(requireEnum(category, CATEGORIES, "category"));
  }
  const status = q.get("status");
  if (status) {
    if (status === "active") where.push("status NOT IN ('closed', 'released')");
    else {
      where.push("status = ?");
      args.push(requireEnum(status, STATUSES, "status"));
    }
  }
  if (q.get("mine") === "1") {
    const p = requireSession(c.principal);
    where.push("author_id = ?");
    args.push(p.user.id);
  }
  const sort = q.get("sort") ?? "new";
  const orderBy =
    sort === "votes"
      ? "votes DESC, created_at DESC, number DESC"
      : sort === "updated"
        ? "updated_at DESC, number DESC"
        : sort === "new"
          ? "created_at DESC, number DESC"
          : null;
  if (!orderBy) throw new ApiError(400, "invalid_body", "sort must be votes, new or updated");
  const page = parseIntParam(q.get("page"), 1, 1, 100000, "page");
  const perPage = parseIntParam(q.get("per_page"), 20, 1, 100, "per_page");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [totalRow, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM feedback ${whereSql}`)
      .bind(...args)
      .first<{ n: number }>(),
    c.env.DB.prepare(`SELECT * FROM feedback ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .bind(...args, perPage, (page - 1) * perPage)
      .all<FeedbackRow>(),
  ]);
  const items = rows.results;
  const users = await loadUsers(c.env, items.map((f) => f.author_id));
  const viewer = viewerUserId(c.principal);
  const myVotes = new Set<string>();
  if (viewer && items.length) {
    const v = await c.env.DB.prepare(
      `SELECT feedback_id FROM votes WHERE user_id = ? AND feedback_id IN (${items.map(() => "?").join(",")})`,
    )
      .bind(viewer, ...items.map((f) => f.id))
      .all<{ feedback_id: string }>();
    for (const r of v.results) myVotes.add(r.feedback_id);
  }
  return json({
    items: items.map((f) => summary(f, users, myVotes.has(f.id))),
    total: totalRow?.n ?? 0,
    page,
    per_page: perPage,
  });
}

export async function getOne(c: Ctx) {
  const fb = await getFeedback(c.env, c.params.id);
  return json({ feedback: await fullFeedback(c.env, c.principal, fb) });
}

// ---- update / close -----------------------------------------------------------------------------

export async function patchFeedback(c: Ctx) {
  const p = requireWriter(c.principal, "developer");
  const fb = await getFeedback(c.env, c.params.id);
  const body = await readJson(c.request);
  const stmts: D1PreparedStatement[] = [];
  const t = now();

  let newStatus: Status | null = null;
  if (body.status !== undefined) {
    const to = requireEnum(body.status, STATUSES, "status");
    if (to !== fb.status) {
      if (to === "released") {
        throw new ApiError(409, "invalid_transition", "released is only set by POST /v1/releases");
      }
      if (!canTransition(fb.status, to)) {
        throw new ApiError(409, "invalid_transition", `Cannot change status from ${fb.status} to ${to}`);
      }
      newStatus = to;
    }
  }

  if (body.assignee !== undefined) {
    let assigneeId: string | null = null;
    let assigneeLogin: string | null = null;
    if (body.assignee !== null) {
      const login = requireLogin(body.assignee, "assignee");
      const u = await findUserByLogin(c.env, login);
      if (!u) throw new ApiError(400, "invalid_body", "assignee is not a known user");
      const users = await loadUsers(c.env, [u.id]);
      if (!atLeast((users.get(u.id)?.role ?? "user") as "user", "developer")) {
        throw new ApiError(400, "invalid_body", "assignee must be a developer or maintainer");
      }
      assigneeId = u.id;
      assigneeLogin = u.login;
    }
    if (assigneeId !== fb.assignee_id) {
      const old = fb.assignee_id ? (await loadUsers(c.env, [fb.assignee_id])).get(fb.assignee_id)?.login ?? null : null;
      stmts.push(c.env.DB.prepare("UPDATE feedback SET assignee_id = ?, updated_at = ? WHERE id = ?").bind(assigneeId, t, fb.id));
      stmts.push(eventStmt(c.env, fb.id, "assign", p.user.id, old, assigneeLogin, null));
    }
  }

  if (body.labels !== undefined) {
    const labels = parseLabels(body.labels).map((l) => redact(l).text);
    stmts.push(c.env.DB.prepare("UPDATE feedback SET labels = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(labels), t, fb.id));
  }

  let duplicateOf: string | null = null;
  if (body.duplicate_of !== undefined && body.duplicate_of !== null) {
    if (typeof body.duplicate_of !== "string" && typeof body.duplicate_of !== "number") {
      throw new ApiError(400, "invalid_body", "duplicate_of must be a feedback id");
    }
    let target: FeedbackRow;
    try {
      target = await getFeedback(c.env, String(body.duplicate_of));
    } catch {
      throw new ApiError(400, "invalid_body", "duplicate_of is not a known feedback");
    }
    if (target.id === fb.id) throw new ApiError(400, "invalid_body", "duplicate_of cannot be the feedback itself");
    duplicateOf = target.id;
    stmts.push(c.env.DB.prepare("UPDATE feedback SET duplicate_of = ?, updated_at = ? WHERE id = ?").bind(duplicateOf, t, fb.id));
  }

  if (stmts.length) await c.env.DB.batch(stmts);
  if (newStatus) {
    const fresh = await getFeedback(c.env, fb.id);
    await applyStatus(c.env, fresh, newStatus, {
      actorUserId: p.user.id,
      resolution: newStatus === "closed" ? (duplicateOf ? "duplicate" : "completed") : null,
      mirrorToGitHub: true,
    });
  }
  const out = await getFeedback(c.env, fb.id);
  return json({ feedback: await fullFeedback(c.env, c.principal, out) });
}

export async function closeFeedback(c: Ctx) {
  const p = requireWriter(c.principal);
  const fb = await getFeedback(c.env, c.params.id);
  const dev = isDevPlus(p);
  const isAuthor = fb.author_id === p.user.id;
  if (!dev && !isAuthor) throw new ApiError(403, "forbidden", "Only the author or a developer can close this");
  const body = await readJson(c.request);
  const resolution = requireEnum(body.resolution, RESOLUTIONS, "resolution");
  if (!dev && resolution !== "completed") {
    throw new ApiError(403, "forbidden", "Authors can only close with resolution completed");
  }
  const noteRaw = optionalString(body, "note", 1000, { multiline: true });
  const note = noteRaw ? redact(noteRaw).text : null;
  if (fb.status === "closed") throw new ApiError(409, "invalid_transition", "Already closed");
  await applyStatus(c.env, fb, "closed", { actorUserId: p.user.id, resolution, note, mirrorToGitHub: true });
  const out = await getFeedback(c.env, fb.id);
  return json({ feedback: await fullFeedback(c.env, c.principal, out) });
}

// ---- votes --------------------------------------------------------------------------------------

async function recountVotes(c: Ctx, fbId: string): Promise<number> {
  const r = await c.env.DB.prepare(
    "UPDATE feedback SET votes = (SELECT COUNT(*) FROM votes WHERE feedback_id = ?1) WHERE id = ?1 RETURNING votes",
  )
    .bind(fbId)
    .first<{ votes: number }>();
  return r?.votes ?? 0;
}

export async function vote(c: Ctx) {
  const p = requireWriter(c.principal);
  const fb = await getFeedback(c.env, c.params.id);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO votes (feedback_id, user_id, created_at) VALUES (?, ?, ?)").bind(fb.id, p.user.id, now()),
    subscribeStmt(c.env, fb.id, p.user.id),
  ]);
  return json({ votes: await recountVotes(c, fb.id), my_vote: true });
}

export async function unvote(c: Ctx) {
  const p = requireWriter(c.principal);
  const fb = await getFeedback(c.env, c.params.id);
  await c.env.DB.prepare("DELETE FROM votes WHERE feedback_id = ? AND user_id = ?").bind(fb.id, p.user.id).run();
  return json({ votes: await recountVotes(c, fb.id), my_vote: false });
}

// ---- comments -----------------------------------------------------------------------------------

interface CommentRow {
  id: string;
  feedback_id: string;
  author_id: string | null;
  body: string;
  official: number;
  source: "cyw" | "github";
  github_author: string | null;
  hidden: number;
  created_at: number;
}

function commentView(r: CommentRow, users: Map<string, { login: string; role: string; avatar_url: string | null }>, showHidden: boolean) {
  return {
    id: r.id,
    author: r.author_id ? (users.get(r.author_id) ?? null) : null,
    body: r.hidden && !showHidden ? "" : r.body,
    official: !!r.official,
    source: r.source,
    github_author: r.github_author,
    hidden: !!r.hidden,
    created_at: r.created_at,
  };
}

export async function listComments(c: Ctx) {
  const fb = await getFeedback(c.env, c.params.id);
  const rows = await c.env.DB.prepare("SELECT * FROM comments WHERE feedback_id = ? ORDER BY created_at, rowid LIMIT 1000")
    .bind(fb.id)
    .all<CommentRow>();
  const users = await loadUsers(c.env, rows.results.map((r) => r.author_id));
  const isMaintainer = c.principal.kind === "user" && c.principal.role === "maintainer";
  return json({ items: rows.results.map((r) => commentView(r, users, isMaintainer)) });
}

export async function createComment(c: Ctx) {
  const p = requireWriter(c.principal);
  const fb = await getFeedback(c.env, c.params.id);
  const body = await readJson(c.request);
  const raw = requireString(body, "body", 1, 4000, { multiline: true });
  if (body.official !== undefined && typeof body.official !== "boolean") {
    throw new ApiError(400, "invalid_body", "official must be a boolean");
  }
  const official = body.official === true;
  if (official && !isDevPlus(p)) throw new ApiError(403, "forbidden", "Official replies require developer");
  const text = redact(raw).text;
  const id = crypto.randomUUID();
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO comments (id, feedback_id, author_id, body, official, source, hidden, created_at) VALUES (?, ?, ?, ?, ?, 'cyw', 0, ?)",
    ).bind(id, fb.id, p.user.id, text, official ? 1 : 0, t),
    c.env.DB.prepare("UPDATE feedback SET comments = comments + 1, updated_at = ? WHERE id = ?").bind(t, fb.id),
    subscribeStmt(c.env, fb.id, p.user.id),
  ]);
  if (official) {
    const preview = [...text].slice(0, 200).join("");
    await notifySubscribers(c.env, fb.id, p.user.id, "reply", notificationTitle(fb), `${p.user.login} 官方回覆：${preview}`);
  }
  // Mirror to the linked GitHub issue.
  if (fb.github_number !== null && fb.github_repo && c.env.GITHUB_TOKEN) {
    try {
      const r = await gh.createIssueComment(
        c.env.GITHUB_TOKEN,
        fb.github_repo,
        fb.github_number,
        `**${p.user.login}** (CYW): ${neutralizeForGitHub(text)}\n\n<!-- cyw-comment:${id} -->`,
      );
      await c.env.DB.prepare("UPDATE comments SET github_comment_id = ? WHERE id = ?").bind(r.id, id).run();
    } catch (e) {
      console.error("GitHub comment mirror failed", e instanceof Error ? e.message : "error");
    }
  }
  const row = await c.env.DB.prepare("SELECT * FROM comments WHERE id = ?").bind(id).first<CommentRow>();
  const users = await loadUsers(c.env, [p.user.id]);
  return json({ comment: commentView(row!, users, true) }, 201);
}

export async function hideComment(c: Ctx) {
  requireWriter(c.principal, "maintainer");
  const r = await c.env.DB.prepare("UPDATE comments SET hidden = 1 WHERE id = ?").bind(c.params.id).run();
  if (!r.meta.changes) throw new ApiError(404, "not_found", "Comment not found");
  return noContent();
}

// ---- subscriptions ------------------------------------------------------------------------------

export async function subscribe(c: Ctx) {
  const p = requireWriter(c.principal);
  const fb = await getFeedback(c.env, c.params.id);
  await subscribeStmt(c.env, fb.id, p.user.id).run();
  return json({ subscribed: true });
}

export async function unsubscribe(c: Ctx) {
  const p = requireWriter(c.principal);
  const fb = await getFeedback(c.env, c.params.id);
  await c.env.DB.prepare("DELETE FROM subscriptions WHERE feedback_id = ? AND user_id = ?").bind(fb.id, p.user.id).run();
  return json({ subscribed: false });
}

// ---- attachments --------------------------------------------------------------------------------

export async function uploadAttachment(c: Ctx) {
  const p = requireWriter(c.principal);
  const fb = await getFeedback(c.env, c.params.id);
  if (fb.author_id !== p.user.id) throw new ApiError(403, "forbidden", "Only the author can attach files");
  if (fb.status === "closed") throw new ApiError(403, "forbidden", "Feedback is closed");

  const contentType = (c.request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  const spec = ATTACHMENT_TYPES[contentType];
  if (!spec || !Object.hasOwn(ATTACHMENT_TYPES, contentType)) {
    throw new ApiError(415, "unsupported_type", "Allowed: image/png, image/jpeg, image/webp, text/plain");
  }
  const filename = redact(sanitizeFilename(c.request.headers.get("X-Filename"))).text;

  const existing = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM attachments WHERE feedback_id = ?",
  )
    .bind(fb.id)
    .first<{ n: number; total: number }>();
  if ((existing?.n ?? 0) >= MAX_ATTACHMENTS) {
    throw new ApiError(400, "bad_attachment", `At most ${MAX_ATTACHMENTS} attachments per feedback`);
  }

  let bytes = await readBodyLimited(c.request, spec.max);
  if (bytes.byteLength === 0) throw new ApiError(400, "bad_attachment", "Empty attachment");
  if (contentType === "text/plain") {
    const text = decodeUtf8Log(bytes);
    bytes = new TextEncoder().encode(redact(text).text);
  } else {
    checkImage(contentType, bytes);
  }
  if ((existing?.total ?? 0) + bytes.byteLength > MAX_TOTAL_BYTES) {
    throw new ApiError(413, "too_large", "Attachments of one feedback may total at most 8 MiB");
  }

  const id = crypto.randomUUID();
  const key = `attachments/${fb.id}/${id}`;
  const storedType = contentType === "text/plain" ? "text/plain; charset=utf-8" : contentType;
  await c.env.ATTACHMENTS.put(key, bytes, { httpMetadata: { contentType: storedType } });
  const t = now();
  await c.env.DB.prepare(
    "INSERT INTO attachments (id, feedback_id, uploader_id, filename, content_type, size, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, fb.id, p.user.id, filename, contentType, bytes.byteLength, key, t)
    .run();
  return json({ attachment: { id, filename, content_type: contentType, size: bytes.byteLength, created_at: t } }, 201);
}

function contentDisposition(filename: string): string {
  const asciiName = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function downloadAttachment(c: Ctx) {
  const p = requireSession(c.principal);
  const row = await c.env.DB.prepare(
    "SELECT a.*, f.author_id FROM attachments a JOIN feedback f ON f.id = a.feedback_id WHERE a.id = ?",
  )
    .bind(c.params.id)
    .first<{ id: string; feedback_id: string; filename: string; content_type: string; r2_key: string; author_id: string }>();
  if (!row) throw new ApiError(404, "not_found", "Attachment not found");
  if (!canSeePrivate(p, { author_id: row.author_id } as FeedbackRow)) {
    throw new ApiError(403, "forbidden", "Only the author or a developer can read attachments");
  }
  const obj = await c.env.ATTACHMENTS.get(row.r2_key);
  if (!obj) throw new ApiError(404, "not_found", "Attachment not found");
  const type = row.content_type === "text/plain" ? "text/plain; charset=utf-8" : row.content_type;
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(obj.size),
      "Content-Disposition": contentDisposition(row.filename),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

// ---- notifications ------------------------------------------------------------------------------

export async function listNotifications(c: Ctx) {
  const p = requireSession(c.principal);
  const unreadOnly = c.url.searchParams.get("unread") === "1";
  const rows = await c.env.DB.prepare(
    `SELECT id, feedback_id, kind, title, body, created_at, read_at FROM notifications
      WHERE user_id = ? ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC, rowid DESC LIMIT 200`,
  )
    .bind(p.user.id)
    .all<{ id: string; feedback_id: string; kind: string; title: string; body: string; created_at: number; read_at: number | null }>();
  const unread = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL")
    .bind(p.user.id)
    .first<{ n: number }>();
  return json({
    items: rows.results.map((r) => ({
      id: r.id,
      feedback_id: r.feedback_id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      created_at: r.created_at,
      read: r.read_at !== null,
    })),
    unread: unread?.n ?? 0,
  });
}

export async function markNotificationsRead(c: Ctx) {
  const p = requireWriter(c.principal);
  const body = await readJson(c.request);
  const t = now();
  if (body.ids === undefined || body.ids === null) {
    await c.env.DB.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(t, p.user.id).run();
    return noContent();
  }
  if (!Array.isArray(body.ids) || body.ids.length > 200 || !body.ids.every((x) => typeof x === "string" && x.length <= 64)) {
    throw new ApiError(400, "invalid_body", "ids must be an array of at most 200 ids");
  }
  const ids = body.ids as string[];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    if (!chunk.length) continue;
    await c.env.DB.prepare(
      `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(t, p.user.id, ...chunk)
      .run();
  }
  return noContent();
}

