import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertLead } from "../src/db";
import { FIELD_MASK } from "../src/places";
import { syncLeads } from "../src/sync";
import { sha256Hex } from "../src/util";

const API_KEY = "test-places-key-123";
const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

// A plain copy of the bindings with a Places key. The Google token is
// pre-cached in KV, so these tests never need a service account.
function placesEnv(overrides: Record<string, string> = {}): Env {
  return {
    DB: env.DB,
    KV: env.KV,
    SHEET_ID: env.SHEET_ID,
    SHEET_TAB: env.SHEET_TAB,
    SYNC_BATCH_SIZE: env.SYNC_BATCH_SIZE,
    PLACES_MAX_PER_RUN: "25",
    GHL_WEBHOOK_SECRET: env.GHL_WEBHOOK_SECRET,
    ADMIN_TOKEN: env.ADMIN_TOKEN,
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    GOOGLE_PLACES_API_KEY: API_KEY,
    ...overrides,
  } as Env;
}

const acme = {
  id: "ChIJacme",
  displayName: { text: "Acme Plumbing LLC", languageCode: "en" },
  formattedAddress: "1 Main St, Austin, TX 78701, USA",
  rating: 4.7,
  userRatingCount: 212,
  websiteUri: "https://acme.example",
};

interface Call { url: string; init: RequestInit }

type PlacesHandler = (init: RequestInit) => Promise<Response> | Response;

function fakeGoogle(places: PlacesHandler = () => Response.json({ places: [acme] }), sheetsStatus = 200) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://places.googleapis.com/")) return places(init);
    if (url.startsWith("https://sheets.googleapis.com/")) return new Response(sheetsStatus === 200 ? "{}" : "boom", { status: sheetsStatus });
    return new Response("unexpected", { status: 599 });
  }) as typeof fetch;
  const placesCalls = () => calls.filter((c) => c.url.startsWith("https://places.googleapis.com/"));
  const sheetRows = (): unknown[][] =>
    calls
      .filter((c) => c.url.startsWith("https://sheets.googleapis.com/"))
      .flatMap((c) => JSON.parse(String(c.init.body)).values);
  return { calls, fetchFn, placesCalls, sheetRows };
}

async function seed(id: string, business: { company?: string; city?: string; state?: string } = {}) {
  await upsertLead(
    env.DB,
    {
      contactId: id, firstName: "Test", lastName: null, email: null, phone: null, source: null, tags: null, locationId: null,
      companyName: business.company ?? null, address1: null, city: business.city ?? null, state: business.state ?? null,
    },
    "{}",
  );
}

function lead(id: string) {
  return env.DB.prepare("SELECT * FROM leads WHERE contact_id = ?").bind(id).first<Record<string, unknown>>();
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM leads"), env.DB.prepare("DELETE FROM sync_runs")]);
  const { keys } = await env.KV.list({ prefix: "places:" });
  await Promise.all(keys.map((k) => env.KV.delete(k.name)));
  await env.KV.put("google:access_token", "fake-token");
});

afterEach(() => vi.restoreAllMocks());

