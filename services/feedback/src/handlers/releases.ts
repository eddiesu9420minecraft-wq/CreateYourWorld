// Recording a release that a human already published on GitHub. This service never publishes releases.
import { requireWriter } from "../auth";
import type { Env } from "../env";
import { products } from "../env";
import { ApiError, json, readJson } from "../http";
import { eventStmt, notificationTitle, notifySubscribers, productName, type FeedbackRow } from "../model";
import { now } from "../ratelimit";
import type { Ctx } from "../router";
import { RELEASABLE } from "../transitions";
import { requireString } from "../validate";

export async function recordRelease(
  env: Env,
  r: { product: string; version: string; url: string; numbers: number[]; actorUserId: string | null },
): Promise<{ updated: number; notified: number }> {
  let updated = 0;
  let notified = 0;
  const name = productName(env, r.product);
  for (const n of r.numbers) {
    const fb = await env.DB.prepare("SELECT * FROM feedback WHERE number = ? AND product = ?")
      .bind(n, r.product)
      .first<FeedbackRow>();
    if (!fb || !RELEASABLE.includes(fb.status)) continue;
    const t = now();
    const res = await env.DB.batch([
      env.DB.prepare(
        "UPDATE feedback SET status = 'released', resolution = NULL, fixed_in = ?, updated_at = ? WHERE id = ? AND status IN ('fixed', 'in_progress', 'triaged')",
      ).bind(r.version, t, fb.id),
      eventStmt(env, fb.id, "release", r.actorUserId, fb.status, "released", `${r.version} ${r.url}`),
    ]);
    if (!res[0].meta.changes) continue;
    updated++;
    notified += await notifySubscribers(
      env,
      fb.id,
      r.actorUserId,
      "released",
      notificationTitle(fb),
      `已在 ${name} ${r.version} 修復`,
    );
  }
  return { updated, notified };
}

export async function postRelease(c: Ctx) {
  // Maintainer *session* only: service tokens (agents, CYWS) get 403 agent_forbidden from requireWriter.
  const p = requireWriter(c.principal, "maintainer");
  const body = await readJson(c.request);
  if (body.human_approved !== true) {
    throw new ApiError(400, "invalid_body", "human_approved: true is required (a human must have published the release)");
  }
  const catalog = products(c.env);
  const productId = body.product;
  if (typeof productId !== "string" || !Object.hasOwn(catalog, productId)) {
    throw new ApiError(400, "invalid_body", "Unknown product");
  }
  const repo = catalog[productId].repo;
  const version = requireString(body, "version", 1, 64);
  const url = body.url;
  const prefix = `https://github.com/${repo}/releases/tag/`.toLowerCase();
  if (
    typeof url !== "string" ||
    url.length > 300 ||
    !url.toLowerCase().startsWith(prefix) ||
    !/^[^\s/?#]+$/.test(url.slice(prefix.length))
  ) {
    throw new ApiError(400, "invalid_body", `url must be https://github.com/${repo}/releases/tag/<tag>`);
  }
  const nums = body.feedback_numbers;
  if (
    !Array.isArray(nums) ||
    nums.length > 200 ||
    !nums.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0 && n < 1e9)
  ) {
    throw new ApiError(400, "invalid_body", "feedback_numbers must be an array of at most 200 positive integers");
  }
  const numbers = [...new Set(nums as number[])];
  const r = await recordRelease(c.env, { product: productId, version, url, numbers, actorUserId: p.user.id });
  return json(r);
}
