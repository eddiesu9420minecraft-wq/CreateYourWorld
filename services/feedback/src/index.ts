// CYW Feedback Center Worker. Contract: docs/feedback/API.md.
import { resolvePrincipal, type Principal } from "./auth";
import { sha256Hex } from "./crypto";
import type { Env } from "./env";
import * as admin from "./handlers/admin";
import * as auth from "./handlers/auth";
import * as fb from "./handlers/feedback";
import * as ghh from "./handlers/github";
import { postRelease } from "./handlers/releases";
import * as tasks from "./handlers/tasks";
import { ApiError, errorResponse, json } from "./http";
import { hit } from "./ratelimit";
import { Router, type Ctx } from "./router";

export type { Env } from "./env";

export const router = new Router()
  // auth
  .add({ method: "POST", path: "/v1/auth/device", handler: auth.deviceStart, bucket: "auth", perIp: true })
  .add({ method: "POST", path: "/v1/auth/token", handler: auth.deviceToken, bucket: "none" }) // own poll bucket
  .add({ method: "POST", path: "/v1/auth/dev", handler: auth.devLogin, bucket: "none" }) // limited after the env check
  .add({ method: "POST", path: "/v1/auth/logout", handler: auth.logout })
  .add({ method: "GET", path: "/v1/me", handler: auth.me })
  // feedback
  .add({ method: "POST", path: "/v1/feedback", handler: fb.createFeedback, bucket: "feedback.create" })
  .add({ method: "GET", path: "/v1/feedback", handler: fb.listFeedback })
  .add({ method: "GET", path: "/v1/feedback/:id", handler: fb.getOne })
  .add({ method: "PATCH", path: "/v1/feedback/:id", handler: fb.patchFeedback })
  .add({ method: "POST", path: "/v1/feedback/:id/close", handler: fb.closeFeedback })
  .add({ method: "POST", path: "/v1/feedback/:id/vote", handler: fb.vote, bucket: "vote" })
  .add({ method: "DELETE", path: "/v1/feedback/:id/vote", handler: fb.unvote, bucket: "vote" })
  .add({ method: "GET", path: "/v1/feedback/:id/comments", handler: fb.listComments })
  .add({ method: "POST", path: "/v1/feedback/:id/comments", handler: fb.createComment, bucket: "comment" })
  .add({ method: "DELETE", path: "/v1/comments/:id", handler: fb.hideComment })
  .add({ method: "POST", path: "/v1/feedback/:id/attachments", handler: fb.uploadAttachment, bucket: "attachment" })
  .add({ method: "GET", path: "/v1/attachments/:id", handler: fb.downloadAttachment })
  .add({ method: "POST", path: "/v1/feedback/:id/subscription", handler: fb.subscribe })
  .add({ method: "DELETE", path: "/v1/feedback/:id/subscription", handler: fb.unsubscribe })
  .add({ method: "GET", path: "/v1/notifications", handler: fb.listNotifications })
  .add({ method: "POST", path: "/v1/notifications/read", handler: fb.markNotificationsRead })
  // GitHub
  .add({ method: "POST", path: "/v1/feedback/:id/github", handler: ghh.linkGitHub })
  .add({ method: "POST", path: "/v1/github/webhook", handler: ghh.webhook, bucket: "none" })
  // releases
  .add({ method: "POST", path: "/v1/releases", handler: postRelease })
  // tasks
  .add({ method: "POST", path: "/v1/feedback/:id/tasks", handler: tasks.createTask })
  .add({ method: "GET", path: "/v1/tasks", handler: tasks.listTasks })
  .add({ method: "GET", path: "/v1/tasks/:id", handler: tasks.getTaskHandler })
  .add({ method: "PATCH", path: "/v1/tasks/:id", handler: tasks.patchTask })
  .add({ method: "POST", path: "/v1/tasks/:id/analysis", handler: tasks.postAnalysis })
  .add({ method: "POST", path: "/v1/tasks/:id/pull-requests", handler: tasks.postPullRequest })
  // admin
  .add({ method: "POST", path: "/v1/admin/tokens", handler: admin.createToken })
  .add({ method: "GET", path: "/v1/admin/tokens", handler: admin.listTokens })
  .add({ method: "DELETE", path: "/v1/admin/tokens/:id", handler: admin.revokeToken })
  .add({ method: "PUT", path: "/v1/admin/roles/:login", handler: admin.putRole })
  .add({ method: "POST", path: "/v1/admin/bans/:login", handler: admin.ban })
  .add({ method: "DELETE", path: "/v1/admin/bans/:login", handler: admin.unban })
  .add({ method: "GET", path: "/v1/health", handler: async () => json({ ok: true }), bucket: "none" });

function principalKey(p: Principal, ipKey: string): string {
  if (p.kind === "user") return `user:${p.user.id}`;
  if (p.kind === "service") return `svc:${p.id}`;
  return `ip:${ipKey}`;
}

export async function handle(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const { route, params } = router.match(request.method, url.pathname);
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const ipKey = (await sha256Hex(`cyw-feedback-ip:${ip}`)).slice(0, 32);
    const bucket = route.bucket ?? (route.method === "GET" ? "read" : "write");
    if (bucket === "read" || route.perIp) {
      if (bucket !== "none") await hit(env.DB, bucket, `ip:${ipKey}`);
    }
    const principal = route.path === "/v1/github/webhook" ? ({ kind: "anon" } as const) : await resolvePrincipal(env, request);
    if (bucket !== "none" && bucket !== "read" && !route.perIp) {
      await hit(env.DB, bucket, principalKey(principal, ipKey));
    }
    const ctx: Ctx = { env, request, url, params, principal, ipKey };
    return await route.handler(ctx);
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e);
    console.error("unhandled error", e instanceof Error ? e.message : "error");
    return errorResponse(new ApiError(500, "internal", "Internal error"));
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
} satisfies ExportedHandler<Env>;
