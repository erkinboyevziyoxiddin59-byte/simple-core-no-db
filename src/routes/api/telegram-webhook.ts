import { createFileRoute } from "@tanstack/react-router";

interface TelegramUser {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
  is_bot?: boolean;
}


interface TelegramChat {
  id?: number;
  type?: string;
}

interface TelegramMessage {
  message_id?: number;
  from?: TelegramUser;
  chat?: TelegramChat;
  date?: number;
  text?: string;
}

interface TelegramBusinessConnection {
  id?: string;
  user?: TelegramUser;
  date?: number;
}

interface TelegramUpdate {
  update_id?: number;
  business_connection?: TelegramBusinessConnection;
  business_connection_id?: string;
  business_message?: TelegramMessage;
  edited_business_message?: TelegramMessage;
  deleted_business_messages?: unknown;
  message?: TelegramMessage;
}

/** Safe, non-sensitive projection of a Telegram update. Never contains the raw payload. */
interface DiagnosticRecord {
  received_at: string;
  update_id: number | null;
  update_type: string;
  business_connection_id: string | null;
  business_user_id: number | null;
  chat_id: number | null;
  chat_type: string | null;
  from_id: number | null;
  from_username: string | null;
  from_first_name: string | null;
  message_date: number | null;
  text_length: number | null;
  text_preview: string | null;
}

function getUpdateType(update: TelegramUpdate): string {
  if (update.business_connection) return "business_connection";
  if (update.business_message) return "business_message";
  if (update.edited_business_message) return "edited_business_message";
  if (update.deleted_business_messages) return "deleted_business_messages";
  if (update.message) return "message";
  return "other";
}

function safeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildRecord(update: TelegramUpdate): DiagnosticRecord {
  const type = getUpdateType(update);
  const message =
    update.business_message ?? update.edited_business_message ?? update.message;
  const text = typeof message?.text === "string" ? message.text : null;

  return {
    received_at: new Date().toISOString(),
    update_id: safeNumber(update.update_id),
    update_type: type,
    business_connection_id:
      safeString(update.business_connection?.id, 128) ??
      safeString(update.business_connection_id, 128),
    business_user_id: safeNumber(update.business_connection?.user?.id),
    chat_id: safeNumber(message?.chat?.id),
    chat_type: safeString(message?.chat?.type, 32),
    from_id: safeNumber(message?.from?.id),
    from_username: safeString(message?.from?.username, 64),
    from_first_name: safeString(message?.from?.first_name, 128),
    message_date: safeNumber(message?.date),
    text_length: text === null ? null : text.length,
    text_preview: safeString(text, 500),
  };
}

/**
 * In-memory ring buffer of the most recent updates.
 * Survives only for the lifetime of a single serverless instance, but it makes
 * the diagnostic usable even when Supabase persistence is unavailable.
 */
const RECENT_LIMIT = 20;
const recent: DiagnosticRecord[] = [];

function remember(record: DiagnosticRecord) {
  recent.unshift(record);
  if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
}

