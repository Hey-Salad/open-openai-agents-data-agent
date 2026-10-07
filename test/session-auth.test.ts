import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker, { sessionAttemptKey } from "../src/index";
import { GLOBAL_SESSION_START_INSTANCE, GLOBAL_SESSION_START_LIMIT } from "../src/session-guard";
import { network } from "./network";

const workerEnv = env as Env;

const IP_ATTEMPT_LIMIT = 20;
const VALID_SECRET = "x".repeat(32);
const SHORT_SECRET = "x".repeat(31);
const UPSTREAM = "https://agents.example.test";

let outboundCalls = 0;
let ipSeq = 0;

function nextIp(): string {
  ipSeq += 1;
  return `203.0.113.${ipSeq}`;
}

function rejectUpstream(): void {
  outboundCalls = 0;
  network.use(
    http.all(`${UPSTREAM}/*`, () => {
      outboundCalls += 1;
      return HttpResponse.json({ error: "upstream should not be called" }, { status: 500 });
    }),
  );
}

function allowUpstream(): void {
  outboundCalls = 0;
  network.use(
    http.post(`${UPSTREAM}/agents`, () => {
      outboundCalls += 1;
      return HttpResponse.json({ id: "agent_test" });
    }),
    http.post(`${UPSTREAM}/agents/sessions`, () => {
      outboundCalls += 1;
      return new HttpResponse("data: hello\n\n", { status: 200 });
    }),
  );
}

beforeEach(async () => {
  await workerEnv.SESSION_START_LIMITER.getByName(GLOBAL_SESSION_START_INSTANCE).reset();
  rejectUpstream();
});

