import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertLead } from "../src/db";
import { syncLeads } from "../src/sync";

// A throwaway RSA key pair stands in for a Google service account, so the
// JWT signing path runs for real and its signature can be verified.
let privatePem = "";
let publicKey: CryptoKey;

function toPem(der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privatePem = toPem((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  publicKey = pair.publicKey;
});

// A plain copy of the bindings with test Google credentials. (Never assign
// onto the shared env object: that would leak into other tests.)
function testEnv(): Env {
  return {
    DB: env.DB,
    KV: env.KV,
    SHEET_ID: env.SHEET_ID,
    SHEET_TAB: env.SHEET_TAB,
    SYNC_BATCH_SIZE: env.SYNC_BATCH_SIZE,
    GHL_WEBHOOK_SECRET: env.GHL_WEBHOOK_SECRET,
    ADMIN_TOKEN: env.ADMIN_TOKEN,
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sync@test.iam.gserviceaccount.com", private_key: privatePem }),
  } as Env;
}

interface Call { url: string; init: RequestInit }

function fakeGoogle(sheetsStatus = 200) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "fake-token", expires_in: 3600 });
    }
    if (url.startsWith("https://sheets.googleapis.com/")) {
      return new Response(sheetsStatus === 200 ? "{}" : "boom", { status: sheetsStatus });
    }
    return new Response("unexpected", { status: 599 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

async function seed(id: string, first: string) {
  await upsertLead(
    env.DB,
    { contactId: id, firstName: first, lastName: "Test", email: `${id}@x.com`, phone: null, source: "web", tags: null, locationId: null, companyName: null, address1: null, city: null, state: null },
    "{}",
  );
}

// Storage persists across tests in a file, so start each test clean.
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM leads"), env.DB.prepare("DELETE FROM sync_runs")]);
  await env.KV.delete("google:access_token");
});

describe("syncLeads", () => {
  it("records a no-op run when nothing is pending", async () => {
    const { calls, fetchFn } = fakeGoogle();
    const result = await syncLeads(testEnv(), "cron", fetchFn);
    expect(result).toEqual({ status: "noop", rowsSynced: 0 });
    expect(calls).toHaveLength(0);
    const run = await env.DB.prepare("SELECT * FROM sync_runs ORDER BY id DESC").first();
    expect(run).toMatchObject({ status: "noop", trigger: "cron" });
  });

  it("appends pending leads as RAW rows, marks them synced, and signs a valid JWT", async () => {
    await seed("s1", "Ana");
    await seed("s2", "=HYPERLINK(\"evil\")");
    const { calls, fetchFn } = fakeGoogle();

    const result = await syncLeads(testEnv(), "manual", fetchFn);
    expect(result).toEqual({ status: "success", rowsSynced: 2 });

    // Token request carries a JWT signed by the service account key.
    const tokenBody = new URLSearchParams(String(calls[0].init.body));
    const [h, p, sig] = tokenBody.get("assertion")!.split(".");
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    expect(claims).toMatchObject({ iss: "sync@test.iam.gserviceaccount.com", aud: "https://oauth2.googleapis.com/token" });
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, b64urlDecode(sig), new TextEncoder().encode(`${h}.${p}`));
    expect(valid).toBe(true);

    // Append request: RAW input (formulas stored as text), correct sheet and tab.
    const append = calls[1];
    expect(append.url).toContain("/spreadsheets/test-sheet-id/values/Leads!A1:append");
    expect(append.url).toContain("valueInputOption=RAW");
    expect((append.init.headers as Record<string, string>).authorization).toBe("Bearer fake-token");
    const { values } = JSON.parse(String(append.init.body));
    expect(values).toHaveLength(2);
    expect(values[1][2]).toBe("=HYPERLINK(\"evil\")");

    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE synced_at IS NULL").first<{ n: number }>();
    expect(pending!.n).toBe(0);
  });

  it("reuses the cached Google token on the next run", async () => {
    await seed("c1", "Cam");
    const first = fakeGoogle();
    await syncLeads(testEnv(), "cron", first.fetchFn);

    await seed("c2", "Dee");
    const second = fakeGoogle();
    await syncLeads(testEnv(), "cron", second.fetchFn);
    expect(second.calls.map((c) => new URL(c.url).hostname)).toEqual(["sheets.googleapis.com"]);
  });

  it("leaves leads pending and logs the error when Sheets fails", async () => {
    await seed("f1", "Eve");
    const { fetchFn } = fakeGoogle(500);
    const result = await syncLeads(testEnv(), "cron", fetchFn);
    expect(result.status).toBe("error");
    expect(result.error).toContain("Sheets append failed (500)");

    const lead = await env.DB.prepare("SELECT synced_at FROM leads WHERE contact_id = 'f1'").first();
    expect(lead).toEqual({ synced_at: null });
    const run = await env.DB.prepare("SELECT * FROM sync_runs ORDER BY id DESC").first();
    expect(run).toMatchObject({ status: "error", rows_synced: 0 });
  });

  it("drops the cached token when Google answers 401", async () => {
    await seed("u1", "Fay");
    await env.KV.put("google:access_token", "stale-token");
    const { fetchFn } = fakeGoogle(401);
    await syncLeads(testEnv(), "cron", fetchFn);
    expect(await env.KV.get("google:access_token")).toBeNull();
  });

  it("reports a clear error when the service account secret is missing", async () => {
    await seed("m1", "Gus");
    const { fetchFn } = fakeGoogle();
    const result = await syncLeads(env, "cron", fetchFn);
    expect(result).toMatchObject({ status: "error" });
    expect(result.error).toContain("missing client_email or private_key");
  });

  it("explains a malformed private key instead of a low-level crypto error", async () => {
    await seed("k1", "Hal");
    const broken = { ...testEnv(), GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "a@b.c", private_key: "not-a-key" }) } as Env;
    const result = await syncLeads(broken, "cron", fakeGoogle().fetchFn);
    expect(result.error).toBe("GOOGLE_SERVICE_ACCOUNT_JSON private_key is not a valid PEM private key");
  });
});
