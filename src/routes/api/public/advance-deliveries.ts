import { createFileRoute } from "@tanstack/react-router";

/**
 * Background delivery progress. Called by a scheduler with the shared cron
 * credential. Never returns user data and never performs a purchase that the
 * normal delivery rules would not already allow.
 */
export const Route = createFileRoute("/api/public/advance-deliveries")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["LOVABLE_CRON_SECRET"];
        if (!secret) return new Response("not_configured", { status: 503 });

        const header = request.headers.get("authorization") ?? "";
        const token = header.replace(/^Bearer\s+/i, "").trim();
        if (token !== secret) return new Response("unauthorized", { status: 401 });

        const { advanceStuckDeliveries } = await import("../../../lib/server/delivery.server");
        const result = await advanceStuckDeliveries();
        return Response.json({ ok: true, advanced: result.advanced });
      },
    },
  },
});
