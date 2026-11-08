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
 * channel='whatsapp') → code is exchanged for a long-lived user token
 * → /me/whatsapp_business_accounts lists the user's WhatsApp Business
 * accounts → each account's phone numbers are listed → exactly 1
 * number: the channel is created immediately; >1 numbers: the user
 * picks one on the Channels page (POST /connect); no account or no
 * number: redirect with reason=no_waba.
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
  wabas: WaAccount[];
  userToken: string;
}

async function fetchWabas(longLivedToken: string): Promise<{ id: string; name: string }[]> {
  const url = new URL(`${graphBase()}/me/whatsapp_business_accounts`);
  url.searchParams.set('fields', 'id,name');
  const res = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${longLivedToken}` },
  });
  const data = (await res.json().catch(() => null)) as {
    data?: { id?: string; name?: string }[];
    error?: { message?: string };
  } | null;
  if (!res.ok) {
    throw new Error(`Meta Graph /me/whatsapp_business_accounts failed (${res.status})${data?.error?.message ? `: ${data.error.message}` : ''}`);
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
    });
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
    });
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

/** Complete the WhatsApp flow after the code exchange (shared callback). */
export async function completeWhatsappOAuth(
  verified: VerifiedState,
  code: string,
  res: Response,
): Promise<void> {
  const shortToken = await exchangeCodeForToken(code);
  const longToken = await exchangeForLongLived(shortToken);
  const account = await fetchMeName(longToken);
  const wabas = await fetchWabas(longToken);
  if (wabas.length === 0) {
    return webRedirect(res, 'whatsapp', {
      whatsapp: 'error',
      reason: 'no_waba',
      ...(account ? { account } : {}),
    });
  }
  const enriched: WaAccount[] = [];
  for (const w of wabas) {
    enriched.push({ ...w, phoneNumbers: await fetchWabaNumbers(longToken, w.id) });
  }
  const totalNumbers = enriched.reduce((n, w) => n + w.phoneNumbers.length, 0);
  if (totalNumbers === 0) {
    return webRedirect(res, 'whatsapp', {
      whatsapp: 'error',
      reason: 'no_waba',
      ...(account ? { account } : {}),
    });
  }
  if (totalNumbers === 1) {
    const waba = enriched.find((w) => w.phoneNumbers.length === 1) as WaAccount;
    const number = waba.phoneNumbers[0];
    const result = await createWhatsappChannel(verified.workspaceId, waba, number, longToken);
    if (!result.ok) {
      return webRedirect(res, 'whatsapp', {
        whatsapp: 'error',
        reason: result.reason,
        ...(account ? { account } : {}),
      });
    }
    return webRedirect(res, 'whatsapp', { whatsapp: 'connected', name: number.displayNumber });
  }
  const session = signSession('whatsapp_accounts', {
    workspaceId: verified.workspaceId,
    wabas: enriched,
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
    typeof p.userToken !== 'string' ||
    !Array.isArray(p.wabas)
  ) {
    return null;
  }
  const wabas = p.wabas as WaAccount[];
  if (
    !wabas.every(
      (w) =>
        typeof w?.id === 'string' &&
        Array.isArray(w.phoneNumbers) &&
        w.phoneNumbers.every((n) => typeof n?.id === 'string' && typeof n?.displayNumber === 'string'),
    )
  ) {
    return null;
  }
  return { workspaceId: p.workspaceId as string, wabas, userToken: p.userToken as string };
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
 * The long-lived user token is stripped: each account carries id/name
 * plus its phone numbers (id, display number, verified name) — never
 * a token.
 */
whatsappOAuthRouter.get('/accounts', requireAuth, (req: AuthRequest, res: Response) => {
  const session = verifyWaSession(String(req.query.session ?? ''));
  if (!session || session.workspaceId !== getWorkspaceId(req)) {
    res.status(401).json({ error: 'Invalid or expired WhatsApp session — please log in again.' });
    return;
  }
  res.json({
    wabas: session.wabas.map(({ id, name, phoneNumbers }) => ({
      id,
      name,
      phoneNumbers: phoneNumbers.map((n) => ({ id: n.id, displayNumber: n.displayNumber, verifiedName: n.verifiedName })),
    })),
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
  const waba = verified.wabas.find((w) => w.id === wabaId);
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
