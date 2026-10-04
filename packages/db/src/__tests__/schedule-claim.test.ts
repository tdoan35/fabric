// SCH: claiming a slot must be idempotent under races — the scheduler tick, "Run now" and "skip"
// all claim the same (schedule_id, scheduled_for), and two processes may try at once. DB-gated
// like writer-race.test.ts: skips without DATABASE_URL.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimFire, createDb, finishFire, loadRootEnv } from "../index";

loadRootEnv(); // the suite is DB-gated; .env supplies DATABASE_URL
const maybeDb = process.env.DATABASE_URL ? createDb() : undefined;

describe.skipIf(!maybeDb)("schedule claim races", () => {
  const db = maybeDb!;
  const scheduleId = `claim-race-${process.pid}`;
  const slot = new Date("2026-10-05T08:00:00-07:00");

  beforeAll(async () => {
    await db.db.execute(sql`
      insert into schedules (id, title, kind, agent_id, prompt, recurrence, cron, tz, session_id)
      values (${scheduleId}, 'claim race', 'assistant', 'dana', 'x', ${JSON.stringify({ freq: "daily", time: "08:00" })}::jsonb,
              '0 8 * * *', 'America/Los_Angeles', ${`${scheduleId}-session`})`);
  });

  afterAll(async () => {
    // Full cleanup so the parity suites never see these rows.
    await db.db.execute(sql`delete from schedule_fires where schedule_id = ${scheduleId}`);
    await db.db.execute(sql`delete from schedules where id = ${scheduleId}`);
    await db.close();
  });

  it("10 concurrent claims of one slot: exactly one wins", async () => {
    const claimed = await Promise.all(Array.from({ length: 10 }, () => claimFire(db, scheduleId, slot)));
    const won = claimed.filter((f) => f !== undefined);
    expect(won).toHaveLength(1);
    expect(won[0]!.scheduleId).toBe(scheduleId);
    expect(won[0]!.scheduledFor).toBe(slot.toISOString());
  }, 20_000);

  it("a claimed slot never claims again, even after finishFire", async () => {
    expect(await claimFire(db, scheduleId, slot)).toBeUndefined();
    const rows = await db.db.execute(sql`select id from schedule_fires where schedule_id = ${scheduleId}`);
    const fire = rows.rows[0] as { id: string }; // pg rows are untyped
    await finishFire(db, fire.id, { status: "fired", messageId: "msg-1" });
    expect(await claimFire(db, scheduleId, slot, "missed")).toBeUndefined();
  });
});
