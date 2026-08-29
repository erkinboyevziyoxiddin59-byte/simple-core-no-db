/**
 * Storage of parsed HUMO bank notifications.
 * This module NEVER touches orders, payments, loyalty, referrals or Stars —
 * it only records what the bank told us, for later (human) review.
 */
import { parseHumoMessage } from "./humo-parser.server";

/** Approved HUMO Card senders (Telegram Business). Text alone is never trusted. */
export const HUMO_SENDER_IDS = new Set<number>([856254449]);
export const HUMO_SENDER_USERNAMES = new Set<string>(["humocardbot"]);

export function isHumoSender(from: { id?: number | null; username?: string | null } | null | undefined): boolean {
  if (!from) return false;
  if (typeof from.id === "number" && HUMO_SENDER_IDS.has(from.id)) return true;
  const username = typeof from.username === "string" ? from.username.toLowerCase() : null;
  return username !== null && HUMO_SENDER_USERNAMES.has(username);
}

export interface BankMessageInput {
  updateId: number | null;
  messageId: number | null;
  messageDate: number | null;
  text: string | null;
}

export type StoreResult =
  | { stored: true; duplicate: false; parseStatus: string; direction: string }
  | { stored: false; duplicate: true; parseStatus: string; direction: string }
  | { stored: false; duplicate: false; error: string };

/** Inserts one bank transaction row. Duplicates (update id / fingerprint) are silent no-ops. */
export async function storeBankTransaction(input: BankMessageInput): Promise<StoreResult> {
  const parsed = parseHumoMessage(input.text);
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("bank_transactions").insert({
      telegram_update_id: input.updateId,
      telegram_message_id: input.messageId,
      telegram_message_date: input.messageDate,
      telegram_message_at:
        typeof input.messageDate === "number" ? new Date(input.messageDate * 1000).toISOString() : null,
      raw_text: input.text ?? "",
      direction: parsed.direction,
      operation_label: parsed.operationLabel,
      amount_uzs: parsed.amountUzs,
      amount_raw: parsed.amountRaw,
      currency: parsed.currency,
      description_raw: parsed.descriptionRaw,
      card_product: parsed.cardProduct,
      card_last4: parsed.cardLast4,
      bank_time_raw: parsed.bankTimeRaw,
      bank_time_at: parsed.bankTimeAt,
      balance_after_uzs: parsed.balanceAfterUzs,
      parse_status: parsed.parseStatus,
      parser_version: parsed.parserVersion,
    });

    if (error) {
      if (error.code === "23505") {
        return { stored: false, duplicate: true, parseStatus: parsed.parseStatus, direction: parsed.direction };
      }
      return { stored: false, duplicate: false, error: error.message };
    }
    return { stored: true, duplicate: false, parseStatus: parsed.parseStatus, direction: parsed.direction };
  } catch (err) {
    return { stored: false, duplicate: false, error: err instanceof Error ? err.message : "store_failed" };
  }
}
