import { Router, type Response } from 'express';
import { fetchWithTimeout } from '../ai-agent/http';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { config } from '../config';
import type { AuthRequest } from '../types';
import {
  createOAuthChannel,
  exchangeCodeForToken,
  exchangeForLongLived,
  fetchMeName,
  graphBase,
  loginUrl,
  OAUTH_GRAPH_TIMEOUT_MS,
  signSession,
  signStateToken,
  verifySession,
  webRedirect,
  type VerifiedState,
} from './meta-oauth';

/**
 * "Connect WhatsApp" — connects a WhatsApp Business phone number through
 * the same Meta app as Facebook Login. No IDs or tokens typed by hand.
 *
 * Flow: Channels page → GET /login (Meta dialog, WhatsApp scopes) →
 * Meta calls the SHARED callback (/api/channels/facebook/callback — the
 * one redirect URI registered in the Meta app; the state JWT carries
 * channel='whatsapp') → the callback does ONLY the code exchange, the
 * long-lived exchange and the account-name read, then redirects to the
 * Channels page with a token-only picker session (whatsapp=pick) → the
 * page calls GET /accounts, which lists the WhatsApp Business accounts
 * + phone numbers live from Graph → exactly 1 number or several: the
 * user picks one on the Channels page (POST /connect); no account or no
 * number: the picker shows reason='no_waba'.
 *
 * The WABA lookup deliberately happens AFTER the redirect, not in the
 * callback: the old callback fetched the accounts synchronously and its
 * sequential Graph calls ran past Vercel's 10s default function limit —
 * the live browser test on 2026-11-09 got a 504 FUNCTION_INVOCATION_TIMEOUT
 * twice, and the flow never reached the number picker. The callback now
 * answers in ~1-2s (3 fast Graph calls, each capped at
 * OAUTH_GRAPH_TIMEOUT_MS) and the slow lookup runs as an XHR, where the
 * page already shows a loading state. vercel.json also raises the
 * function limit to 60s (maxDuration) as a safety net.
 *
 * The connected channel is ONE row: platform 'whatsapp',
 * external_id = WhatsApp phone-number ID, display_name = the phone
 * number, token_encrypted = the long-lived user token,
 * source_id = the WhatsApp Business Account ID. Incoming WhatsApp
 * messages resolve through the existing
 * findChannelByExternalId('whatsapp', phoneNumberId) webhook lookup.
 *
 * The picker session JWT carries the long-lived user token (same
 * pattern as the Facebook flow, where page tokens ride in the signed
 * 10-minute session JWT): /accounts strips it out, and /connect reads
 * it back from the verified session. It is never logged or returned.
 *
 * NOTE (Meta-side setup): the whatsapp_business_management +
 * whatsapp_business_messaging scopes need the WhatsApp product added
 * to the Meta app. In Development mode the app admin can grant them
 * for their own account; public shops need App Review (advanced
 * access) later.
 */
export const whatsappOAuthRouter = Router();

const SCOPES = ['whatsapp_business_management', 'whatsapp_business_messaging'];

export interface WaPhoneNumber {
  id: string;
  displayNumber: string;
  verifiedName: string;
}

export interface WaAccount {
  id: string;
  name: string;
  phoneNumbers: WaPhoneNumber[];
}

interface WaSession {
  workspaceId: string;
  /** Accounts + numbers, when the session was issued with them (old
   * sessions, pre-2026-11-09, carried the list; new sessions are
   * token-only and /accounts + /connect fetch live instead). */
  wabas?: WaAccount[];
  userToken: string;
}

/**
 * Thrown when the session token lacks whatsapp_business_management:
 * Graph answers 400 (#100) "Tried accessing nonexisting field" on
 * /me/whatsapp_business_accounts. A PLAIN Facebook Login NEVER grants
 * this permission — Meta only grants it through Embedded Signup
 * (Facebook Login for Business, which needs a config_id created in the
 * Meta app dashboard and WHATSAPP_CONFIG_ID set). So this is a SETUP
 * error, NOT "no WABA": with this token Meta will not even say whether
 * a WABA exists. Callers must answer with reason 'wa_scope_missing'
 * and the honest Embedded-Signup-or-manual-form message — never a
 * generic "could not load" and never an empty list pretending
 * "no account". Live-proven 2026-11-09: the fresh token from the plain
 * login failed exactly this way 3 times in the live browser test.
 */
