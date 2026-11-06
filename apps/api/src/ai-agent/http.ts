/**
 * Shared HTTP helper for AI provider clients.
 * A bare fetch() has NO timeout in Node: a stalled provider connection
 * would block the agent reply forever and the Groq fallback would never
 * run. Every provider call goes through fetchWithTimeout so a hanging
 * provider fails fast (default 20s, AI_PROVIDER_TIMEOUT_MS) and the
 * caller can fall back honestly.
 */
import { config } from '../config';

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = config.aiProviderTimeoutMs,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new Error(`AI provider request timed out after ${timeoutMs}ms (${url})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
