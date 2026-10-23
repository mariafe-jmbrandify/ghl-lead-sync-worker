import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { saveEnrichments, upsertLead } from "../src/db";
import worker from "../src/index";

const noBusiness = { companyName: null, address1: null, city: null, state: null };

function basic(password: string) {
  return { authorization: `Basic ${btoa(`admin:${password}`)}` };
}

// Storage persists across tests in a file, so start each test clean.
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM leads"), env.DB.prepare("DELETE FROM sync_runs")]);
});

async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://worker.test${path}`, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("routing", () => {
  it("serves a health check and 404s unknown paths", async () => {
    expect(await (await call("/health")).json()).toEqual({ ok: true });
    expect((await call("/nope")).status).toBe(404);
  });
});

describe("admin dashboard", () => {
  it("requires Basic auth with the admin token", async () => {
    const anon = await call("/admin");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain("Basic");
    expect((await call("/admin", { headers: basic("wrong") })).status).toBe(401);
  });

  it("lists leads with HTML escaped", async () => {
    await upsertLead(
      env.DB,
      { contactId: "x1", firstName: "<script>alert(1)</script>", lastName: null, email: "x@y.com", phone: null, source: "form", tags: null, locationId: null, ...noBusiness },
      "{}",
    );
    const res = await call("/admin", { headers: basic("test-admin-token") });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("x@y.com");
  });

  it("shows business name, rating and enrichment status, escaped", async () => {
    await upsertLead(
      env.DB,
      { contactId: "b1", firstName: "Bo", lastName: null, email: null, phone: null, source: null, tags: null, locationId: null, ...noBusiness },
      "{}",
    );
    const { id } = (await env.DB.prepare("SELECT id FROM leads WHERE contact_id = 'b1'").first<{ id: number }>())!;
    await saveEnrichments(
      env.DB,
      [{ id, result: { status: "found", placeName: "<b>Acme</b> & Sons", placeRating: 4.6, placeRatingCount: 128 } }],
      "2026-10-23T00:00:00.000Z",
    );
    const html = await (await call("/admin", { headers: basic("test-admin-token") })).text();
    expect(html).toContain("<th>Business</th><th>Rating</th><th>Enrichment</th>");
    expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt; &amp; Sons");
    expect(html).not.toContain("<b>Acme</b>");
    expect(html).toContain("4.6 (128)");
    expect(html).toContain('<span class="badge ok">found</span>');
  });

  it("shows the outcome of a manual sync", async () => {
    await upsertLead(
      env.DB,
      { contactId: "m1", firstName: "Ann", lastName: null, email: null, phone: null, source: null, tags: null, locationId: null, ...noBusiness },
      "{}",
    );
    // Test env has no real Google credentials, so the sync fails safely.
    const res = await call("/admin/sync", { method: "POST", headers: basic("test-admin-token") });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sync failed");
  });
});

describe("scheduled handler", () => {
  it("runs a cron sync and records it", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    const run = await env.DB.prepare("SELECT trigger, status FROM sync_runs ORDER BY id DESC").first();
    expect(run).toEqual({ trigger: "cron", status: "noop" });
  });
});
