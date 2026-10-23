/**
 * Minimal Google Sheets client for Workers: signs a service-account JWT with
 * WebCrypto (no Node libraries needed) and appends rows with the REST API.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_CACHE_KEY = "google:access_token";

export type FetchFn = typeof fetch;

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function base64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function parseServiceAccount(json: string): ServiceAccount {
  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

export async function createSignedJwt(sa: ServiceAccount, nowSeconds: number): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(sa.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON private_key is not a valid PEM private key");
  }
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(signature)}`;
}

/** Returns a Google access token, cached in KV for just under an hour. */
export async function getAccessToken(env: Env, fetchFn: FetchFn): Promise<string> {
  const cached = await env.KV.get(TOKEN_CACHE_KEY);
  if (cached) return cached;

  const sa = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const assertion = await createSignedJwt(sa, Math.floor(Date.now() / 1000));
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  const ttl = Math.max(60, (data.expires_in ?? 3600) - 300);
  await env.KV.put(TOKEN_CACHE_KEY, data.access_token, { expirationTtl: ttl });
  return data.access_token;
}

/**
 * Appends rows to the sheet tab. Uses RAW input so values like "=SUM(...)"
 * from a form are stored as text, never executed as formulas.
 */
export async function appendRows(
  env: Env,
  rows: (string | null)[][],
  fetchFn: FetchFn,
): Promise<void> {
  const token = await getAccessToken(env, fetchFn);
  const range = encodeURIComponent(`${env.SHEET_TAB}!A1`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.SHEET_ID)}` +
    `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const res = await fetchFn(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ values: rows.map((r) => r.map((v) => v ?? "")) }),
  });

  if (res.status === 401) {
    // Token revoked or expired early: drop the cache so the next run refreshes it.
    await env.KV.delete(TOKEN_CACHE_KEY);
  }
  if (!res.ok) {
    throw new Error(`Sheets append failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}
