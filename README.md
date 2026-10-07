# OpenAI Agents API Data Agent

Runnable Cloudflare Worker and curl-first example for the OpenAI Agents API. It creates a reusable agent named `Data agent`, starts a streamed session from the returned `agent_id`, and streams raw session events.

## Files

- `config/agent-definition.json` contains the reusable agent definition.
- `config/session-input.txt` contains the initial user message.
- `scripts/run-agent-session.sh` calls the Agents HTTP API directly with `curl`.
- `src/index.ts` is a Cloudflare Worker UI/API layer that mirrors the same flow.

## Setup

```bash
npm install
export OPENAI_API_KEY="your-api-key"
```

The app uses OpenAI project `proj_mRsQVx3NjOamxeXH6UrLowoC` via the `OpenAI-Project` header by default.

`POST /api/sessions` requires `Authorization: Bearer <SESSION_AUTH_SECRET>`. The secret must be at least 32 characters. A missing or shorter secret fails closed with HTTP 503. Set it as a Wrangler secret (do not commit it):

```bash
npx wrangler secret put SESSION_AUTH_SECRET
```

Before the bearer token is checked, each client IP is attempt-limited (`CF-Connecting-IP`, or a shared `ip:unknown` bucket when the header is absent). After authentication, a Durable Object caps session starts at 10 per 60 seconds for this Worker only. Identifiers are listed in `rollout/README.md`.

## Run Locally

```bash
npm run run:agent
npm run typecheck
npm run dev
```

## Deploy To Cloudflare Workers

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put SESSION_AUTH_SECRET
npm run deploy
```

Default Agents API environment is `openai_hosted`. Set `AGENTS_ENVIRONMENT_TYPE=none` only when no sandbox is needed.
