// Manual top-up typed fetch helpers (courier/topup module — own file, lib/api.ts untouched).
// No payment gateway: the payer sends money by hand (bKash/Nagad/bank) and
// submits the transaction id; a workspace member approves/rejects it.
import { api, asArrayOf } from "@/lib/api";

export type TopupMethod = "bkash" | "nagad" | "rocket" | "bank" | "manual";

export const TOPUP_METHODS: { value: TopupMethod; label: string }[] = [
  { value: "bkash", label: "বিকাশ (Send Money)" },
  { value: "nagad", label: "নগদ (Send Money)" },
  { value: "rocket", label: "রকেট (Send Money)" },
  { value: "bank", label: "ব্যাংক ট্রান্সফার" },
  { value: "manual", label: "হাতে (ক্যাশ/অন্যান্য)" },
];

export type CheckoutPurpose =
  | { kind: "schedule"; slug: string }
  | { kind: "package"; replies: number }
  | { kind: "payg" };

export interface PaymentNumber {
  type: string;
  bankName: string;
  accountHolder: string;
  number: string;
  branch: string | null;
}

export interface PaymentNumbers {
  bkash: PaymentNumber | null;
  nagad: PaymentNumber | null;
  rocket: PaymentNumber | null;
  bank: PaymentNumber | null;
}

export type TopupStatus = "pending" | "approved" | "rejected";

export const TOPUP_STATUS_BN: Record<TopupStatus, string> = {
  pending: "যাচাইয়ের অপেক্ষায়",
  approved: "অনুমোদিত",
  rejected: "বাতিল",
};

export interface TopupRequest {
  id: string;
  amountPaisa?: number;
  amount_paisa?: number;
  method?: string;
  methodBn?: string;
  transactionId?: string;
  transaction_id?: string;
  status?: string;
  reason?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export function topupAmountPaisa(t: TopupRequest): number {
  return t.amountPaisa ?? t.amount_paisa ?? 0;
}

export function topupTransactionId(t: TopupRequest): string {
  return t.transactionId ?? t.transaction_id ?? "—";
}

export const topupApi = {
  request: (body: { amountPaisa: number; method: TopupMethod; transactionId: string; purpose?: CheckoutPurpose }) =>
    api.post<{ topupRequest: TopupRequest; message?: string }>(
      "/api/billing/topup/request",
      body
    ),
  paymentNumbers: () =>
    api.get<{ numbers: PaymentNumbers }>("/api/billing/payment-numbers"),
  list: async (status?: TopupStatus) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    const data = await api.get<TopupRequest[] | { topupRequests: TopupRequest[] }>(
      `/api/billing/topup/requests${qs}`
    );
    return asArrayOf<TopupRequest>(data, ["topupRequests"]);
  },
  approve: (id: string, workspaceId?: string) =>
    api.post<{ topupRequest: TopupRequest; balancePaisa?: number; message?: string; delivery?: { ok: boolean; message: string } | null }>(
      `/api/billing/topup/${id}/approve`,
      workspaceId ? { workspaceId } : {}
    ),
  reject: (id: string, reason?: string, workspaceId?: string) =>
    api.post<{ topupRequest: TopupRequest; message?: string }>(
      `/api/billing/topup/${id}/reject`,
      { reason, workspaceId }
    ),
};
