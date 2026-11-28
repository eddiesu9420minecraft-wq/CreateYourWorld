// Test helpers: call the Worker inside workerd with local D1/R2, dev sign-in, a GitHub fetch mock, webhook signing.
import { env } from "cloudflare:test";
import { expect } from "vitest";
import { hmacSha256Hex } from "../src/crypto";
import type { Env } from "../src/env";
import { setGitHubFetch } from "../src/github";
import { handle } from "../src/index";

export { env };

let counter = 0;
export function uniq(prefix = "u"): string {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 39);
}

export const randomIp = () =>
  `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

export interface CallOpts {
  token?: string;
  body?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  ip?: string;
  env?: Partial<Env>;
}

export async function call(method: string, path: string, opts: CallOpts = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.token) headers.set("Authorization", `Bearer ${opts.token}`);
  headers.set("CF-Connecting-IP", opts.ip ?? randomIp());
  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  const req = new Request(`http://localhost${path}`, { method, headers, body });
  return handle(req, { ...env, ...(opts.env ?? {}) } as Env);
}

export async function callJson<T = any>(method: string, path: string, opts: CallOpts = {}): Promise<{ status: number; body: T; res: Response }> {
  const res = await call(method, path, opts);
  const text = await res.text();
  let body: any = null;
  if (text) body = JSON.parse(text);
  return { status: res.status, body, res };
}

export interface Session {
  token: string;
  login: string;
  user: { login: string; role: string; avatar_url: string | null };
}

export async function login(role: "user" | "developer" | "maintainer" = "user", name?: string, extra: Record<string, unknown> = {}): Promise<Session> {
  const l = name ?? uniq(role[0]);
  const r = await callJson("POST", "/v1/auth/dev", { body: { login: l, role, ...extra } });
  expect(r.status).toBe(200);
  return { token: r.body.session, login: l, user: r.body.user };
}

/** The bootstrap maintainer configured in vitest.config.ts (MAINTAINER_LOGINS). */
export const BOOTSTRAP_MAINTAINER = "boss-maintainer";

export async function serviceToken(maintainer: Session, role: "agent" | "cyws", name = uniq(role)): Promise<string> {
  const r = await callJson("POST", "/v1/admin/tokens", { token: maintainer.token, body: { name, role } });
  expect(r.status).toBe(201);
  return r.body.token;
}

export const PREVIEW = "a".repeat(64);

export function feedbackBody(overrides: Record<string, unknown> = {}) {
  return {
    product: "PikaraScienceStudio",
    category: "bug",
    title: "App crashes on start",
    body: `The app crashes right after the splash screen. ${uniq("ref")}`,
    environment: { product_version: "v0.3.1", cyw_version: "0.1.3-alpha", os: "windows", os_version: "Windows 11 (26200)", arch: "x86_64" },
    consent: { content: true, environment: true, preview_sha256: PREVIEW },
    website: "",
    ...overrides,
  };
}

export async function createFeedback(s: Session, overrides: Record<string, unknown> = {}) {
  const r = await callJson("POST", "/v1/feedback", { token: s.token, body: feedbackBody(overrides) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.feedback;
}

// ---- GitHub mock --------------------------------------------------------------------------------

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: any;
}

export type MockHandler = (call: RecordedCall) => Response | Promise<Response>;

/** Routes outbound GitHub fetches to `handler`; returns the list of recorded calls. */
export function mockGitHub(handler: MockHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  setGitHubFetch(async (url, init) => {
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === "string" ? init.body : null;
    const rec: RecordedCall = { url, method: init?.method ?? "GET", headers, body: raw ? JSON.parse(raw) : null };
    calls.push(rec);
    return handler(rec);
  });
  return calls;
}

export const jsonRes = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// ---- webhook ------------------------------------------------------------------------------------

export async function sendWebhook(event: string, payload: unknown, opts: { secret?: string; delivery?: string; signature?: string | null } = {}) {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const sig =
    opts.signature !== undefined ? opts.signature : "sha256=" + (await hmacSha256Hex(opts.secret ?? env.GITHUB_WEBHOOK_SECRET!, raw));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-GitHub-Event": event,
    "X-GitHub-Delivery": opts.delivery ?? crypto.randomUUID(),
  };
  if (sig !== null) headers["X-Hub-Signature-256"] = sig;
  return callJson("POST", "/v1/github/webhook", { rawBody: raw, headers });
}