export class WaScopeMissingError extends Error {
  readonly code = 'wa_scope_missing';
}

async function fetchWabas(longLivedToken: string): Promise<{ id: string; name: string }[]> {
  const url = new URL(`${graphBase()}/me/whatsapp_business_accounts`);
  url.searchParams.set('fields', 'id,name');
  const res = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${longLivedToken}` },
  }, OAUTH_GRAPH_TIMEOUT_MS);
  const data = (await res.json().catch(() => null)) as {
    data?: { id?: string; name?: string }[];
    error?: { message?: string; code?: number };
  } | null;
  if (!res.ok) {
    const msg = data?.error?.message ?? '';
    // 400 (#100) "nonexisting field" = the token was never granted
    // whatsapp_business_management (plain login). See WaScopeMissingError.
    if (res.status === 400 && /nonexisting field/i.test(msg)) {
      throw new WaScopeMissingError(`Meta Graph /me/whatsapp_business_accounts failed (${res.status}): ${msg}`);
    }
    throw new Error(`Meta Graph /me/whatsapp_business_accounts failed (${res.status})${msg ? `: ${msg}` : ''}`);
  }
  return (data?.data ?? [])
    .filter((w) => typeof w?.id === 'string')
    .map((w) => ({ id: w.id as string, name: w.name ?? (w.id as string) }));
}

/** One account's phone numbers (empty on a per-account failure). */
async function fetchWabaNumbers(longLivedToken: string, wabaId: string): Promise<WaPhoneNumber[]> {
  try {
    const url = new URL(`${graphBase()}/${encodeURIComponent(wabaId)}/phone_numbers`);
    url.searchParams.set('fields', 'id,display_phone_number,verified_name');
    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${longLivedToken}` },
    }, OAUTH_GRAPH_TIMEOUT_MS);
    const data = (await res.json().catch(() => null)) as {
      data?: { id?: string; display_phone_number?: string; verified_name?: string }[];
    } | null;
    if (!res.ok) return [];
    return (data?.data ?? [])
      .filter((n) => typeof n?.id === 'string')
      .map((n) => ({
        id: n.id as string,
        displayNumber: n.display_phone_number ?? (n.id as string),
        verifiedName: n.verified_name ?? '',
      }));
  } catch {
    return [];
  }
}

/**
 * All WABA accounts with their phone numbers, numbers fetched in
 * parallel (independent calls — the old sequential loop multiplied the
 * callback's Graph time by the account count).
 */
async function fetchWabasEnriched(longLivedToken: string): Promise<WaAccount[]> {
  const wabas = await fetchWabas(longLivedToken);
  const enriched = await Promise.all(
    wabas.map(async (w) => ({ ...w, phoneNumbers: await fetchWabaNumbers(longLivedToken, w.id) })),
  );
  return enriched;
}

/**
 * VERIFY a WhatsApp phone number by reading it back from Graph
 * (GET /{phone-number-id}?fields=id,display_phone_number,verified_name).
 * Used by the manual Cloud API connect — the number is only stored
 * after Meta confirms it exists and the token can read it. Never throws
 * (null on any failure: wrong id, wrong token, no permission).
 */
export async function fetchPhoneNumber(
  token: string,
  phoneNumberId: string,
): Promise<WaPhoneNumber | null> {
  try {
    const url = new URL(`${graphBase()}/${encodeURIComponent(phoneNumberId)}`);
    url.searchParams.set('fields', 'id,display_phone_number,verified_name');
    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, OAUTH_GRAPH_TIMEOUT_MS);
    const data = (await res.json().catch(() => null)) as {
      id?: string;
      display_phone_number?: string;
      verified_name?: string;
    } | null;
    if (!res.ok || typeof data?.id !== 'string') return null;
    return {
      id: data.id,
      displayNumber: data.display_phone_number ?? data.id,
      verifiedName: data.verified_name ?? '',
    };
  } catch {
    return null;
  }
}

