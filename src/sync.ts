import { finishSyncRun, getUnsyncedLeads, markSynced, startSyncRun, type LeadRow } from "./db";
import { appendRows, type FetchFn } from "./sheets";
import { nowIso } from "./util";

export interface SyncResult {
  status: "success" | "noop" | "error";
  rowsSynced: number;
  error?: string;
}

export function leadToRow(lead: LeadRow): (string | null)[] {
  return [
    lead.received_at,
    lead.contact_id,
    lead.first_name,
    lead.last_name,
    lead.email,
    lead.phone,
    lead.source,
    lead.tags,
  ];
}

/**
 * Pushes unsynced leads to Google Sheets in one append call. Leads are only
 * marked synced after Google confirms the write, so a failed run is simply
 * retried by the next cron tick.
 */
export async function syncLeads(
  env: Env,
  trigger: "cron" | "manual",
  fetchFn: FetchFn = fetch,
): Promise<SyncResult> {
  const runId = await startSyncRun(env.DB, trigger);
  const batchSize = Math.min(Math.max(Number(env.SYNC_BATCH_SIZE) || 100, 1), 500);

  try {
    const leads = await getUnsyncedLeads(env.DB, batchSize);
    if (leads.length === 0) {
      await finishSyncRun(env.DB, runId, "noop", 0);
      return { status: "noop", rowsSynced: 0 };
    }

    await appendRows(env, leads.map(leadToRow), fetchFn);
    await markSynced(env.DB, leads.map((l) => l.id), nowIso());
    await finishSyncRun(env.DB, runId, "success", leads.length);
    return { status: "success", rowsSynced: leads.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("sync failed", { runId, message });
    await finishSyncRun(env.DB, runId, "error", 0, message.slice(0, 500));
    return { status: "error", rowsSynced: 0, error: message };
  }
}
