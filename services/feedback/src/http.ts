// HTTP helpers: JSON responses, errors, bounded body reading.

export const MAX_JSON_BODY = 64 * 1024;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  "Referrer-Policy": "no-referrer",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...headers },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS } });
}

export function errorResponse(err: ApiError): Response {
  return json({ error: { code: err.code, message: err.message } }, err.status, err.headers);
}

/** Reads at most `max` bytes from the request body; throws 413 when the body is larger. */
export async function readBodyLimited(request: Request, max: number): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) {
    throw new ApiError(413, "too_large", `Body is larger than ${max} bytes`);
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ApiError(413, "too_large", `Body is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Parses a JSON object body (≤ 64 KiB). An empty body is treated as `{}`. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readBodyLimited(request, MAX_JSON_BODY);
  if (bytes.byteLength === 0) return {};
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ApiError(400, "invalid_body", "Body is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_body", "Body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid_body", "Body must be a JSON object");
  }
  return value as Record<string, unknown>;
}
