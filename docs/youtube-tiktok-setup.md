# YouTube + TikTok setup — what the owner must do

The code for YouTube scheduling, YouTube comments, TikTok posting,
TikTok comments and TikTok DMs is built and deployed. None of it can run
until the accounts below exist — the app cannot create them. Until then
every endpoint answers honestly ("not set up yet" / "not connected"),
never a fake post or message.

## 1. YouTube (Google)

1. Google Cloud Console → create/select a project → enable **YouTube Data
   API v3**.
2. APIs & Services → Credentials → Create OAuth client (Web application).
   Add Authorized redirect URI:
   `https://ai-sales-inbox-api.vercel.app/api/channels/youtube/callback`
3. Put in Vercel → API project → Environment Variables:
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_OAUTH_REDIRECT_URI=https://ai-sales-inbox-api.vercel.app/api/channels/youtube/callback`
4. Channels page → YouTube → connect. The connect asks for three scopes:
   `youtube.readonly` (read channel/videos/comments), `youtube.upload`
   (upload videos), `youtube.force-ssl` (reply to comments).
5. **If YouTube was connected before** (read-only only), connect it
   AGAIN — the reconnect re-consents with the upload scope. The Schedule
   page warns you while the stored scopes are read-only.
6. Quota: the Google project gets 10,000 units/day; one upload costs
   ~1,600 units, so ~6 uploads/day per project (Google's Dec 2025
   revision moved uploads into their own 100/day bucket — the app still
   caps at 6/day to stay safe). A quota-exhausted publish FAILS
   honestly and retries the next day; it never shows as published.
7. Google may restrict uploads from an **unverified OAuth app** (videos
   stay private) until the app is verified in the Cloud Console
   (OAuth consent screen → Publish app / verification).

## 2. TikTok posting + comments (Login Kit)

1. developers.tiktok.com → create an app → add the **Login Kit** product.
2. Add these scopes to the app: `user.info.basic`, `video.list`,
   `video.publish` (Direct Post), `video.upload` (inbox drafts),
   `comment.list` (read comments on your videos).
3. Register Redirect URI:
   `https://ai-sales-inbox-api.vercel.app/api/channels/tiktok/callback`
4. Put in Vercel → API project → Environment Variables:
   - `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`
   - `TIKTOK_OAUTH_REDIRECT_URI=https://ai-sales-inbox-api.vercel.app/api/channels/tiktok/callback`
5. Channels page → TikTok → connect (reconnect again if it was connected
   with only `user.info.basic` — the new scopes need a fresh consent).
6. **Submit the app for review** in the TikTok developer portal for the
   `video.publish` / `video.upload` / `comment.list` scopes. Until TikTok
   approves, posting and comment-reading fail with TikTok's own
   `scope_not_authorized` error — the app reports it, never fakes it.
7. **Audit gate:** even after approval, TikTok shows posts from an
   unaudited app as PRIVATE. The app keeps the `TIKTOK_SCHEDULING_AUDITED`
   gate: set `TIKTOK_SCHEDULING_AUDITED=true` in Vercel env ONLY after
   TikTok passes the Content Posting API audit. Until then scheduled
   TikTok posts end `failed` with "TikTok audit pending".
8. Comment replies (`POST /api/tiktok/comments/reply`) need TikTok's
   approval of the comment scopes; reading comments works once
   `comment.list` is approved.

## 3. TikTok DMs (Business Messaging — a SEPARATE product)

Login Kit can NEVER read or send DMs. DMs need TikTok for Business:

1. TikTok for Business → register as a developer → apply for the
   **Business Messaging API** (Advanced Access + Verified Business
   Account). This is a different application from the Login Kit app.
2. The account must NOT be registered in the US / EEA / Switzerland /
   UK — TikTok does not offer Business Messaging there at all.
3. Register the webhook URL with TikTok:
   `https://ai-sales-inbox-api.vercel.app/api/webhooks/tiktok-dm`
   (verification token = `TIKTOK_DM_VERIFY_TOKEN`, or the Meta verify
   token as fallback).
4. Put in Vercel → API project → Environment Variables:
   - `TIKTOK_BUSINESS_ACCESS_TOKEN` (the Business Messaging access
     token — NOT the Login Kit token)
   - `TIKTOK_BUSINESS_ID` (the Business Account id — NOT the Login Kit
     open_id)
   - `TIKTOK_DM_APPROVED=true` (only after TikTok approves messaging)
   - `TIKTOK_DM_VERIFY_TOKEN` (your chosen webhook verify token)
5. Rules TikTok enforces (the app cannot change them): **reply-only** —
   the customer must message first; **48-hour window** from their last
   message; **~10 replies** per window; no business-initiated or bulk
   messages; text + images only (no video/voice).
6. How DMs arrive: the webhook saves each DM into the Inbox (one
   customer = one chat) and the AI auto-replies like Messenger. If the
   webhook is not registered yet, `POST /api/tiktok/dm/sync` pulls the
   live Business Messaging threads into the Inbox instead. Manual and AI
   replies go out through the same Business Messaging send endpoint;
   a failed send is marked `failed` with TikTok's own reason.

## What is already live in the app

- Schedule page: Facebook + YouTube + TikTok platforms (YouTube/TikTok
  video-only). Overdue posts publish via the GitHub Actions cron sweep
  and the Schedule page's lazy sweep. A post is `published` only on a
  real video id (YouTube) / `PUBLISH_COMPLETE` (TikTok).
- Comments page: Facebook / YouTube / TikTok tabs, live from each
  platform, with replies.
- Inbox: TikTok DM chats appear like Messenger chats; AI + manual
  replies use the Business Messaging send endpoint.
- `GET /api/youtube/status` (quota + upload scope) and
  `GET /api/tiktok/status` (connected / audited / DM approved /
  Business Messaging configured) — the honest state, in one call.
