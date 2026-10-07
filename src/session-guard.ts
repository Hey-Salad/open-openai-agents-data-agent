import type { Env } from "./env";
import { jsonResponse } from "./http";

export const MIN_SESSION_AUTH_SECRET_LENGTH = 32;
export const GLOBAL_SESSION_START_LIMIT = 10;
export const GLOBAL_SESSION_START_WINDOW_MS = 60_000;
export const GLOBAL_SESSION_START_INSTANCE = "global";

/** Pre-auth attempt key. Missing or empty CF-Connecting-IP shares one fallback bucket. */
export function sessionAttemptKey(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return "ip:unknown";
  return `ip:${ip}`;
}

function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length, 1);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function bearerMatches(request: Request, secret: string): boolean {
  const header = request.headers.get("Authorization");
  if (!header) return false;
  const prefix = "bearer ";
  if (header.length < prefix.length || header.slice(0, prefix.length).toLowerCase() !== prefix) {
    return false;
  }
  return timingSafeEqual(header.slice(prefix.length), secret);
}

/**
 * Authorize POST /api/sessions.
 * Returns a response to send, or null when the caller may start a session.
 *
 * Order is fixed: per-IP attempt limit, then secret length, then bearer, then the global cap.
 * The attempt limiter runs before the bearer comparison so failed guesses consume the client budget.
 */
export async function guardSessionStart(request: Request, env: Env): Promise<Response | null> {
  const attempt = await env.SESSION_ATTEMPT_LIMITER.limit({ key: sessionAttemptKey(request) });
  if (!attempt.success) {
    return jsonResponse({ error: "Too many session start attempts." }, 429, { "Retry-After": "60" });
  }

  const secret = env.SESSION_AUTH_SECRET ?? "";
  if (secret.length < MIN_SESSION_AUTH_SECRET_LENGTH) {
    return jsonResponse({ error: "Session auth is unavailable." }, 503);
  }

  if (!bearerMatches(request, secret)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const allowed = await env.SESSION_START_LIMITER.getByName(GLOBAL_SESSION_START_INSTANCE).tryConsume(
    GLOBAL_SESSION_START_LIMIT,
    GLOBAL_SESSION_START_WINDOW_MS,
  );
  if (!allowed) {
    return jsonResponse({ error: "Session start rate limit exceeded." }, 429, { "Retry-After": "60" });
  }

  return null;
}
