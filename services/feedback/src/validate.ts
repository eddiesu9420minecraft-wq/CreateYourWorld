// Input validation and normalisation. User content is only ever treated as data.
import { ApiError } from "./http";

export const CATEGORIES = ["bug", "feature", "performance", "compatibility", "general"] as const;
export const STATUSES = ["open", "triaged", "in_progress", "fixed", "released", "closed"] as const;
export const RESOLUTIONS = ["completed", "duplicate", "wont_fix", "invalid", "spam"] as const;
export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "wont_do"] as const;
export const USER_ROLES = ["user", "developer", "maintainer"] as const;
export const SERVICE_ROLES = ["agent", "cyws"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Status = (typeof STATUSES)[number];
export type Resolution = (typeof RESOLUTIONS)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type UserRole = (typeof USER_ROLES)[number];
export type ServiceRole = (typeof SERVICE_ROLES)[number];

// C0 controls except \t and \n, DEL, C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** NFC-normalises and strips control characters (except \n and \t). CRLF/CR become \n. */
export function normalizeText(input: string, opts: { multiline?: boolean } = {}): string {
  let s = input.normalize("NFC").replace(/\r\n?/g, "\n").replace(CONTROL_RE, "");
  if (!opts.multiline) s = s.replace(/[\n\t]+/g, " ");
  return s.trim();
}

/** Length in Unicode code points. */
export function charLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function requireString(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  opts: { multiline?: boolean } = {},
): string {
  const v = body[field];
  if (typeof v !== "string") throw new ApiError(400, "invalid_body", `${field} must be a string`);
  const s = normalizeText(v, opts);
  const len = charLength(s);
  if (len > max) throw new ApiError(400, "too_long", `${field} must be at most ${max} characters`);
  if (len < min) throw new ApiError(400, "invalid_body", `${field} must be at least ${min} characters`);
  return s;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  max: number,
  opts: { multiline?: boolean } = {},
): string | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ApiError(400, "invalid_body", `${field} must be a string`);
  const s = normalizeText(v, opts);
  if (charLength(s) > max) throw new ApiError(400, "too_long", `${field} must be at most ${max} characters`);
  return s === "" ? null : s;
}

export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ApiError(400, "invalid_body", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function isEnum<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** GitHub login syntax: 1..39 alphanumerics or single hyphens, not starting/ending with a hyphen. */
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function requireLogin(value: unknown, field = "login"): string {
  if (typeof value !== "string" || !LOGIN_RE.test(value)) {
    throw new ApiError(400, "invalid_body", `${field} is not a valid GitHub login`);
  }
  return value;
}

export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Owner/name of a GitHub repository. */
export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const LINK_RE = /\bhttps?:\/\/|\bwww\./gi;
export function countLinks(text: string): number {
  return (text.match(LINK_RE) ?? []).length;
}

/** Body form used for duplicate detection: lower case, collapsed whitespace. */
export function normalizeForDuplicate(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export const ENVIRONMENT_FIELDS = ["product_version", "cyw_version", "os", "os_version", "arch"] as const;

/** Validates the environment block: an object of known string fields (≤ 100 chars each). Unknown keys are dropped. */
export function parseEnvironment(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid_body", "environment must be an object");
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ENVIRONMENT_FIELDS) {
    const v = src[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new ApiError(400, "invalid_body", `environment.${key} must be a string`);
    const s = normalizeText(v);
    if (charLength(s) > 100) throw new ApiError(400, "too_long", `environment.${key} is too long`);
    if (s !== "") out[key] = s;
  }
  return out;
}

export function parseLabels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ApiError(400, "invalid_body", "labels must be an array of strings");
  if (value.length > 20) throw new ApiError(400, "invalid_body", "at most 20 labels");
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") throw new ApiError(400, "invalid_body", "labels must be strings");
    const s = normalizeText(v);
    if (s.length < 1 || charLength(s) > 50) throw new ApiError(400, "invalid_body", "label must be 1..50 characters");
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function parseIntParam(value: string | null, def: number, min: number, max: number, field: string): number {
  if (value === null || value === "") return def;
  if (!/^\d{1,9}$/.test(value)) throw new ApiError(400, "invalid_body", `${field} must be an integer`);
  const n = Number(value);
  if (n < min || n > max) throw new ApiError(400, "invalid_body", `${field} must be between ${min} and ${max}`);
  return n;
}
