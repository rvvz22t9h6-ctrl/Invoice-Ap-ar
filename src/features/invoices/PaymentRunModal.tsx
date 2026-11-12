/**
 * 批次付款（AP payment run）
 *
 * 一次付清多張已審批的供應商帳單：輸入付款日期、方式與參考號碼，
 * 系統逐張記錄「付清未付餘額」的付款，並回報成功與失敗的張數。
 * 每筆付款仍經過相同的業務規則檢查（審批、超額付款）。
 */
import { useState } from 'react';
import { Alert, Button, Modal, SelectInput, TextInput } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { formatDate } from '@/domain/dates';
import { formatMYR, senToDecimalString } from '@/domain/money';
import type { ComputedInvoice } from '@/domain/types';
import { PAYMENT_METHODS, paymentFormSchema } from '@/domain/validation';
import { useInvoiceMutations, useInvoices } from '@/hooks/useFinanceData';

export function PaymentRunModal({ bills, onClose, onDone }: { bills: ComputedInvoice[]; onClose: () => void; onDone: () => void }) {
  const { today } = useInvoices();
  const { recordPayment } = useInvoiceMutations();
  const toast = useToast();
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState(PAYMENT_METHODS[0]!);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failures, setFailures] = useState<{ bill: ComputedInvoice; message: string }[]>([]);
  const total = bills.reduce((t, b) => t + b.outstandingBalance, 0);

  const run = async () => {
    setBusy(true);
    setFailures([]);
    const failed: { bill: ComputedInvoice; message: string }[] = [];
    let ok = 0;
    for (const [i, bill] of bills.entries()) {
      const parsed = paymentFormSchema(today).safeParse({ kind: 'payment', paymentDate: date, amount: senToDecimalString(bill.outstandingBalance), method, reference, notes: 'Payment run' });
      if (!parsed.success) { failed.push({ bill, message: parsed.error.issues[0]?.message ?? 'Invalid' }); continue; }
      try {
        await recordPayment.mutateAsync([bill.id, parsed.data]);
        ok += 1;
      } catch (e) {
        failed.push({ bill, message: e instanceof Error ? e.message : 'Failed' });
      }
      setProgress(i + 1);
    }
    setBusy(false);
    if (failed.length) {
      setFailures(failed);
      if (ok) toast(`${ok} bill${ok === 1 ? '' : 's'} paid. ${failed.length} could not be paid.`, 'error');
    } else {
      toast(`${ok} bill${ok === 1 ? '' : 's'} paid, ${formatMYR(total)} in total`);
      onDone();
    }
  };

  return (
    <Modal open onClose={busy ? () => undefined : onClose} size="md" title={`Pay ${bills.length} supplier bill${bills.length === 1 ? '' : 's'}`}
      subtitle="Records a full payment of each bill's outstanding balance."
      footer={<>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="success" onClick={run} loading={busy} disabled={!bills.length || !!failures.length} data-testid="confirm-payment-run">
          {busy ? `Paying ${progress}/${bills.length}…` : `Pay ${formatMYR(total)}`}
        </Button>
      </>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TextInput label="Payment date *" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
        <SelectInput label="Method *" value={method} onChange={(e) => setMethod(e.target.value)}>
          {PAYMENT_METHODS.filter((m) => m !== 'Contra / Offset').map((m) => <option key={m}>{m}</option>)}
        </SelectInput>
        <TextInput label="Reference" placeholder="e.g. bank batch no." maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg ring-1 ring-slate-200">
        <table className="min-w-full text-sm" data-testid="payment-run-table">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-3 py-2 text-left">Bill</th><th className="px-3 py-2 text-left">Supplier</th><th className="hidden px-3 py-2 text-left sm:table-cell">Due</th><th className="px-3 py-2 text-right">Amount</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {bills.map((b) => (
              <tr key={b.id}>
                <td className="px-3 py-2 font-medium">{b.invoiceNumber}</td>
                <td className="px-3 py-2">{b.counterpartyName}</td>
                <td className={`hidden px-3 py-2 sm:table-cell ${b.isOverdue ? 'text-red-700' : ''}`}>{formatDate(b.dueDate)}</td>
                <td className="tabular px-3 py-2 text-right">{formatMYR(b.outstandingBalance)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
            <tr><td className="px-3 py-2" colSpan={2}>Total</td><td className="hidden sm:table-cell" /><td className="tabular px-3 py-2 text-right" data-testid="payment-run-total">{formatMYR(total)}</td></tr>
          </tfoot>
        </table>
      </div>
      {failures.length > 0 && (
        <div className="mt-4"><Alert>
          <p className="font-semibold">These bills were not paid:</p>
          <ul className="mt-1 list-disc pl-5">{failures.map((f) => <li key={f.bill.id}>{f.bill.invoiceNumber}: {f.message}</li>)}</ul>
        </Alert></div>
      )}
    </Modal>
  );
}
