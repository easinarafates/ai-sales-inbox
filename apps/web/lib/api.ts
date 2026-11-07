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
  /** Profile photo URL fetched from Meta (Messenger/Instagram) on first sight. */
  picture_url?: string;
  pictureUrl?: string;
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
  [key: string]: unknown;
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
  | "ready_to_ship"
  | "in_transit"
  | "delivered";

export interface Order {
  id: string;
  orderNumber?: string;
  order_number?: string;
  customerId?: string;
  customer_id?: string;
  customer?: Customer;
  conversationId?: string;
  conversation_id?: string;
  status?: string;
  paymentStatus?: string;
  payment_status?: string;
  totalPaisa?: number;
  total_paisa?: number;
  total?: number;
  items?: OrderItem[];
  orderItems?: OrderItem[];
  order_items?: OrderItem[];
  events?: unknown[];
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export function orderTotalPaisa(o: Order): number {
  return o.totalPaisa ?? o.total_paisa ?? o.total ?? 0;
}

export function orderItemsOf(o: Order): OrderItem[] {
  return o.items ?? o.orderItems ?? o.order_items ?? [];
}

export interface Ticket {
  id: string;
  conversationId?: string;
  conversation_id?: string;
  reason?: string;
  status?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
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
  /** Ask for a password-reset link (always the same generic reply). */
  forgotPassword: (body: { email: string }) =>
    api.post<{ message: string }>("/api/auth/forgot-password", body),
  /** Finish a reset with the token from the emailed link. */
  resetPassword: (body: { token: string; password: string }) =>
    api.post<{ message: string }>("/api/auth/reset-password", body),
  me: () => api.get<{ user: User; workspace: Workspace }>("/api/auth/me"),
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
  dot: (id: string) => api.post<Conversation>(`/api/inbox/${id}/dot`),
};

export const productsApi = {
  list: () => api.get<Product[] | { products: Product[] }>("/api/products"),
  create: (body: { name: string; pricePaisa: number; size?: string; stock?: number; description?: string }) =>
    api.post<Product>("/api/products", body),
  // Backend returns { product } — unwrap so the detail page gets the product itself.
  get: async (id: string) => {
    const data = await api.get<Product | { product: Product }>(`/api/products/${id}`);
    return (data as { product?: Product }).product ?? (data as Product);
  },
  search: (q: string) =>
    api.get<Product[] | { products: Product[] }>(
      `/api/products/search?q=${encodeURIComponent(q)}`
    ),
};

export const ordersApi = {
  list: () => api.get<Order[] | { orders: Order[] }>("/api/orders"),
  create: (body: Record<string, unknown>) => api.post<Order>("/api/orders", body),
  // Backend returns { order, items, events } — merge into one Order object.
  get: async (id: string) => {
    const data = await api.get<Order | { order: Order; items?: OrderItem[]; events?: unknown[] }>(
      `/api/orders/${id}`
    );
    if ((data as { order?: Order }).order) {
      const d = data as { order: Order; items?: OrderItem[]; events?: unknown[] };
      return { ...d.order, items: d.items ?? d.order.items ?? [], events: d.events ?? [] };
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
};

export const ticketsApi = {
  list: () => api.get<Ticket[] | { tickets: Ticket[] }>("/api/tickets"),
  create: (body: { conversationId: string; reason: string }) =>
    api.post<Ticket>("/api/tickets", body),
  update: (id: string, body: { status: string }) =>
    api.patch<Ticket>(`/api/tickets/${id}`, body),
};

export const billingApi = {
  get: () => api.get<Billing>("/api/billing"),
  topup: (amountPaisa: number) =>
    api.post<{ balancePaisa: number } | Billing>("/api/billing/topup", { amountPaisa }),
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
  [key: string]: unknown;
}

export const customersApi = {
  list: (q?: string) => {
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    return api.get<Customer[] | { customers: Customer[] }>(`/api/customers${qs}`);
  },
  get: (id: string) => api.get<CustomerDetail>(`/api/customers/${id}`),
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
  runDue: () => api.post<{ processed: number; sent: number }>("/api/followups/run", {}),
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
    api.post<{ preview: string; newBody?: string }>(`/api/knowledge/preview-change`, { knowledgeId, instruction }),
  applyChange: (knowledgeId: string, newBody: string) =>
    api.post<{ knowledgeItem: KnowledgeItem; versionId?: string }>(`/api/knowledge/apply-change`, { knowledgeId, newBody }),
  rollback: (knowledgeId: string, versionId: string) =>
    api.post<{ knowledgeItem: KnowledgeItem }>(`/api/knowledge/${knowledgeId}/rollback`, { versionId }),
};

export interface Broadcast {
  id: string;
  title?: string;
  message?: string;
  offerText?: string;
  offer_text?: string;
  couponCode?: string;
  coupon_code?: string;
  status?: string;
  sent?: number;
  skipped?: number;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export const broadcastsApi = {
  list: () => api.get<Broadcast[] | { broadcasts: Broadcast[] }>("/api/broadcasts"),
  create: (body: { title: string; message: string; offerText?: string; couponCode?: string }) =>
    api.post<{ broadcast: Broadcast } | Broadcast>("/api/broadcasts", body),
  send: (id: string) =>
    api.post<{ broadcast: Broadcast; sent: number; skipped: number }>(`/api/broadcasts/${id}/send`, {}),
  get: (id: string) =>
    api.get<{ broadcast: Broadcast; recipients?: unknown[] }>(`/api/broadcasts/${id}`),
};

export interface Booking {
  id: string;
  customerId?: string;
  customer_id?: string;
  customer?: Customer;
  service?: string;
  date?: string;
  time?: string;
  advanceTxId?: string;
  advance_tx_id?: string;
  advancePaisa?: number;
  advance_paisa?: number;
  notes?: string;
  status?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export function bookingAdvancePaisa(b: Booking): number {
  return b.advancePaisa ?? b.advance_paisa ?? 0;
}

export const bookingsApi = {
  list: (params?: { date?: string; status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.date) qs.set("date", params.date);
    if (params?.status) qs.set("status", params.status);
    const s = qs.toString();
    return api.get<Booking[] | { bookings: Booking[] }>(`/api/bookings${s ? `?${s}` : ""}`);
  },
  create: (body: { customerId: string; service: string; date: string; time: string; advanceTxId?: string; advancePaisa?: number; notes?: string }) =>
    api.post<{ booking: Booking } | Booking>("/api/bookings", body),
  update: (id: string, body: { status?: string; advanceTxId?: string; advancePaisa?: number }) =>
    api.patch<{ booking: Booking } | Booking>(`/api/bookings/${id}`, body),
  remindersDue: () =>
    api.get<Booking[] | { bookings: Booking[] }>("/api/bookings/reminders-due"),
  remind: (id: string) =>
    api.post<{ booking: Booking } | Booking>(`/api/bookings/${id}/remind`, {}),
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

export type MigrationType = "customers" | "products" | "orders";

export interface MigrationImport {
  id: string;
  type?: string;
  imported?: number;
  failed?: number;
  errors?: string[];
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export const migrationApi = {
  importCsv: (type: MigrationType, csv: string) =>
    api.post<{ imported: number; failed: number; errors?: string[] }>("/api/migration/import", { type, csv }),
  listImports: () =>
    api.get<MigrationImport[] | { imports: MigrationImport[] }>("/api/migration/imports"),
};

export interface FeatureRequest {
  id: string;
  title: string;
  details?: string;
  status?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export const featureRequestsApi = {
  list: () =>
    api.get<FeatureRequest[] | { featureRequests: FeatureRequest[] }>("/api/feature-requests"),
  create: (body: { title: string; details?: string }) =>
    api.post<{ featureRequest: FeatureRequest } | FeatureRequest>("/api/feature-requests", body),
  update: (id: string, status: string) =>
    api.patch<{ featureRequest: FeatureRequest } | FeatureRequest>(`/api/feature-requests/${id}`, { status }),
};
