/**
 * Customer media for the AI (2026-11-08) — photos and voice notes.
 *
 * A customer photo / voice note arrives on the Messenger webhook as an
 * attachment. The webhook intake (webhooks/routes.ts) downloads it with
 * the Page token, re-uploads it to Vercel Blob, and stores the Blob URL
 * on the message row (messages.media_url / media_type, migration 27).
 * This module is the AI side of that pipeline:
 *
 * - downloadMedia(url): fetch bytes (any public URL — Blob or Meta).
 * - uploadMediaToBlob(bytes, mimeType, filename): store in the Blob
 *   store (same @vercel/blob `put` the scheduled-post upload uses).
 * - analyseCustomerImage(imageUrl, products): Gemini vision matches the
 *   customer's photo against the shop's REAL catalog — the customer
 *   photo + each product's photo go in as image parts, and the model
 *   returns the matching catalog id (or null) as JSON. A match comes
 *   ONLY from the catalog rows — a product, price or stock level is
 *   never invented. Returns null when vision is unavailable (no key,
 *   download failed, API error) so the caller falls back honestly.
 * - transcribeCustomerAudio(audioUrl): Gemini audio input → transcript
 *   (Bengali / Banglish speech to text). The transcript then flows
 *   through the normal text pipeline (anger / off-topic / gibberish /
 *   LLM) so a voice question gets a text reply. Returns null when the
 *   audio cannot be fetched or transcribed — the caller replies
 *   honestly ("ভয়েস মেসেজটি শুনতে পারিনি...") and never fakes it.
 *
 * Voice REPLY (the AI speaking back) is NOT here — text reply only.
 */
import { put } from '@vercel/blob';
import { callGeminiMultimodal, uploadGeminiFile, type GeminiPart } from './gemini';
import { fetchWithTimeout } from './http';

/** Same media cap as the rest of the app (product photos, 25 MB). */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
/** Inline data stays under Gemini's ~20 MB per-request cap. */
const INLINE_LIMIT_BYTES = 10 * 1024 * 1024;

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
  size: number;
}

