// Server-only referral signup logic.
// Shared by the Mini App session bootstrap (auth.functions -> core.attachReferral)
// and the Telegram bot webhook (/start ref_xxx). Never rewards points — the
// reward stays in the existing complete_order() database function.

export interface ReferralUser {
  id: string;
  referral_code: string;
  referred_by: string | null;
}

export type ReferralOutcome =
  | "created"
  | "no_code"
  | "invalid_code"
  | "unknown_referrer"
  | "self_referral"
  | "already_referred"
  | "insert_failed";

/**
 * Extracts the referral code from a bot `/start` message text.
 * Accepts "/start ref_123", "/start@Starjbot ref_123" and plain "ref_123".
 */
export function parseStartPayload(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/start")) return trimmed.startsWith("ref_") ? trimmed : null;
  const parts = trimmed.split(/\s+/);
  return parts[1]?.trim() || null;
}

/** True when the string looks like our referral code format (`ref_<digits>`). */
export function isReferralCode(code: string | null | undefined): boolean {
  return typeof code === "string" && /^ref_\d+$/.test(code.trim());
}

/**
 * Records the referral relationship for a freshly registered user.
 * Idempotent: an existing referrer is never replaced and duplicates are ignored.
 */
export async function recordReferralSignup(
  db: {
    from: (table: string) => any;
  },
  user: ReferralUser,
  startParam: string | null | undefined,
): Promise<ReferralOutcome> {
  if (!startParam) return "no_code";
  const code = startParam.trim();
  if (!isReferralCode(code)) return "invalid_code";
  // A user keeps their original referrer forever.
  if (user.referred_by) return "already_referred";
  if (code === user.referral_code) return "self_referral";

  const { data: referrer } = await db
    .from("users")
    .select("id")
    .eq("referral_code", code)
    .maybeSingle();
  if (!referrer) return "unknown_referrer";
  if (referrer.id === user.id) return "self_referral";

  const { data: existing } = await db
    .from("referrals")
    .select("id")
    .eq("referred_id", user.id)
    .maybeSingle();
  if (existing) return "already_referred";

  const { error } = await db
    .from("referrals")
    .insert({ referrer_id: referrer.id, referred_id: user.id });
  // unique / check constraint => already referred or self-referral
  if (error) return "insert_failed";

  await db.from("users").update({ referred_by: referrer.id }).eq("id", user.id);
  return "created";
}
