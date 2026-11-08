# Order Management — User Brief (2026-11-08 ~15:50, NEXT work after AI training)

User's words: "পরবর্তী কাজ" = the NEXT task, after the AI-training build finishes. Do NOT run in parallel with the AI-training agent (it touches order/AI code too).

## 1. Auto order number
When a customer places an order, an order number is created automatically.

## 2. Orders page — status tabs with counts (top)
Pending, Hold, Approved, Processing, In Courier (how many), Ready, Ready to Ship, Delivered, Cancelled, In Store (how many). Each tab shows its count.

## 3. Report (from the top)
- Courier view: click to see how many products are going via courier.
- Scan option: scan a product/order (to look it up).
- Customer list (inside Orders): which customers, when they ordered. Amount (how much money) is HIDDEN by default — shown only when clicked.
- Customer detail: how many orders a customer placed, how many cancelled, how many returned, last order date — so the owner can understand the customer.
- Daily report: today — how many orders, delivered, cancelled, returned, damaged.

## 4. Order detail — right-side panel (click an order, esp. the newest)
Manual status options (owner selects): Pending, Approve, Processing, Ready to Ship, In Transit / Courier, Cancelled, Delivered.
"Send to Courier" button: after approving, click it → shows couriers (Sundarban, Steadfast, Pathao) → click one (e.g. Steadfast) → auto-books with that courier via its API → returns a tracking/booking number.
Order details shown: who ordered, order number, address, city (Dhaka or outside Dhaka, which zone), who talked to the customer (an agent or the AI agent).
Three contact buttons:
- WhatsApp: auto-linked to the customer's WhatsApp number; click → message that number. (If no WhatsApp, fine.)
- Open Chat: click → opens the Facebook chat where we talked to the customer.
- Call: click → call directly.
Short brief: which product was ordered, how much money, delivery charge, etc.

## 5. Auto receipt / memo (on order confirmation)
When the customer says "অর্ডার কনফার্ম করো" (confirm the order), an automatic receipt/memo is created and sent to the customer as an IMAGE (screenshot-style) showing: order number, order confirmed, delivery address, items, payment type (Cash on Delivery / Advance / 50-50), when delivery will be.
PLUS an order LINK is created and shared with the customer — the customer clicks it to view the order invoice.

## Notes / assumptions
- "স্টোরে কতগুলা" = orders kept at the store (In Store status).
- "স্ক্যান" = scan a product/order code to look it up.
- Courier booking: Steadfast is already implemented (needs the user's Api-Key + Secret-Key to go live). Pathao is a stub ("not connected yet"). Sundarban is NOT in the system yet — show it honestly as not connected until its API is wired. Never fake a booking/tracking number.
- Order confirmation message to the customer is a Messenger message (not email).