async function persist(record: DiagnosticRecord): Promise<string | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("telegram_webhook_diagnostics")
      .insert(record);
    return error ? error.message : null;
  } catch (err) {
    return err instanceof Error ? err.message : "persist_failed";
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(request: Request): boolean {
  const expected = process.env["DIAGNOSTIC_SECRET"];
  if (!expected) return false;
  const url = new URL(request.url);
  const provided =
    request.headers.get("x-diagnostic-secret") ?? url.searchParams.get("secret") ?? "";
  return timingSafeEqual(provided, expected);
}

/**
 * Telegram webhook secret check.
 * When TELEGRAM_WEBHOOK_SECRET is configured, a missing/wrong token is rejected.
 * When it is not configured we keep accepting (diagnostics-only mode) so no
 * currently working HUMO notification is silently dropped.
 */
function isTelegramRequestTrusted(request: Request): { ok: boolean; enforced: boolean } {
  const expected = process.env["TELEGRAM_WEBHOOK_SECRET"];
  if (!expected) return { ok: true, enforced: false };
  const provided = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  return { ok: timingSafeEqual(provided, expected), enforced: true };
}


async function readLatest(limit: number): Promise<DiagnosticRecord[] | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("telegram_webhook_diagnostics")
      .select(
        "received_at, update_id, update_type, business_connection_id, business_user_id, chat_id, chat_type, from_id, from_username, from_first_name, message_date, text_length, text_preview",
      )
      .order("received_at", { ascending: false })
      .limit(limit);
    if (error) return null;
    return (data ?? []) as DiagnosticRecord[];
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/telegram-webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const wantsLatest =
          url.searchParams.has("latest") || url.searchParams.has("secret");

        if (!wantsLatest) return Response.json({ ok: true });

        if (!isAuthorized(request)) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const limitParam = Number(url.searchParams.get("limit") ?? "5");
        const limit = Number.isFinite(limitParam)
          ? Math.min(Math.max(Math.trunc(limitParam), 1), RECENT_LIMIT)
          : 5;

        const stored = await readLatest(limit);
        return Response.json({
          ok: true,
          source: stored === null ? "memory" : "supabase",
          count: (stored ?? recent).length,
          updates: stored ?? recent.slice(0, limit),
          memoryCount: recent.length,
        });
      },
      POST: async ({ request }) => {
        const trust = isTelegramRequestTrusted(request);
        if (!trust.ok) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        if (!trust.enforced) {
          console.warn("[telegram-webhook] TELEGRAM_WEBHOOK_SECRET is not configured");
        }

        let update: TelegramUpdate;
        try {
          update = (await request.json()) as TelegramUpdate;
        } catch {
          return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
        }

        const record = buildRecord(update);
        remember(record);
        console.log("[telegram-webhook]", record);

        const persistError = await persist(record);
        if (persistError) {
          console.error("[telegram-webhook] persist_failed:", persistError);
        }

        // HUMO bank notifications: parse + store only. Never touches orders/payments.
        try {
          const { isHumoSender, storeBankTransaction } = await import(
            "@/lib/server/bank-transactions.server"
          );
          const message = update.business_message;
          if (record.update_type === "business_message" && message && isHumoSender(message.from)) {
            const bank = await storeBankTransaction({
              updateId: safeNumber(update.update_id),
              messageId: safeNumber(message.message_id),
              messageDate: safeNumber(message.date),
              text: typeof message.text === "string" ? message.text : null,
            });
            console.log("[telegram-webhook] bank:", bank);
          }
        } catch (err) {
          console.error("[telegram-webhook] bank_failed:", err instanceof Error ? err.message : err);
        }

        // Referral signup: `/start ref_<telegramId>` in a private bot chat.
        // Registration only — Star Points are still awarded by complete_order().
        try {
          const message = update.message;
          const from = message?.from;
          if (
            record.update_type === "message" &&
            message?.chat?.type === "private" &&
            from?.id &&
            !from.is_bot &&
            typeof message.text === "string" &&
            message.text.trim().startsWith("/start")
          ) {
            const { parseStartPayload, isReferralCode } = await import(
              "@/lib/server/referrals.server"
            );
            const code = parseStartPayload(message.text);
            if (isReferralCode(code)) {
              const core = await import("@/lib/server/core.server");
              const user = await core.ensureTelegramUser({
                telegram_id: from.id,
                username: from.username ?? null,
                first_name: from.first_name ?? null,
                last_name: from.last_name ?? null,
                photo_url: null,
                language_code: from.language_code ?? null,
              });
              const outcome = await core.attachReferral(user, code);
              console.log("[telegram-webhook] referral:", outcome);
            }
          }
        } catch (err) {
          console.error(
            "[telegram-webhook] referral_failed:",
            err instanceof Error ? err.message : err,
          );
        }

        // Always 200 so Telegram never retries.

        return Response.json({ ok: true });
      },

    },
  },
});
