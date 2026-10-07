# Session-auth rollout — openai-agents-data-agent

This public twin keeps its own Worker name and rate-limit namespace. Do not copy identifiers from `bulk-invoice-contract-review-agent` or any other agent worker. Shared namespace ids merge counters across Workers.

| Identity | Value |
| --- | --- |
| Worker name | `openai-agents-data-agent` |
| Session-start route | `POST /api/sessions` |
| Pre-auth attempt limiter binding | `SESSION_ATTEMPT_LIMITER` |
| Attempt limiter namespace id | `748201` |
| Attempt key | `ip:` + `CF-Connecting-IP`, or `ip:unknown` when that header is missing |
| Attempt limit | 20 requests / 60 seconds (per key, before the bearer check) |
| Auth secret | `SESSION_AUTH_SECRET` (Wrangler secret, at least 32 characters; never committed) |
| Global session-start Durable Object class | `SessionStartLimiter` |
| Durable Object binding | `SESSION_START_LIMITER` |
| Durable Object migration | `openai-agents-data-agent-session-start-v1` |
| Global instance name | `global` |
| Global cap | 10 session starts / 60 seconds |

The Durable Object class is defined in this Worker. Do not set `script_name` to another Worker, and do not reuse namespace id `748201` on another binding.
