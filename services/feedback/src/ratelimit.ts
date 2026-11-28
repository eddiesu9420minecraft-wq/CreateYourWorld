// Fixed-window rate limits stored in D1 (API.md "Rate limits").
import { ApiError } from "./http";

export type Bucket = "auth" | "auth.poll" | "feedback.create" | "comment" | "vote" | "attachment" | "write" | "read";

export const LIMITS: Record<Bucket, { limit: number; window: number }[]> = {
  auth: [{ limit: 20, window: 600 }],
  // device-flow polling (POST /v1/auth/token), per IP; see API.md
  "auth.poll": [{ limit: 200, window: 600 }],
  "feedback.create": [
    { limit: 5, window: 3600 },
    { limit: 20, window: 86400 },
  ],
  comment: [{ limit: 30, window: 3600 }],
  vote: [{ limit: 120, window: 3600 }],
  attachment: [{ limit: 20, window: 3600 }],
  write: [{ limit: 120, window: 3600 }],
  read: [{ limit: 600, window: 600 }],
};

export const now = () => Math.floor(Date.now() / 1000);

/** Counts one hit in every window of `bucket` for `principalKey`; throws 429 + Retry-After when over the limit. */
export async function hit(db: D1Database, bucket: Bucket, principalKey: string): Promise<void> {
  const t = now();
  let retryAfter = 0;
  for (const { limit, window } of LIMITS[bucket]) {
    const start = Math.floor(t / window) * window;
    const key = `${bucket}:${window}:${principalKey}`;
    const row = await db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
           window_start = excluded.window_start
         RETURNING count, window_start`,
      )
      .bind(key, start)
      .first<{ count: number; window_start: number }>();
    if (row && row.count > limit) retryAfter = Math.max(retryAfter, row.window_start + window - t);
  }
  if (retryAfter > 0) {
    throw new ApiError(429, "rate_limited", "Too many requests, try again later", {
      "Retry-After": String(Math.max(1, retryAfter)),
    });
  }
}

/** Increments a plain counter (e.g. spam attempts) without enforcing a limit. */
export async function count(db: D1Database, key: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, 0, 1)
       ON CONFLICT(key) DO UPDATE SET count = rate_limits.count + 1`,
    )
    .bind(key)
    .run();
}
