import { getDashboardData } from "./db";
import { escapeHtml as e } from "./util";

function statusBadge(status: string): string {
  const cls = status === "success" ? "ok" : status === "error" ? "err" : "muted";
  return `<span class="badge ${cls}">${e(status)}</span>`;
}

export async function renderDashboard(env: Env, flash?: string): Promise<Response> {
  const data = await getDashboardData(env.DB);
  const lastRun = data.runs[0];

  const leadRows = data.leads
    .map(
      (l) => `<tr>
        <td>${e(l.received_at.replace("T", " ").slice(0, 16))}</td>
        <td>${e([l.first_name, l.last_name].filter(Boolean).join(" ") || "—")}</td>
        <td>${e(l.email ?? "—")}</td>
        <td>${e(l.phone ?? "—")}</td>
        <td>${e(l.source ?? "—")}</td>
        <td>${l.synced_at ? '<span class="badge ok">synced</span>' : '<span class="badge muted">pending</span>'}</td>
      </tr>`,
    )
    .join("");

  const runRows = data.runs
    .map(
      (r) => `<tr>
        <td>${e(r.started_at.replace("T", " ").slice(0, 19))}</td>
        <td>${e(r.trigger)}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${r.rows_synced}</td>
        <td class="error">${e(r.error ?? "")}</td>
      </tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lead Sync Admin</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1c2230; --muted:#6b7385; --line:#e3e6ec; --ok:#1f7a4d; --err:#b42318; --accent:#2f5bd3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#12151b; --card:#1a1f28; --text:#e6e9ef; --muted:#9aa3b5; --line:#2a313d; --ok:#4cc38a; --err:#ff7a6e; --accent:#7c9bff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:1100px; margin:0 auto; padding:24px 16px 48px; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; margin-bottom:20px; }
  h1 { font-size:20px; margin:0; }
  h2 { font-size:15px; margin:28px 0 10px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .stat b { display:block; font-size:24px; }
  .stat > span { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .table-wrap { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  table { width:100%; border-collapse:collapse; min-width:640px; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; color:var(--muted); font-weight:600; }
  tr:last-child td { border-bottom:none; }
  .badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; border:1px solid currentColor; }
  .ok { color:var(--ok); } .err { color:var(--err); } .muted { color:var(--muted); }
  td.error { color:var(--err); max-width:360px; word-break:break-word; }
  button { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:8px 14px; font:inherit; cursor:pointer; }
  .flash { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--accent); padding:10px 14px; border-radius:8px; margin-bottom:16px; }
  .empty { color:var(--muted); padding:16px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>GoHighLevel → Google Sheets lead sync</h1>
    <form method="post" action="/admin/sync"><button type="submit">Sync now</button></form>
  </header>
  ${flash ? `<div class="flash">${e(flash)}</div>` : ""}
  <div class="stats">
    <div class="stat"><span>Total leads</span><b>${data.total}</b></div>
    <div class="stat"><span>Waiting to sync</span><b>${data.unsynced}</b></div>
    <div class="stat"><span>Last sync</span><b>${lastRun ? statusBadge(lastRun.status) : "—"}</b></div>
  </div>

  <h2>Latest leads</h2>
  <div class="table-wrap">
    ${
      data.leads.length
        ? `<table><thead><tr><th>Received (UTC)</th><th>Name</th><th>Email</th><th>Phone</th><th>Source</th><th>Sheet</th></tr></thead><tbody>${leadRows}</tbody></table>`
        : `<div class="empty">No leads yet. Point a GoHighLevel workflow webhook at /webhooks/ghl.</div>`
    }
  </div>

  <h2>Recent sync runs</h2>
  <div class="table-wrap">
    ${
      data.runs.length
        ? `<table><thead><tr><th>Started (UTC)</th><th>Trigger</th><th>Status</th><th>Rows</th><th>Error</th></tr></thead><tbody>${runRows}</tbody></table>`
        : `<div class="empty">No sync runs yet. The cron runs every 5 minutes.</div>`
    }
  </div>
</main>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    },
  });
}