/** Fetch bytes from a URL (Blob URL, Meta attachment URL, product image). */
export async function downloadMedia(url: string, timeoutMs = 20000): Promise<DownloadedMedia | null> {
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs);
    if (!res.ok) {
      console.error(`[media] download failed ${res.status} for ${url.slice(0, 80)}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_MEDIA_BYTES) {
      console.error(`[media] download size ${buf.length} out of range for ${url.slice(0, 80)}`);
      return null;
    }
    const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
    return { buffer: buf, mimeType, size: buf.length };
  } catch (err) {
    console.error(`[media] download failed for ${url.slice(0, 80)}:`, (err as Error).message);
    return null;
  }
}

/**
 * Download a Meta attachment URL with the Page token. Meta attachment
 * URLs are short-lived CDN links; appending the page access token is
 * the documented way to fetch them. Falls back to a plain fetch when
 * the tokenised fetch fails (some CDN URLs work without it).
 */
export async function downloadMetaAttachment(
  url: string,
  pageToken: string | null,
): Promise<DownloadedMedia | null> {
  if (pageToken) {
    const sep = url.includes('?') ? '&' : '?';
    const withToken = await downloadMedia(`${url}${sep}access_token=${encodeURIComponent(pageToken)}`);
    if (withToken) return withToken;
  }
  return downloadMedia(url);
}

/** Store bytes in the Blob store (public) — returns the URL, or null when Blob is not configured. */
export async function uploadMediaToBlob(
  bytes: Buffer,
  mimeType: string,
  filename: string,
): Promise<string | null> {
  try {
    const blob = await put(filename, bytes, { access: 'public', contentType: mimeType });
    return blob.url;
  } catch (err) {
    console.error('[media] Blob upload failed:', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Photo → product match (Gemini vision)
// ---------------------------------------------------------------------------

export interface MatchCatalogProduct {
  id: string;
  name: string;
  pricePaisa: number;
  stock: number;
  description: string | null;
  imageUrl: string | null;
}

export interface ImageMatchOutcome {
  /** Catalog id of the product the photo shows, or null (not our product). */
  matchedId: string | null;
  /** 0–1 confidence in the match. */
  confidence: number;
  /** What the photo shows, in Bengali (for the reply / logs). */
  description: string;
  /** Catalog ids of the closest products (max 3) when there is no match. */
  similarIds: string[];
}

/**
 * Match a customer photo against the catalog with Gemini vision.
 * The customer photo + up to 6 product photos go in as image parts;
 * the model returns JSON naming the matching catalog id (or null).
 * A match is only trusted when the model names an id that IS in the
 * catalog — an unknown id is treated as "no match", never invented.
 */
export async function analyseCustomerImage(
  imageUrl: string,
  products: MatchCatalogProduct[],
): Promise<ImageMatchOutcome | null> {
  const customer = await downloadMedia(imageUrl);
  if (!customer || !customer.mimeType.startsWith('image/')) {
    console.error('[media] customer photo download failed or not an image');
    return null;
  }
  const catalog = products.slice(0, 20);
  // Exact-match shortcut: the customer sent the shop's OWN product photo
  // (e.g. forwarded from the shop's Facebook post) — the URL is identical
  // to a catalog image, so it IS that product. No vision call needed.
  const exact = catalog.find((p) => p.imageUrl && p.imageUrl === imageUrl);
  if (exact) {
    return {
      matchedId: exact.id,
      confidence: 1,
      description: `ছবিটি দোকানের "${exact.name}" প্রোডাক্টের নিজের ছবি।`,
      similarIds: [],
    };
  }
  const catalogText = catalog
    .map(
      (p, i) =>
        `${i + 1}. id=${p.id} name="${p.name}" price=৳${p.pricePaisa / 100} stock=${p.stock}${p.description ? ` desc="${p.description}"` : ''}`,
    )
    .join('\n');
  // Interleave a TEXT label before each image part — the model then knows
  // exactly which catalog product each photo belongs to (a bare positional
  // "in the same order" mapping was unreliable: the Jeans photo — olive
  // trousers worn by a person — came back unmatched). The product may be
  // worn by a person in the photo; match the garment, not the person.
  const parts: GeminiPart[] = [
    {
      text:
        'তুমি একটি দোকানের প্রোডাক্ট মেলানোর কাজ করছো। নিচে প্রথমে কাস্টমারের ছবি, তারপর দোকানের প্রোডাক্টের ছবি — প্রতিটার আগে কোন প্রোডাক্ট সেটা লেখা আছে। প্রোডাক্টটি কোনো মানুষের পরনে থাকতে পারে — মানুষটিকে নয়, পোশাকটি/জিনিসটি মেলাও। ছবিতে একাধিক প্রোডাক্ট দেখা গেলে, যেটা ছবির মূল বিষয় (সবচেয়ে বড় / মাঝখানে / ছবিটা যার জন্য তোলা) সেটাকে matchedId দাও, বাকিগুলো similarIds-এ দাও।\n' +
        `দোকানের প্রোডাক্ট তালিকা:\n${catalogText}\n\n` +
        'কাস্টমারের ছবিতে কোন প্রোডাক্টটি দেখা যাচ্ছে? শুধু JSON-এ উত্তর দাও: {"matchedId": "<তালিকার id অথবা null>", "confidence": 0.0-1.0, "description": "<ছবিতে কী দেখা যাচ্ছে, বাংলায়>", "similarIds": ["<মিলে এমন প্রোডাক্টের id, সর্বোচ্চ 3টি>"]}\n' +
        'নিয়ম: matchedId শুধু তখনই দাও যখন নিশ্চিত যে ছবির জিনিসটি তালিকার ওই প্রোডাক্টটিই (একই জিনিস, শুধু একই ধরন নয়)। ছবিতে তালিকার বাইরের জিনিস থাকলে matchedId=null দাও, আর সবচেয়ে কাছের প্রোডাক্টগুলো similarIds-এ দাও। ছবিতে কোনো প্রোডাক্টই না থাকলে (মানুষ, প্রকৃতি, এলোমেলো ছবি) matchedId=null, similarIds=[] দাও। তালিকায় নেই এমন কোনো id বানিয়ে দিও না।',
    },
    { text: 'কাস্টমারের ছবি:' },
    { inlineData: { mimeType: customer.mimeType, data: customer.buffer.toString('base64') } },
  ];
  const imageProducts = catalog.filter((p) => p.imageUrl);
  for (const p of imageProducts.slice(0, 6)) {
    const img = await downloadMedia(p.imageUrl as string);
    if (img && img.mimeType.startsWith('image/')) {
      parts.push({ text: `প্রোডাক্ট (id=${p.id}): ${p.name} — দাম ৳${p.pricePaisa / 100}` });
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.buffer.toString('base64') } });
    }
  }
  try {
    const result = await callGeminiMultimodal(parts, { json: true });
    if (!result || !result.text.trim()) return null;
    const parsed = JSON.parse(result.text) as Partial<ImageMatchOutcome>;
    const matchedId =
      typeof parsed.matchedId === 'string' && catalog.some((p) => p.id === parsed.matchedId)
        ? parsed.matchedId
        : null;
    const similarIds = Array.isArray(parsed.similarIds)
      ? (parsed.similarIds as unknown[]).filter((id): id is string => typeof id === 'string' && catalog.some((p) => p.id === id)).slice(0, 3)
      : [];
    return {
      matchedId,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      description: typeof parsed.description === 'string' ? parsed.description : '',
      similarIds,
    };
  } catch (err) {
    console.error('[media] vision match failed:', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Voice → text (Gemini audio input)
// ---------------------------------------------------------------------------

/**
 * Transcribe a voice note to text with Gemini. Small files go inline;
 * larger ones go through the Gemini File API. Returns the transcript
 * (Bengali / Banglish as spoken), or null when the audio cannot be
 * fetched or transcribed — the caller must then reply honestly.
 */
export async function transcribeCustomerAudio(audioUrl: string): Promise<string | null> {
  const audio = await downloadMedia(audioUrl);
  if (!audio || !audio.mimeType.startsWith('audio/')) {
    // Meta voice notes sometimes arrive as audio/mp4 or video/mp4 (AAC
    // in an MP4 container) — Gemini accepts those as audio, so retry
    // with the audio mime when the server reported a video/mp4 type.
    if (audio && audio.mimeType.startsWith('video/')) {
      return transcribeAudioBytes(audio.buffer, 'audio/aac');
    }
    console.error('[media] voice note download failed or not audio');
    return null;
  }
  return transcribeAudioBytes(audio.buffer, audio.mimeType);
}

async function transcribeAudioBytes(bytes: Buffer, mimeType: string): Promise<string | null> {
  const prompt =
    'এই ভয়েস মেসেজটি শুনে লেখায় রূপান্তর করো। কথা বাংলা বা বাংলিশ (Roman অক্ষরে বাংলা) হতে পারে — যেভাবে বলা হয়েছে সেভাবেই লেখো। শুধু JSON-এ উত্তর দাও: {"transcript": "<যা বলা হয়েছে>", "language": "bn"|"en"|"unknown"}। কোনো বোধগম্য কথা না থাকলে transcript খালি ("") রাখো। বানিয়ে কিছু লিখো না।';
  try {
    let result: { text: string } | null;
    if (bytes.length <= INLINE_LIMIT_BYTES) {
      result = await callGeminiMultimodal(
        [{ text: prompt }, { inlineData: { mimeType, data: bytes.toString('base64') } }],
        { json: true, timeoutMs: 60000 },
      );
    } else {
      const file = await uploadGeminiFile(bytes, mimeType, 'voice-note');
      result = await callGeminiMultimodal(
        [{ text: prompt }, { fileData: { mimeType: file.mimeType, fileUri: file.uri } }],
        { json: true, timeoutMs: 60000 },
      );
    }
    if (!result || !result.text.trim()) return null;
    const parsed = JSON.parse(result.text) as { transcript?: unknown };
    const transcript = typeof parsed.transcript === 'string' ? parsed.transcript.trim() : '';
    return transcript ? transcript : null;
  } catch (err) {
    console.error('[media] voice transcription failed:', (err as Error).message);
    return null;
  }
}
