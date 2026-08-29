/**
 * Pure parser for HUMO Card (Telegram Business) notification messages.
 * No side effects, no database access — deliberately fail-closed.
 *
 * Observed format (6 lines):
 *   🎉 To'ldirish
 *   ➕ 2.500,00 UZS
 *   📍 TEZ P2P KIRIM>Toshke
 *   💳 HUMOCARD *9614
 *   🕓 14:08 25.08.2026
 *   💰 13.952,00 UZS
 */

export const PARSER_VERSION = 1;

export type HumoDirection = "in" | "out" | "unknown";
export type HumoParseStatus = "parsed" | "partial" | "unparsed";

export interface HumoParsed {
  direction: HumoDirection;
  operationLabel: string | null;
  amountUzs: number | null;
  amountRaw: string | null;
  currency: string | null;
  descriptionRaw: string | null;
  cardProduct: string | null;
  cardLast4: string | null;
  bankTimeRaw: string | null;
  bankTimeAt: string | null;
  balanceAfterUzs: number | null;
  parseStatus: HumoParseStatus;
  parserVersion: number;
}

const IN_LABELS = ["to'ldirish", "to‘ldirish", "toldirish", "пополнение", "top-up", "topup"];
const OUT_LABELS = ["to'lov", "to‘lov", "tolov", "платёж", "платеж", "payment"];

/** Removes leading emoji / symbols / spaces from a line. */
function stripLeadingSymbols(line: string): string {
  return line.replace(/^[^\p{L}\p{N}*+\-]+/u, "").trim();
}

/** `2.500,00` / `2 500,00` / `2500` → 2500 (integer UZS, decimals dropped). */
function parseUzsAmount(raw: string): number | null {
  const cleaned = raw.replace(/[\s\u00a0]/g, "");
  const match = cleaned.match(/^(\d{1,3}(?:[.,]\d{3})*|\d+)(?:[.,](\d{1,2}))?$/);
  if (!match) return null;
  const integerPart = (match[1] ?? "").replace(/[.,]/g, "");
  if (!integerPart) return null;
  const value = Number(integerPart);
  return Number.isFinite(value) ? value : null;
}

/** `HH:MM DD.MM.YYYY` in Asia/Tashkent (fixed UTC+5) → ISO UTC string. */
function parseBankTime(raw: string): string | null {
  const m = raw.match(/^(\d{2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, hh, mm, dd, mo, yyyy] = m;
  const utcMs = Date.UTC(Number(yyyy), Number(mo) - 1, Number(dd), Number(hh), Number(mm));
  if (!Number.isFinite(utcMs)) return null;
  // Asia/Tashkent has no DST: local time = UTC + 5h.
  const date = new Date(utcMs - 5 * 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function directionFrom(label: string | null, signLine: string | null): HumoDirection {
  const lower = (label ?? "").toLowerCase();
  const labelIn = IN_LABELS.some((l) => lower.includes(l));
  const labelOut = OUT_LABELS.some((l) => lower.includes(l));
  const signIn = signLine ? /[➕+]/.test(signLine) : false;
  const signOut = signLine ? /[➖\-−]/.test(signLine) : false;

  // Both signals must agree; anything else is not trusted.
  if (signIn && !signOut && labelIn && !labelOut) return "in";
  if (signOut && !signIn && labelOut && !labelIn) return "out";
  return "unknown";
}

export function parseHumoMessage(text: string | null | undefined): HumoParsed {
  const empty: HumoParsed = {
    direction: "unknown",
    operationLabel: null,
    amountUzs: null,
    amountRaw: null,
    currency: null,
    descriptionRaw: null,
    cardProduct: null,
    cardLast4: null,
    bankTimeRaw: null,
    bankTimeAt: null,
    balanceAfterUzs: null,
    parseStatus: "unparsed",
    parserVersion: PARSER_VERSION,
  };
  if (typeof text !== "string" || !text.trim()) return empty;

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return empty;

  const operationLabel = stripLeadingSymbols(lines[0] ?? "") || null;

  // Amount line: first line carrying a sign glyph plus a number + currency.
  const amountLine = lines.find((l) => /[➕➖+\-−]/.test(l) && /\d/.test(l)) ?? null;
  let amountRaw: string | null = null;
  let amountUzs: number | null = null;
  let currency: string | null = null;
  if (amountLine) {
    const m = stripLeadingSymbols(amountLine).match(/^[➕➖+\-−]?\s*([\d.,\s\u00a0]+?)\s*([A-Za-z]{3})?$/);
    if (m) {
      amountRaw = (m[1] ?? "").trim();
      amountUzs = parseUzsAmount(amountRaw);
      currency = (m[2] ?? "UZS").toUpperCase();
    }
  }

  const direction = directionFrom(operationLabel, amountLine);

  const cardLine = lines.find((l) => /\*\s*\d{4}\b/.test(l)) ?? null;
  let cardProduct: string | null = null;
  let cardLast4: string | null = null;
  if (cardLine) {
    const m = stripLeadingSymbols(cardLine).match(/^([A-Za-z][A-Za-z0-9 ]*?)?\s*\*\s*(\d{4})\b/);
    if (m) {
      cardProduct = (m[1] ?? "").trim().toUpperCase() || null;
      cardLast4 = m[2] ?? null;
    }
  }

  const timeLine = lines.find((l) => /\d{2}:\d{2}\s+\d{2}\.\d{2}\.\d{4}/.test(l)) ?? null;
  const bankTimeRaw = timeLine
    ? (timeLine.match(/(\d{2}:\d{2}\s+\d{2}\.\d{2}\.\d{4})/)?.[1] ?? null)
    : null;
  const bankTimeAt = bankTimeRaw ? parseBankTime(bankTimeRaw) : null;

  // Balance-after: a numeric line after the time line that carries no sign glyph.
  let balanceAfterUzs: number | null = null;
  if (timeLine) {
    const idx = lines.indexOf(timeLine);
    const balanceLine = lines.slice(idx + 1).find((l) => /\d/.test(l) && !/[➕➖]/.test(l));
    if (balanceLine) {
      const m = stripLeadingSymbols(balanceLine).match(/^([\d.,\s\u00a0]+?)\s*([A-Za-z]{3})?$/);
      if (m) balanceAfterUzs = parseUzsAmount((m[1] ?? "").trim());
    }
  }

  const descriptionRaw = (() => {
    const candidates = lines.filter(
      (l) => l !== lines[0] && l !== amountLine && l !== cardLine && l !== timeLine && !/^\p{Nd}/u.test(stripLeadingSymbols(l)),
    );
    const desc = candidates[0] ? stripLeadingSymbols(candidates[0]) : "";
    return desc || null;
  })();

  const hasCore = amountUzs !== null && cardLast4 !== null && direction !== "unknown";
  const hasSome = amountUzs !== null || cardLast4 !== null || bankTimeRaw !== null;
  const parseStatus: HumoParseStatus = hasCore ? "parsed" : hasSome ? "partial" : "unparsed";

  return {
    direction,
    operationLabel,
    amountUzs,
    amountRaw,
    currency: amountUzs === null ? null : currency,
    descriptionRaw,
    cardProduct,
    cardLast4,
    bankTimeRaw,
    bankTimeAt,
    balanceAfterUzs,
    parseStatus,
    parserVersion: PARSER_VERSION,
  };
}
