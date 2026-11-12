/**
 * 發票明細（Invoice detail）
 *
 * 顯示金額摘要、付款紀錄與操作歷程，並提供所有操作按鈕：
 *   編輯、記錄付款、審批／退回（AP，管理員）、取消／還原、刪除（管理員）、沖銷付款（管理員）。
 * 按鈕依角色顯示（domain/permissions.ts）；實際權限仍由資料庫控管。
 *
 * 為避免多層對話框互相干擾，以 view 狀態一次只顯示一個對話框。
 */
import { useState } from 'react';
import { Alert, ApprovalBadge, Button, Modal, StatusBadge, TextArea, TypeTag } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { formatDate, formatDateTime } from '@/domain/dates';
import { dueDescription } from '@/domain/invoice';
import { formatMYR } from '@/domain/money';
import { can } from '@/domain/permissions';
import { TYPE_LABELS, type ApprovalStatus } from '@/domain/types';
import { useAuth } from '@/features/auth/AuthContext';
import { useActivity, useInvoiceMutations, useInvoices } from '@/hooks/useFinanceData';
import { InvoiceFormModal } from './InvoiceFormModal';
import { PaymentFormModal } from './PaymentFormModal';

type View =
  | { kind: 'detail' }
  | { kind: 'edit' }
  | { kind: 'pay' }
  | { kind: 'cancel' }
  | { kind: 'delete' }
  | { kind: 'reverse'; paymentId: string; amount: number };

