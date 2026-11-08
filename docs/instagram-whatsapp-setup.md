# Instagram posting + WhatsApp sending — setup

Built 2026-11-08. Verified offline with `node scripts/verify-instagram-whatsapp.mjs`
(stub Meta Graph server; AI replies live via Gemini). Real end-to-end is
blocked until the owner does the browser/phone steps below — no Instagram
account is linked to the Halal Chic Page yet and no WhatsApp Business
number is confirmed.

## What works in code

- **Instagram posting** (Schedule page): image posts (1 image, or a
  carousel for several), video posts (reels). Real Instagram Graph API
  flow — media container (`POST /{ig-user-id}/media`) → wait for
  `status_code: FINISHED` → publish (`POST /{ig-user-id}/media_publish`).
  A post shows "published" ONLY when Instagram returns a real media id.
  Text-only posts are rejected (Instagram needs media).
- **Instagram DM intake + send** (already existed, verified): webhook
  `object: 'instagram'` → Inbox; replies go out via the Graph Send API
  with the Page token.
- **WhatsApp sending** (new): WhatsApp Cloud API
  `POST /{phone-number-id}/messages` with the channel's stored permanent
  token — text + image. A message counts as sent ONLY on a real `wamid.…`
  id. Manual replies AND AI replies both route through it
  (`deliverOutgoingMessage` / `deliverOutgoingImageMessage`).
- **WhatsApp intake** (already existed, verified): webhook
  `POST /api/webhooks/whatsapp` → Inbox (deduped by message id).
- **24-hour window (WhatsApp)**: a free-form reply only works within 24h
  of the customer's last message. Outside it WhatsApp answers error
  131047 and the reply is honestly marked `failed` with
  `windowExpired: true` — the owner sees "the customer must message
  again first". No template messages exist yet, so there is no way to
  message a customer outside the window; never a fake send.

## What the owner must do (browser / phone — no code)

### Instagram — link the account, then connect
1. In the **Instagram app**, switch the shop's account to **Business** or
   **Creator** (Settings → Account type and tools → Switch to
   professional account).
2. Link it to the **Halal Chic Facebook Page**: Instagram app →
   Accounts Centre → Pages, or Meta Business Suite → Settings → Linked
   accounts → Instagram → connect the Page. (Until this is done the
   Page has no `instagram_business_account` and nothing can connect.)
3. In the app: **Channels → Connect Instagram** and pick Halal Chic.
   The login now asks for `instagram_content_publish` too.
4. If Instagram was connected BEFORE this update, its token has no
   publish permission: the Schedule page shows "reconnect Instagram"
   and posts fail honestly until the owner reconnects on the Channels
   page (same pattern as the YouTube read-only reconnect).

### WhatsApp — get a Business number, then connect (either way)
- **Option A (Embedded Signup — the ONLY one-click path):** in the
  Meta app dashboard create the WhatsApp Embedded Signup config
  (Facebook Login for Business → Configuration → login variation
  "WhatsApp Embedded Signup"), then set `WHATSAPP_CONFIG_ID` in the
  Vercel API env; Channels → Connect WhatsApp runs the signup flow.
  **A plain Facebook Login can NEVER grant
  `whatsapp_business_management`** — Meta only grants that permission
  through Embedded Signup. Live-proven 2026-11-09: the plain login
  returned a token, but `GET /me/whatsapp_business_accounts` failed
  400 `(#100) Tried accessing nonexisting field` 3 times, so the
  number picker could not list anything. The picker now answers 502
  with `reason: 'wa_scope_missing'` and says so honestly (never a
  generic "could not load", never an empty list pretending "no
  account"). Until the permission is granted Meta will not even say
  whether a WhatsApp Business Account exists — so WABA existence
  cannot be checked from the app's tokens at all.
- **Option B (manual, no config needed):** in Meta Business Suite →
  WhatsApp Manager (or System Users) copy the **Phone Number ID** and
  a **permanent access token**, then Channels → WhatsApp manual connect
  and paste them. The number is verified first (a wrong id/token is
  rejected and nothing is stored); no test message is sent.

## Honest limits

- Instagram posts need a **public media URL** (Vercel Blob URLs work;
  local `/api/uploads` links do not — Instagram cannot fetch them).
- WhatsApp image messages need a public image URL for the same reason.
- WhatsApp replies outside the 24h window fail honestly (see above).
- Trial workspaces have 1 channel slot: Instagram and WhatsApp cannot
  both connect on the same trial workspace (pick one or upgrade).
- Public shops still need Meta App Review (advanced access) for
  `instagram_content_publish` / WhatsApp messaging, like the other
  Meta permissions.
