// Worker bindings and configuration.

export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  ENVIRONMENT: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_BOT_LOGIN?: string;
  MAINTAINER_LOGINS: string;
  PRODUCTS: string;
  /** secret */
  GITHUB_TOKEN?: string;
  /** secret */
  GITHUB_WEBHOOK_SECRET?: string;
}

export interface Product {
  id: string;
  name: string;
  repo: string;
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function products(env: Env): Record<string, Product> {
  let raw: unknown;
  try {
    raw = JSON.parse(env.PRODUCTS || "{}");
  } catch {
    throw new Error("PRODUCTS is not valid JSON");
  }
  const out: Record<string, Product> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const { name, repo } = v as { name?: unknown; repo?: unknown };
    if (typeof repo !== "string" || !REPO_RE.test(repo)) continue;
    out[id] = { id, name: typeof name === "string" && name ? name : id, repo };
  }
  return out;
}

export function maintainerLogins(env: Env): Set<string> {
  return new Set(
    (env.MAINTAINER_LOGINS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const isDevelopment = (env: Env) => env.ENVIRONMENT === "development";
