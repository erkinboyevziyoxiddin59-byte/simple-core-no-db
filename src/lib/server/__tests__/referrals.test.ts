import { describe, expect, it } from "vitest";
import { createFakeDb } from "./fake-db";
import {
  isReferralCode,
  parseStartPayload,
  recordReferralSignup,
  type ReferralUser,
} from "../referrals.server";

const REFERRER = {
  id: "u_referrer",
  telegram_id: 1208388326,
  referral_code: "ref_1208388326",
  referred_by: null,
};
const NEW_USER: ReferralUser = { id: "u_new", referral_code: "ref_555", referred_by: null };

function db(extraReferrals: Record<string, unknown>[] = []) {
  return createFakeDb({
    users: [REFERRER, { ...NEW_USER, telegram_id: 555 }],
    referrals: extraReferrals,
    points_ledger: [],
  });
}

describe("parseStartPayload", () => {
  it("extracts the code from a bot deep link message", () => {
    expect(parseStartPayload("/start ref_1208388326")).toBe("ref_1208388326");
    expect(parseStartPayload("/start@Starjbot ref_1208388326")).toBe("ref_1208388326");
    expect(parseStartPayload("/start")).toBeNull();
    expect(parseStartPayload("hello")).toBeNull();
  });

  it("validates the existing ref_<telegramId> format", () => {
    expect(isReferralCode("ref_1208388326")).toBe(true);
    expect(isReferralCode("ref_abc")).toBe(false);
    expect(isReferralCode("promo_1")).toBe(false);
  });
});

describe("recordReferralSignup", () => {
  it("A. creates the referral row for a valid link + new signup", async () => {
    const fake = db();
    expect(await recordReferralSignup(fake, NEW_USER, "ref_1208388326")).toBe("created");
    expect(fake.tables["referrals"]).toHaveLength(1);
    expect(fake.tables["referrals"]![0]).toMatchObject({
      referrer_id: "u_referrer",
      referred_id: "u_new",
    });
  });

  it("B. the referrer's count reflects the new row", async () => {
    const fake = db();
    await recordReferralSignup(fake, NEW_USER, "ref_1208388326");
    const mine = fake.tables["referrals"]!.filter((r) => r["referrer_id"] === "u_referrer");
    expect(mine).toHaveLength(1);
  });

  it("C. opening the link without registering creates nothing", async () => {
    const fake = db();
    expect(await recordReferralSignup(fake, NEW_USER, null)).toBe("no_code");
    expect(fake.tables["referrals"]).toHaveLength(0);
  });

  it("D. an invalid or unknown code creates nothing", async () => {
    const fake = db();
    expect(await recordReferralSignup(fake, NEW_USER, "not_a_code")).toBe("invalid_code");
    expect(await recordReferralSignup(fake, NEW_USER, "ref_999999")).toBe("unknown_referrer");
    expect(fake.tables["referrals"]).toHaveLength(0);
  });

  it("E. rejects self-referral", async () => {
    const fake = db();
    const self: ReferralUser = { id: "u_referrer", referral_code: "ref_1208388326", referred_by: null };
    expect(await recordReferralSignup(fake, self, "ref_1208388326")).toBe("self_referral");
    expect(fake.tables["referrals"]).toHaveLength(0);
  });

  it("F. never replaces an original referrer", async () => {
    const fake = db([{ id: "r1", referrer_id: "u_other", referred_id: "u_new" }]);
    const referred: ReferralUser = { ...NEW_USER, referred_by: "u_other" };
    expect(await recordReferralSignup(fake, referred, "ref_1208388326")).toBe("already_referred");
    expect(fake.tables["referrals"]).toHaveLength(1);
    expect(fake.tables["referrals"]![0]!["referrer_id"]).toBe("u_other");
  });

  it("F2. ignores a duplicate signup for the same referred user", async () => {
    const fake = db();
    await recordReferralSignup(fake, NEW_USER, "ref_1208388326");
    expect(await recordReferralSignup(fake, NEW_USER, "ref_1208388326")).toBe("already_referred");
    expect(fake.tables["referrals"]).toHaveLength(1);
  });

  it("G. registration alone grants no Star Points", async () => {
    const fake = db();
    await recordReferralSignup(fake, NEW_USER, "ref_1208388326");
    expect(fake.tables["points_ledger"]).toHaveLength(0);
    expect(fake.tables["referrals"]![0]!["status"]).toBeUndefined(); // defaults to 'pending' in Postgres
  });
});