async function createWhatsappChannel(
  workspaceId: string,
  waba: WaAccount,
  number: WaPhoneNumber,
  userToken: string,
): Promise<ReturnType<typeof createOAuthChannel>> {
  return createOAuthChannel(workspaceId, {
    platform: 'whatsapp',
    externalId: number.id,
    displayName: number.displayNumber,
    token: userToken,
    pictureUrl: null,
    sourceId: waba.id,
    duplicateMessage: 'This WhatsApp number is already connected to this workspace.',
  });
}

/**
 * Complete the WhatsApp flow after the code exchange (shared callback).
 *
 * FAST BY DESIGN: only the code exchange, the long-lived exchange and
 * the account-name read happen here (~1-2s), then the user is redirected
 * to the Channels page with a token-only picker session. The WABA +
 * phone-number lookup runs in GET /accounts (an XHR, where the page
 * shows a loading state) — never in this callback. The old version did
 * the whole lookup synchronously and timed out on Vercel (504) twice
 * in a live browser test (2026-11-09); the flow never reached the
 * number picker. No WABA / no number is therefore NOT a callback error
 * any more: the picker lists zero numbers and the page shows the
 * no_waba message (reason='no_waba' is returned by /accounts).
 */
export async function completeWhatsappOAuth(
  verified: VerifiedState,
  code: string,
  res: Response,
): Promise<void> {
  const shortToken = await exchangeCodeForToken(code);
  const longToken = await exchangeForLongLived(shortToken);
  const account = await fetchMeName(longToken);
  const session = signSession('whatsapp_accounts', {
    workspaceId: verified.workspaceId,
    userToken: longToken,
  });
  return webRedirect(res, 'whatsapp', {
    whatsapp: 'pick',
    session,
    ...(account ? { account } : {}),
  });
}

function verifyWaSession(token: string): WaSession | null {
  const p = verifySession(token, 'whatsapp_accounts');
  if (
    !p ||
    typeof p.workspaceId !== 'string' ||
    typeof p.userToken !== 'string'
  ) {
    return null;
  }
  const wabas = p.wabas as WaAccount[] | undefined;
  if (
    wabas !== undefined &&
    (!Array.isArray(wabas) ||
      !wabas.every(
        (w) =>
          typeof w?.id === 'string' &&
          Array.isArray(w.phoneNumbers) &&
          w.phoneNumbers.every((n) => typeof n?.id === 'string' && typeof n?.displayNumber === 'string'),
      ))
  ) {
    return null;
  }
  return { workspaceId: p.workspaceId as string, wabas, userToken: p.userToken as string };
}

/**
 * The user's WABA accounts + numbers, fetched LIVE from Graph with the
 * session's long-lived token. A token-only session (issued by the fast
 * callback) has no embedded list, so this is the only source. If the
 * live fetch fails, a session that still carries an embedded list falls
 * back to it; otherwise the error propagates and the caller answers
 * honestly (502) instead of inventing accounts. A scope error
 * (WaScopeMissingError) is NEVER masked by the fallback: it means the
 * current login cannot see WABAs at all, and the caller must say so.
 */
async function resolveWabas(session: WaSession): Promise<WaAccount[]> {
  try {
    return await fetchWabasEnriched(session.userToken);
  } catch (err) {
    if (err instanceof WaScopeMissingError) throw err;
    if (session.wabas) return session.wabas;
    throw err;
  }
}

/**
 * Honest 502 body for a scope-missing lookup: the login did not grant
 * whatsapp_business_management, so no account list can be produced.
 * The message names the two real ways forward (Embedded Signup setup
 * by the owner, or the manual form) instead of a generic "try again".
 */
function waScopeMissingBody(): { error: string; reason: string } {
  return {
    error:
      'Facebook লগইনে WhatsApp Business-এর অনুমতি মেলেনি — Meta এই অনুমতি শুধু Embedded Signup দিয়ে দেয়। মালিককে Meta অ্যাপে WhatsApp → Embedded Signup থেকে Configuration ID বানিয়ে WHATSAPP_CONFIG_ID বসাতে হবে, অথবা নিচের ফর্মে Phone Number ID + স্থায়ী টোকেন বসিয়ে ম্যানুয়ালি যুক্ত করুন।',
    reason: 'wa_scope_missing',
  };
}

