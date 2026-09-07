// Operator tool: grant prepaid credit to a workspace (beta credits) or record
// a refund you made in the Stripe dashboard (negative amount).
//   npx tsx scripts/credit.ts <workspaceId> <amountMinor> <currency> "<note>"
import { creditTopup } from "../lib/balance";
import { pool } from "../lib/db";

const [ws, amountRaw, currency = "USD", ...noteParts] = process.argv.slice(2);
const amount = parseInt(amountRaw ?? "", 10);
if (!ws || !Number.isInteger(amount) || amount === 0) {
  console.error('usage: npx tsx scripts/credit.ts <workspaceId> <amountMinor> <currency> "<note>"');
  process.exit(1);
}
const note = noteParts.join(" ") || (amount > 0 ? "operator credit" : "operator refund");
const r = await creditTopup(ws, currency, amount, "credit", `credit:${ws}:${Date.now()}:${note}`.slice(0, 200), "operator");
console.log(r.credited ? `recorded ${amount} ${currency.toUpperCase()} for ${ws}: ${note}` : "already recorded");
await pool.end();
