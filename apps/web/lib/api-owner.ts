// API helpers for the Owner Panel (platform super-admin).
// Uses the shared `api` client from ./api — nothing here edits that file.
// All money is in paisa; display via fmtTaka from @/lib/i18n.
import { api } from "./api";

export interface OwnerOverview {
  shops: { total: number; active: number };
  activeSubscriptions: number;
  revenueThisMonthPaisa: number;
  revenueThisMonthCharges: number;
  expectedMonthlyRevenuePaisa: number;
  apiSpendThisMonthPaisa: number;
  apiSpendTotalPaisa: number;
  ownerWallet: {
    balancePaisa: number;
    lowBalanceThresholdPaisa: number;
    lowBalance: boolean;
  };
  trend: { date: string; revenuePaisa: number; apiCostPaisa: number }[];
}

export interface OwnerShop {
  id: string;
  name: string;
  balancePaisa: number;
  suspended: boolean;
  aiEnabled: boolean;
  practiceMode: boolean;
  ownerName: string | null;
  ownerEmail: string | null;
  planName: string | null;
  planStatus: string | null;
  planEndsAt: string | null;
  joinedAt: string;
}

export interface OwnerShopDetail {
  shop: {
    id: string;
    name: string;
    balancePaisa: number;
    suspended: boolean;
    aiEnabled: boolean;
    practiceMode: boolean;
    ownerName: string | null;
    ownerEmail: string | null;
    joinedAt: string;
  };
  totals: { orders: number; conversations: number; aiReplies: number; apiCostPaisa: number };
  subscriptions: {
    status: string;
    planName: string;
    planPricePaisa: number;
    periodStart: string;
    periodEnd: string;
  }[];
}

export interface BankAccount {
  id: string;
  bankName: string;
  accountHolder: string;
  accountNumberMasked: string;
  accountNumberLast4: string;
  branch: string | null;
  type: string;
  isPrimary: boolean;
  createdAt: string;
}

export interface OwnerExpense {
  id: string;
  date: string;
  category: string;
  amountPaisa: number;
  note: string | null;
  createdAt: string;
}

export interface ApiCosts {
  period: string;
  since: string;
  totalProviderCostPaisa: number;
  byProvider: { provider: string; replies: number; providerCostPaisa: number; walletChargePaisa: number }[];
  byDay: { date: string; provider: string; providerCostPaisa: number }[];
  byShop: { workspaceId: string; shopName: string; replies: number; providerCostPaisa: number }[];
  note: string;
}

export interface OwnerWalletTx {
  id: string;
  type: string;
  amountPaisa: number;
  provider: string | null;
  reference: string | null;
  note: string | null;
  createdAt: string;
}

export interface OwnerWallet {
  balancePaisa: number;
  lowBalanceThresholdPaisa: number;
  lowBalance: boolean;
  transactions: OwnerWalletTx[];
}

export interface OwnerCard {
  id: string;
  brand: string;
  last4: string;
  masked: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
  createdAt: string;
}

export interface OwnerDeposit {
  id: string;
  amountPaisa: number;
  method: string;
  transactionId: string | null;
  status: string;
  cardId: string | null;
  requestedBy: string | null;
  reviewedBy: string | null;
  reason: string | null;
  createdAt: string;
}

export const ownerApi = {
  me: () => api.get<{ isOwner: boolean }>("/api/owner/me"),
  setup: (email: string, setupToken?: string) =>
    api.post<{ owner: { id: string; email: string; name: string | null }; message: string }>("/api/owner/setup", {
      email,
      setupToken,
    }),
  overview: (days: 7 | 30 = 30) => api.get<OwnerOverview>(`/api/owner/overview?days=${days}`),
  shops: () => api.get<{ shops: OwnerShop[] }>("/api/owner/shops"),
  shop: (id: string) => api.get<OwnerShopDetail>(`/api/owner/shops/${id}`),
  suspendShop: (id: string) => api.post<{ shop: OwnerShop; message: string }>(`/api/owner/shops/${id}/suspend`),
  activateShop: (id: string) => api.post<{ shop: OwnerShop; message: string }>(`/api/owner/shops/${id}/activate`),
  bankAccounts: () => api.get<{ bankAccounts: BankAccount[] }>("/api/owner/bank-accounts"),
  addBankAccount: (body: {
    bankName: string;
    accountHolder: string;
    accountNumber: string;
    branch?: string;
    type?: string;
    isPrimary?: boolean;
  }) => api.post<{ bankAccount: BankAccount }>("/api/owner/bank-accounts", body),
  updateBankAccount: (
    id: string,
    body: { bankName?: string; accountHolder?: string; branch?: string; type?: string; isPrimary?: boolean }
  ) => api.patch<{ bankAccount: BankAccount }>(`/api/owner/bank-accounts/${id}`, body),
  deleteBankAccount: (id: string) => api.del<{ deleted: boolean }>(`/api/owner/bank-accounts/${id}`),
  expenses: (month?: string) =>
    api.get<{ month: string; expenses: OwnerExpense[]; totalsByCategory: Record<string, number>; monthTotalPaisa: number }>(
      month ? `/api/owner/expenses?month=${month}` : "/api/owner/expenses"
    ),
  addExpense: (body: { date: string; category: string; amountPaisa: number; note?: string }) =>
    api.post<{ expense: OwnerExpense }>("/api/owner/expenses", body),
  deleteExpense: (id: string) => api.del<{ deleted: boolean }>(`/api/owner/expenses/${id}`),
  apiCosts: (period: "7d" | "30d" | "month" = "30d") => api.get<ApiCosts>(`/api/owner/api-costs?period=${period}`),
  wallet: () => api.get<OwnerWallet>("/api/owner/wallet"),
  setThreshold: (thresholdPaisa: number) =>
    api.patch<{ balancePaisa: number; lowBalanceThresholdPaisa: number; lowBalance: boolean }>(
      "/api/owner/wallet/threshold",
      { thresholdPaisa }
    ),
  sweep: () =>
    api.post<{ deductedRows: number; totalPaisa: number; balancePaisa: number; lowBalance: boolean }>(
      "/api/owner/wallet/sweep"
    ),
  cards: () => api.get<{ cards: OwnerCard[] }>("/api/owner/wallet/cards"),
  addCard: (body: { brand: string; last4: string; expMonth?: number; expYear?: number; isDefault?: boolean }) =>
    api.post<{ card: OwnerCard }>("/api/owner/wallet/cards", body),
  setDefaultCard: (id: string) => api.patch<{ card: OwnerCard }>(`/api/owner/wallet/cards/${id}/set-default`),
  deleteCard: (id: string) => api.del<{ deleted: boolean }>(`/api/owner/wallet/cards/${id}`),
  deposits: (status?: string) =>
    api.get<{ deposits: OwnerDeposit[] }>(
      status ? `/api/owner/wallet/deposits?status=${status}` : "/api/owner/wallet/deposits"
    ),
  addDeposit: (body: { amountPaisa: number; method: string; transactionId?: string; cardId?: string }) =>
    api.post<{ deposit: OwnerDeposit; message: string }>("/api/owner/wallet/deposits", body),
  approveDeposit: (id: string) =>
    api.post<{ deposit: OwnerDeposit; balancePaisa: number; message: string }>(
      `/api/owner/wallet/deposits/${id}/approve`
    ),
  rejectDeposit: (id: string, reason?: string) =>
    api.post<{ deposit: OwnerDeposit; message: string }>(`/api/owner/wallet/deposits/${id}/reject`, { reason }),
};