/**
 * GET /api/channels/whatsapp/login — returns the Meta dialog URL.
 * 503 while no Meta app is configured (META_APP_ID unset).
 * ?reauthenticate=1 forces Facebook to ask for credentials again so the
 * user can log in with a DIFFERENT Facebook account (see loginUrl).
 *
 * The dialog URL carries config_id when WHATSAPP_CONFIG_ID is set —
 * that is what turns this from a plain Facebook Login into Meta's
 * Embedded Signup (create/use a WhatsApp Business account + pick a
 * number). Without it, Meta only logs the user in and the callback
 * finds no WABA (reason=no_waba) for anyone who has none yet.
 *
 * HARD LIMIT (live-proven 2026-11-09): a PLAIN Facebook Login — no
 * config_id — NEVER grants whatsapp_business_management, so the token
 * it returns cannot call /me/whatsapp_business_accounts at all (Graph
 * 400 #100 "nonexisting field"). The picker then answers 502 with
 * reason wa_scope_missing, naming Embedded Signup or the manual form
 * as the way forward. Embedded Signup is the only one-click path; the
 * manual form (Phone Number ID + permanent token) works without it.
 */
whatsappOAuthRouter.get('/login', requireAuth, (req: AuthRequest, res: Response) => {
  if (!config.meta.appId) {
    res.status(503).json({
      error: 'WhatsApp login is not configured yet — the Meta app (META_APP_ID) has not been set up. The platform owner needs to connect a Meta app first.',
    });
    return;
  }
  const state = signStateToken(req.userId as string, getWorkspaceId(req), 'whatsapp');
  res.json({ url: loginUrl(SCOPES, state, { reauthenticate: req.query.reauthenticate === '1', configId: config.whatsapp.configId || undefined }) });
});

/**
 * GET /api/channels/whatsapp/accounts?session=... — the picker list.
 * The accounts are fetched LIVE from Graph with the session's long-lived
 * user token (the fast callback no longer does this lookup — see
 * completeWhatsappOAuth). The long-lived user token is stripped: each
 * account carries id/name plus its phone numbers (id, display number,
 * verified name) — never a token. An empty list means no WABA / no
 * number on this Facebook account: the Channels page shows the
 * no_waba message (reason='no_waba' is returned alongside). A Graph
 * failure answers 502 honestly instead of an empty list — an empty list
 * must mean "none found", never "the lookup failed".
 */
whatsappOAuthRouter.get('/accounts', requireAuth, async (req: AuthRequest, res: Response) => {
  const session = verifyWaSession(String(req.query.session ?? ''));
  if (!session || session.workspaceId !== getWorkspaceId(req)) {
    res.status(401).json({ error: 'Invalid or expired WhatsApp session — please log in again.' });
    return;
  }
  let wabas: WaAccount[];
  try {
    wabas = await resolveWabas(session);
  } catch (err) {
    if (err instanceof WaScopeMissingError) {
      console.error('[whatsapp-oauth] accounts lookup failed (scope missing):', err.message);
      res.status(502).json(waScopeMissingBody());
      return;
    }
    console.error('[whatsapp-oauth] accounts lookup failed:', (err as Error).message);
    res.status(502).json({ error: 'WhatsApp অ্যাকাউন্টগুলো লোড করা যায়নি — আবার চেষ্টা করুন।' });
    return;
  }
  res.json({
    wabas: wabas.map(({ id, name, phoneNumbers }) => ({
      id,
      name,
      phoneNumbers: phoneNumbers.map((n) => ({ id: n.id, displayNumber: n.displayNumber, verifiedName: n.verifiedName })),
    })),
    ...(wabas.length === 0 ? { reason: 'no_waba' } : {}),
  });
});

