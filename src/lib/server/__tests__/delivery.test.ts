import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";

/* All Fragment traffic is mocked — no real purchase can ever happen in tests. */
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
// Base64 of a complete 12-word mnemonic, matching the current API contract.
const TEST_SEED = Buffer.from("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about").toString("base64");
process.env["FRAGMENT_WALLET_SEED"] = TEST_SEED;

let db = createFakeDb({});
vi.mock("../core.server", () => ({
  get db() {
    return dbRef.current;
  },
}));
const dbRef = { current: db as any };

async function loadDelivery() {
  return import("../delivery.server");
}

/** Fragment wraps every successful payload in { success: true, data: {...} }. */
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fragment reports failures as { success: false, error: {...} }, often with HTTP 200. */
function errorResponse(message: string, status = 200) {
  return new Response(
    JSON.stringify({ success: false, error: { code: status, message, error_code: "ERROR" } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function seed(overrides: Record<string, unknown> = {}, paid = true) {
  db = createFakeDb({
    orders: [
      {
        id: "o1",
        user_id: "u1",
        status: "completed",
        product_type: "stars",
        quantity: 100,
        recipient_username: "buyer", // orders store the username without "@"

        ...overrides,
      },
    ],
    payments: paid ? [{ id: "p1", order_id: "o1", status: "verified" }] : [],
    deliveries: [],
  });
  dbRef.current = db as any;
}

beforeEach(() => {
  fetchMock.mockReset();
  delete process.env["FRAGMENT_WALLET_ADDRESS"];
  seed();
});

describe("delivery", () => {
  it("never calls Fragment for an order that is not completed", async () => {
    seed({ status: "awaiting_payment" });
    const { runDelivery } = await loadDelivery();
    const result = await runDelivery("o1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe("none");
  });

  it("never calls Fragment without a verified payment", async () => {
    seed({}, false);
    const { runDelivery } = await loadDelivery();
    await runDelivery("o1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the order username to Fragment with a leading @ and the amount from the order", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ request_id: "req-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "processing" }));
    const { runDelivery } = await loadDelivery();
    const result = await runDelivery("o1");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // The order row stores "buyer"; the Fragment API requires "@buyer".
    expect(body.username).toBe("@buyer");
    expect(body.amount).toBe(100);
    expect(result.status).toBe("processing");
    expect(db.tables["deliveries"][0]["provider_request_id"]).toBe("req-1");
  });

  it("keeps an already-prefixed @username unchanged", async () => {
    seed({ recipient_username: "@buyer" });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ request_id: "req-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "processing" }));
    const { runDelivery } = await loadDelivery();
    await runDelivery("o1");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).username).toBe("@buyer");
  });

  it("marks delivery successful when the queue reports success", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ request_id: "req-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }));
    const { runDelivery } = await loadDelivery();
    expect((await runDelivery("o1")).status).toBe("success");
  });

  it("marks delivery failed when the queue reports failure", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ request_id: "req-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "failed", error: "username not found" }));
    const { runDelivery } = await loadDelivery();
    const result = await runDelivery("o1");
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("invalid_username");
  });

  it("never purchases twice on repeated runs", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ request_id: "req-1" }))
      .mockResolvedValue(jsonResponse({ status: "processing" }));
    const { runDelivery } = await loadDelivery();
    await runDelivery("o1");
    await runDelivery("o1");
    await runDelivery("o1");
    const buys = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/stars/buy"));
    expect(buys).toHaveLength(1);
    expect(db.tables["deliveries"]).toHaveLength(1);
  });

  it("does not purchase again after an uncertain (timeout) outcome", async () => {
    fetchMock.mockRejectedValueOnce(new Error("The operation timed out"));
    const { runDelivery } = await loadDelivery();
    expect((await runDelivery("o1")).status).toBe("processing");
    const second = await runDelivery("o1");
    expect(second.status).toBe("failed");
    expect(second.reason).toBe("needs_review");
    const buys = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/stars/buy"));
    expect(buys).toHaveLength(1);
  });

  it("reports insufficient wallet balance safely", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse("Insufficient balance", 400));
    const { runDelivery } = await loadDelivery();
    expect((await runDelivery("o1")).reason).toBe("insufficient_funds");
  });

  it("buys Premium after a positive eligibility check", async () => {
    seed({ product_type: "premium_6", quantity: 6 });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ eligible: true }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const { runDelivery } = await loadDelivery();
    expect((await runDelivery("o1")).status).toBe("success");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).duration).toBe(6);
  });

  it("does not buy Premium when the user already has it", async () => {
    seed({ product_type: "premium_3", quantity: 3 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ eligible: false, has_premium: true }));
    const { runDelivery } = await loadDelivery();
    const result = await runDelivery("o1");
    expect(result.reason).toBe("already_premium");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/premium/buy"))).toHaveLength(0);
  });

  it("fails safely and without a network call when the seed is missing", async () => {
    const saved = process.env["FRAGMENT_WALLET_SEED"];
    delete process.env["FRAGMENT_WALLET_SEED"];
    const { runDelivery } = await loadDelivery();
    const result = await runDelivery("o1");
    process.env["FRAGMENT_WALLET_SEED"] = saved;
    expect(result.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before any network call when the seed is not Base64", async () => {
    const saved = process.env["FRAGMENT_WALLET_SEED"];
    process.env["FRAGMENT_WALLET_SEED"] = "not!!base64!!";
    const { runDelivery } = await loadDelivery();
    const result = await runDelivery("o1");
    process.env["FRAGMENT_WALLET_SEED"] = saved;
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
    // The invalid seed value itself must never be stored.
    expect(JSON.stringify(db.tables["deliveries"])).not.toContain("not!!base64!!");
  });

  it("rejects Base64 that does not decode to a complete mnemonic", async () => {
    const saved = process.env["FRAGMENT_WALLET_SEED"];
    process.env["FRAGMENT_WALLET_SEED"] = Buffer.from("test-seed-value").toString("base64");
    const { runDelivery } = await loadDelivery();
    const result = await runDelivery("o1");
    process.env["FRAGMENT_WALLET_SEED"] = saved;
    expect(result.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a configured wallet and sends its verified account selection", async () => {
    process.env["FRAGMENT_WALLET_ADDRESS"] = "UQ_TEST_WALLET";
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ wallet_address: "UQ_TEST_WALLET", account_index: 3 }))
      .mockResolvedValueOnce(jsonResponse({ request_id: "req-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }));
    const { runDelivery } = await loadDelivery();
    expect((await runDelivery("o1")).status).toBe("success");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/wallet/resolve");
    const buyBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(buyBody.wallet_address).toBe("UQ_TEST_WALLET");
    expect(buyBody.account_index).toBe(3);
  });

  it("does not purchase when wallet resolution rejects the seed/address pairing", async () => {
    process.env["FRAGMENT_WALLET_ADDRESS"] = "UQ_OTHER_WALLET";
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        success: false,
        error: { error_code: "WALLET_ADDRESS_MISMATCH", message: "Wallet address mismatch" },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const { runDelivery } = await loadDelivery();
    const result = await runDelivery("o1");
    expect(result.reason).toBe("not_configured");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/stars/buy"))).toHaveLength(0);
    expect(db.tables["deliveries"][0]["last_error"]).toBe("Wallet address mismatch");
  });

  it("never leaks the wallet seed in the stored delivery record", async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(`bad seed "seed":"${TEST_SEED}"`, 400),
    );
    const { runDelivery } = await loadDelivery();
    await runDelivery("o1");
    const dump = JSON.stringify(db.tables["deliveries"]);
    expect(dump).not.toContain(TEST_SEED);
  });

  it("treats an HTTP 200 { success: false } purchase response as a definite failure", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse("Please enter a username assigned to a user."));
    const { runDelivery } = await loadDelivery();
    const result = await runDelivery("o1");
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("invalid_username");
    const buys = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/stars/buy"));
    expect(buys).toHaveLength(1);
  });

  it("serializes nested provider errors instead of storing [object Object]", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: { code: 400, message: { reason: "bad request" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { runDelivery } = await loadDelivery();
    await runDelivery("o1");
    expect(db.tables["deliveries"][0]["last_error"]).toBe('{"reason":"bad request"}');
    expect(db.tables["deliveries"][0]["last_error"]).not.toBe("[object Object]");
  });

  it("reads the queue state from the response envelope", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ request_id: "req-1", position: 1 }))
      .mockResolvedValueOnce(jsonResponse({ request_id: "req-1", status: "queued" }));
    const { runDelivery } = await loadDelivery();
    expect((await runDelivery("o1")).status).toBe("processing");

    fetchMock.mockResolvedValueOnce(jsonResponse({ request_id: "req-1", status: "completed" }));
    expect((await runDelivery("o1")).status).toBe("success");
  });

  it("treats a queue timeout as a failure without re-purchasing", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ request_id: "req-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "timeout", error: { message: "timed out" } }));
    const { runDelivery } = await loadDelivery();
    expect((await runDelivery("o1")).status).toBe("failed");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/stars/buy"))).toHaveLength(1);
  });

  it("keeps a 5xx result uncertain instead of buying again", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse("upstream down", 503));
    const { runDelivery } = await loadDelivery();
    expect((await runDelivery("o1")).status).toBe("processing");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/stars/buy"))).toHaveLength(1);
  });

  it("polls the queue for a queued Premium purchase", async () => {
    seed({ product_type: "premium_3", quantity: 3 });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ eligible: true }))
      .mockResolvedValueOnce(jsonResponse({ request_id: "req-p" }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }));
    const { runDelivery } = await loadDelivery();
    expect((await runDelivery("o1")).status).toBe("success");
    expect(db.tables["deliveries"][0]["provider_request_id"]).toBe("req-p");
  });
});
