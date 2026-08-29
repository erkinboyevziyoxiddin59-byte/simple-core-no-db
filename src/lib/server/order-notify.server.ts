/**
 * Automatic Telegram channel notifications for finished orders.
 *
 * Server-only. Uses the existing StarjBot token and never exposes it, the
 * chat ids, wallet seeds or any provider credential. A notification failure is
 * logged and swallowed: it must never change order or delivery state.
 */
import { db } from "./core.server";

type Kind = "completed" | "failed";

interface OrderInfo {
  orderNo: number | string;
  username: string;
  product: string;
  amountUzs: number;
}

function formatAmount(n: number): string {
  return Number(n || 0).toLocaleString("en-US");
}

function formatTime(date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tashkent",
  }).format(date);
}

function productLabel(productType: string, quantity: number): string {
  if (productType === "stars") return `${formatAmount(quantity)} Stars`;
  const months = Number(String(productType).replace("premium_", "")) || quantity;
  return `Premium — ${months} months`;
}

/** Short, safe, human reason for the private failure channel. */
function reasonLabel(failureCode: string | null): string {
  switch (failureCode) {
    case "invalid_username":
      return "Invalid recipient username";
    case "already_premium":
      return "Recipient already has Premium";
    case "insufficient_funds":
      return "Insufficient wallet balance";
    case "not_eligible":
      return "Recipient not eligible";
    case "not_configured":
      return "Delivery wallet not configured";
    case "needs_review":
      return "Manual review required";
    default:
      return "Fragment delivery failed";
  }
}

async function loadOrderInfo(orderId: string): Promise<OrderInfo | null> {
  const { data } = await db
    .from("orders")
    .select("order_no, product_type, quantity, amount_uzs, recipient_username, users(username)")
    .eq("id", orderId)
    .maybeSingle();
  if (!data) return null;

  const row = data as unknown as {
    order_no: number;
    product_type: string;
    quantity: number;
    amount_uzs: number;
    recipient_username: string;
    users?: { username: string | null } | null;
  };

  return {
    orderNo: row.order_no,
    username: row.users?.username ?? row.recipient_username,
    product: productLabel(row.product_type, row.quantity),
    amountUzs: row.amount_uzs,
  };
}

async function sendToChannel(chatId: string, text: string): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    console.warn("[order-notify] TELEGRAM_BOT_TOKEN is not configured");
    return;
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(`[order-notify] telegram_error ${response.status}: ${body.slice(0, 300)}`);
  }
}

/**
 * Sends exactly one channel message for a finished order.
 * Callers must guarantee they only call this on the transition into the final
 * delivery state, so an order can never produce a duplicate message.
 */
export async function notifyOrderOutcome(
  orderId: string,
  kind: Kind,
  failureCode: string | null = null,
): Promise<void> {
  try {
    const chatId =
      kind === "completed"
        ? process.env["TELEGRAM_COMPLETED_ORDERS_CHAT_ID"]
        : process.env["TELEGRAM_FAILED_ORDERS_CHAT_ID"];
    if (!chatId) {
      console.warn(`[order-notify] chat id for ${kind} orders is not configured`);
      return;
    }

    const info = await loadOrderInfo(orderId);
    if (!info) return;

    const lines =
      kind === "completed"
        ? [
            "✅ ORDER COMPLETED",
            "",
            `Order: #${info.orderNo}`,
            `User: @${info.username}`,
            `Product: ${info.product}`,
            `Amount: ${formatAmount(info.amountUzs)} UZS`,
            `Time: ${formatTime()}`,
          ]
        : [
            "❌ ORDER FAILED",
            "",
            `Order: #${info.orderNo}`,
            `User: @${info.username}`,
            `Product: ${info.product}`,
            `Amount: ${formatAmount(info.amountUzs)} UZS`,
            `Reason: ${reasonLabel(failureCode)}`,
            `Time: ${formatTime()}`,
          ];

    await sendToChannel(chatId, lines.join("\n"));
  } catch (error) {
    console.error(
      "[order-notify] notify_failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}
