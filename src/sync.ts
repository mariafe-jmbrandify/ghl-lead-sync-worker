import { finishSyncRun, getUnsyncedLeads, markSynced, startSyncRun, type LeadRow } from "./db";
import { DEFAULT_TIMEOUT_MS, enrichLeads } from "./places";
import { appendRows, type Cell, type FetchFn } from "./sheets";
import { nowIso } from "./util";

export interface SyncResult {
  status: "success" | "noop" | "error";
  rowsSynced: number;
  error?: string;
}

export function leadToRow(lead: LeadRow): Cell[] {
  return [
    lead.received_at,
    lead.contact_id,
    lead.first_name,
    lead.last_name,
    lead.email,
    lead.phone,
    lead.source,
    lead.tags,
    lead.company_name,
    lead.address1,
    lead.city,
    lead.state,
    lead.place_name,
    lead.place_address,
    lead.place_rating,
    lead.place_rating_count,
    lead.place_website,
    lead.place_id,
    lead.enrichment_status,
  ];
}

/**
 * Pushes unsynced leads to Google Sheets in one append call. Leads are only
 * marked synced after Google confirms the write, so a failed run is simply
 * retried by the next cron tick.
 *
 * With GOOGLE_PLACES_API_KEY set, leads are enriched from Google Places
 * first. Leads past the per-run lookup cap wait for the next run so they
 * reach the sheet enriched; a Places failure never holds a lead back.
 */
export async function syncLeads(
  env: Env,
  trigger: "cron" | "manual",
  fetchFn: FetchFn = fetch,
  placesTimeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SyncResult> {
  const runId = await startSyncRun(env.DB, trigger);
  const batchSize = Math.min(Math.max(Number(env.SYNC_BATCH_SIZE) || 100, 1), 500);

  try {
    let leads = await getUnsyncedLeads(env.DB, batchSize);
    if (leads.length === 0) {
      await finishSyncRun(env.DB, runId, "noop", 0);
      return { status: "noop", rowsSynced: 0 };
    }

    let holdPending = false;
    if (env.GOOGLE_PLACES_API_KEY) {
      try {
        leads = await enrichLeads(env, leads, fetchFn, placesTimeoutMs);
        holdPending = true;
      } catch (err) {
        // Enrichment couldn't be stored: sync every lead unenriched instead.
        console.warn("enrichment step failed", { runId, message: String(err).slice(0, 200) });
      }
    }

    const ready = holdPending ? leads.filter((l) => l.enrichment_status !== "pending") : leads;
    if (ready.length === 0) {
      await finishSyncRun(env.DB, runId, "noop", 0);
      return { status: "noop", rowsSynced: 0 };
    }

    // A lead still pending here will never be enriched; markSynced stores it as skipped.
    const rows = ready.map((l) =>
      leadToRow(l.enrichment_status === "pending" ? { ...l, enrichment_status: "skipped" } : l),
    );
    await appendRows(env, rows, fetchFn);
    await markSynced(env.DB, ready.map((l) => l.id), nowIso());
    await finishSyncRun(env.DB, runId, "success", ready.length);
    return { status: "success", rowsSynced: ready.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("sync failed", { runId, message });
    await finishSyncRun(env.DB, runId, "error", 0, message.slice(0, 500));
    return { status: "error", rowsSynced: 0, error: message };
  }
}
