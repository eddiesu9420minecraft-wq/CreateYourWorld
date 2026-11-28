// Maintainer administration: service tokens, roles, bans.
import { effectiveRole, requireWriter } from "../auth";
import { randomToken, sha256Hex } from "../crypto";
import { maintainerLogins } from "../env";
import { ApiError, json, noContent, readJson } from "../http";
import { now } from "../ratelimit";
import type { Ctx } from "../router";
import { optionalString, requireEnum, requireLogin, requireString, SERVICE_ROLES, USER_ROLES } from "../validate";

export async function createToken(c: Ctx) {
  const p = requireWriter(c.principal, "maintainer");
  const body = await readJson(c.request);
  const name = requireString(body, "name", 1, 100);
  const role = requireEnum(body.role, SERVICE_ROLES, "role");
  const token = randomToken();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO service_tokens (id, name, role, token_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, name, role, await sha256Hex(token), p.user.id, now())
    .run();
  // The token is shown once; only its SHA-256 is stored.
  return json({ token, id }, 201);
}

export async function listTokens(c: Ctx) {
  requireWriter(c.principal, "maintainer");
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.role, t.created_at, t.revoked_at, u.login AS created_by
       FROM service_tokens t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.created_at DESC`,
  ).all<{ id: string; name: string; role: string; created_at: number; revoked_at: number | null; created_by: string | null }>();
  return json({
    items: rows.results.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      created_by: r.created_by,
      created_at: r.created_at,
      revoked: r.revoked_at !== null,
    })),
  });
}

export async function revokeToken(c: Ctx) {
  requireWriter(c.principal, "maintainer");
  const r = await c.env.DB.prepare("UPDATE service_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(now(), c.params.id)
    .run();
  if (!r.meta.changes) throw new ApiError(404, "not_found", "Token not found");
  return noContent();
}

export async function putRole(c: Ctx) {
  const p = requireWriter(c.principal, "maintainer");
  const login = requireLogin(c.params.login);
  const lc = login.toLowerCase();
  const body = await readJson(c.request);
  const role = requireEnum(body.role, USER_ROLES, "role");
  if (maintainerLogins(c.env).has(lc) && role !== "maintainer") {
    throw new ApiError(403, "forbidden", "Bootstrap maintainers (MAINTAINER_LOGINS) cannot be demoted here");
  }
  await c.env.DB.prepare(
    "INSERT INTO roles (login_lc, role, granted_by, granted_at) VALUES (?, ?, ?, ?) ON CONFLICT(login_lc) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at",
  )
    .bind(lc, role, p.user.login, now())
    .run();
  const u = await c.env.DB.prepare("SELECT login, avatar_url FROM users WHERE login_lc = ?")
    .bind(lc)
    .first<{ login: string; avatar_url: string | null }>();
  return json({ user: { login: u?.login ?? login, role: effectiveRole(c.env, lc, role), avatar_url: u?.avatar_url ?? null } });
}

export async function ban(c: Ctx) {
  const p = requireWriter(c.principal, "maintainer");
  const login = requireLogin(c.params.login);
  const lc = login.toLowerCase();
  if (maintainerLogins(c.env).has(lc) || lc === p.user.login_lc) {
    throw new ApiError(403, "forbidden", "This account cannot be banned");
  }
  const body = await readJson(c.request);
  const reason = optionalString(body, "reason", 500, { multiline: true }) ?? "";
  await c.env.DB.prepare(
    "INSERT INTO bans (login_lc, reason, banned_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(login_lc) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by",
  )
    .bind(lc, reason, p.user.login, now())
    .run();
  return json({ login, banned: true });
}

export async function unban(c: Ctx) {
  requireWriter(c.principal, "maintainer");
  const login = requireLogin(c.params.login);
  await c.env.DB.prepare("DELETE FROM bans WHERE login_lc = ?").bind(login.toLowerCase()).run();
  return json({ login, banned: false });
}