export function InvoiceDetailModal({ invoiceId, onClose }: { invoiceId: string | null; onClose: () => void }) {
  const { invoices, today } = useInvoices();
  const invoice = invoices.find((i) => i.id === invoiceId) ?? null;
  const history = useActivity({ invoiceId: invoiceId ?? undefined, limit: 50, enabled: !!invoiceId });
  const { user } = useAuth();
  const role = user?.role;
  const m = useInvoiceMutations();
  const toast = useToast();
  const [view, setView] = useState<View>({ kind: 'detail' });
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  if (!invoiceId) return null;
  const close = () => { setView({ kind: 'detail' }); setError(''); setReason(''); onClose(); };
  const back = () => { setView({ kind: 'detail' }); setError(''); };

  if (!invoice) {
    return <Modal open onClose={close} title="Invoice"><p className="text-sm text-slate-500">This invoice no longer exists.</p></Modal>;
  }

  const L = TYPE_LABELS[invoice.type];
  const run = async (action: () => Promise<unknown>, message: string, after: () => void = back) => {
    setError('');
    try {
      await action();
      toast(message);
      after();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    }
  };

  // ---------- 子對話框 ----------
  if (view.kind === 'edit') return <InvoiceFormModal open type={invoice.type} invoice={invoice} onClose={back} />;
  if (view.kind === 'pay') return <PaymentFormModal open invoice={invoice} onClose={back} />;

  if (view.kind === 'cancel') {
    return (
      <Modal open onClose={back} size="sm" title={`Cancel invoice ${invoice.invoiceNumber}?`}
        footer={<><Button onClick={back}>Keep invoice</Button>
          <Button variant="danger" loading={m.cancel.isPending} data-testid="confirm-cancel"
            onClick={() => (reason.trim() ? run(() => m.cancel.mutateAsync([invoice.id, reason]), 'Invoice cancelled') : setError('Please give a reason for cancelling'))}>Cancel invoice</Button></>}>
        <p className="mb-3 text-sm text-slate-600">Cancelled invoices are excluded from all outstanding and overdue totals. You can restore it later.</p>
        <TextArea label="Reason *" rows={2} maxLength={300} value={reason} onChange={(e) => { setReason(e.target.value); setError(''); }} placeholder="e.g. Duplicate billing, replaced by new invoice" />
        {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      </Modal>
    );
  }

  if (view.kind === 'delete' || view.kind === 'reverse') {
    const isDelete = view.kind === 'delete';
    return (
      <Modal open onClose={back} size="sm" title={isDelete ? `Delete invoice ${invoice.invoiceNumber}?` : 'Reverse this payment?'}
        footer={<><Button onClick={back}>Go back</Button>
          <Button variant="danger" data-testid="confirm-danger" loading={m.remove.isPending || m.reversePayment.isPending}
            onClick={() => (isDelete
              ? run(() => m.remove.mutateAsync([invoice.id]), 'Invoice deleted', close)
              : run(() => m.reversePayment.mutateAsync([view.paymentId]), 'Payment reversed'))}>
            {isDelete ? 'Delete permanently' : 'Reverse payment'}</Button></>}>
        <p className="text-sm text-slate-600">
          {isDelete
            ? 'This permanently removes the invoice. Consider cancelling instead to keep a record. This cannot be undone.'
            : `The ${formatMYR(view.amount)} payment will be removed and the outstanding balance will increase by the same amount. The reversal is recorded in the activity log.`}
        </p>
        {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      </Modal>
    );
  }

  // ---------- 主明細 ----------
  const canPay = can(role, 'payment.record') && !invoice.isCancelled && invoice.outstandingBalance > 0
    && (invoice.type === 'AR' || invoice.approvalStatus === 'approved');
  const needsApproval = invoice.type === 'AP' && invoice.approvalStatus !== 'approved' && !invoice.isCancelled;
  const approve = (s: ApprovalStatus) => run(() => m.setApproval.mutateAsync([invoice.id, s]), s === 'approved' ? 'Invoice approved' : 'Invoice rejected');

  return (
    <Modal open onClose={close} size="lg"
      title={<span className="flex flex-wrap items-center gap-2"><TypeTag type={invoice.type} />{invoice.invoiceNumber}<StatusBadge status={invoice.status} /><ApprovalBadge status={invoice.approvalStatus} /></span>}
      subtitle={`${L.party}: ${invoice.counterpartyName}`}
      footer={<>
        {can(role, 'invoice.delete') && invoice.amountPaid === 0 && <Button variant="danger" className="mr-auto" onClick={() => setView({ kind: 'delete' })}>Delete</Button>}
        {can(role, 'invoice.cancel') && !invoice.isCancelled && invoice.amountPaid === 0 && <Button onClick={() => setView({ kind: 'cancel' })}>Cancel invoice</Button>}
        {can(role, 'invoice.cancel') && invoice.isCancelled && <Button loading={m.restore.isPending} onClick={() => run(() => m.restore.mutateAsync([invoice.id]), 'Invoice restored')}>Restore</Button>}
        {can(role, 'invoice.edit') && !invoice.isCancelled && <Button onClick={() => setView({ kind: 'edit' })} data-testid="edit-invoice">Edit</Button>}
        {canPay && <Button variant="success" onClick={() => setView({ kind: 'pay' })} data-testid="record-payment">{L.pay}</Button>}
        {!role || role === 'viewer' ? <Button onClick={close}>Close</Button> : null}
      </>}>
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      {needsApproval && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-sky-50 px-4 py-3 ring-1 ring-sky-200">
          <p className="text-sm text-sky-900">
            {invoice.approvalStatus === 'rejected' ? 'This supplier invoice was rejected and cannot be paid.' : 'This supplier invoice is awaiting approval before it can be paid.'}
          </p>
          {can(role, 'invoice.approve') && (
            <div className="flex gap-2">
              {invoice.approvalStatus !== 'rejected' && <Button size="sm" variant="danger" onClick={() => approve('rejected')}>Reject</Button>}
              <Button size="sm" variant="primary" loading={m.setApproval.isPending} onClick={() => approve('approved')} data-testid="approve">Approve</Button>
            </div>
          )}
        </div>
      )}
      {invoice.isCancelled && <div className="mb-5"><Alert tone="warning">Cancelled{invoice.cancelReason ? `: ${invoice.cancelReason}` : ''}</Alert></div>}

      {/* 金額摘要 */}
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-slate-200 ring-1 ring-slate-200 sm:grid-cols-5">
        {[
          ['Invoice Amount', formatMYR(invoice.invoiceAmount)],
          ['Tax Amount', formatMYR(invoice.taxAmount)],
          ['Total Amount', formatMYR(invoice.totalAmount)],
          [L.paid, formatMYR(invoice.amountPaid)],
          ['Outstanding', formatMYR(invoice.outstandingBalance)],
        ].map(([k, v]) => (
          <div key={k} className="bg-white px-4 py-3">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{k}</dt>
            <dd className="tabular mt-0.5 text-sm font-semibold text-slate-900" data-testid={`detail-${k!.toLowerCase().replace(/\s+/g, '-')}`}>{v}</dd>
          </div>
        ))}
      </dl>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-slate-500">Invoice Date</dt><dd className="font-medium">{formatDate(invoice.invoiceDate)}</dd></div>
        <div><dt className="text-xs text-slate-500">Due Date</dt><dd className="font-medium">{formatDate(invoice.dueDate)}</dd>
          <dd className={invoice.isOverdue ? 'text-xs font-medium text-red-700' : 'text-xs text-slate-500'}>{dueDescription(invoice, today)}</dd></div>
        <div><dt className="text-xs text-slate-500">{L.status}</dt><dd className="font-medium">{invoice.status}{invoice.isOverdue && invoice.isPartiallyPaid ? ' (part paid)' : ''}</dd></div>
        <div><dt className="text-xs text-slate-500">Last Payment</dt><dd className="font-medium">{formatDate(invoice.lastPaymentDate)}</dd></div>
        {invoice.description && <div className="col-span-2 sm:col-span-4"><dt className="text-xs text-slate-500">Description</dt><dd>{invoice.description}</dd></div>}
      </dl>

      {/* 付款紀錄 */}
      <h3 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{invoice.type === 'AR' ? 'Collections' : 'Payments'} ({invoice.payments.length})</h3>
      {invoice.payments.length === 0 ? <p className="text-sm text-slate-500">No payments recorded yet.</p> : (
        <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200">
          <table className="min-w-full text-sm" data-testid="payments-table">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-left">Method</th><th className="hidden px-3 py-2 text-left sm:table-cell">Reference</th><th className="px-3 py-2 text-right">Amount</th>{can(role, 'payment.reverse') && <th className="px-3 py-2" />}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoice.payments.map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDate(p.paymentDate)}</td>
                  <td className="px-3 py-2">{p.method}{p.notes && <p className="text-xs text-slate-500">{p.notes}</p>}</td>
                  <td className="hidden px-3 py-2 text-slate-600 sm:table-cell">{p.reference || '—'}</td>
                  <td className="tabular px-3 py-2 text-right font-medium">{formatMYR(p.amount)}</td>
                  {can(role, 'payment.reverse') && <td className="px-3 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => setView({ kind: 'reverse', paymentId: p.id, amount: p.amount })}>Reverse</Button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 歷程 */}
      <h3 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">History</h3>
      <ol className="space-y-2 border-l-2 border-slate-100 pl-4">
        {(history.data ?? []).map((a) => (
          <li key={a.id} className="text-sm">
            <p className="text-slate-700">{a.summary}</p>
            <p className="text-xs text-slate-500">{a.actorName ?? 'System'} · {formatDateTime(a.createdAt)}</p>
          </li>
        ))}
        {history.data && history.data.length === 0 && <li className="text-sm text-slate-500">No history recorded.</li>}
      </ol>
    </Modal>
  );
}
