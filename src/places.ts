/**
 * Google Places (New) Text Search enrichment: looks up each lead's business
 * before it is synced and stores address, rating, review count and website.
 */

import { saveEnrichments, type Enrichment, type LeadRow } from "./db";
import type { FetchFn } from "./sheets";
import { nowIso, sha256Hex } from "./util";

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
// Only the fields we store. The field mask sets the billed SKU: rating,
// userRatingCount and websiteUri put each request on Text Search Enterprise.
export const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.rating",
  "places.userRatingCount",
  "places.websiteUri",
].join(",");
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_TIMEOUT_MS = 5000;

interface Place {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  websiteUri?: string;
}

/** Removes the API key (plain or URL-encoded) from text bound for logs or D1. */
function scrubKey(text: string, apiKey: string): string {
  return text.split(apiKey).join("[redacted]").split(encodeURIComponent(apiKey)).join("[redacted]");
}

/** "Company, City, State", or null when there is no company to look up. */
export function buildPlacesQuery(lead: Pick<LeadRow, "company_name" | "city" | "state">): string | null {
  if (!lead.company_name) return null;
  return [lead.company_name, lead.city, lead.state].filter(Boolean).join(", ");
}

/**
 * Runs one Text Search and returns the top match. Throws on HTTP errors and
 * timeouts. The API key goes in a header, never the URL, and is scrubbed from
 * error text so it can't reach logs or the database.
 */
export async function searchPlace(
  apiKey: string,
  query: string,
  fetchFn: FetchFn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Enrichment> {
  let res: Response;
  try {
    res = await fetchFn(SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
        "x-goog-fieldmask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: query, pageSize: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`Places request timed out after ${timeoutMs} ms`);
    }
    throw err;
  }
  if (!res.ok) {
    const detail = scrubKey(await res.text(), apiKey).slice(0, 200);
    throw new Error(`Places search failed (${res.status}): ${detail}`);
  }

  // No matches come back as {} with no "places" key at all.
  const data = (await res.json()) as { places?: Place[] };
  const place = data.places?.[0];
  if (!place) return { status: "not_found" };
  return {
    status: "found",
    placeId: place.id ?? null,
    placeName: place.displayName?.text ?? null,
    placeAddress: place.formattedAddress ?? null,
    placeRating: place.rating ?? null,
    placeRatingCount: place.userRatingCount ?? null,
    placeWebsite: place.websiteUri ?? null,
  };
}

/** Cached answer for a query, or null on a miss or an unreadable entry. */
async function readCache(kv: KVNamespace, key: string): Promise<Enrichment | null> {
  const cached = await kv.get(key);
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached) as Enrichment;
    return parsed.status === "found" || parsed.status === "not_found" ? parsed : null;
  } catch {
    return null;
  }
}

function applyEnrichment(lead: LeadRow, result: Enrichment, at: string): LeadRow {
  return {
    ...lead,
    enrichment_status: result.status,
    enrichment_error: result.error ?? null,
    enriched_at: at,
    place_id: result.placeId ?? null,
    place_name: result.placeName ?? null,
    place_address: result.placeAddress ?? null,
    place_rating: result.placeRating ?? null,
    place_rating_count: result.placeRatingCount ?? null,
    place_website: result.placeWebsite ?? null,
  };
}

/**
 * Enriches leads still pending enrichment and returns the updated rows.
 * Does nothing without GOOGLE_PLACES_API_KEY. Answers are cached in KV for
 * 7 days by query; at most PLACES_MAX_PER_RUN uncached lookups run, and
 * leads past that cap are returned still 'pending'. A lookup error marks
 * that lead 'failed'. Results are saved in one D1 batch; if that write
 * fails it throws, so the caller can sync the leads unenriched rather than
 * put data in the sheet that D1 doesn't have.
 */
export async function enrichLeads(
  env: Env,
  leads: LeadRow[],
  fetchFn: FetchFn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LeadRow[]> {
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return leads;
  // Capped at 40 so lookups plus the Google token and append calls stay
  // under the Workers Free plan's 50 subrequests per invocation.
  const maxLookups = Math.min(Math.max(Number(env.PLACES_MAX_PER_RUN) || 25, 1), 40);
  let lookups = 0;

  const updates: { id: number; result: Enrichment }[] = [];
  for (const lead of leads) {
    if (lead.enrichment_status !== "pending") continue;

    let result: Enrichment | null = null;
    try {
      const query = buildPlacesQuery(lead);
      if (!query) {
        result = { status: "skipped" };
      } else {
        const cacheKey = `places:${await sha256Hex(query.toLowerCase())}`;
        result = await readCache(env.KV, cacheKey);
        if (!result && lookups < maxLookups) {
          lookups++;
          result = await searchPlace(apiKey, query, fetchFn, timeoutMs);
          await env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => {});
        }
      }
    } catch (err) {
      const message = scrubKey(err instanceof Error ? err.message : String(err), apiKey).slice(0, 500);
      console.warn("places lookup failed", { leadId: lead.id, message });
      result = { status: "failed", error: message };
    }

    // No result means over this run's lookup cap: left pending for the next run.
    if (result) updates.push({ id: lead.id, result });
  }

  const at = nowIso();
  await saveEnrichments(env.DB, updates, at);
  const byId = new Map(updates.map((u) => [u.id, u.result]));
  return leads.map((lead) => {
    const result = byId.get(lead.id);
    return result ? applyEnrichment(lead, result, at) : lead;
  });
}
