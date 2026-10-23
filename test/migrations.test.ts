import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Each test file gets its own storage, so this file can rebuild the schema
// from scratch without affecting the others.
describe("migration 0002", () => {
  it("marks already-synced leads skipped and leaves unsynced ones pending", async () => {
    await env.DB.batch([
      env.DB.prepare("DROP TABLE IF EXISTS leads"),
      env.DB.prepare("DROP TABLE IF EXISTS sync_runs"),
      env.DB.prepare("DROP TABLE IF EXISTS d1_migrations"),
    ]);

    const [init, ...later] = env.TEST_MIGRATIONS;
    expect(init.name).toBe("0001_init.sql");
    await applyD1Migrations(env.DB, [init]);

    const insert = env.DB.prepare(
      `INSERT INTO leads (contact_id, raw_json, received_at, updated_at, synced_at)
       VALUES (?, '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?)`,
    );
    await env.DB.batch([insert.bind("old_synced", "2026-10-01T00:05:00.000Z"), insert.bind("old_pending", null)]);

    expect(later.map((m) => m.name)).toContain("0002_places_enrichment.sql");
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const { results } = await env.DB.prepare(
      "SELECT contact_id, enrichment_status FROM leads ORDER BY contact_id",
    ).all();
    expect(results).toEqual([
      { contact_id: "old_pending", enrichment_status: "pending" },
      { contact_id: "old_synced", enrichment_status: "skipped" },
    ]);
  });
});
