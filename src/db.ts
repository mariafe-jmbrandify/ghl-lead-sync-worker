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
  companyName: string | null;
  address1: string | null;
  city: string | null;
  state: string | null;
}

export type EnrichmentStatus = "pending" | "found" | "not_found" | "skipped" | "failed";

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
  company_name: string | null;
  address1: string | null;
  city: string | null;
  state: string | null;
  place_id: string | null;
  place_name: string | null;
  place_address: string | null;
  place_rating: number | null;
  place_rating_count: number | null;
  place_website: string | null;
  enrichment_status: EnrichmentStatus;
  enrichment_error: string | null;
  enriched_at: string | null;
  received_at: string;
  updated_at: string;
  synced_at: string | null;
}

/** Outcome of a Places lookup, as stored on the lead. */
export interface Enrichment {
  status: Exclude<EnrichmentStatus, "pending">;
  placeId?: string | null;
  placeName?: string | null;
  placeAddress?: string | null;
  placeRating?: number | null;
  placeRatingCount?: number | null;
  placeWebsite?: string | null;
  error?: string | null;
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
         (contact_id, first_name, last_name, email, phone, source, tags, location_id,
          company_name, address1, city, state, raw_json, received_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (contact_id) DO UPDATE SET
         first_name   = COALESCE(excluded.first_name, leads.first_name),
         last_name    = COALESCE(excluded.last_name, leads.last_name),
         email        = COALESCE(excluded.email, leads.email),
         phone        = COALESCE(excluded.phone, leads.phone),
         source       = COALESCE(excluded.source, leads.source),
         tags         = COALESCE(excluded.tags, leads.tags),
         location_id  = COALESCE(excluded.location_id, leads.location_id),
         company_name = COALESCE(excluded.company_name, leads.company_name),
         address1     = COALESCE(excluded.address1, leads.address1),
         city         = COALESCE(excluded.city, leads.city),
         state        = COALESCE(excluded.state, leads.state),
         raw_json     = excluded.raw_json,
         updated_at   = excluded.updated_at`,
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
      lead.companyName,
      lead.address1,
      lead.city,
      lead.state,
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

/**
 * Marks leads synced. A lead still 'pending' enrichment at this point (no
 * Places API key) becomes 'skipped': it is in the sheet and won't be enriched.
 */
export async function markSynced(db: D1Database, ids: number[], at: string): Promise<void> {
  if (ids.length === 0) return;
  const stmt = db.prepare(
    `UPDATE leads SET synced_at = ?,
       enrichment_status = CASE WHEN enrichment_status = 'pending' THEN 'skipped' ELSE enrichment_status END
     WHERE id = ?`,
  );
  await db.batch(ids.map((id) => stmt.bind(at, id)));
}

/** Stores enrichment results for several leads in one D1 batch. */
export async function saveEnrichments(
  db: D1Database,
  updates: { id: number; result: Enrichment }[],
  at: string,
): Promise<void> {
  if (updates.length === 0) return;
  const stmt = db.prepare(
    `UPDATE leads SET
       enrichment_status = ?, enrichment_error = ?, enriched_at = ?,
       place_id = ?, place_name = ?, place_address = ?,
       place_rating = ?, place_rating_count = ?, place_website = ?
     WHERE id = ?`,
  );
  await db.batch(
    updates.map(({ id, result }) =>
      stmt.bind(
        result.status,
        result.error ?? null,
        at,
        result.placeId ?? null,
        result.placeName ?? null,
        result.placeAddress ?? null,
        result.placeRating ?? null,
        result.placeRatingCount ?? null,
        result.placeWebsite ?? null,
        id,
      ),
    ),
  );
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
