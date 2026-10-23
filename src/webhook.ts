import { upsertLead, type LeadInput } from "./db";
import { json, safeEqual, sha256Hex } from "./util";

const MAX_BODY_BYTES = 64 * 1024;
const DEDUPE_TTL_SECONDS = 600;

type Payload = Record<string, unknown>;

function str(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/**
 * Maps a GoHighLevel workflow webhook body to a lead. GHL sends snake_case
 * standard fields (contact_id, first_name, ...); camelCase variants are
 * accepted too so the same endpoint works with custom webhook actions.
 */
export function normalizeLead(body: Payload): LeadInput | null {
  const location = (body.location ?? {}) as Payload;
  const contactId = str(body.contact_id ?? body.contactId ?? body.id);
  if (!contactId) return null;

  const rawTags = body.tags;
  const tags = Array.isArray(rawTags)
    ? rawTags.map(String).join(", ")
    : str(rawTags);

  return {
    contactId,
    firstName: str(body.first_name ?? body.firstName),
    lastName: str(body.last_name ?? body.lastName),
    email: str(body.email)?.toLowerCase() ?? null,
    phone: str(body.phone),
    source: str(body.contact_source ?? body.source),
    tags: tags || null,
    locationId: str(location.id ?? body.location_id ?? body.locationId),
    companyName: str(body.company_name ?? body.companyName),
    address1: str(body.address1),
    city: str(body.city),
    state: str(body.state),
  };
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  // GHL's standard webhook action can't add headers, so the shared secret
  // may arrive as ?key=... ; a header is preferred when available.
  const url = new URL(request.url);
  const provided = request.headers.get("x-webhook-secret") ?? url.searchParams.get("key") ?? "";
  if (!env.GHL_WEBHOOK_SECRET || !(await safeEqual(provided, env.GHL_WEBHOOK_SECRET))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, 413);
  }

  let body: Payload;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ ok: false, error: "expected a JSON object" }, 400);
  }

  const lead = normalizeLead(body);
  if (!lead) {
    return json({ ok: false, error: "missing contact_id" }, 422);
  }

  // GHL retries on slow responses; identical bodies within 10 minutes are
  // acknowledged without touching the database again.
  const dedupeKey = `webhook:${await sha256Hex(raw)}`;
  if (await env.KV.get(dedupeKey)) {
    return json({ ok: true, duplicate: true, contactId: lead.contactId });
  }

  const result = await upsertLead(env.DB, lead, raw);
  await env.KV.put(dedupeKey, "1", { expirationTtl: DEDUPE_TTL_SECONDS });

  return json({ ok: true, created: result.created, contactId: lead.contactId });
}
