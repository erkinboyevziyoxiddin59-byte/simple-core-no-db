import { createServerFn } from "@tanstack/react-start";

export const verifyFragmentWallet = createServerFn({ method: "POST" }).handler(async () => {
  const core = await import("./server/core.server");
  await core.requireAdmin();
  const fragment = await import("./server/fragment.server");
  const result = await fragment.verifyWalletConfiguration();
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  return {
    ok: true,
    configuredAddress: result.data?.walletAddress ?? null,
    accountIndex: result.data?.accountIndex ?? null,
  };
});