import { nowIso } from "./util";

export interface LeadInput {
  contactId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  tags: string | null;
  locationId: string | null;
}

export interface LeadRow {
  id: number;
  contact_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  tags: string | null;
  location_id: string | null;
  received_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface SyncRunRow {
  id: number;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  rows_synced: number;
  status: string;
  error: string | null;
}

/**
 * Inserts a lead or updates the existing row for the same contact.
 * received_at and synced_at are preserved on update, so a contact is only
 * ever appended to the sheet once.
 */
export async function upsertLead(
  db: D1Database,
  lead: LeadInput,
  rawJson: string,
): Promise<{ created: boolean }> {
  const now = nowIso();
  const existing = await db
    .prepare("SELECT id FROM leads WHERE contact_id = ?")
    .bind(lead.contactId)
    .first<{ id: number }>();

  await db
    .prepare(
      `INSERT INTO leads
         (contact_id, first_name, last_name, email, phone, source, tags, location_id, raw_json, received_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (contact_id) DO UPDATE SET
         first_name  = COALESCE(excluded.first_name, leads.first_name),
         last_name   = COALESCE(excluded.last_name, leads.last_name),
         email       = COALESCE(excluded.email, leads.email),
         phone       = COALESCE(excluded.phone, leads.phone),
         source      = COALESCE(excluded.source, leads.source),
         tags        = COALESCE(excluded.tags, leads.tags),
         location_id = COALESCE(excluded.location_id, leads.location_id),
         raw_json    = excluded.raw_json,
         updated_at  = excluded.updated_at`,
    )
    .bind(
      lead.contactId,
      lead.firstName,
      lead.lastName,
      lead.email,
      lead.phone,
      lead.source,
      lead.tags,
      lead.locationId,
      rawJson,
      now,
      now,
    )
    .run();

  return { created: !existing };
}

export async function getUnsyncedLeads(db: D1Database, limit: number): Promise<LeadRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM leads WHERE synced_at IS NULL ORDER BY received_at, id LIMIT ?")
    .bind(limit)
    .all<LeadRow>();
  return results;
}

export async function markSynced(db: D1Database, ids: number[], at: string): Promise<void> {
  if (ids.length === 0) return;
  const stmt = db.prepare("UPDATE leads SET synced_at = ? WHERE id = ?");
  await db.batch(ids.map((id) => stmt.bind(at, id)));
}

export async function startSyncRun(db: D1Database, trigger: string): Promise<number> {
  const row = await db
    .prepare("INSERT INTO sync_runs (trigger, started_at, status) VALUES (?, ?, 'running') RETURNING id")
    .bind(trigger, nowIso())
    .first<{ id: number }>();
  return row!.id;
}

export async function finishSyncRun(
  db: D1Database,
  id: number,
  status: "success" | "noop" | "error",
  rowsSynced: number,
  error: string | null = null,
): Promise<void> {
  await db
    .prepare("UPDATE sync_runs SET finished_at = ?, status = ?, rows_synced = ?, error = ? WHERE id = ?")
    .bind(nowIso(), status, rowsSynced, error, id)
    .run();
}

export async function getDashboardData(db: D1Database) {
  const [counts, leads, runs] = await db.batch([
    db.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN synced_at IS NULL THEN 1 ELSE 0 END) AS unsynced FROM leads",
    ),
    db.prepare("SELECT * FROM leads ORDER BY received_at DESC, id DESC LIMIT 50"),
    db.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 10"),
  ]);
  const c = (counts.results[0] ?? {}) as { total?: number; unsynced?: number | null };
  return {
    total: c.total ?? 0,
    unsynced: c.unsynced ?? 0,
    leads: leads.results as unknown as LeadRow[],
    runs: runs.results as unknown as SyncRunRow[],
  };
}
