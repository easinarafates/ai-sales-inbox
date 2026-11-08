import { config } from './config';

/**
 * Outgoing email (password-reset links) via the Resend HTTP API.
 *
 * Configuration comes ONLY from env vars (RESEND_API_KEY, RESEND_FROM).
 * Nothing is hardcoded and the API key is NEVER logged. When the key is
 * missing the mailer is OFF: isMailerConfigured() is false and sendMail()
 * throws — callers must catch that, log it, and carry on without
 * claiming an email was sent.
 *
 * No extra dependency: the Resend API is plain HTTPS, sent with the
 * built-in fetch. The default sender is Resend's onboarding address
 * (works without a verified domain, but Resend only delivers those to
 * the Resend account's own email — set RESEND_FROM to a verified-domain
 * sender for delivery to any address).
 */

const RESEND_API_URL = 'https://api.resend.com/emails';

export function isMailerConfigured(): boolean {
  return Boolean(config.resend.apiKey);
}

export interface SendMailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Send one email via Resend. Returns Resend's message id on success. Throws on failure — the caller logs it and never fails the request over it. */
export async function sendMail(opts: SendMailOptions): Promise<string> {
  if (!isMailerConfigured()) {
    throw new Error('Mailer not configured (RESEND_API_KEY missing)');
  }
  const controller = new AbortController();
  // Serverless-safe: a stalled Resend call must fail fast, never hang
  // the request for minutes.
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.resend.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.resend.from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        ...(opts.html ? { html: opts.html } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`Resend rejected the send (HTTP ${res.status}): ${detail}`);
    }
    const data = (await res.json()) as { id?: string };
    return data?.id ?? '';
  } finally {
    clearTimeout(timeout);
  }
}
