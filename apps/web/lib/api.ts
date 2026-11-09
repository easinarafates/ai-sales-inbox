// API client for the AI Sales Inbox backend (Phase 1 contract).
// Base URL from NEXT_PUBLIC_API_URL, default http://localhost:4000.
// All prices in the API are in paisa; display helpers convert to Taka (৳).

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

export function setToken(token: string) {
  localStorage.setItem("token", token);
}

export function clearToken() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  localStorage.removeItem("workspace");
}

/** Paisa -> Taka display, e.g. 1250 -> "৳12.50" */
export function formatTaka(paisa: number | null | undefined): string {
  if (paisa == null || Number.isNaN(paisa)) return "৳0";
  return `৳${(paisa / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  // Bangladesh time (UTC+6)
  return d.toLocaleString("bn-BD", { timeZone: "Asia/Dhaka" });
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    throw new ApiError(
      0,
      "সার্ভারের সাথে সংযোগ করা যাচ্ছে না। API (http://localhost:4000) চালু আছে কি না দেখুন।"
    );
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg =
      (data as { message?: string; error?: string } | null)?.message ||
      (data as { message?: string; error?: string } | null)?.error ||
      `অনুরোধ ব্যর্থ হয়েছে (HTTP ${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  del: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ---------- Types (tolerant: backend may return extra / differently-cased fields) ----------

export interface User {
  id: string;
  name?: string;
  email: string;
  role?: string;
  /** Profile photo URL (users.avatar_url) — null means "no photo yet". */
  avatarUrl?: string | null;
}

/** Current plan / trial for the workspace (GET /api/auth/me). */
export interface SubscriptionInfo {
  planName?: string | null;
  planSlug?: string | null;
  status?: string | null;
  periodEnd?: string | null;
}

export interface Workspace {
  id: string;
  name?: string;
  isLive?: boolean;
  is_live?: boolean;
  [key: string]: unknown;
}

export interface AuthResponse {
  token: string;
  user: User;
  workspace: Workspace;
}

export interface Customer {
  id: string;
  name?: string;
  phone?: string;
  address?: string;
  /** Gender for AI addressing: 'male' → "স্যার", 'female' → "ম্যাডাম", 'unknown' → neutral "আপনি". Inferred from the name; set by hand in the Inbox. */
  gender?: string;
  /** True once the owner corrected the name by hand — the Meta refresh never overwrites it. */
  name_manually_set?: boolean;
  /** Profile photo URL fetched from Meta (Messenger/Instagram) on first sight. */
  picture_url?: string;
  pictureUrl?: string;
  /** Where the photo came from: 'meta' (Graph) or 'manual' (owner upload from the Inbox). */
  picture_source?: string;
  pictureSource?: string;
  /** List endpoint only: total spent (real order totals, cancelled/returned excluded) + order count. */
  total_spent_paisa?: number | string | null;
  totalSpentPaisa?: number | string | null;
  order_count?: number | null;
  orderCount?: number | null;
  facebookId?: string;
  facebook_id?: string;
  [key: string]: unknown;
}

export interface Message {
  id: string;
  conversationId?: string;
  conversation_id?: string;
  direction?: string; // backend: 'in' (customer) | 'out' (shop / AI)
  sender?: string;
  senderType?: string;
  sender_type?: string;
  role?: string;
  body?: string;
  text?: string;
  content?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface Conversation {
  id: string;
  customerId?: string;
  customer_id?: string;
  customer?: Customer;
  customerName?: string;
  customer_name?: string;
  customer_picture_url?: string;
  customerPictureUrl?: string;
  channel?: string;
  channelType?: string;
  channel_type?: string;
  status?: string;
  escalation_reason?: string | null;
  escalated_at?: string | null;
  mode?: string; // backend: 'ai' | 'human'
  aiMode?: boolean;
  ai_mode?: boolean;
  isAiHandled?: boolean;
  lastMessage?: string;
  last_message?: string;
  lastMessageAt?: string;
  last_message_at?: string;
  updatedAt?: string;
  updated_at?: string;
  createdAt?: string;
  created_at?: string;
  assigneeId?: string;
  assignee_id?: string;
  [key: string]: unknown;
}

export interface ConversationDetail {
  conversation: Conversation;
  customer?: Customer | null;
  messages: Message[];
  openOrders?: Order[];
  /** True when this customer is the workspace's marked owner (dot commands work for them). */
  ownerMarked?: boolean;
  [key: string]: unknown;
}

export interface ProductImage {
  id: string;
  url: string;
  created_at?: string;
}

export interface Product {
  id: string;
  name: string;
  pricePaisa?: number;
  price_paisa?: number;
  price?: number;
  size?: string;
  stock?: number;
  description?: string;
  imageUrl?: string;
  image_url?: string;
  /** Photos uploaded for this product (multiple allowed). */
  images?: ProductImage[];
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export function productPricePaisa(p: Product): number {
  return p.pricePaisa ?? p.price_paisa ?? p.price ?? 0;
}

export interface OrderItem {
  id?: string;
  productId?: string;
  product_id?: string;
  productName?: string;
  product_name?: string;
  name?: string;
  quantity?: number;
  qty?: number;
  pricePaisa?: number;
  price_paisa?: number;
  price?: number;
  [key: string]: unknown;
}

export type OrderStatus =
  | "pending"
  | "on_hold"
  | "approved"
  | "processing"
  | "ready"
  | "ready_to_ship"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "returned"
  | "damaged"
  | "in_store";

export interface Order {
  id: string;
  orderNumber?: string;
  order_number?: string;
  customerId?: string;
  customer_id?: string;
  customer?: Customer;
  /** Delivery snapshot taken when the order was created (migration 24) — what the customer gave at order time. Null for older orders. */
  customerName?: string;
  customer_name?: string;
  customerPhone?: string;
  customer_phone?: string;
  deliveryAddress?: string;
  delivery_address?: string;
  /** Where the order came from: 'ai' (AI chat), 'team' (created by the team), or a channel platform. */
  source?: string;
  conversationId?: string;
  conversation_id?: string;
  status?: string;
  paymentStatus?: string;
  payment_status?: string;
  /** cod | advance | fifty_fifty (default cod). */
  paymentMethod?: string;
  payment_method?: string;
  totalPaisa?: number;
  total_paisa?: number;
  total?: number;
  /** Delivery charge resolved from the owner's rules, snapshotted at order time. */
  deliveryChargePaisa?: number;
  delivery_charge_paisa?: number;
  /** Grand total the customer pays (products + delivery charge). */
  grandTotalPaisa?: number;
  grandTotal?: number;
  /** 'ai' (AI agent talked to the customer) or 'agent' (a human did). */
  handledBy?: string;
  handled_by?: string;
  invoiceToken?: string;
  invoice_token?: string;
  invoiceUrl?: string;
  receiptImageUrl?: string;
  receipt_image_url?: string;
  /** Delivery zone derived from the address: district + inside/outside Dhaka. */
  zone?: { district: string | null; insideDhaka: boolean; label: string };
  /** Estimated delivery window (Bengali date range — an estimate, no courier ETA). */
  deliveryEstimate?: string;
  items?: OrderItem[];
  orderItems?: OrderItem[];
  order_items?: OrderItem[];
  events?: unknown[];
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export function orderTotalPaisa(o: Order): number {
  // Money arrives from the API as a number, but a bigint column can come
  // back as a STRING (node-postgres returns int8 as string) — coerce, or
  // `total + delivery` below concatenates strings and shows ৳50,000,100
  // for a ৳600 order (bug, 2026-11-09). Number() of a number is a no-op.
  return Number(o.totalPaisa ?? o.total_paisa ?? o.total ?? 0);
}

/** Delivery charge snapshot on the order, always a number (same string trap). */
export function deliveryChargePaisa(o: Order): number {
  return Number(o.deliveryChargePaisa ?? o.delivery_charge_paisa ?? 0);
}

export function orderItemsOf(o: Order): OrderItem[] {
  return o.items ?? o.orderItems ?? o.order_items ?? [];
}

export interface WalletTransaction {
  id: string;
  type?: string;
  amountPaisa?: number;
  amount_paisa?: number;
  amount?: number;
  description?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface UsageLedgerEntry {
  id: string;
  conversationId?: string;
  conversation_id?: string;
  costPaisa?: number;
  cost_paisa?: number;
  cost?: number;
  tokens?: number;
  inputTokens?: number;
  input_tokens?: number;
  outputTokens?: number;
  output_tokens?: number;
  model?: string;
  provider?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface Billing {
  balancePaisa?: number;
  balance_paisa?: number;
  balance?: number;
  transactions?: WalletTransaction[];
  walletTransactions?: WalletTransaction[];
  usageLedger?: UsageLedgerEntry[];
  usage_ledger?: UsageLedgerEntry[];
  usage?: UsageLedgerEntry[]; // backend returns `usage`
  [key: string]: unknown;
}

export function billingBalance(b: Billing): number {
  return b.balancePaisa ?? b.balance_paisa ?? b.balance ?? 0;
}

export function billingTransactions(b: Billing): WalletTransaction[] {
  return b.transactions ?? b.walletTransactions ?? [];
}

export function billingUsage(b: Billing): UsageLedgerEntry[] {
  return b.usageLedger ?? b.usage_ledger ?? b.usage ?? [];
}

export interface Channel {
  id: string;
  type?: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}

// ---------- Typed helpers for every Phase 1 endpoint ----------

export const authApi = {
  signup: (body: { name: string; email: string; password: string; workspaceName: string }) =>
    api.post<AuthResponse>("/api/auth/signup", body),
  // Backend login returns { token, user, workspaceId } (no workspace object);
  // normalise so pages can store a workspace like signup does.
  login: async (body: { email: string; password: string }) => {
    const res = await api.post<{ token: string; user: User; workspace?: Workspace; workspaceId?: string }>(
      "/api/auth/login",
      body
    );
    return {
      ...res,
      workspace: res.workspace ?? (res.workspaceId ? { id: res.workspaceId } : undefined),
    } as AuthResponse;
  },
  /** Ask for a password-reset link (always the same generic reply). mailerConfigured says only whether this platform has an SMTP mailer set up — never whether the email has an account. */
  forgotPassword: (body: { email: string }) =>
    api.post<{ message: string; mailerConfigured?: boolean }>("/api/auth/forgot-password", body),
  /** Finish a reset with the token from the emailed link. */
  resetPassword: (body: { token: string; password: string }) =>
    api.post<{ message: string }>("/api/auth/reset-password", body),
  me: () => api.get<{ user: User; workspace: Workspace; subscription: SubscriptionInfo | null }>("/api/auth/me"),
};

/** Header Profile menu — the logged-in user's photo (users.avatar_url). */
export const profileApi = {
  /** Set the profile photo. Same Blob pattern as product photos. */
  uploadPhoto: async (file: File) => {
    let blobUrl: string | null = null;
    try {
      const { upload } = await import("@vercel/blob/client");
      const token = getToken();
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: `${API_URL}/api/profile/upload-token`,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      blobUrl = blob.url;
    } catch {
      // Blob unavailable (no Blob token locally) — fall through to base64.
    }
    if (blobUrl) {
      const data = await api.post<{ user: User }>("/api/profile/photo", { url: blobUrl });
      return data.user;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Could not read the file."));
      reader.readAsDataURL(file);
    });
    const data = await api.post<{ user: User }>("/api/profile/photo", {
      fileBase64: dataUrl,
      fileName: file.name,
      mimeType: file.type,
    });
    return data.user;
  },
  /** Remove the profile photo (back to the initials avatar). */
  removePhoto: async () => {
    const data = await api.del<{ user: User }>("/api/profile/photo");
    return data.user;
  },
};

export const inboxApi = {
  list: (params?: { q?: string; status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.status) qs.set("status", params.status);
    const s = qs.toString();
    return api.get<Conversation[] | { conversations: Conversation[] }>(
      `/api/inbox${s ? `?${s}` : ""}`
    );
  },
  get: (id: string) => api.get<ConversationDetail>(`/api/inbox/${id}`),
  reply: (id: string, body: string) =>
    api.post<{ message: Message } | Message>(`/api/inbox/${id}/reply`, { body }),
  assign: (id: string, userId: string) =>
    api.post<Conversation>(`/api/inbox/${id}/assign`, { userId }),
  done: (id: string) => api.post<Conversation>(`/api/inbox/${id}/done`),
  /** Move a 'waiting' conversation back to Open. Mode stays 'human' — the owner handles it; he turns the AI back on with the thread switch. */
  reopen: (id: string) => api.post<Conversation>(`/api/inbox/${id}/reopen`),
  dot: (id: string) => api.post<Conversation>(`/api/inbox/${id}/dot`),
  setMode: (id: string, mode: "ai" | "human") =>
    api.post<Conversation>(`/api/inbox/${id}/mode`, { mode }),
  markOwner: (id: string) => api.post<{ ownerMarked: boolean }>(`/api/inbox/${id}/mark-owner`),
};

/**
 * Per-chat / per-customer AI usage — real sums from ai_usage_ledger
 * (GET /api/inbox/usage). Cost is provider_cost_paisa only, the same
 * basis as the Owner Panel. A chat with no AI replies has no row —
 * callers show 0 tokens / ৳0.00 for it, never an invented number.
 */
export interface ConversationUsage {
  conversationId: string;
  customerId: string | null;
  customerName: string | null;
  replies: number;
  inputTokens: number;
  outputTokens: number;
  /** SUM(provider_cost_paisa) — what the AI providers really charged. */
  costPaisa: number;
}

export interface CustomerUsage {
  customerId: string;
  customerName: string | null;
  replies: number;
  inputTokens: number;
  outputTokens: number;
  /** SUM(provider_cost_paisa) — what the AI providers really charged. */
  costPaisa: number;
  conversationCount: number;
}

export interface UsageSummary {
  byConversation: ConversationUsage[];
  byCustomer: CustomerUsage[];
  totals: { replies: number; inputTokens: number; outputTokens: number; costPaisa: number };
}

export const usageApi = {
  list: (params?: { conversationId?: string; customerId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.conversationId) qs.set("conversationId", params.conversationId);
    if (params?.customerId) qs.set("customerId", params.customerId);
    const s = qs.toString();
    return api.get<UsageSummary>(`/api/inbox/usage${s ? `?${s}` : ""}`);
  },
};

export const productsApi = {
  list: () => api.get<Product[] | { products: Product[] }>("/api/products"),
  create: (body: { name: string; pricePaisa: number; size?: string; stock?: number; description?: string }) =>
    api.post<Product>("/api/products", body),
  /** Update name / price / size / stock / description (only sent fields change). */
  update: (id: string, body: { name?: string; pricePaisa?: number; size?: string | null; stock?: number; description?: string | null }) =>
    api.patch<{ product: Product } | Product>(`/api/products/${id}`, body),
  /** Delete the product and its photos. */
  delete: (id: string) => api.del<{ deleted: boolean }>(`/api/products/${id}`),
  // Backend returns { product } — unwrap so the detail page gets the product itself.
  get: async (id: string) => {
    const data = await api.get<Product | { product: Product }>(`/api/products/${id}`);
    return (data as { product?: Product }).product ?? (data as Product);
  },
  search: (q: string) =>
    api.get<Product[] | { products: Product[] }>(
      `/api/products/search?q=${encodeURIComponent(q)}`
    ),
  /** List a product's photos. */
  listImages: async (id: string) => {
    const data = await api.get<{ images: ProductImage[] }>(`/api/products/${id}/images`);
    return data.images ?? [];
  },
  /** Register one photo (an already-uploaded URL, or a base64 file). */
  addImage: async (
    id: string,
    body: { url: string } | { fileBase64: string; fileName?: string; mimeType?: string }
  ) => {
    const data = await api.post<{ image: ProductImage }>(`/api/products/${id}/images`, body);
    return data.image;
  },
  /** Remove one photo (DB row always; Blob object best-effort). */
  deleteImage: (id: string, imageId: string) =>
    api.del<{ deleted: { id: string } }>(`/api/products/${id}/images/${imageId}`),
  /**
   * Upload one photo file for a product. Preferred path: direct
   * browser→Vercel Blob upload (bypasses the API 4.5 MB body cap), then
   * register the Blob URL. If Blob is unavailable (local dev / no Blob
   * token), falls back to a base64 upload through the API. Returns the
   * created image row.
   */
  uploadImage: async (id: string, file: File) => {
    let blobUrl: string | null = null;
    try {
      const { upload } = await import("@vercel/blob/client");
      const token = getToken();
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: `${API_URL}/api/products/upload-token`,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      blobUrl = blob.url;
    } catch {
      // Blob unavailable (no Blob token locally) — fall through to base64.
    }
    if (blobUrl) return await productsApi.addImage(id, { url: blobUrl });
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Could not read the file."));
      reader.readAsDataURL(file);
    });
    return await productsApi.addImage(id, {
      fileBase64: dataUrl,
      fileName: file.name,
      mimeType: file.type,
    });
  },
};

export const ordersApi = {
  list: (status?: string) =>
    api.get<Order[] | { orders: Order[] }>(`/api/orders${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  create: (body: Record<string, unknown>) => api.post<Order>("/api/orders", body),
  // Backend returns { order, items, events } — merge into one Order object.
  get: async (id: string) => {
    const data = await api.get<Order | { order: Order; items?: OrderItem[]; events?: unknown[]; shipment?: unknown }>(
      `/api/orders/${id}`
    );
    if ((data as { order?: Order }).order) {
      const d = data as { order: Order; items?: OrderItem[]; events?: unknown[]; shipment?: unknown };
      return { ...d.order, items: d.items ?? d.order.items ?? [], events: d.events ?? [], shipment: d.shipment ?? null };
    }
    return data as Order;
  },
  // After a status/payment change, re-fetch the full order so the detail
  // page keeps its items and bill instead of a partial { id, status }.
  updateStatus: async (id: string, status: string) => {
    await api.patch(`/api/orders/${id}/status`, { status });
    return ordersApi.get(id);
  },
  updatePayment: async (id: string, paymentStatus: string) => {
    await api.patch(`/api/orders/${id}/payment`, { paymentStatus });
    return ordersApi.get(id);
  },
  updatePaymentMethod: async (id: string, paymentMethod: string) => {
    await api.patch(`/api/orders/${id}/payment-method`, { paymentMethod });
    return ordersApi.get(id);
  },
  /** Status counts for the tabs on top of the Orders page. */
  counts: () => api.get<{ counts: Record<string, number>; total: number }>("/api/orders/counts"),
  /** Today's report (Asia/Dhaka day) + courier view. */
  report: () => api.get<{
    date: string;
    today: { orders: number; delivered: number; cancelled: number; returned: number; damaged: number; valuePaisa: number };
    courier: { inTransitOrders: number; shipmentsByStatus: Record<string, number> };
  }>("/api/orders/report"),
  /** Customer list inside Orders — amounts are NOT in this response. */
  customers: () => api.get<{ customers: OrderCustomer[] }>("/api/orders/customers"),
  /** Click-to-reveal: the customer's stats + total amount + their orders. */
  customerDetail: (customerId: string) =>
    api.get<{
      customer: { id: string; name: string | null; phone: string | null; picture_url: string | null };
      stats: { orders: number; cancelled: number; returned: number; delivered: number; totalPaisa: number; lastOrderAt: string | null };
      orders: Order[];
    }>(`/api/orders/customers/${customerId}`),
  /** Scan box: order number (ASI-0001), tracking number or invoice token. */
  lookup: (q: string) => api.get<{ order: Order; items?: OrderItem[]; events?: unknown[]; shipment?: unknown }>(`/api/orders/lookup?q=${encodeURIComponent(q)}`),
  /** "Send to Courier": book the order with a chosen courier. */
  sendToCourier: (id: string, courier: string) =>
    api.post<{ shipment: Shipment; provider: string; providerConfigured: boolean; alreadyBooked: boolean; message: string; order: Order }>(
      `/api/orders/${id}/send-to-courier`, { courier }
    ),
  /** (Re)send the receipt (confirmation + invoice link) to the customer. */
  sendReceipt: (id: string) =>
    api.post<{ sent: boolean; delivery?: string; error?: string | null; invoiceUrl: string | null; orderNumber: string | null }>(
      `/api/orders/${id}/receipt`, {}
    ),
  /** Cancel requests: the owner's queue (pending first). */
  cancelRequests: (status?: string) =>
    api.get<{ requests: CancelRequest[]; pendingCount: number }>(
      `/api/orders/cancel-requests${status ? `?status=${encodeURIComponent(status)}` : ""}`
    ),
  /** Approve a cancel request: the order becomes cancelled + the customer is told. */
  approveCancelRequest: (id: string) =>
    api.post<{ request: { id: string; status: string }; order: Order; sent: boolean; sendError: string | null }>(
      `/api/orders/cancel-requests/${id}/approve`, {}
    ),
  /** Decline a cancel request: the order stays as-is; the owner handles it manually. */
  declineCancelRequest: (id: string) =>
    api.post<{ request: { id: string; status: string } }>(
      `/api/orders/cancel-requests/${id}/decline`, {}
    ),
};

/** A customer's request to cancel an order (pending = waiting for the owner). */
export interface CancelRequest {
  id: string;
  order_id: string;
  customer_id: string | null;
  conversation_id: string | null;
  reason: string | null;
  status: "pending" | "approved" | "declined";
  decided_at: string | null;
  created_at: string;
  order_number: string | null;
  order_status: string | null;
  total_paisa: number | null;
  customer_name: string | null;
  customer_phone: string | null;
}

export interface OrderCustomer {
  id: string;
  name: string | null;
  phone: string | null;
  picture_url: string | null;
  orders: number;
  cancelled: number;
  returned: number;
  delivered: number;
  last_order_at: string | null;
}

export interface Shipment {
  id: string;
  orderId?: string;
  order_id?: string;
  courier: string | null;
  trackingCode?: string | null;
  tracking_code?: string | null;
  trackingNumber?: string | null;
  tracking_number?: string | null;
  providerBookingId?: string | null;
  provider_booking_id?: string | null;
  status: string | null;
  createdAt?: string;
  created_at?: string;
}

export interface CourierProviderOption {
  name: string;
  configured: boolean;
  needs: string;
  selected: boolean;
}

export const courierApi = {
  provider: () => api.get<{ provider: string; configured: boolean; providers: CourierProviderOption[] }>("/api/courier/provider"),
  shipments: () => api.get<{ shipments: Shipment[] }>("/api/courier/shipments"),
};

/** Public invoice — no login; the token is the auth. (No token is stored
 * on this page, so the request goes out without an Authorization header.) */
export const publicInvoiceApi = {
  get: (token: string) => api.get<PublicInvoice>(`/api/public/invoice/${encodeURIComponent(token)}`),
};

export interface PublicInvoice {
  orderNumber: string | null;
  shopName: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  paymentMethodLabel: string;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  zone: string;
  insideDhaka: boolean;
  items: { name: string; quantity: number; pricePaisa: number; lineTotalPaisa: number }[];
  totalPaisa: number;
  deliveryChargePaisa: number;
  grandTotalPaisa: number;
  grandTotalText: string;
  deliveryEstimate: string;
  createdAt: string;
}

export const billingApi = {
  get: () => api.get<Billing>("/api/billing"),
};

export const channelsApi = {
  list: () => api.get<Channel[] | { channels: Channel[] }>("/api/channels"),
  create: (body: Record<string, unknown>) => api.post<Channel>("/api/channels", body),
};

export const knowledgeApi = {
  list: () => api.get<unknown[]>("/api/knowledge"),
  create: (body: Record<string, unknown>) => api.post("/api/knowledge", body),
};

export const unansweredApi = {
  list: () => api.get<unknown[]>("/api/unanswered"),
};

export const workspacesApi = {
  goLive: (id: string) => api.post(`/api/workspaces/${id}/go-live`),
};

/** Normalise list responses that may be a bare array or { <key>: [...] } */
export function asArray<T>(data: T[] | { [key: string]: unknown } | null | undefined): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  const obj = data as { [key: string]: unknown };
  for (const key of ["conversations", "products", "orders", "tickets", "channels", "items", "data"]) {
    if (Array.isArray(obj[key])) return obj[key] as T[];
  }
  return [];
}

// ============================================================================
// Phase 2 + Phase 3 types & helpers (appended; Phase 1 code above untouched)
// ============================================================================

/** Normalise a list response using the caller's own key names. */
export function asArrayOf<T>(data: unknown, keys: string[]): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as T[];
  const obj = data as Record<string, unknown>;
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k] as T[];
  }
  return [];
}

export interface SalesChannel {
  id: string;
  platform?: string;
  externalId?: string;
  external_id?: string;
  displayName?: string;
  display_name?: string;
  status?: string;
  approvalRequired?: boolean;
  approval_required?: boolean;
  /** Facebook Page picture URL (OAuth-connected pages). */
  pictureUrl?: string;
  picture_url?: string;
  /** Approx. Page-token expiry (OAuth-connected pages). */
  tokenExpiresAt?: string;
  token_expires_at?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export function channelPlatform(c: SalesChannel): string {
  return c.platform || (typeof c.type === "string" ? c.type : "") || "—";
}

export function channelDisplayName(c: SalesChannel): string {
  return c.displayName || c.display_name || (typeof c.name === "string" ? c.name : "") || c.externalId || c.external_id || "—";
}

export function channelNeedsApproval(c: SalesChannel): boolean {
  return (
    c.approvalRequired === true ||
    c.approval_required === true ||
    c.status === "pending_approval"
  );
}

/** One Facebook Page offered by the login picker (no tokens — see API). */
export interface FacebookPage {
  id: string;
  name: string;
  category?: string;
  picture?: string;
}

/** One Facebook Page offered by the Instagram picker, with its linked Instagram account (null = none linked). */
export interface InstagramPage {
  id: string;
  name: string;
  category?: string;
  picture?: string;
  instagram?: { id: string; username: string; picture?: string } | null;
}

/** One WhatsApp Business phone number offered by the WhatsApp picker. */
export interface WhatsappNumber {
  id: string;
  displayNumber?: string;
  display_phone_number?: string;
  verifiedName?: string;
  verified_name?: string;
}

export function whatsappNumberLabel(n: WhatsappNumber): string {
  return n.displayNumber || n.display_phone_number || n.id;
}

/** One WhatsApp Business account with its phone numbers (no tokens — see API). */
export interface WhatsappAccount {
  id: string;
  name: string;
  phoneNumbers?: WhatsappNumber[];
  phone_numbers?: WhatsappNumber[];
}

export function whatsappNumbersOf(w: WhatsappAccount): WhatsappNumber[] {
  return w.phoneNumbers ?? w.phone_numbers ?? [];
}

export const salesChannelsApi = {
  list: () =>
    api.get<SalesChannel[] | { channels: SalesChannel[] }>("/api/channels"),
  create: (body: { platform: string; externalId: string; displayName?: string; token?: string }) =>
    api.post<{ channel: SalesChannel } | SalesChannel>("/api/channels", body),
  /** "Login with Facebook" — returns the Meta dialog URL to redirect to.
   *  reauthenticate: force Facebook to ask for credentials again so the
   *  user can log in with a DIFFERENT Facebook account. */
  facebookLogin: (opts?: { reauthenticate?: boolean }) =>
    api.get<{ url: string }>(`/api/channels/facebook/login${opts?.reauthenticate ? "?reauthenticate=1" : ""}`),
  /** Pages to pick from, for a ?facebook=pick&session=... redirect. */
  facebookPages: (session: string) =>
    api.get<{ pages: FacebookPage[] }>(`/api/channels/facebook/pages?session=${encodeURIComponent(session)}`),
  /** Connect the Page the user picked. */
  facebookConnect: (body: { session: string; pageId: string }) =>
    api.post<{ channel: SalesChannel }>("/api/channels/facebook/connect", body),
  /** "Connect Instagram" — returns the Meta dialog URL to redirect to. */
  instagramLogin: (opts?: { reauthenticate?: boolean }) =>
    api.get<{ url: string }>(`/api/channels/instagram/login${opts?.reauthenticate ? "?reauthenticate=1" : ""}`),
  /** Pages (with linked Instagram account) to pick from, for a ?instagram=pick&session=... redirect. */
  instagramPages: (session: string) =>
    api.get<{ pages: InstagramPage[] }>(`/api/channels/instagram/pages?session=${encodeURIComponent(session)}`),
  /** Connect the Instagram account linked to the Page the user picked. */
  instagramConnect: (body: { session: string; pageId: string }) =>
    api.post<{ channel: SalesChannel }>("/api/channels/instagram/connect", body),
  /** "Connect WhatsApp" — returns the Meta dialog URL to redirect to. */
  whatsappLogin: (opts?: { reauthenticate?: boolean }) =>
    api.get<{ url: string }>(`/api/channels/whatsapp/login${opts?.reauthenticate ? "?reauthenticate=1" : ""}`),
  /** WhatsApp Business accounts + numbers to pick from, for a ?whatsapp=pick&session=... redirect. */
  whatsappAccounts: (session: string) =>
    api.get<{ wabas: WhatsappAccount[] }>(`/api/channels/whatsapp/accounts?session=${encodeURIComponent(session)}`),
  /** Connect the WhatsApp number the user picked. */
  whatsappConnect: (body: { session: string; wabaId: string; phoneNumberId: string }) =>
    api.post<{ channel: SalesChannel }>("/api/channels/whatsapp/connect", body),
  /** Manual WhatsApp Cloud API connect — verified phone-number ID + permanent token. */
  whatsappManualConnect: (body: { phoneNumberId: string; token: string; wabaId?: string }) =>
    api.post<{ channel: SalesChannel }>("/api/channels/whatsapp/manual", body),
  /** "Connect TikTok" — returns the TikTok authorize URL to redirect to. */
  tiktokLogin: () =>
    api.get<{ url: string }>("/api/channels/tiktok/login"),
  /** "Connect YouTube" — returns the Google authorize URL to redirect to. */
  youtubeLogin: () =>
    api.get<{ url: string }>("/api/channels/youtube/login"),
  /** Which connects are actually configured (booleans only, no secrets). */
  setupStatus: () =>
    api.get<{ metaConfigured: boolean; whatsappConfigIdConfigured: boolean; tiktokConfigured: boolean; youtubeConfigured: boolean }>("/api/channels/setup-status"),
};

export type CouponType = "percent" | "amount" | "free_delivery";

export interface Coupon {
  id: string;
  code: string;
  type?: CouponType | string;
  value?: number;
  expiresAt?: string;
  expires_at?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface CouponValidateResult {
  valid: boolean;
  discountPaisa?: number;
  discount_paisa?: number;
  freeDelivery?: boolean;
  free_delivery?: boolean;
  type?: string;
  value?: number;
  message?: string;
  [key: string]: unknown;
}

export function couponDiscountPaisa(r: CouponValidateResult): number {
  return r.discountPaisa ?? r.discount_paisa ?? 0;
}

export const couponsApi = {
  list: () => api.get<Coupon[] | { coupons: Coupon[] }>("/api/coupons"),
  create: (body: { code: string; type: CouponType; value: number; expiresAt?: string }) =>
    api.post<{ coupon: Coupon } | Coupon>("/api/coupons", body),
  update: (id: string, body: { type?: CouponType; value?: number; expiresAt?: string }) =>
    api.patch<{ coupon: Coupon } | Coupon>(`/api/coupons/${id}`, body),
  remove: (id: string) =>
    api.del<{ deleted: boolean }>(`/api/coupons/${id}`),
  validate: (code: string, subtotalPaisa: number) =>
    api.post<CouponValidateResult>("/api/coupons/validate", { code, subtotalPaisa }),
  applyToOrder: (orderId: string, code: string) =>
    api.post<{ order: Order; coupon?: Coupon }>(`/api/orders/${orderId}/apply-coupon`, { code }),
};

export const stockApi = {
  lowStock: (threshold = 5) =>
    api.get<Product[] | { products: Product[] }>(`/api/products/low-stock?threshold=${threshold}`),
  adjustStock: (id: string, delta: number, reason?: string) =>
    api.post<{ product: Product } | Product>(`/api/products/${id}/adjust-stock`, { delta, reason }),
};

export interface CustomerIdentity {
  id?: string;
  channel?: string;
  platform?: string;
  externalId?: string;
  external_id?: string;
  displayName?: string;
  display_name?: string;
  [key: string]: unknown;
}

export interface CustomerDetail {
  customer: Customer;
  identities?: CustomerIdentity[];
  conversations?: Conversation[];
  orders?: Order[];
  notes?: { id?: string; body?: string; text?: string; createdAt?: string; created_at?: string }[];
  /** Totals computed from the customer's REAL order rows (never invented):
   * totalSpentPaisa excludes cancelled/returned orders; grossTotalPaisa
   * sums every order. lastOrderAt is the newest order's date (ISO). */
  summary?: {
    orderCount: number;
    deliveredCount: number;
    cancelledCount: number;
    returnedCount: number;
    totalSpentPaisa: number;
    grossTotalPaisa: number;
    lastOrderAt: string | null;
  };
  /** What the customer ordered, aggregated across orders: product name +
   * total quantity + total amount + how many orders included it. */
  productsOrdered?: {
    productId: string | null;
    productName: string;
    quantity: number;
    amountPaisa: number;
    orderCount: number;
  }[];
  [key: string]: unknown;
}

export const customersApi = {
  list: (q?: string) => {
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    return api.get<Customer[] | { customers: Customer[] }>(`/api/customers${qs}`);
  },
  get: (id: string) => api.get<CustomerDetail>(`/api/customers/${id}`),
  /** Set the customer's gender (male/female/unknown) — drives the AI's স্যার/ম্যাডাম addressing. */
  updateGender: (id: string, gender: "male" | "female" | "unknown") =>
    api.patch<{ customer: Customer } | Customer>(`/api/customers/${id}`, { gender }),
  /** Correct the customer's display name by hand — stored exactly as typed, never overwritten by the Meta refresh. */
  updateName: (id: string, name: string) =>
    api.patch<{ customer: Customer } | Customer>(`/api/customers/${id}`, { name }),
  merge: (keepCustomerId: string, mergeCustomerId: string) =>
    api.post<{ customer: Customer } | Customer>("/api/customers/merge", { keepCustomerId, mergeCustomerId }),
};

export interface CarouselCard {
  productId?: string;
  product_id?: string;
  name?: string;
  pricePaisa?: number;
  price_paisa?: number;
  stock?: number;
  description?: string;
  [key: string]: unknown;
}

export const commentsApi = {
  carousel: (postId: string) =>
    api.get<{ postId: string; cards: CarouselCard[] }>(`/api/comments/${postId}/carousel`),
  reply: (commentId: string, text: string) =>
    api.post<{ comment?: unknown; conversationId?: string }>(`/api/comments/${commentId}/reply`, { text }),
  like: (commentId: string) =>
    api.post<{ liked: boolean; alreadyLiked?: boolean }>(`/api/comments/${commentId}/like`, {}),
};

export interface ScheduledPost {
  id: string;
  caption?: string;
  mediaUrls?: string[];
  media_urls?: string[];
  platforms?: string[];
  scheduledAt?: string;
  scheduled_at?: string;
  status?: string;
  platformPostId?: string;
  platform_post_id?: string;
  lastError?: string | null;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export const scheduledPostsApi = {
  list: (params?: { status?: string; platform?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.platform) qs.set("platform", params.platform);
    const s = qs.toString();
    return api.get<ScheduledPost[] | { posts: ScheduledPost[] }>(
      `/api/scheduled-posts${s ? `?${s}` : ""}`
    );
  },
  create: (body: { caption: string; mediaUrls?: string[]; platforms: string[]; scheduledAt?: string; productIds?: string[] }) =>
    api.post<{ post: ScheduledPost } | ScheduledPost>("/api/scheduled-posts", body),
  get: (id: string) =>
    api.get<{ post: ScheduledPost; products?: Product[] } | ScheduledPost>(`/api/scheduled-posts/${id}`),
  update: (id: string, body: { caption?: string; mediaUrls?: string[]; scheduledAt?: string; status?: string }) =>
    api.patch<{ post: ScheduledPost } | ScheduledPost>(`/api/scheduled-posts/${id}`, body),
  remove: (id: string) =>
    api.del<{ deleted: boolean }>(`/api/scheduled-posts/${id}`),
  schedule: (id: string, scheduledAt: string) =>
    api.post<{ post: ScheduledPost } | ScheduledPost>(`/api/scheduled-posts/${id}/schedule`, { scheduledAt }),
  publishNow: (id: string) =>
    api.post<{ post: ScheduledPost } | ScheduledPost>(`/api/scheduled-posts/${id}/publish-now`, {}),
  attachProduct: (id: string, productId: string) =>
    api.post<unknown>(`/api/scheduled-posts/${id}/attach-product`, { productId }),
  detachProduct: (id: string, productId: string) =>
    api.del<{ deleted: boolean }>(`/api/scheduled-posts/${id}/products/${productId}`),
  calendar: (month: string) =>
    api.get<{ days: Record<string, ScheduledPost[]> }>(`/api/scheduled-posts/calendar?month=${encodeURIComponent(month)}`),
  aiCaption: (id: string, productIds?: string[]) =>
    api.post<{ caption: string }>(`/api/scheduled-posts/${id}/ai-caption`, { productIds }),
};

export interface Lead {
  id: string;
  customerId?: string;
  customer_id?: string;
  customer?: Customer;
  need?: string;
  followUpAt?: string;
  follow_up_at?: string;
  callAt?: string;
  call_at?: string;
  outcome?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export const leadsApi = {
  list: () => api.get<Lead[] | { leads: Lead[] }>("/api/leads"),
  create: (body: { customerId: string; need?: string; followUpAt?: string; callAt?: string }) =>
    api.post<{ lead: Lead } | Lead>("/api/leads", body),
  update: (id: string, body: { need?: string; followUpAt?: string; callAt?: string; outcome?: string }) =>
    api.patch<{ lead: Lead } | Lead>(`/api/leads/${id}`, body),
};

export interface Followup {
  id: string;
  leadId?: string;
  lead_id?: string;
  customerId?: string;
  customer_id?: string;
  customer?: Customer;
  message?: string;
  sendAt?: string;
  send_at?: string;
  status?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export const followupsApi = {
  list: (status?: string) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    return api.get<Followup[] | { followups: Followup[] }>(`/api/followups${qs}`);
  },
  create: (body: { leadId?: string; customerId?: string; message: string; sendAt: string }) =>
    api.post<{ followup: Followup } | Followup>("/api/followups", body),
  update: (id: string, body: { message?: string; sendAt?: string; status?: string }) =>
    api.patch<{ followup: Followup } | Followup>(`/api/followups/${id}`, body),
  sendNow: (id: string) =>
    api.post<{ followup: Followup } | Followup>(`/api/followups/${id}/send-now`, {}),
  runDue: () => api.post<{ processed: number; sent: number; logged?: number }>("/api/followups/run", {}),
};

export interface AnalyticsOverview {
  range?: string;
  conversations?: number;
  orders?: number;
  aiHandledPct?: number;
  ai_handled_pct?: number;
  humanHandoverCount?: number;
  human_handover_count?: number;
  avgCostPaisa?: number;
  avg_cost_paisa?: number;
  orderSource?: { ai?: number; product_page?: number; team?: number; website?: number; other?: number };
  order_source?: { ai?: number; product_page?: number; team?: number; website?: number; other?: number };
  [key: string]: unknown;
}

export interface AnalyticsPost {
  postId?: string;
  post_id?: string;
  caption?: string;
  platforms?: string[];
  comments?: number;
  chats?: number;
  orders?: number;
  [key: string]: unknown;
}

export interface LostSaleReason {
  reason: string;
  count: number;
  [key: string]: unknown;
}

export interface PagePostSummary {
  id: string;
  message: string;
  createdTime: string | null;
  permalinkUrl: string | null;
  likes: number;
  comments: number;
  shares: number;
  engagement: number;
  commentsInInbox: number;
  unansweredInInbox: number;
}

export interface PagePostAnalysis {
  page: { id: string; name: string } | null;
  channelId: string | null;
  posts: PagePostSummary[];
  totals: { posts: number; likes: number; comments: number; shares: number; engagement: number };
  topPostId: string | null;
  topComments: { postId: string; author: string; text: string; createdTime: string | null }[];
  suggestions: { en: string; bn: string }[];
  fetchedAt: string;
  message?: string;
}

export const analyticsApi = {
  overview: (range: "today" | "yesterday" | "7d" | "30d") =>
    api.get<AnalyticsOverview>(`/api/analytics/overview?range=${range}`),
  posts: () => api.get<AnalyticsPost[] | { posts: AnalyticsPost[] }>("/api/analytics/posts"),
  lostSales: () =>
    api.get<{ reasons: LostSaleReason[]; total: number }>("/api/analytics/lost-sales"),
  // Real Facebook Page post analysis (Graph data, never invented).
  pagePosts: (channelId?: string) =>
    api.get<PagePostAnalysis>(`/api/analytics/page-posts${channelId ? `?channelId=${encodeURIComponent(channelId)}` : ""}`),
  // Like a Page post as the Page (needs pages_manage_engagement).
  likePagePost: (postId: string) =>
    api.post<{ liked: boolean; alreadyLiked?: boolean }>(
      `/api/analytics/page-posts/${encodeURIComponent(postId)}/like`,
      {}
    ),
};

export interface UnansweredQuestion {
  id: string;
  question: string;
  count?: number;
  taught?: boolean;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface KnowledgeItem {
  id: string;
  title?: string;
  body?: string;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export const teachApi = {
  unanswered: () =>
    api.get<UnansweredQuestion[] | { unanswered: UnansweredQuestion[] }>("/api/unanswered"),
  teach: (id: string, answer: string) =>
    api.post<{ knowledgeItem: KnowledgeItem } | KnowledgeItem>(`/api/unanswered/${id}/teach`, { answer }),
  knowledgeList: () =>
    api.get<KnowledgeItem[] | { knowledgeItems: KnowledgeItem[] }>("/api/knowledge"),
  knowledgeCreate: (body: { title?: string; body: string }) =>
    api.post<{ knowledgeItem: KnowledgeItem } | KnowledgeItem>("/api/knowledge", body),
  knowledgeUpdate: (id: string, body: { title?: string; body?: string }) =>
    api.patch<{ knowledgeItem: KnowledgeItem } | KnowledgeItem>(`/api/knowledge/${id}`, body),
  knowledgeDelete: (id: string) =>
    api.del<{ deleted: boolean }>(`/api/knowledge/${id}`),
  previewChange: (knowledgeId: string | undefined, instruction: string) =>
    api.post<{ preview: string; newBody?: string; aiGenerated?: boolean; note?: string }>(`/api/knowledge/preview-change`, { knowledgeId, instruction }),
  /** Earlier saved versions of one item (newest first) — for cross-session rollback. */
  listVersions: async (knowledgeId: string) => {
    const data = await api.get<{ versions: { id: string; body: string; createdAt?: string; created_at?: string }[] }>(`/api/knowledge/${knowledgeId}/versions`);
    return data.versions ?? [];
  },
  applyChange: (knowledgeId: string, newBody: string) =>
    api.post<{ knowledgeItem: KnowledgeItem; versionId?: string }>(`/api/knowledge/apply-change`, { knowledgeId, newBody }),
  rollback: (knowledgeId: string, versionId: string) =>
    api.post<{ knowledgeItem: KnowledgeItem }>(`/api/knowledge/${knowledgeId}/rollback`, { versionId }),
};


export interface ReviewItem {
  id: string;
  orderId?: string;
  order_id?: string;
  orderNumber?: string;
  order_number?: string;
  customer?: Customer;
  customerName?: string;
  customer_name?: string;
  status?: string;
  rating?: number;
  comment?: string;
  text?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export const reviewsApi = {
  list: () => api.get<ReviewItem[] | { reviews: ReviewItem[] }>("/api/reviews"),
  requestReview: (orderId: string) =>
    api.post<{ reviewRequest: ReviewItem } | ReviewItem>(`/api/orders/${orderId}/request-review`, {}),
};

