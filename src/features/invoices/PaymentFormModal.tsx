/**
 * 記錄付款／收款表單（Record payment）
 *
 * - 支援部分付款：金額預設為「未付餘額」，可改為較小金額。
 * - 送出前檢查：金額 > 0、不超過未付餘額、日期不可是未來。
 * - 即時預覽付款後的未付餘額。
 */
import { useState } from 'react';
import { Alert, Button, Modal, SelectInput, TextArea, TextInput } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { formatDate } from '@/domain/dates';
import { formatMYR, senToDecimalString, toSen } from '@/domain/money';
import { TYPE_LABELS, type ComputedInvoice } from '@/domain/types';
import { assertCanRecordPayment, DomainError, fieldErrors, PAYMENT_METHODS, paymentFormSchema, type PaymentFormInput } from '@/domain/validation';
import { useInvoiceMutations, useInvoices } from '@/hooks/useFinanceData';

export function PaymentFormModal({ invoice, open, onClose }: { invoice: ComputedInvoice; open: boolean; onClose: () => void }) {
  const L = TYPE_LABELS[invoice.type];
  const { today } = useInvoices();
  const { recordPayment } = useInvoiceMutations();
  const toast = useToast();
  const [values, setValues] = useState<Required<PaymentFormInput>>({
    paymentDate: today, amount: senToDecimalString(invoice.outstandingBalance), method: PAYMENT_METHODS[0]!, reference: '', notes: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');

  const set = (field: keyof PaymentFormInput, value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => ({ ...e, [field]: '' }));
  };

  const amountSen = toSen(values.amount);
  const after = amountSen !== null && amountSen > 0 ? invoice.outstandingBalance - amountSen : null;

  const submit = async () => {
    setFormError('');
    const parsed = paymentFormSchema(today).safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    try {
      assertCanRecordPayment(invoice, parsed.data.amount);
      await recordPayment.mutateAsync([invoice.id, parsed.data]);
      const full = parsed.data.amount === invoice.outstandingBalance;
      toast(`${formatMYR(parsed.data.amount)} ${invoice.type === 'AR' ? 'collected' : 'paid'}${full ? ' — invoice fully settled' : ''}`);
      onClose();
    } catch (e) {
      if (e instanceof DomainError && e.field) setErrors({ [e.field]: e.message });
      else setFormError(e instanceof Error ? e.message : 'Could not record the payment');
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="sm" title={L.pay}
      subtitle={`${invoice.invoiceNumber} · ${invoice.counterpartyName}`}
      footer={<>
        <Button onClick={onClose} disabled={recordPayment.isPending}>Cancel</Button>
        <Button variant="success" onClick={submit} loading={recordPayment.isPending} data-testid="save-payment">Save {invoice.type === 'AR' ? 'collection' : 'payment'}</Button>
      </>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <dl className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center ring-1 ring-slate-200">
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-500">Total</dt><dd className="tabular text-sm font-semibold">{formatMYR(invoice.totalAmount)}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-500">{invoice.type === 'AR' ? 'Received' : 'Paid'}</dt><dd className="tabular text-sm font-semibold">{formatMYR(invoice.amountPaid)}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-500">Outstanding</dt><dd className="tabular text-sm font-semibold text-navy-800">{formatMYR(invoice.outstandingBalance)}</dd></div>
        </dl>
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="Payment Date *" type="date" max={today} value={values.paymentDate} error={errors.paymentDate} onChange={(e) => set('paymentDate', e.target.value)} />
          <TextInput label="Amount (RM) *" inputMode="decimal" value={values.amount} error={errors.amount} onChange={(e) => set('amount', e.target.value)} />
        </div>
        <div className="-mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <button type="button" className="font-medium text-navy-700 hover:underline" onClick={() => set('amount', senToDecimalString(invoice.outstandingBalance))}>Use full balance</button>
          {after !== null && (
            <span className={after < 0 ? 'font-medium text-red-600' : 'text-slate-500'} data-testid="balance-after">
              {after < 0 ? `Exceeds outstanding by ${formatMYR(-after)}` : after === 0 ? 'Invoice will be fully settled' : `Balance after: ${formatMYR(after)} (partial payment)`}
            </span>
          )}
        </div>
        <SelectInput label="Payment Method *" value={values.method} error={errors.method} onChange={(e) => set('method', e.target.value)}>
          {PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}
        </SelectInput>
        <TextInput label="Reference" placeholder="Bank reference / cheque no." maxLength={100} value={values.reference} error={errors.reference} onChange={(e) => set('reference', e.target.value)} />
        <TextArea label="Notes" rows={2} maxLength={500} value={values.notes} error={errors.notes} onChange={(e) => set('notes', e.target.value)} />
        <p className="text-xs text-slate-500">Due {formatDate(invoice.dueDate)}. Payments cannot be edited later — an admin can reverse a payment if it was entered by mistake.</p>
        {formError && <Alert>{formError}</Alert>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