/** POST /api/channels/whatsapp/connect — connect the picked phone number. */
whatsappOAuthRouter.post('/connect', requireAuth, async (req: AuthRequest, res: Response) => {
  const { session, wabaId, phoneNumberId } = (req.body ?? {}) as {
    session?: string;
    wabaId?: string;
    phoneNumberId?: string;
  };
  const verified = session ? verifyWaSession(session) : null;
  if (!verified || verified.workspaceId !== getWorkspaceId(req)) {
    res.status(401).json({ error: 'Invalid or expired WhatsApp session — please log in again.' });
    return;
  }
  // Validate the pick against a LIVE WABA list (the session is token-only
  // since the fast callback — it carries no list to trust).
  let wabas: WaAccount[];
  try {
    wabas = await resolveWabas(verified);
  } catch (err) {
    if (err instanceof WaScopeMissingError) {
      console.error('[whatsapp-oauth] connect lookup failed (scope missing):', err.message);
      res.status(502).json(waScopeMissingBody());
      return;
    }
    console.error('[whatsapp-oauth] connect lookup failed:', (err as Error).message);
    res.status(502).json({ error: 'WhatsApp অ্যাকাউন্টগুলো লোড করা যায়নি — আবার চেষ্টা করুন।' });
    return;
  }
  const waba = wabas.find((w) => w.id === wabaId);
  const number = waba?.phoneNumbers.find((n) => n.id === phoneNumberId);
  if (!waba || !number) {
    res.status(400).json({ error: 'Unknown WhatsApp number — please log in again.' });
    return;
  }
  const result = await createWhatsappChannel(verified.workspaceId, waba, number, verified.userToken);
  if (!result.ok) {
    res.status(result.reason === 'limit' ? 402 : 409).json({ error: result.message });
    return;
  }
  res.status(201).json({ channel: result.channel });
});

/**
 * POST /api/channels/whatsapp/manual — manual Cloud API connect.
 * Fallback when Embedded Signup is not set up (no WHATSAPP_CONFIG_ID)
 * or the user already has a WhatsApp Business number + permanent access
 * token from Meta Business Suite / the WhatsApp Manager.
 *
 * Body: { phoneNumberId, token, wabaId? } — the phone-number ID and a
 * permanent (never-expiring) token. The number is VERIFIED first
 * (GET /{phone-number-id} with the token): a wrong id, an expired
 * token or a token without whatsapp_business_management answers 400
 * with a Bengali message and nothing is stored. Only a verified number
 * is stored — never a fake "connected" row. No test message is ever
 * sent by this endpoint.
 */
whatsappOAuthRouter.post('/manual', requireAuth, async (req: AuthRequest, res: Response) => {
  const { phoneNumberId, token, wabaId } = (req.body ?? {}) as {
    phoneNumberId?: string;
    token?: string;
    wabaId?: string;
  };
  if (!phoneNumberId || typeof phoneNumberId !== 'string' || !token || typeof token !== 'string') {
    res.status(400).json({ error: 'ফোন নম্বর ID আর টোকেন — দুটোই লাগবে। Meta Business Suite থেকে নম্বরের ID আর স্থায়ী (permanent) অ্যাক্সেস টোকেনটি বসান।' });
    return;
  }
  const number = await fetchPhoneNumber(token.trim(), phoneNumberId.trim());
  if (!number) {
    res.status(400).json({
      error: 'এই নম্বরটি যাচাই করা যায়নি — নম্বর ID ভুল হতে পারে, অথবা টোকেনটি ভুল/মেয়াদোত্তীর্ণ। Meta Business Suite-এ নম্বরটি আছে কি না আর টোকেনটি স্থায়ী (permanent) কি না দেখে আবার চেষ্টা করুন।',
      reason: 'wa_verify_failed',
    });
    return;
  }
  const result = await createWhatsappChannel(getWorkspaceId(req), {
    id: typeof wabaId === 'string' && wabaId ? wabaId : '',
    name: '',
    phoneNumbers: [number],
  }, number, token.trim());
  if (!result.ok) {
    res.status(result.reason === 'limit' ? 402 : 409).json({ error: result.message });
    return;
  }
  res.status(201).json({ channel: result.channel });
});
