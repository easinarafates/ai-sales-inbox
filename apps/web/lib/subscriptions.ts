// সাবস্ক্রিপশন API হেল্পার — নিজের ফাইল (lib/api.ts ছোঁয়া হয়নি)।
// lib/api.ts থেকে শুধু শেয়ার্ড request হেল্পার (api), টোকেন ও টাকা ফরম্যাট
// ইমপোর্ট করা হয়েছে — সেখানে কোনো পরিবর্তন নেই।

import { api, formatDate, formatTaka, getToken } from "./api";

export { formatDate, formatTaka, getToken };

export interface Plan {
  id: string;
  slug: string;
  nameBn?: string;
  name_bn?: string;
  pricePaisa?: number;
  price_paisa?: number;
  includedAiReplies?: number;
  included_ai_replies?: number;
  maxChannels?: number | null;
  max_channels?: number | null;
  maxProducts?: number | null;
  max_products?: number | null;
  active?: boolean;
  [key: string]: unknown;
}

export function planName(p: Plan): string {
  return p.nameBn || p.name_bn || p.slug || "—";
}

export function planPricePaisa(p: Plan): number {
  return p.pricePaisa ?? p.price_paisa ?? 0;
}

export function planIncludedReplies(p: Plan): number {
  return p.includedAiReplies ?? p.included_ai_replies ?? 0;
}

export function planMaxChannels(p: Plan): number | null {
  return p.maxChannels ?? p.max_channels ?? null;
}

export function planMaxProducts(p: Plan): number | null {
  return p.maxProducts ?? p.max_products ?? null;
}

export function planLimitText(v: number | null, unit: string): string {
  return v === null || v === undefined ? "সীমাহীন" : `${v}টি ${unit}`;
}

export interface SubscriptionStatus {
  id: string;
  planId?: string;
  plan_id?: string;
  status?: string;
  effectiveStatus?: string;
  isActive?: boolean;
  currentPeriodStart?: string;
  current_period_start?: string;
  currentPeriodEnd?: string;
  current_period_end?: string;
  [key: string]: unknown;
}

export interface CurrentSubscription {
  subscription: SubscriptionStatus;
  plan: Plan;
  usage: {
    usedReplies?: number;
    includedReplies?: number;
    remainingReplies?: number;
    overageReplies?: number;
    [key: string]: unknown;
  };
  limits: {
    channels?: { used?: number; limit?: number | null; canAdd?: boolean; message?: string };
    products?: { used?: number; limit?: number | null; canAdd?: boolean; message?: string };
    [key: string]: unknown;
  };
  balancePaisa?: number;
  recentUsage?: { id: string; cost_paisa?: number; provider?: string; included_in_plan?: boolean; created_at?: string }[];
  [key: string]: unknown;
}

export function subscriptionStatusBn(s: SubscriptionStatus | undefined): string {
  if (!s) return "—";
  const eff = s.effectiveStatus || s.status || "";
  const map: Record<string, string> = {
    trial: "ফ্রি ট্রায়াল",
    active: "চালু",
    past_due: "বকেয়া",
    cancelled: "বাতিল (মেয়াদ পর্যন্ত চালু)",
    expired: "মেয়াদ শেষ",
  };
  return map[eff] || eff;
}

export function subscriptionPeriodEnd(s: SubscriptionStatus | undefined): string {
  return s?.currentPeriodEnd || s?.current_period_end || "";
}

export const subscriptionsApi = {
  plans: () => api.get<Plan[] | { plans: Plan[] }>("/api/subscriptions/plans"),
  current: () =>
    api.get<CurrentSubscription | { current: CurrentSubscription }>(
      "/api/subscriptions/current"
    ),
  limits: () =>
    api.get<{
      channels: { used: number; limit: number | null; canAdd: boolean; message: string };
      products: { used: number; limit: number | null; canAdd: boolean; message: string };
    }>("/api/subscriptions/limits"),
  subscribe: (planSlug: string) =>
    api.post<{ subscription: SubscriptionStatus; plan: Plan; balancePaisa: number; message?: string }>(
      "/api/subscriptions/subscribe",
      { planSlug }
    ),
  upgrade: (planSlug: string) =>
    api.post<{ subscription: SubscriptionStatus; plan: Plan; balancePaisa: number; message?: string }>(
      "/api/subscriptions/upgrade",
      { planSlug }
    ),
  downgrade: (planSlug: string) =>
    api.post<{ subscription: SubscriptionStatus; plan: Plan; balancePaisa: number; message?: string }>(
      "/api/subscriptions/downgrade",
      { planSlug }
    ),
  cancel: () =>
    api.post<{ subscription: SubscriptionStatus; message?: string }>(
      "/api/subscriptions/cancel",
      {}
    ),
  renew: () =>
    api.post<{ subscription: SubscriptionStatus; plan: Plan; balancePaisa: number; message?: string }>(
      "/api/subscriptions/renew",
      {}
    ),
};

export function asPlans(data: Plan[] | { plans: Plan[] } | null | undefined): Plan[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return Array.isArray(data.plans) ? data.plans : [];
}

export function asCurrent(
  data: CurrentSubscription | { current: CurrentSubscription } | null | undefined
): CurrentSubscription | null {
  if (!data) return null;
  if ((data as { current?: CurrentSubscription }).current) {
    return (data as { current: CurrentSubscription }).current;
  }
  return data as CurrentSubscription;
}