async function postSession(options: {
  ip?: string | null;
  secret?: string;
  bearer?: string;
}): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.ip) headers.set("CF-Connecting-IP", options.ip);
  if (options.bearer !== undefined) headers.set("Authorization", `Bearer ${options.bearer}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://worker.example.test/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ input: "hello" }),
    }),
    {
      ...workerEnv,
      OPENAI_API_KEY: "test-openai-key",
      OPENAI_BASE_URL: UPSTREAM,
      OPENAI_PROJECT: "proj_test",
      AGENTS_ENVIRONMENT_TYPE: "none",
      SESSION_AUTH_SECRET: options.secret,
    },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

it("builds attempt keys from CF-Connecting-IP and falls back to ip:unknown", () => {
  const withIp = new Request("https://worker.example.test/api/sessions", {
    headers: { "CF-Connecting-IP": "203.0.113.9" },
  });
  expect(sessionAttemptKey(withIp)).toBe("ip:203.0.113.9");
  expect(sessionAttemptKey(new Request("https://worker.example.test/api/sessions"))).toBe("ip:unknown");
});

it("leaves health and the home page unauthenticated", async () => {
  const ctx = createExecutionContext();
  const health = await worker.fetch(new Request("https://worker.example.test/health"), workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true, service: "openai-agents-data-agent" });

  const homeCtx = createExecutionContext();
  const home = await worker.fetch(new Request("https://worker.example.test/"), workerEnv, homeCtx);
  await waitOnExecutionContext(homeCtx);
  expect(home.status).toBe(200);
  expect(await home.text()).toContain("Session bearer token");
  expect(outboundCalls).toBe(0);
});

it("returns 503 when the auth secret is missing or shorter than 32 characters", async () => {
  const ip = nextIp();
  const missing = await postSession({ ip });
  expect(missing.status).toBe(503);
  expect(await missing.json()).toMatchObject({ error: "Session auth is unavailable." });

  const short = await postSession({ ip, secret: SHORT_SECRET, bearer: SHORT_SECRET });
  expect(short.status).toBe(503);
  expect(outboundCalls).toBe(0);
});

it("rejects a bad bearer with 401 and does not call upstream", async () => {
  const response = await postSession({ ip: nextIp(), secret: VALID_SECRET, bearer: "not-the-secret" });
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: "Unauthorized" });
  expect(outboundCalls).toBe(0);
});

it("limits attempts per IP before checking the bearer token", async () => {
  const ip = nextIp();
  for (let i = 0; i < IP_ATTEMPT_LIMIT; i++) {
    const response = await postSession({ ip, secret: VALID_SECRET, bearer: "wrong" });
    expect(response.status).toBe(401);
  }

  const blocked = await postSession({ ip, secret: VALID_SECRET, bearer: VALID_SECRET });
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toMatchObject({ error: "Too many session start attempts." });
  expect(blocked.headers.get("Retry-After")).toBe("60");
  expect(outboundCalls).toBe(0);

  const otherIp = await postSession({ ip: nextIp(), secret: VALID_SECRET, bearer: "wrong" });
  expect(otherIp.status).toBe(401);
});

it("shares one ip:unknown bucket when CF-Connecting-IP is absent", async () => {
  for (let i = 0; i < IP_ATTEMPT_LIMIT; i++) {
    const response = await postSession({ secret: VALID_SECRET, bearer: "wrong" });
    expect(response.status).toBe(401);
  }

  const blocked = await postSession({ secret: VALID_SECRET, bearer: VALID_SECRET });
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toMatchObject({ error: "Too many session start attempts." });

  const withIp = await postSession({ ip: nextIp(), secret: VALID_SECRET, bearer: "wrong" });
  expect(withIp.status).toBe(401);
});

it("counts attempts before the misconfigured-secret response", async () => {
  const ip = nextIp();
  for (let i = 0; i < IP_ATTEMPT_LIMIT; i++) {
    const response = await postSession({ ip, secret: SHORT_SECRET, bearer: SHORT_SECRET });
    expect(response.status).toBe(503);
  }
  const blocked = await postSession({ ip, secret: SHORT_SECRET, bearer: SHORT_SECRET });
  expect(blocked.status).toBe(429);
  expect(outboundCalls).toBe(0);
});

it("starts a session for a 32 character secret and a matching bearer", async () => {
  allowUpstream();
  const response = await postSession({ ip: nextIp(), secret: VALID_SECRET, bearer: VALID_SECRET });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("agent_test");
  expect(body).toContain("data: hello");
  expect(outboundCalls).toBe(2);
});

it("caps authenticated session starts at 10 per 60 seconds across IPs", async () => {
  allowUpstream();
  const ip = nextIp();
  for (let i = 0; i < GLOBAL_SESSION_START_LIMIT; i++) {
    const response = await postSession({ ip, secret: VALID_SECRET, bearer: VALID_SECRET });
    expect(response.status).toBe(200);
  }
  expect(outboundCalls).toBe(GLOBAL_SESSION_START_LIMIT * 2);

  const blocked = await postSession({ ip, secret: VALID_SECRET, bearer: VALID_SECRET });
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toMatchObject({ error: "Session start rate limit exceeded." });
  expect(blocked.headers.get("Retry-After")).toBe("60");
  expect(outboundCalls).toBe(GLOBAL_SESSION_START_LIMIT * 2);

  const otherIp = await postSession({ ip: nextIp(), secret: VALID_SECRET, bearer: VALID_SECRET });
  expect(otherIp.status).toBe(429);
  expect(await otherIp.json()).toMatchObject({ error: "Session start rate limit exceeded." });
});

it("does not spend the global session-start budget on failed auth", async () => {
  const ip = nextIp();
  for (let i = 0; i < 5; i++) {
    const response = await postSession({ ip, secret: VALID_SECRET, bearer: "wrong" });
    expect(response.status).toBe(401);
  }

  allowUpstream();
  for (let i = 0; i < GLOBAL_SESSION_START_LIMIT; i++) {
    const response = await postSession({ ip, secret: VALID_SECRET, bearer: VALID_SECRET });
    expect(response.status).toBe(200);
  }
  expect(outboundCalls).toBe(GLOBAL_SESSION_START_LIMIT * 2);
});
