// Principals: anonymous, user sessions and service tokens. Only SHA-256 digests of tokens are stored.
import { sha256Hex, randomToken } from "./crypto";
import type { Env } from "./env";
import { maintainerLogins } from "./env";
import { ApiError } from "./http";
import { now } from "./ratelimit";
import type { ServiceRole, UserRole } from "./validate";

export const SESSION_TTL = 30 * 24 * 3600;

export interface UserRow {
  id: string;
  github_id: number | null;
  login: string;
  login_lc: string;
  avatar_url: string | null;
  github_created_at: number;
  created_at: number;
}

export type Principal =
  | { kind: "anon" }
  | { kind: "user"; user: UserRow; role: UserRole; banned: boolean; tokenHash: string }
  | { kind: "service"; id: string; name: string; role: ServiceRole };

export type UserPrincipal = Extract<Principal, { kind: "user" }>;
export type ServicePrincipal = Extract<Principal, { kind: "service" }>;

const RANK: Record<UserRole, number> = { user: 0, developer: 1, maintainer: 2 };
export const atLeast = (role: UserRole, min: UserRole) => RANK[role] >= RANK[min];

export function effectiveRole(env: Env, loginLc: string, dbRole: string | null | undefined): UserRole {
  if (maintainerLogins(env).has(loginLc)) return "maintainer";
  if (dbRole === "developer" || dbRole === "maintainer") return dbRole;
  return "user";
}

export async function roleOf(env: Env, loginLc: string): Promise<UserRole> {
  const r = await env.DB.prepare("SELECT role FROM roles WHERE login_lc = ?").bind(loginLc).first<{ role: string }>();
  return effectiveRole(env, loginLc, r?.role);
}

export async function isBanned(env: Env, loginLc: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT 1 AS x FROM bans WHERE login_lc = ?").bind(loginLc).first();
  return r !== null;
}

export async function resolvePrincipal(env: Env, request: Request): Promise<Principal> {
  const header = request.headers.get("Authorization");
  if (header === null) return { kind: "anon" };
  const m = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(header.trim());
  if (!m) throw new ApiError(401, "unauthenticated", "Malformed Authorization header");
  const hash = await sha256Hex(m[1]);
  const t = now();
  const s = await env.DB.prepare(
    `SELECT u.id, u.github_id, u.login, u.login_lc, u.avatar_url, u.github_created_at, u.created_at, r.role AS db_role,
            (SELECT 1 FROM bans b WHERE b.login_lc = u.login_lc) AS banned
       FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN roles r ON r.login_lc = u.login_lc
      WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(hash, t)
    .first<UserRow & { db_role: string | null; banned: number | null }>();
  if (s) {
    const { db_role, banned, ...user } = s;
    return { kind: "user", user, role: effectiveRole(env, user.login_lc, db_role), banned: !!banned, tokenHash: hash };
  }
  const svc = await env.DB.prepare(
    "SELECT id, name, role FROM service_tokens WHERE token_hash = ? AND revoked_at IS NULL",
  )
    .bind(hash)
    .first<{ id: string; name: string; role: ServiceRole }>();
  if (svc) return { kind: "service", id: svc.id, name: svc.name, role: svc.role };
  throw new ApiError(401, "unauthenticated", "Session expired or invalid");
}

// ---- guards -------------------------------------------------------------------------------------

/** A signed-in human (session). Service tokens get 403 agent_forbidden. */
export function requireSession(p: Principal): UserPrincipal {
  if (p.kind === "anon") throw new ApiError(401, "unauthenticated", "Sign in first");
  if (p.kind === "service") throw new ApiError(403, "agent_forbidden", "Service tokens cannot do this");
  return p;
}

/** A signed-in, non-banned human, for writes. */
export function requireWriter(p: Principal, min: UserRole = "user"): UserPrincipal {
  const u = requireSession(p);
  if (u.banned) throw new ApiError(403, "banned", "This account is banned");
  if (!atLeast(u.role, min)) throw new ApiError(403, "forbidden", `Requires role ${min}`);
  return u;
}

/** Any authenticated principal (session or service). */
export function requireAuthenticated(p: Principal): Exclude<Principal, { kind: "anon" }> {
  if (p.kind === "anon") throw new ApiError(401, "unauthenticated", "Sign in first");
  return p;
}

export const isDevPlus = (p: Principal) => p.kind === "user" && atLeast(p.role, "developer");

// ---- sessions -----------------------------------------------------------------------------------

export async function createSession(env: Env, userId: string): Promise<{ session: string; expires_at: number }> {
  const token = randomToken();
  const t = now();
  const expires_at = t + SESSION_TTL;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").bind(userId, t),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
      await sha256Hex(token),
      userId,
      t,
      expires_at,
    ),
  ]);
  return { session: token, expires_at };
}

/** Inserts or updates a user from GitHub (`githubId` null for local development users). */
export async function upsertUser(
  env: Env,
  u: { github_id: number | null; login: string; avatar_url: string | null; github_created_at: number },
): Promise<UserRow> {
  const t = now();
  const loginLc = u.login.toLowerCase();
  let existing: UserRow | null = null;
  if (u.github_id !== null) {
    existing = await env.DB.prepare("SELECT * FROM users WHERE github_id = ?").bind(u.github_id).first<UserRow>();
  }
  if (!existing) {
    existing = await env.DB.prepare("SELECT * FROM users WHERE login_lc = ?").bind(loginLc).first<UserRow>();
    if (existing && u.github_id !== null && existing.github_id !== null && existing.github_id !== u.github_id) {
      // the login was renamed on GitHub and is now owned by someone else: free the old record's login
      await env.DB.prepare("UPDATE users SET login_lc = ? WHERE id = ?")
        .bind(`${existing.login_lc}#${existing.github_id}`, existing.id)
        .run();
      existing = null;
    }
  }
  if (existing) {
    await env.DB.prepare(
      "UPDATE users SET login = ?, login_lc = ?, avatar_url = ?, github_id = COALESCE(?, github_id), github_created_at = ?, updated_at = ? WHERE id = ?",
    )
      .bind(u.login, loginLc, u.avatar_url, u.github_id, u.github_created_at, t, existing.id)
      .run();
    return { ...existing, login: u.login, login_lc: loginLc, avatar_url: u.avatar_url, github_created_at: u.github_created_at };
  }
  const row: UserRow = {
    id: crypto.randomUUID(),
    github_id: u.github_id,
    login: u.login,
    login_lc: loginLc,
    avatar_url: u.avatar_url,
    github_created_at: u.github_created_at,
    created_at: t,
  };
  await env.DB.prepare(
    "INSERT INTO users (id, github_id, login, login_lc, avatar_url, github_created_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, row.github_id, row.login, row.login_lc, row.avatar_url, row.github_created_at, t, t)
    .run();
  return row;
}
