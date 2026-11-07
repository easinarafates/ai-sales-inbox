import fs from 'node:fs';
import path from 'node:path';
import { callGeminiMultimodal, uploadGeminiFile } from '../ai-agent/gemini';
import { fetchWithTimeout } from '../ai-agent/http';

/**
 * Media-aware caption: fetch the post's attached image/video and ask
 * Gemini (multimodal) what is actually in it, then write a caption
 * from that analysis — never a generic caption from the typed topic.
 *
 * - Images / videos up to ~18 MB go inline (base64) in one request.
 * - Bigger files go through the Gemini File API (Vercel has no ffmpeg,
 *   so frame extraction is not an option there).
 * - Media over 25 MB (the upload cap) is rejected, never downscaled
 *   silently.
 * Every failure throws with a plain message; the auto-caption endpoint
 * catches it and falls back to the text-only (Groq/template) captions
 * honestly — an analysis is never faked.
 */

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // same as the upload cap
const INLINE_LIMIT_BYTES = 18 * 1024 * 1024; // Gemini inline cap is ~20 MB/request

export interface MediaAnalysis {
  analysis: string;
  caption: string;
  mediaType: 'image' | 'video';
  source: 'gemini-vision';
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  for (const [mime, e] of Object.entries(MIME_EXT)) if (e === ext) return mime;
  return '';
}

/** Fetch media bytes for a URL the post already has (Blob URL, any http(s) URL, or a local /api/uploads/<file> path). */
export async function fetchMediaBytes(url: string): Promise<{ bytes: Buffer; mime: string }> {
  const trimmed = url.trim();
  if (trimmed.startsWith('/api/uploads/')) {
    // Local disk upload — read the file directly (never trust the path
    // beyond its basename: no directory traversal).
    const fileName = path.basename(trimmed);
    const full = path.join(path.resolve(process.cwd(), 'uploads'), fileName);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(full);
    } catch {
      throw new Error('আপলোড করা ফাইলটি সার্ভারে পাওয়া যায়নি');
    }
    if (bytes.length === 0) throw new Error('মিডিয়া ফাইলটি খালি');
    if (bytes.length > MAX_MEDIA_BYTES) throw new Error('মিডিয়া ফাইলটি 25 MB-এর বেশি');
    return { bytes, mime: mimeFromPath(fileName) || 'image/jpeg' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('মিডিয়ার লিংকটি সঠিক নয়');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('মিডিয়ার লিংকটি http(s) হতে হবে');
  }
  const res = await fetchWithTimeout(parsed.toString(), { method: 'GET' }, 30000);
  if (!res.ok) throw new Error(`মিডিয়া ডাউনলোড করা যায়নি (HTTP ${res.status})`);
  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('মিডিয়া ফাইলটি খালি');
  if (buf.length > MAX_MEDIA_BYTES) throw new Error('মিডিয়া ফাইলটি 25 MB-এর বেশি');
  return { bytes: buf, mime: mime || mimeFromPath(parsed.pathname) || 'image/jpeg' };
}

/**
 * Analyze one attached media item with Gemini vision and return the
 * analysis + a caption written from what is actually in it.
 * `productContext` (optional) is the shop's real product name/price/stock
 * text — the caption may use ONLY those values, never invent a price.
 * Throws on any failure (no key, fetch failure, Gemini error, empty
 * reply) — the caller falls back to text-only captions.
 */
