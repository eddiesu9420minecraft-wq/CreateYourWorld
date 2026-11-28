// Auth: GitHub OAuth device flow, local development sign-in, logout, me.
import { createSession, requireSession, roleOf, upsertUser, type UserRow } from "../auth";
import { isDevelopment, maintainerLogins } from "../env";
import * as gh from "../github";
import { ApiError, json, noContent, readJson } from "../http";
import { hit, now } from "../ratelimit";
import type { Ctx } from "../router";
import { requireLogin, USER_ROLES, isEnum } from "../validate";

async function sessionResponse(c: Ctx, user: UserRow) {
  const { session, expires_at } = await createSession(c.env, user.id);
  const role = await roleOf(c.env, user.login_lc);
  return json({ session, expires_at, user: { login: user.login, role, avatar_url: user.avatar_url } });
}

function requireClientId(c: Ctx): string {
  const id = c.env.GITHUB_OAUTH_CLIENT_ID;
  if (!id) throw new ApiError(503, "not_configured", "GitHub sign-in is not configured on this server");
  return id;
}

export async function deviceStart(c: Ctx) {
  const clientId = requireClientId(c);
  try {
    const d = await gh.requestDeviceCode(clientId);
    return json(d);
  } catch (e) {
    if (e instanceof gh.GitHubError) throw new ApiError(502, "github_unavailable", "GitHub did not answer");
    throw e;
  }
}

export async function deviceToken(c: Ctx) {
  // Polling is limited by its own bucket (a device flow may legitimately poll every 5 s for 15 min).
  await hit(c.env.DB, "auth.poll", c.ipKey);
  const clientId = requireClientId(c);
  const body = await readJson(c.request);
  const deviceCode = body.device_code;
  if (typeof deviceCode !== "string" || deviceCode.length < 1 || deviceCode.length > 200) {
    throw new ApiError(400, "invalid_body", "device_code is required");
  }
  const prevInterval =
    typeof body.interval === "number" && Number.isFinite(body.interval) ? Math.min(Math.max(body.interval, 1), 120) : 5;
  let r: gh.TokenPoll;
  try {
    r = await gh.pollDeviceToken(clientId, deviceCode);
  } catch {
    throw new ApiError(502, "github_unavailable", "GitHub did not answer");
  }
  if (r.kind === "pending") return json({ pending: true, interval: prevInterval }, 202);
  if (r.kind === "slow_down") return json({ pending: true, interval: r.interval ?? prevInterval + 5 }, 202);
  if (r.kind === "error") {
    const code = r.error === "expired_token" || r.error === "access_denied" ? r.error : "device_flow_failed";
    throw new ApiError(400, code, `GitHub device flow: ${code}`);
  }
  // Use the user token exactly once to read /user, then drop it.
  let accessToken: string | null = r.accessToken;
  let ghUser: gh.GitHubUser;
  try {
    ghUser = await gh.fetchUser(accessToken);
  } catch {
    throw new ApiError(502, "github_unavailable", "Could not read the GitHub user");
  } finally {
    accessToken = null;
  }
  void accessToken;
  const user = await upsertUser(c.env, {
    github_id: ghUser.id,
    login: ghUser.login,
    avatar_url: ghUser.avatar_url,
    github_created_at: ghUser.created_at,
  });
  return sessionResponse(c, user);
}

/** Local development sign-in. 404 unless ENVIRONMENT = "development". */
export async function devLogin(c: Ctx) {
  if (!isDevelopment(c.env)) throw new ApiError(404, "not_found", "Not found");
  await hit(c.env.DB, "auth", c.ipKey);
  const body = await readJson(c.request);
  const login = requireLogin(body.login);
  const role = body.role === undefined ? "user" : body.role;
  if (!isEnum(role, USER_ROLES)) throw new ApiError(400, "invalid_body", "role must be user, developer or maintainer");
  let githubCreatedAt = 0; // dev accounts count as old GitHub accounts unless told otherwise
  if (body.github_created_at !== undefined) {
    if (typeof body.github_created_at !== "number" || !Number.isInteger(body.github_created_at)) {
      throw new ApiError(400, "invalid_body", "github_created_at must be an integer (unix seconds)");
    }
    githubCreatedAt = body.github_created_at;
  }
  const user = await upsertUser(c.env, { github_id: null, login, avatar_url: null, github_created_at: githubCreatedAt });
  if (!maintainerLogins(c.env).has(user.login_lc)) {
    await c.env.DB.prepare(
      "INSERT INTO roles (login_lc, role, granted_by, granted_at) VALUES (?, ?, 'dev-auth', ?) ON CONFLICT(login_lc) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at",
    )
      .bind(user.login_lc, role, now())
      .run();
  }
  return sessionResponse(c, user);
}

export async function logout(c: Ctx) {
  const p = requireSession(c.principal);
  await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(p.tokenHash).run();
  return noContent();
}

export async function me(c: Ctx) {
  const p = requireSession(c.principal);
  return json({
    user: { login: p.user.login, github_id: p.user.github_id, role: p.role, avatar_url: p.user.avatar_url },
  });
}
