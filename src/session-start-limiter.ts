import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * One global counter for session starts that passed authentication.
 * Instance name is fixed by the caller so every request shares this cap.
 */
export class SessionStartLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS hits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at_ms INTEGER NOT NULL
        )
      `);
    });
  }

  tryConsume(limit: number, windowMs: number, now = Date.now()): boolean {
    const cutoff = now - windowMs;
    this.ctx.storage.sql.exec("DELETE FROM hits WHERE at_ms <= ?", cutoff);
    const row = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hits").one();
    if (row.n >= limit) return false;
    this.ctx.storage.sql.exec("INSERT INTO hits (at_ms) VALUES (?)", now);
    return true;
  }

  reset(): void {
    this.ctx.storage.sql.exec("DELETE FROM hits");
  }
}