export async function analyzePostMedia(opts: {
  mediaUrl: string;
  lang: 'en' | 'bn';
  productContext?: string;
}): Promise<MediaAnalysis> {
  const { bytes, mime } = await fetchMediaBytes(opts.mediaUrl);
  if (!/^(image|video)\//.test(mime)) {
    throw new Error(`এই ফরম্যাট বিশ্লেষণ করা যায় না: ${mime || 'অজানা'}`);
  }
  const mediaType: 'image' | 'video' = mime.startsWith('video/') ? 'video' : 'image';
  const english = opts.lang === 'en';
  const mediaWord = english ? (mediaType === 'video' ? 'video' : 'image') : mediaType === 'video' ? 'ভিডিও' : 'ছবি';
  const contextLine = opts.productContext
    ? english
      ? `Real product info (use ONLY these values — never invent a price or stock): ${opts.productContext}`
      : `আসল প্রোডাক্টের তথ্য (শুধু এই তথ্যই ব্যবহার করো — দাম বা স্টক বানিয়ে লিখো না): ${opts.productContext}`
    : english
      ? 'No specific product is linked — do not invent any price or stock.'
      : 'কোনো নির্দিষ্ট প্রোডাক্ট যুক্ত নেই — দাম বা স্টক বানিয়ে লিখো না।';
  const prompt = english
    ? `Look carefully at this ${mediaWord} and answer in JSON only: {"analysis": "...", "caption": "..."}.
"analysis": 1-2 sentences in English describing exactly what is visible — objects, colours, people, setting, and any text visible in the media. Only what you can actually see.
"caption": a Facebook/Instagram post caption in English (2-3 lines, with 3-5 hashtags at the end) written from what is in the ${mediaWord} — mention the main thing shown. ${contextLine} If product info is given, include its real price in the caption.`
    : `এই ${mediaWord}টি ভালো করে দেখে শুধু JSON-এ উত্তর দাও: {"analysis": "...", "caption": "..."}।
"analysis": বাংলায় ১-২ বাক্যে লেখো — ছবি/ভিডিওতে আসলে কী দেখা যাচ্ছে (জিনিস, রং, মানুষ, পরিবেশ, ভেতরে কোনো লেখা থাকলে সেটাও)। যা সত্যিই দেখা যাচ্ছে শুধু সেটাই লিখবে।
"caption": ${mediaWord}তে যা আছে সেটা নিয়ে বাংলায় ফেসবুক/ইনস্টাগ্রাম পোস্টের ক্যাপশন লেখো (২-৩ লাইন, শেষে ৩-৫টি হ্যাশট্যাগ) — মূল জিনিসটির নাম লেখো। ${contextLine} প্রোডাক্টের তথ্য দেওয়া থাকলে ক্যাপশনে তার আসল দাম লিখবে।`;
  let result;
  if (bytes.length <= INLINE_LIMIT_BYTES) {
    result = await callGeminiMultimodal(
      [
        { inlineData: { mimeType: mime, data: bytes.toString('base64') } },
        { text: prompt },
      ],
      { json: true, timeoutMs: 60000 },
    );
  } else {
    // Too big for an inline request — upload via the Gemini File API.
    const uploaded = await uploadGeminiFile(bytes, mime, `post-media-${Date.now()}`);
    result = await callGeminiMultimodal(
      [
        { fileData: { mimeType: uploaded.mimeType, fileUri: uploaded.uri } },
        { text: prompt },
      ],
      { json: true, timeoutMs: 60000 },
    );
  }
  if (!result || !result.text.trim()) {
    throw new Error('Gemini ছবি/ভিডিও বিশ্লেষণ করে উত্তর দেয়নি');
  }
  let parsed: { analysis?: string; caption?: string } | null = null;
  try {
    const cleaned = result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    parsed = JSON.parse(cleaned) as { analysis?: string; caption?: string };
  } catch {
    // Not JSON — use the raw text as the caption and derive a short
    // analysis from its first line. Still real AI output, not a fake.
    parsed = null;
  }
  const caption = (parsed?.caption ?? '').trim() || result.text.trim();
  const analysis =
    (parsed?.analysis ?? '').trim() || caption.split('\n').filter(Boolean)[0]?.trim() || caption;
  if (!caption) throw new Error('Gemini ছবি/ভিডিও বিশ্লেষণ করে ক্যাপশন দিতে পারেনি');
  return { analysis, caption, mediaType, source: 'gemini-vision' };
}
