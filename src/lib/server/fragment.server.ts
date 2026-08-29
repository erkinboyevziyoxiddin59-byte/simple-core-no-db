/**
 * Thin server-only client for the Fragment REST API (fragment-stars-api).
 *
 * Security rules enforced here:
 *  - the wallet seed is read from process.env at call time and NEVER logged,
 *    returned, embedded in an error message or exposed to the client
 *  - every call has an explicit timeout; a timeout is reported as "unknown",
 *    never as a failure that would allow a blind retry purchase
 */

export const FRAGMENT_BASE_URL = "https://api.fragment-api.space";

const REQUEST_TIMEOUT_MS = 20_000;

export type FragmentOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "error"; code: string; message: string }
  /** The result of the call is genuinely unknown (timeout / network / 5xx). */
  | { ok: false; kind: "unknown"; code: string; message: string };

export class MissingSeedError extends Error {
  constructor() {
    super("delivery_not_configured");
    this.name = "MissingSeedError";
  }
}

/** Thrown when the seed is present but obviously not Base64 — checked before any network call. */
export class InvalidSeedError extends Error {
  constructor() {
    super("delivery_seed_invalid");
    this.name = "InvalidSeedError";
  }
}

/** The current Fragment API expects Base64 of a complete 12- or 24-word mnemonic. */
function isBase64Mnemonic(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    const canonical = decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "");
    const phrase = decoded.toString("utf8").trim().replace(/\s+/g, " ");
    const words = phrase.split(" ");
    return canonical && !phrase.includes("�") && [12, 24].includes(words.length) && words.every((word) => /^[a-z]+$/i.test(word));
  } catch {
    return false;
  }
}

/** Reads the server-only wallet seed. Never returned to any caller but this module. */
function walletSeed(): string {
  const seed = process.env["FRAGMENT_WALLET_SEED"];
  if (!seed || !seed.trim()) throw new MissingSeedError();
  if (!isBase64Mnemonic(seed.trim())) throw new InvalidSeedError();
  return seed.trim();
}

/** The current Fragment REST API requires the username to start with "@". */
export function normalizeUsername(username: string): string {
  const bare = String(username ?? "").trim().replace(/^@+/, "");
  return bare ? `@${bare}` : "";
}

/** Strips anything that could echo the seed back into logs or storage. */
function sanitize(text: string): string {
  const seed = process.env["FRAGMENT_WALLET_SEED"];
  let out = String(text ?? "").slice(0, 500);
  if (seed && seed.trim()) out = out.split(seed).join("[redacted]");
  return out.replace(/"?seed"?\s*[:=]\s*"?[^",}\s]+/gi, "seed:[redacted]");
}

