/**
 * 資料讀寫 Hooks（使用 TanStack Query 管理快取）
 *
 * 讀取：useInvoices 會回傳「已計算」的發票（含未付餘額、付款狀態等）。
 * 寫入：每個 mutation 成功後都會讓發票與活動紀錄的快取失效，畫面自動重新整理，
 *       確保儀表板數字永遠與最新資料一致。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { repository } from '@/data';
import { computeInvoices } from '@/domain/invoice';
import type { ApprovalStatus, Attachment, CounterpartyKind, InvoiceType } from '@/domain/types';
import type { InvoiceFormValues, PaymentFormValues } from '@/domain/validation';

export const queryKeys = {
  invoices: ['invoices'] as const,
  activity: (invoiceId?: string, limit?: number) => ['activity', invoiceId ?? 'all', limit ?? 10] as const,
  counterparties: (kind?: CounterpartyKind) => ['counterparties', kind ?? 'all'] as const,
};

/** 所有發票（已計算）與今天日期。 */
export function useInvoices() {
  const query = useQuery({ queryKey: queryKeys.invoices, queryFn: () => repository.listInvoices() });
  const today = repository.today();
  const invoices = useMemo(() => computeInvoices(query.data ?? [], today), [query.data, today]);
  return { ...query, invoices, today };
}

export function useActivity({ enabled = true, ...options }: { invoiceId?: string; limit?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.activity(options.invoiceId, options.limit),
    queryFn: () => repository.listActivity(options),
    enabled,
  });
}

export function useCounterparties(kind?: CounterpartyKind) {
  return useQuery({ queryKey: queryKeys.counterparties(kind), queryFn: () => repository.listCounterparties(kind) });
}

/** 所有寫入動作；成功後統一刷新相關快取。 */
export function useInvoiceMutations() {
  const qc = useQueryClient();
  const keys = [queryKeys.invoices, ['activity'], ['counterparties']];
  // 先取消進行中的讀取，再讓快取失效：
  // 若某查詢正在「第一次載入」，TanStack Query 會把重新讀取合併到那次（舊的）請求，
  // 畫面就會顯示變更前的資料。先取消可確保一定會重新讀取最新資料。
  const refresh = async () => {
    await Promise.all(keys.map((queryKey) => qc.cancelQueries({ queryKey })));
    await Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
  };
  const m = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    // 每個動作建立一個 useMutation（呼叫順序固定，符合 Hooks 規則）
    useMutation({ mutationFn: (args: A) => fn(...args), onSuccess: refresh });

  return {
    create: m((type: InvoiceType, v: InvoiceFormValues) => repository.createInvoice(type, v)),
    update: m((id: string, v: InvoiceFormValues) => repository.updateInvoice(id, v)),
    setApproval: m((id: string, s: ApprovalStatus) => repository.setApproval(id, s)),
    cancel: m((id: string, reason: string) => repository.cancelInvoice(id, reason)),
    restore: m((id: string) => repository.restoreInvoice(id)),
    remove: m((id: string) => repository.deleteInvoice(id)),
    recordPayment: m((id: string, v: PaymentFormValues) => repository.recordPayment(id, v)),
    reversePayment: m((paymentId: string) => repository.reversePayment(paymentId)),
    addAttachment: m((id: string, a: Attachment) => repository.addAttachment!(id, a)),
    removeAttachment: m((id: string, attachmentId: string) => repository.removeAttachment!(id, attachmentId)),
  };
}
