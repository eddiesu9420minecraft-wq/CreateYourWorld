// Every outbound call to GitHub goes through this module, so tests can replace the fetch function.
// GITHUB_TOKEN and user tokens never leave this module in a response.
import { REPO_RE } from "./validate";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

let fetchOverride: FetchFn | null = null;

/** Test hook: replace the outbound fetch (null restores the global fetch). */
export function setGitHubFetch(fn: FetchFn | null): void {
  fetchOverride = fn;
}

function doFetch(url: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", "cyw-feedback");
  const finalInit: RequestInit = { ...init, headers, redirect: "manual" };
  return fetchOverride ? fetchOverride(url, finalInit) : fetch(url, finalInit);
}

export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJsonSafe(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (text.length > 1024 * 1024) throw new GitHubError(502, "GitHub response too large");
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---- OAuth device flow (public client id only, no client secret) -----------------------------

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export async function requestDeviceCode(clientId: string): Promise<DeviceCode> {
  const res = await doFetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "" }),
  });
  const j = await readJsonSafe(res);
  if (!res.ok || typeof j.device_code !== "string" || typeof j.user_code !== "string") {
    throw new GitHubError(502, "GitHub device code request failed");
  }
  return {
    device_code: j.device_code,
    user_code: j.user_code,
    verification_uri: typeof j.verification_uri === "string" ? j.verification_uri : "https://github.com/login/device",
    interval: typeof j.interval === "number" ? j.interval : 5,
    expires_in: typeof j.expires_in === "number" ? j.expires_in : 900,
  };
}

export type TokenPoll =
  | { kind: "token"; accessToken: string }
  | { kind: "pending" }
  | { kind: "slow_down"; interval: number | null }
  | { kind: "error"; error: string };

export async function pollDeviceToken(clientId: string, deviceCode: string): Promise<TokenPoll> {
  const res = await doFetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const j = await readJsonSafe(res);
  if (typeof j.access_token === "string" && j.access_token) return { kind: "token", accessToken: j.access_token };
  const error = typeof j.error === "string" ? j.error : "unknown_error";
  if (error === "authorization_pending") return { kind: "pending" };
  if (error === "slow_down") return { kind: "slow_down", interval: typeof j.interval === "number" ? j.interval : null };
  return { kind: "error", error };
}

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string | null;
  created_at: number; // unix seconds
}

/** Reads /user with the user's token. The caller must discard the token afterwards. */
export async function fetchUser(userToken: string): Promise<GitHubUser> {
  const res = await doFetch("https://api.github.com/user", {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${userToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const j = await readJsonSafe(res);
  if (!res.ok || typeof j.id !== "number" || typeof j.login !== "string") {
    throw new GitHubError(502, "GitHub /user request failed");
  }
  const created = typeof j.created_at === "string" ? Date.parse(j.created_at) : NaN;
  return {
    id: j.id,
    login: j.login,
    avatar_url: typeof j.avatar_url === "string" ? j.avatar_url : null,
    created_at: Number.isFinite(created) ? Math.floor(created / 1000) : 0,
  };
}

// ---- Issues (service token GITHUB_TOKEN) ------------------------------------------------------

function api(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return doFetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function repoPath(repo: string): string {
  if (!REPO_RE.test(repo)) throw new GitHubError(500, "invalid repository name");
  return `/repos/${repo}`;
}

export async function createIssue(
  token: string,
  repo: string,
  issue: { title: string; body: string; labels: string[] },
): Promise<{ number: number; html_url: string }> {
  const res = await api(token, "POST", `${repoPath(repo)}/issues`, issue);
  const j = await readJsonSafe(res);
  if (res.status !== 201 || typeof j.number !== "number" || typeof j.html_url !== "string") {
    throw new GitHubError(502, `GitHub issue creation failed (${res.status})`);
  }
  return { number: j.number, html_url: j.html_url };
}

export async function createIssueComment(
  token: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<{ id: number }> {
  const res = await api(token, "POST", `${repoPath(repo)}/issues/${issueNumber}/comments`, { body });
  const j = await readJsonSafe(res);
  if (res.status !== 201 || typeof j.id !== "number") {
    throw new GitHubError(502, `GitHub comment creation failed (${res.status})`);
  }
  return { id: j.id };
}

export async function setIssueState(
  token: string,
  repo: string,
  issueNumber: number,
  state: "open" | "closed",
  stateReason?: "completed" | "not_planned",
): Promise<void> {
  const body: Record<string, string> = { state };
  if (state === "closed" && stateReason) body.state_reason = stateReason;
  const res = await api(token, "PATCH", `${repoPath(repo)}/issues/${issueNumber}`, body);
  await res.body?.cancel();
  if (!res.ok) throw new GitHubError(502, `GitHub issue update failed (${res.status})`);
}