async function request<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: Record<string, unknown> },
): Promise<FragmentOutcome<T>> {
  let response: Response;
  try {
    response = await fetch(`${FRAGMENT_BASE_URL}${path}`, {
      method: init.method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Timeout / network failure: the purchase may or may not have been created.
    return {
      ok: false,
      kind: "unknown",
      code: "network_error",
      message: sanitize(error instanceof Error ? error.message : "network error"),
    };
  }

  const raw = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  const envelope = (parsed ?? {}) as {
    success?: boolean;
    data?: unknown;
    detail?: string;
    error?: unknown;
    message?: string;
  };
  // 5xx / 429 leave the result uncertain; anything else is a definite answer.
  const uncertain = response.status >= 500 || response.status === 429;

  // The Fragment API answers with { success, data } / { success, error } and can
  // report a failure with HTTP 200, so `success: false` must be handled here.
  if (!response.ok || envelope.success === false) {
    const errorObject = (typeof envelope.error === "object" && envelope.error !== null
      ? (envelope.error as { message?: string; error_code?: string; code?: string | number })
      : null);
    const detail =
      errorObject?.message ??
      (typeof envelope.error === "string" ? envelope.error : undefined) ??
      envelope.detail ??
      envelope.message ??
      raw;
    const safeDetail = typeof detail === "string" ? detail : JSON.stringify(detail);
    const message = sanitize(safeDetail || `HTTP ${response.status}`);
    const code = String(errorObject?.error_code ?? errorObject?.code ?? `http_${response.status}`);
    return { ok: false, kind: uncertain ? "unknown" : "error", code, message };
  }

  // Successful payloads carry the useful fields inside `data`.
  const body = envelope.data !== undefined && envelope.data !== null ? envelope.data : parsed;
  return { ok: true, data: (body ?? {}) as T };
}

// accountIndex is null for single-account wallets (e.g. v5r1), where Fragment
// uses the default account and expects no explicit index.
type WalletSelection = { walletAddress: string; accountIndex: number | null };

interface WalletResolveResponse {
  wallet_address?: string;
  account_index?: number | null;
}

/**
 * TON addresses have several equivalent user-friendly encodings (EQ… bounceable,
 * UQ… non-bounceable, base64 vs base64url). Compare the underlying account hash
 * so a different-but-equivalent form is not treated as a mismatch.
 */
function tonAccountKey(address: string): string | null {
  const value = String(address ?? "").trim();
  if (!value) return null;
  try {
    const bytes = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (bytes.length !== 36) return null;
    // byte 0 = flags, byte 1 = workchain, bytes 2..33 = account id
    return `${bytes[1]}:${bytes.subarray(2, 34).toString("hex")}`;
  } catch {
    return null;
  }
}

function sameTonAddress(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  const ka = tonAccountKey(a);
  const kb = tonAccountKey(b);
  return ka !== null && ka === kb;
}

/** Resolves an optional public wallet address to its account index before purchase. */
async function resolveWallet(seed: string): Promise<FragmentOutcome<WalletSelection | null>> {
  const configuredAddress = process.env["FRAGMENT_WALLET_ADDRESS"]?.trim();
  if (!configuredAddress) return { ok: true, data: null };

  const result = await request<WalletResolveResponse>("/api/v1/wallet/resolve", {
    method: "POST",
    body: { seed, wallet_address: configuredAddress },
  });
  if (!result.ok) return result;
  const resolvedAddress = result.data.wallet_address?.trim();
  const resolvedIndex = result.data.account_index;
  if (
    (resolvedAddress && !sameTonAddress(resolvedAddress, configuredAddress)) ||
    (resolvedIndex !== null &&
      resolvedIndex !== undefined &&
      (!Number.isInteger(resolvedIndex) || Number(resolvedIndex) < 0))
  ) {
    return {
      ok: false,
      kind: "error",
      code: "INVALID_WALLET_RESOLUTION",
      message: "Wallet account could not be verified.",
    };
  }

  const selection: WalletSelection = {
    // Always send back the form Fragment itself resolved when it provides one.
    walletAddress: resolvedAddress || configuredAddress,
    accountIndex:
      resolvedIndex === null || resolvedIndex === undefined ? null : Number(resolvedIndex),
  };
  return { ok: true, data: selection };
}


/** Non-purchasing configuration check. Returns no seed or mnemonic material. */
export async function verifyWalletConfiguration(): Promise<FragmentOutcome<WalletSelection | null>> {
  const seed = walletSeed();
  return resolveWallet(seed);
}


/* ---------------- Stars ---------------- */

export interface StarsBuyResponse {
  request_id?: string;
  requestId?: string;
  id?: string;
  status?: string;
}

export interface QueueStatusResponse {
  status?: string;
  state?: string;
  error?: string | { message?: string };
  message?: string;
  result?: { message?: string } | null;
}


export async function buyStars(params: {
  username: string;
  amount: number;
}): Promise<FragmentOutcome<{ requestId: string | null; status: string | null }>> {
  const seed = walletSeed();
  const selection = await resolveWallet(seed);
  if (!selection.ok) return selection;
  const result = await request<StarsBuyResponse>("/api/v1/stars/buy", {
    method: "POST",
    body: {
      username: normalizeUsername(params.username),
      amount: params.amount,
      seed,
      ...(selection.data
        ? {
            wallet_address: selection.data.walletAddress,
            ...(selection.data.accountIndex !== null
              ? { account_index: selection.data.accountIndex }
              : {}),
          }
        : {}),
    },
  });
  if (!result.ok) return result;
  const data = result.data;
  return {
    ok: true,
    data: {
      requestId: data.request_id ?? data.requestId ?? data.id ?? null,
      status: data.status ?? null,
    },
  };
}

export type QueueState = "processing" | "success" | "failed";

export async function getQueueStatus(
  requestId: string,
): Promise<FragmentOutcome<{ state: QueueState; message: string | null }>> {
  const result = await request<QueueStatusResponse>(
    `/api/v1/queue/${encodeURIComponent(requestId)}`,
    { method: "GET" },
  );
  if (!result.ok) return result;
  const raw = String(result.data.status ?? result.data.state ?? "").toLowerCase();
  const errorText =
    typeof result.data.error === "string" ? result.data.error : result.data.error?.message;
  const message = sanitize(errorText ?? result.data.message ?? "") || null;

  // Fragment queue states: queued | processing | completed | failed | timeout
  let state: QueueState = "processing";
  if (["success", "completed", "complete", "done", "sent", "succeeded"].includes(raw)) state = "success";
  else if (["failed", "error", "cancelled", "canceled", "rejected", "timeout", "expired"].includes(raw))
    state = "failed";

  return { ok: true, data: { state, message } };
}


/* ---------------- Premium ---------------- */

export interface EligibilityResponse {
  eligible?: boolean;
  is_eligible?: boolean;
  has_premium?: boolean;
  premium?: boolean;
  reason?: string;
  message?: string;
}

export async function checkPremiumEligibility(params: {
  username: string;
}): Promise<FragmentOutcome<{ eligible: boolean; alreadyPremium: boolean; reason: string | null }>> {
  const result = await request<EligibilityResponse>("/api/v1/premium/check-eligibility", {
    method: "POST",
    body: { username: normalizeUsername(params.username) },
  });
  if (!result.ok) return result;
  const data = result.data;
  const alreadyPremium = Boolean(data.has_premium ?? data.premium ?? false);
  const eligible = Boolean(data.eligible ?? data.is_eligible ?? false) && !alreadyPremium;
  return {
    ok: true,
    data: { eligible, alreadyPremium, reason: sanitize(data.reason ?? data.message ?? "") || null },
  };
}

export interface PremiumBuyResponse {
  request_id?: string;
  requestId?: string;
  id?: string;
  success?: boolean;
  status?: string;
  error?: string;
  message?: string;
}

export async function buyPremium(params: {
  username: string;
  months: number;
}): Promise<FragmentOutcome<{ success: boolean; requestId: string | null; message: string | null }>> {
  const seed = walletSeed();
  const selection = await resolveWallet(seed);
  if (!selection.ok) return selection;
  const result = await request<PremiumBuyResponse>("/api/v1/premium/buy", {
    method: "POST",
    body: {
      username: normalizeUsername(params.username),
      duration: params.months,
      seed,
      ...(selection.data
        ? {
            wallet_address: selection.data.walletAddress,
            ...(selection.data.accountIndex !== null
              ? { account_index: selection.data.accountIndex }
              : {}),
          }
        : {}),
    },
  });
  if (!result.ok) return result;
  const data = result.data;
  const status = String(data.status ?? "").toLowerCase();
  const requestId = data.request_id ?? data.requestId ?? data.id ?? null;
  // A queued purchase counts as accepted; its final state comes from the queue.
  const success =
    data.success === true ||
    Boolean(requestId) ||
    ["success", "completed", "complete", "done"].includes(status);
  return {
    ok: true,
    data: { success, requestId, message: sanitize(data.error ?? data.message ?? "") || null },
  };
}

