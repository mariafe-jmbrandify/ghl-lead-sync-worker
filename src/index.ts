import { renderDashboard } from "./admin";
import { syncLeads } from "./sync";
import { isAdmin, json } from "./util";
import { handleWebhook } from "./webhook";

function unauthorizedAdmin(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Lead Sync Admin", charset="UTF-8"' },
  });
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    try {
      if (pathname === "/health" && method === "GET") {
        return json({ ok: true });
      }

      if (pathname === "/webhooks/ghl") {
        if (method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
        return await handleWebhook(request, env);
      }

      if (pathname === "/admin" || pathname === "/admin/sync") {
        if (!(await isAdmin(request, env.ADMIN_TOKEN))) return unauthorizedAdmin();

        if (pathname === "/admin" && method === "GET") {
          return await renderDashboard(env);
        }
        if (pathname === "/admin/sync" && method === "POST") {
          const result = await syncLeads(env, "manual");
          const flash =
            result.status === "error"
              ? `Sync failed: ${result.error}`
              : result.status === "noop"
                ? "Nothing to sync."
                : `Synced ${result.rowsSynced} lead(s) to Google Sheets.`;
          return await renderDashboard(env, flash);
        }
        return json({ ok: false, error: "method not allowed" }, 405);
      }

      return json({ ok: false, error: "not found" }, 404);
    } catch (err) {
      console.error("unhandled error", { pathname, err: String(err) });
      return json({ ok: false, error: "internal error" }, 500);
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      syncLeads(env, "cron").then((r) => console.log("cron sync", r)),
    );
  },
} satisfies ExportedHandler<Env>;
