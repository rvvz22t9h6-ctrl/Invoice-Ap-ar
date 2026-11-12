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
import { TYPE_LABELS, type ComputedInvoice, type PaymentKind } from '@/domain/types';
import { assertCanRecordPayment, DomainError, fieldErrors, PAYMENT_METHODS, paymentFormSchema, type PaymentFormInput } from '@/domain/validation';
import { useInvoiceMutations, useInvoices } from '@/hooks/useFinanceData';

export function PaymentFormModal({ invoice, open, onClose }: { invoice: ComputedInvoice; open: boolean; onClose: () => void }) {
  const L = TYPE_LABELS[invoice.type];
  const { today } = useInvoices();
  const { recordPayment } = useInvoiceMutations();
  const toast = useToast();
  const [values, setValues] = useState<Required<PaymentFormInput>>({
    kind: 'payment',
    paymentDate: today, amount: senToDecimalString(invoice.outstandingBalance), method: PAYMENT_METHODS[0]!, reference: '', notes: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');

  const kind = values.kind;
  // 依發票類別可用的沖帳類型：未審批的 AP 只能記錄折讓單；呆帳沖銷只限 AR
  const kinds = ([
    ['payment', invoice.type === 'AR' ? 'Payment received' : 'Payment made'],
    ['credit_note', 'Credit note'],
    ...(invoice.type === 'AR' ? [['write_off', 'Write-off']] : []),
  ] as [PaymentKind, string][]).filter(([k]) => k !== 'payment' || invoice.type === 'AR' || invoice.approvalStatus === 'approved');
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
      assertCanRecordPayment(invoice, parsed.data.amount, parsed.data.kind);
      await recordPayment.mutateAsync([invoice.id, parsed.data]);
      const full = parsed.data.amount === invoice.outstandingBalance;
      const what = parsed.data.kind === 'credit_note' ? 'credit note recorded' : parsed.data.kind === 'write_off' ? 'written off' : invoice.type === 'AR' ? 'collected' : 'paid';
      toast(`${formatMYR(parsed.data.amount)} ${what}${full ? '. Invoice fully settled' : ''}`);
      onClose();
    } catch (e) {
      if (e instanceof DomainError && e.field) setErrors({ [e.field]: e.message });
      else setFormError(e instanceof Error ? e.message : 'Could not record the payment');
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="sm" title={kind === 'payment' ? L.pay : kind === 'credit_note' ? 'Record Credit Note' : 'Write Off Bad Debt'}
      subtitle={`${invoice.invoiceNumber} · ${invoice.counterpartyName}`}
      footer={<>
        <Button onClick={onClose} disabled={recordPayment.isPending}>Cancel</Button>
        <Button variant="success" onClick={submit} loading={recordPayment.isPending} data-testid="save-payment">{kind === 'payment' ? `Save ${invoice.type === 'AR' ? 'collection' : 'payment'}` : kind === 'credit_note' ? 'Save credit note' : 'Write off'}</Button>
      </>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        {kinds.length > 1 && (
          <div className="grid gap-1 rounded-lg bg-slate-100 p-1 text-sm font-medium" style={{ gridTemplateColumns: `repeat(${kinds.length}, minmax(0, 1fr))` }} role="radiogroup" aria-label="Type">
            {kinds.map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => set('kind', k)} data-testid={`kind-${k}`}
                className={kind === k ? 'rounded-md bg-white px-2 py-1.5 text-slate-900 shadow-sm' : 'rounded-md px-2 py-1.5 text-slate-500 hover:text-slate-800'}>
                {label}
              </button>
            ))}
          </div>
        )}
        {kind === 'credit_note' && <p className="text-xs text-slate-600">A credit note reduces what {invoice.type === 'AR' ? 'the customer owes' : 'you owe the supplier'} (a discount, return or price correction). It is not counted as cash.</p>}
        {kind === 'write_off' && <p className="text-xs text-amber-800">Write off only amounts you no longer expect to collect (bad debt). The balance is closed but not counted as cash collected.</p>}
        <dl className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center ring-1 ring-slate-200">
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-500">Total</dt><dd className="tabular text-sm font-semibold">{formatMYR(invoice.totalAmount)}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-500">{invoice.type === 'AR' ? 'Received' : 'Paid'}</dt><dd className="tabular text-sm font-semibold">{formatMYR(invoice.amountPaid)}</dd></div>
          <div><dt className="text-[11px] uppercase tracking-wide text-slate-500">Outstanding</dt><dd className="tabular text-sm font-semibold text-navy-800">{formatMYR(invoice.outstandingBalance)}</dd></div>
        </dl>
        <div className="grid grid-cols-2 gap-3">
          <TextInput label={kind === 'payment' ? 'Payment Date *' : 'Date *'} type="date" max={today} value={values.paymentDate} error={errors.paymentDate} onChange={(e) => set('paymentDate', e.target.value)} />
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
        {kind === 'payment' && (
          <SelectInput label="Payment Method *" value={values.method} error={errors.method} onChange={(e) => set('method', e.target.value)}>
            {PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}
          </SelectInput>
        )}
        <TextInput label={kind === 'credit_note' ? 'Credit note number' : 'Reference'} placeholder={kind === 'credit_note' ? 'e.g. CN-0012' : kind === 'write_off' ? 'e.g. approval memo' : 'Bank reference / cheque no.'} maxLength={100} value={values.reference} error={errors.reference} onChange={(e) => set('reference', e.target.value)} />
        <TextArea label="Notes" rows={2} maxLength={500} value={values.notes} error={errors.notes} onChange={(e) => set('notes', e.target.value)} />
        <p className="text-xs text-slate-500">Due {formatDate(invoice.dueDate)}. Payments cannot be edited later — an admin can reverse a payment if it was entered by mistake.</p>
        {formError && <Alert>{formError}</Alert>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