describe("Places enrichment during sync", () => {
  it("stores the found business and appends it as extra sheet columns", async () => {
    await seed("p1", { company: "Acme Plumbing", city: "Austin", state: "TX" });
    const g = fakeGoogle();

    expect(await syncLeads(placesEnv(), "cron", g.fetchFn)).toEqual({ status: "success", rowsSynced: 1 });

    // Lookup happens before the append, with the key in a header and only our fields requested.
    expect(g.calls.map((c) => new URL(c.url).hostname)).toEqual(["places.googleapis.com", "sheets.googleapis.com"]);
    const [call] = g.placesCalls();
    expect(call.url).toBe(SEARCH_URL);
    expect(call.url).not.toContain(API_KEY);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(API_KEY);
    expect(headers["x-goog-fieldmask"]).toBe(
      "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.websiteUri",
    );
    expect(FIELD_MASK).toBe(headers["x-goog-fieldmask"]);
    expect(JSON.parse(String(call.init.body))).toEqual({ textQuery: "Acme Plumbing, Austin, TX", pageSize: 1 });

    expect(await lead("p1")).toMatchObject({
      enrichment_status: "found",
      place_id: "ChIJacme",
      place_name: "Acme Plumbing LLC",
      place_address: "1 Main St, Austin, TX 78701, USA",
      place_rating: 4.7,
      place_rating_count: 212,
      place_website: "https://acme.example",
      enrichment_error: null,
    });
    expect((await lead("p1"))!.synced_at).not.toBeNull();

    const [row] = g.sheetRows();
    expect(row).toHaveLength(19);
    expect(row.slice(8)).toEqual([
      "Acme Plumbing", "", "Austin", "TX",
      "Acme Plumbing LLC", "1 Main St, Austin, TX 78701, USA", 4.7, 212, "https://acme.example", "ChIJacme", "found",
    ]);
  });

  it("marks a business Google doesn't know as not_found and still syncs it", async () => {
    await seed("p2", { company: "Nowhere Co" });
    const g = fakeGoogle(() => Response.json({}));

    expect(await syncLeads(placesEnv(), "cron", g.fetchFn)).toEqual({ status: "success", rowsSynced: 1 });
    expect(JSON.parse(String(g.placesCalls()[0].init.body)).textQuery).toBe("Nowhere Co");
    expect(await lead("p2")).toMatchObject({ enrichment_status: "not_found", place_id: null, place_name: null });
    expect(g.sheetRows()[0].at(-1)).toBe("not_found");
  });

  it("without an API key, syncs as before and marks leads skipped", async () => {
    await seed("p3", { company: "Acme Plumbing", city: "Austin" });
    const g = fakeGoogle();

    const result = await syncLeads(placesEnv({ GOOGLE_PLACES_API_KEY: "" }), "cron", g.fetchFn);
    expect(result).toEqual({ status: "success", rowsSynced: 1 });
    expect(g.placesCalls()).toHaveLength(0);
    expect(await lead("p3")).toMatchObject({ enrichment_status: "skipped", place_id: null });
    expect((await lead("p3"))!.synced_at).not.toBeNull();
    expect(g.sheetRows()[0].at(-1)).toBe("skipped");
  });

  it("marks the lead failed on a Places 500, never logs the key, and still syncs it", async () => {
    await seed("p4", { company: "Acme Plumbing" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = fakeGoogle(() => new Response(`{"error":"backend down for key ${API_KEY}"}`, { status: 500 }));

    expect(await syncLeads(placesEnv(), "cron", g.fetchFn)).toEqual({ status: "success", rowsSynced: 1 });
    const row = await lead("p4");
    expect(row).toMatchObject({ enrichment_status: "failed" });
    expect(row!.synced_at).not.toBeNull();
    expect(row!.enrichment_error).toContain("Places search failed (500)");
    expect(row!.enrichment_error).not.toContain(API_KEY);

    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(API_KEY);
    // Errors aren't cached, so a later lead for the same business gets a fresh lookup.
    expect((await env.KV.list({ prefix: "places:" })).keys).toHaveLength(0);
  });

  it("gives up on a slow Places request at the timeout and still syncs the lead", async () => {
    await seed("p5", { company: "Slow Co" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Never answers; only the request's abort signal ends it.
    const g = fakeGoogle(
      (init) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
    );

    expect(await syncLeads(placesEnv(), "cron", g.fetchFn, 20)).toEqual({ status: "success", rowsSynced: 1 });
    expect(await lead("p5")).toMatchObject({
      enrichment_status: "failed",
      enrichment_error: "Places request timed out after 20 ms",
    });
  });

  it("caches answers in KV for 7 days so a business is looked up once", async () => {
    await seed("c1", { company: "Acme Plumbing", city: "Austin", state: "TX" });
    await seed("c2", { company: "ACME plumbing", city: "austin", state: "tx" });
    const first = fakeGoogle();
    await syncLeads(placesEnv(), "cron", first.fetchFn);
    expect(first.placesCalls()).toHaveLength(1);

    const { keys } = await env.KV.list({ prefix: "places:" });
    expect(keys).toHaveLength(1);
    const ttl = keys[0].expiration! - Date.now() / 1000;
    expect(ttl).toBeGreaterThan(7 * 86400 - 60);
    expect(ttl).toBeLessThanOrEqual(7 * 86400);

    await seed("c3", { company: "Acme Plumbing", city: "Austin", state: "TX" });
    const second = fakeGoogle();
    expect(await syncLeads(placesEnv(), "cron", second.fetchFn)).toEqual({ status: "success", rowsSynced: 1 });
    expect(second.placesCalls()).toHaveLength(0);
    for (const id of ["c1", "c2", "c3"]) {
      expect(await lead(id)).toMatchObject({ enrichment_status: "found", place_name: "Acme Plumbing LLC" });
    }
  });

  it("skips leads without a company name", async () => {
    await seed("p7", { city: "Austin", state: "TX" });
    const g = fakeGoogle();

    expect(await syncLeads(placesEnv(), "cron", g.fetchFn)).toEqual({ status: "success", rowsSynced: 1 });
    expect(g.placesCalls()).toHaveLength(0);
    expect(await lead("p7")).toMatchObject({ enrichment_status: "skipped" });
  });

  it("scrubs the key, plain or URL-encoded, from network errors", async () => {
    await seed("n1", { company: "Acme Plumbing" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const odd = "k3y/with+chars";
    const g = fakeGoogle(() => {
      throw new TypeError(`connect failed for ?key=${encodeURIComponent(odd)} (${odd})`);
    });

    expect(await syncLeads(placesEnv({ GOOGLE_PLACES_API_KEY: odd }), "cron", g.fetchFn)).toEqual({ status: "success", rowsSynced: 1 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(odd);
    const error = String((await lead("n1"))!.enrichment_error);
    expect(error).toContain("[redacted]");
    expect(error).not.toContain(odd);
    expect(error).not.toContain(encodeURIComponent(odd));
  });

  it("treats an unreadable cache entry as a miss", async () => {
    await seed("r1", { company: "Acme Plumbing" });
    await env.KV.put(`places:${await sha256Hex("acme plumbing")}`, '{"status":"pending"}');
    const g = fakeGoogle();

    await syncLeads(placesEnv(), "cron", g.fetchFn);
    expect(g.placesCalls()).toHaveLength(1);
    expect(await lead("r1")).toMatchObject({ enrichment_status: "found" });
  });

  it("marks the lead failed when the KV cache read fails, and still syncs it", async () => {
    await seed("v1", { company: "Acme Plumbing" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = {
      get: (key: string) => (key.startsWith("places:") ? Promise.reject(new Error("KV unavailable")) : env.KV.get(key)),
      put: env.KV.put.bind(env.KV),
      delete: env.KV.delete.bind(env.KV),
    } as unknown as KVNamespace;
    const g = fakeGoogle();

    expect(await syncLeads({ ...placesEnv(), KV: kv }, "cron", g.fetchFn)).toEqual({ status: "success", rowsSynced: 1 });
    expect(g.placesCalls()).toHaveLength(0);
    expect(await lead("v1")).toMatchObject({ enrichment_status: "failed", enrichment_error: "KV unavailable" });
  });

  it("syncs leads unenriched when the enrichment results can't be saved", async () => {
    await seed("d1", { company: "Acme Plumbing" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The first batch (saving enrichment) fails; markSynced's batch works.
    let failNext = true;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch" && failNext) {
          failNext = false;
          return () => Promise.reject(new Error("D1 busy"));
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const g = fakeGoogle();

    expect(await syncLeads({ ...placesEnv(), DB: db }, "cron", g.fetchFn)).toEqual({ status: "success", rowsSynced: 1 });
    expect(await lead("d1")).toMatchObject({ enrichment_status: "skipped", place_id: null });
    expect((await lead("d1"))!.synced_at).not.toBeNull();
    const [row] = g.sheetRows();
    expect(row.slice(12)).toEqual(["", "", "", "", "", "", "skipped"]);
  });

  it("keeps enrichment when the Sheets append fails, without a second lookup on retry", async () => {
    await seed("t1", { company: "Acme Plumbing" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = fakeGoogle(undefined, 500);
    expect(await syncLeads(placesEnv(), "cron", failing.fetchFn)).toMatchObject({ status: "error" });
    expect(await lead("t1")).toMatchObject({ enrichment_status: "found", synced_at: null });

    const retry = fakeGoogle();
    expect(await syncLeads(placesEnv(), "cron", retry.fetchFn)).toEqual({ status: "success", rowsSynced: 1 });
    expect(retry.placesCalls()).toHaveLength(0);
    expect(retry.sheetRows()[0].at(-1)).toBe("found");
  });

  it("caps lookups per run and holds the rest for the next run", async () => {
    await seed("k1", { company: "One Co" });
    await seed("k2", { company: "Two Co" });
    await seed("k3", { company: "Three Co" });
    const env2 = placesEnv({ PLACES_MAX_PER_RUN: "2" });

    const first = fakeGoogle();
    expect(await syncLeads(env2, "cron", first.fetchFn)).toEqual({ status: "success", rowsSynced: 2 });
    expect(first.placesCalls()).toHaveLength(2);
    expect(await lead("k3")).toMatchObject({ enrichment_status: "pending", synced_at: null });

    const second = fakeGoogle();
    expect(await syncLeads(env2, "cron", second.fetchFn)).toEqual({ status: "success", rowsSynced: 1 });
    expect(second.placesCalls()).toHaveLength(1);
    expect(await lead("k3")).toMatchObject({ enrichment_status: "found" });
    expect((await lead("k3"))!.synced_at).not.toBeNull();
  });
});
