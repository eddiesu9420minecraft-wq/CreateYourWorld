// Minimal router: static patterns with :params, no dynamic code.
import type { Principal } from "./auth";
import type { Env } from "./env";
import { ApiError } from "./http";
import type { Bucket } from "./ratelimit";

export interface Ctx {
  env: Env;
  request: Request;
  url: URL;
  params: Record<string, string>;
  principal: Principal;
  /** SHA-256 based key of the client IP (never the raw IP). */
  ipKey: string;
}

export type Handler = (c: Ctx) => Promise<Response>;

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  handler: Handler;
  /** Rate-limit bucket. Default: GET → read (per IP), other → write (per principal). "none" disables. */
  bucket?: Bucket | "none";
  /** Count the bucket per client IP instead of per principal. */
  perIp?: boolean;
}

interface Compiled extends Route {
  re: RegExp;
  names: string[];
}

export class Router {
  private routes: Compiled[] = [];

  add(route: Route): this {
    const names: string[] = [];
    const pattern = route.path
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          names.push(seg.slice(1));
          return "([^/]+)";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ ...route, re: new RegExp(`^${pattern}$`), names });
    return this;
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.names.forEach((n, i) => {
        try {
          params[n] = decodeURIComponent(m[i + 1]);
        } catch {
          throw new ApiError(400, "invalid_body", "Malformed path");
        }
      });
      return { route: r, params };
    }
    if (pathMatched) throw new ApiError(405, "method_not_allowed", "Method not allowed");
    throw new ApiError(404, "not_found", "Not found");
  }
}
