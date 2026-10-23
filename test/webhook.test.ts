import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { normalizeLead } from "../src/webhook";

const SECRET = "test-webhook-secret";

async function send(body: unknown, opts: { key?: string | null; header?: string; method?: string } = {}) {
  const url = new URL("https://worker.test/webhooks/ghl");
  if (opts.key !== null) url.searchParams.set("key", opts.key ?? SECRET);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.header) headers["x-webhook-secret"] = opts.header;
  const request = new Request<unknown, IncomingRequestCfProperties>(url, {
    method: opts.method ?? "POST",
    headers,
    body: opts.method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const ghlPayload = {
  contact_id: "c_123",
  first_name: "Ana",
  last_name: "Reyes",
  email: "Ana.Reyes@Example.com ",
  phone: "+15555550100",
  tags: ["new lead", "facebook"],
  contact_source: "Facebook Lead Ad",
  location: { id: "loc_9", name: "Test Agency" },
  company_name: "Reyes Plumbing",
  address1: "12 Main St",
  city: "Austin",
  state: "TX",
};

describe("normalizeLead", () => {
  it("maps GHL snake_case fields and cleans values", () => {
    expect(normalizeLead(ghlPayload)).toEqual({
      contactId: "c_123",
      firstName: "Ana",
      lastName: "Reyes",
      email: "ana.reyes@example.com",
      phone: "+15555550100",
      source: "Facebook Lead Ad",
      tags: "new lead, facebook",
      locationId: "loc_9",
      companyName: "Reyes Plumbing",
      address1: "12 Main St",
      city: "Austin",
      state: "TX",
    });
  });

  it("accepts camelCase variants", () => {
    const lead = normalizeLead({ contactId: "x1", firstName: "Jo", locationId: "L1", tags: "vip", companyName: " Jo's Bakery " });
    expect(lead).toMatchObject({ contactId: "x1", firstName: "Jo", locationId: "L1", tags: "vip", companyName: "Jo's Bakery" });
  });

  it("leaves business fields null when GHL omits them", () => {
    expect(normalizeLead({ contact_id: "n1", company_name: "  " })).toMatchObject({
      companyName: null,
      address1: null,
      city: null,
      state: null,
    });
  });

  it("returns null without a contact id", () => {
    expect(normalizeLead({ email: "a@b.com" })).toBeNull();
    expect(normalizeLead({ contact_id: "   " })).toBeNull();
  });
});

describe("POST /webhooks/ghl", () => {
  it("rejects requests without the shared secret", async () => {
    expect((await send(ghlPayload, { key: null })).status).toBe(401);
    expect((await send(ghlPayload, { key: "wrong" })).status).toBe(401);
  });

  it("accepts the secret as a header", async () => {
    const res = await send({ contact_id: "hdr_1" }, { key: null, header: SECRET });
    expect(res.status).toBe(200);
  });

  it("stores a new lead in D1", async () => {
    const res = await send(ghlPayload);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: true, contactId: "c_123" });

    const row = await env.DB.prepare("SELECT * FROM leads WHERE contact_id = ?").bind("c_123").first();
    expect(row).toMatchObject({
      first_name: "Ana",
      email: "ana.reyes@example.com",
      tags: "new lead, facebook",
      location_id: "loc_9",
      company_name: "Reyes Plumbing",
      address1: "12 Main St",
      city: "Austin",
      state: "TX",
      enrichment_status: "pending",
      synced_at: null,
    });
  });

  it("stores camelCase business fields from a custom webhook", async () => {
    await send({ contactId: "cc_1", companyName: "Jo's Bakery", address1: "5 Elm St", city: "Reno", state: "NV" });
    const row = await env.DB.prepare("SELECT * FROM leads WHERE contact_id = ?").bind("cc_1").first();
    expect(row).toMatchObject({ company_name: "Jo's Bakery", address1: "5 Elm St", city: "Reno", state: "NV" });
  });

  it("acknowledges an identical retry without writing again", async () => {
    await send(ghlPayload);
    const res = await send(ghlPayload);
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true });
  });

  it("updates the same contact instead of duplicating it, keeping known fields", async () => {
    await send({ contact_id: "c_upd", first_name: "Ben", email: "ben@example.com" });
    const res = await send({ contact_id: "c_upd", phone: "+15555550111" });
    expect(await res.json()).toMatchObject({ created: false });

    const { results } = await env.DB.prepare("SELECT * FROM leads WHERE contact_id = ?").bind("c_upd").all();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ first_name: "Ben", email: "ben@example.com", phone: "+15555550111" });
  });

  it("rejects bad input with clear errors", async () => {
    expect((await send("{not json")).status).toBe(400);
    expect((await send([1, 2])).status).toBe(400);
    expect((await send({ email: "x@y.com" })).status).toBe(422);
    expect((await send("x".repeat(70_000))).status).toBe(413);
    expect((await send(null, { method: "GET" })).status).toBe(405);
  });
});
