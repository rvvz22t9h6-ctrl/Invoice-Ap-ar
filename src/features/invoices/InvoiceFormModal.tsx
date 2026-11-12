/**
 * 新增／編輯發票表單（Invoice form）
 *
 * - AP 與 AR 共用：依 type 切換「供應商／客戶」等字樣。
 * - 稅額可選 SST 稅率自動計算（6% / 8% / 10%），也可自行輸入。
 * - 總金額即時顯示 = 發票金額 + 稅額。
 * - 送出前以 zod 驗證欄位，並檢查重複發票號碼；伺服器端錯誤也會對應回欄位顯示。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Modal, SelectInput, TextArea, TextInput } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { addDays, daysBetween } from '@/domain/dates';
import { formatMYR, senToDecimalString, taxFromRate, toSen } from '@/domain/money';
import { kindForType, TYPE_LABELS, type ComputedInvoice, type InvoiceType } from '@/domain/types';
import { DomainError, fieldErrors, findDuplicateInvoice, invoiceFormSchema, type InvoiceFormInput } from '@/domain/validation';
import { useCounterparties, useInvoiceMutations, useInvoices } from '@/hooks/useFinanceData';
import type { Attachment } from '@/domain/types';
import { AttachmentError, attachmentsEnabled, autoFillEnabled, deleteAttachmentFile, extractInvoiceDetails, uploadAttachment } from '@/lib/attachments';
import { AttachmentDrop, AttachmentList } from './AttachmentDrop';

const TAX_RATES = [
  { value: '0', label: 'No tax (0%)' },
  { value: '6', label: 'SST 6%' },
  { value: '8', label: 'SST 8% (services)' },
  { value: '10', label: 'SST 10% (goods)' },
  { value: 'custom', label: 'Custom amount' },
];

/** 由既有稅額推回可能的稅率選項（編輯時使用）。 */
function guessRate(amountSen: number, taxSen: number): string {
  if (taxSen === 0) return '0';
  const match = ['6', '8', '10'].find((r) => taxFromRate(amountSen, Number(r)) === taxSen);
  return match ?? 'custom';
}

export function InvoiceFormModal({ type, invoice, open, onClose, onSaved, initialFile }: {
  type: InvoiceType; invoice?: ComputedInvoice | null; open: boolean; onClose: () => void; onSaved?: (id: string) => void;
  /** 開啟表單時立即上傳並讀取的附件（例如從清單頁「上傳發票」進入）。 */
  initialFile?: File | null;
}) {
  const L = TYPE_LABELS[type];
  const isEdit = !!invoice;
  const { invoices, today } = useInvoices();
  const parties = useCounterparties(kindForType(type));
  const { create, update, addAttachment } = useInvoiceMutations();
  const toast = useToast();

  const [values, setValues] = useState<Required<InvoiceFormInput>>(() => ({
    invoiceNumber: invoice?.invoiceNumber ?? '',
    counterpartyName: invoice?.counterpartyName ?? '',
    invoiceDate: invoice?.invoiceDate ?? today,
    dueDate: invoice?.dueDate ?? addDays(today, 30),
    description: invoice?.description ?? '',
    invoiceAmount: invoice ? senToDecimalString(invoice.invoiceAmount) : '',
    taxAmount: invoice ? senToDecimalString(invoice.taxAmount) : '0.00',
  }));
  const [rate, setRate] = useState(() => (invoice ? guessRate(invoice.invoiceAmount, invoice.taxAmount) : '0'));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const saving = create.isPending || update.isPending || addAttachment.isPending;

  // ---------- 附件與自動填寫 ----------
  const canAttach = attachmentsEnabled();
  /** 本次表單新上傳、尚未存到發票上的附件。 */
  const [newFiles, setNewFiles] = useState<Attachment[]>([]);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState<{ tone: 'info' | 'warning' | 'error'; text: string; warnings: string[] } | null>(null);
  /** 由附件自動填入的欄位（畫面上標示，提醒使用者確認）。 */
  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set());
  const savedRef = useRef(false);
  const newFilesRef = useRef<Attachment[]>([]);
  newFilesRef.current = newFiles;

  // 關閉表單但未儲存：刪除這次上傳的檔案，避免留下沒有發票對應的檔案
  useEffect(() => () => {
    if (!savedRef.current) newFilesRef.current.forEach((a) => void deleteAttachmentFile(a.id));
  }, []);

  const handleFile = async (file: File) => {
    setReadNote(null);
    setReading(true);
    const uploadP = uploadAttachment(file);
    const readP = autoFillEnabled() ? extractInvoiceDetails(file, type) : Promise.reject(new AttachmentError(''));
    try {
      const att = await uploadP;
      setNewFiles((list) => [...list, att]);
    } catch (e) {
      setReading(false);
      setReadNote({ tone: 'error', text: e instanceof Error ? e.message : 'Upload failed', warnings: [] });
      readP.catch(() => undefined);
      return;
    }
    try {
      const { fields, warnings } = await readP;
      const keys = Object.keys(fields) as (keyof InvoiceFormInput)[];
      if (!keys.length) {
        setReadNote({ tone: 'warning', text: `${file.name} is attached, but no invoice details were found in it. Please fill them in.`, warnings: [] });
        return;
      }
      setValues((v) => ({ ...v, ...fields }));
      // 稅額若剛好等於某個 SST 稅率，就選該稅率；否則設為自訂
      const amt = toSen(fields.invoiceAmount ?? values.invoiceAmount);
      const tax = toSen(fields.taxAmount ?? values.taxAmount);
      if (amt !== null && tax !== null) setRate(guessRate(amt, tax));
      setAutoFilled(new Set(keys));
      setErrors({});
      // 立即檢查是否已輸入過這張發票
      const merged = { ...values, ...fields };
      const dup = findDuplicateInvoice(invoices, { id: invoice?.id, type, invoiceNumber: merged.invoiceNumber, counterpartyName: merged.counterpartyName });
      if (dup) setErrors({ invoiceNumber: `This invoice (${dup.invoiceNumber}, ${dup.counterpartyName}) is already in the system` });
      setReadNote({ tone: warnings.length ? 'warning' : 'info', text: `Details filled in from ${file.name}. Please check them before saving.`, warnings });
    } catch (e) {
      const msg = e instanceof Error && e.message ? e.message : '';
      setReadNote({ tone: msg ? 'warning' : 'info', text: msg ? `${file.name} is attached. ${msg}` : `${file.name} is attached.`, warnings: [] });
    } finally {
      setReading(false);
    }
  };

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return; // React 開發模式會執行兩次 effect，避免重複上傳
    startedRef.current = true;
    if (initialFile && canAttach) void handleFile(initialFile);
    // 只在表單開啟時處理一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeNewFile = (a: Attachment) => {
    setNewFiles((list) => list.filter((x) => x.id !== a.id));
    void deleteAttachmentFile(a.id);
  };
  const filledHint = (field: keyof InvoiceFormInput) => (autoFilled.has(field) ? '✓ From attachment' : undefined);

  const set = (field: keyof InvoiceFormInput, value: string) => {
    setValues((v) => {
      const next = { ...v, [field]: value };
      // 選了稅率時，金額變動會自動重算稅額
      if (field === 'invoiceAmount' && rate !== 'custom') {
        const amt = toSen(value);
        next.taxAmount = amt !== null && amt >= 0 ? senToDecimalString(taxFromRate(amt, Number(rate))) : v.taxAmount;
      }
      return next;
    });
    setErrors((e) => ({ ...e, [field]: '' }));
    setAutoFilled((s0) => { if (!s0.has(field)) return s0; const n = new Set(s0); n.delete(field); return n; });
  };

  const changeRate = (r: string) => {
    setRate(r);
    if (r !== 'custom') {
      const amt = toSen(values.invoiceAmount) ?? 0;
      setValues((v) => ({ ...v, taxAmount: senToDecimalString(taxFromRate(amt, Number(r))) }));
    }
  };

  // 即時總額（輸入不完整時顯示 —）
  const total = useMemo(() => {
    const a = toSen(values.invoiceAmount);
    const t = toSen(values.taxAmount);
    return a !== null && t !== null ? a + t : null;
  }, [values.invoiceAmount, values.taxAmount]);
  const terms = daysBetween(values.invoiceDate || today, values.dueDate || today);

  const submit = async () => {
    setFormError('');
    const parsed = invoiceFormSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    // 先在前端檢查重複號碼，提供即時回饋（資料庫仍會再檢查一次）
    const dup = findDuplicateInvoice(invoices, { id: invoice?.id, type, invoiceNumber: parsed.data.invoiceNumber, counterpartyName: parsed.data.counterpartyName });
    if (dup) {
      setErrors({ invoiceNumber: type === 'AR' ? `Invoice number ${dup.invoiceNumber} already exists` : `${dup.counterpartyName} already has invoice ${dup.invoiceNumber}` });
      return;
    }
    try {
      const saved = isEdit ? await update.mutateAsync([invoice!.id, parsed.data]) : await create.mutateAsync([type, parsed.data]);
      for (const att of newFiles) await addAttachment.mutateAsync([saved.id, att]);
      savedRef.current = true;
      toast(isEdit ? `Invoice ${saved.invoiceNumber} updated` : `Invoice ${saved.invoiceNumber} created`);
      onSaved?.(saved.id);
      onClose();
    } catch (e) {
      if (e instanceof DomainError && e.field) setErrors({ [e.field]: e.message });
      else setFormError(e instanceof Error ? e.message : 'Could not save the invoice');
    }
  };

  const paidNote = isEdit && invoice!.amountPaid > 0
    ? `${formatMYR(invoice!.amountPaid)} already paid — the total cannot go below this.` : undefined;

  return (
    <Modal open={open} onClose={onClose} size="md"
      title={isEdit ? `Edit invoice ${invoice!.invoiceNumber}` : L.newInvoice}
      subtitle={L.module}
      footer={<>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={saving} data-testid="save-invoice">{isEdit ? 'Save changes' : 'Create invoice'}</Button>
      </>}>
      <form className="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        {canAttach && (
          <div className="space-y-2 sm:col-span-2" data-testid="attachment-area">
            <AttachmentDrop onFile={(f) => void handleFile(f)} busy={reading}
              label={reading ? 'Reading invoice…' : autoFillEnabled() ? 'Upload invoice (PDF or photo) to fill in the details' : 'Attach the invoice (PDF or photo)'}
              hint={autoFillEnabled() ? 'Invoice number, name, dates and amounts are filled in automatically. Max 20 MB.' : 'PDF, JPG, PNG or WebP, up to 20 MB.'} />
            {readNote && (
              <div className={readNote.tone === 'error' ? 'rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200'
                : readNote.tone === 'warning' ? 'rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200'
                  : 'rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900 ring-1 ring-sky-200'} role="status" data-testid="read-note">
                <p>{readNote.text}</p>
                {readNote.warnings.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs">{readNote.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
              </div>
            )}
            <AttachmentList items={newFiles} onRemove={removeNewFile} />
          </div>
        )}
        <TextInput label="Invoice Number *" value={values.invoiceNumber} error={errors.invoiceNumber} maxLength={50} hint={filledHint('invoiceNumber')}
          placeholder={type === 'AR' ? 'e.g. INV-10301' : 'As printed on the supplier invoice'} onChange={(e) => set('invoiceNumber', e.target.value)} />
        <TextInput label={`${L.party} Name *`} value={values.counterpartyName} error={errors.counterpartyName} list={`${type}-parties`} maxLength={150}
          hint={filledHint('counterpartyName') ?? `Pick an existing ${L.party.toLowerCase()} or type a new name`} onChange={(e) => set('counterpartyName', e.target.value)} />
        <datalist id={`${type}-parties`}>{parties.data?.map((p) => <option key={p.id} value={p.name} />)}</datalist>

        <TextInput label="Invoice Date *" type="date" value={values.invoiceDate} error={errors.invoiceDate} hint={filledHint('invoiceDate')} onChange={(e) => set('invoiceDate', e.target.value)} />
        <div>
          <TextInput label="Due Date *" type="date" value={values.dueDate} error={errors.dueDate} min={values.invoiceDate}
            hint={!errors.dueDate && terms >= 0 ? `${autoFilled.has('dueDate') ? '✓ From attachment · ' : ''}Payment terms: ${terms} days` : undefined} onChange={(e) => set('dueDate', e.target.value)} />
          <div className="mt-1.5 flex gap-1.5">
            {[30, 45, 60].map((d) => (
              <button key={d} type="button" onClick={() => set('dueDate', addDays(values.invoiceDate || today, d))}
                className="rounded-md px-2 py-0.5 text-xs font-medium text-navy-700 ring-1 ring-navy-200 hover:bg-navy-50">{d} days</button>
            ))}
          </div>
        </div>

        <TextArea label="Description" containerClassName="sm:col-span-2" rows={2} maxLength={500} value={values.description} error={errors.description} hint={filledHint('description')}
          placeholder="What is this invoice for?" onChange={(e) => set('description', e.target.value)} />

        <TextInput label="Invoice Amount (RM) *" inputMode="decimal" value={values.invoiceAmount} error={errors.invoiceAmount} hint={paidNote ?? filledHint('invoiceAmount')}
          placeholder="0.00" onChange={(e) => set('invoiceAmount', e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <SelectInput label="Tax rate" value={rate} onChange={(e) => changeRate(e.target.value)}>
            {TAX_RATES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </SelectInput>
          <TextInput label="Tax Amount (RM)" inputMode="decimal" value={values.taxAmount} error={errors.taxAmount} hint={filledHint('taxAmount')}
            onChange={(e) => { setRate('custom'); set('taxAmount', e.target.value); }} />
        </div>

        <div className="flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3 ring-1 ring-slate-200 sm:col-span-2">
          <span className="text-sm text-slate-600">Total Amount (invoice + tax)</span>
          <span className="tabular text-lg font-semibold text-slate-900" data-testid="form-total">{total === null ? '—' : formatMYR(total)}</span>
        </div>
        {type === 'AP' && !isEdit && <p className="text-xs text-slate-500 sm:col-span-2">New supplier invoices start as <strong>Pending Approval</strong>. An admin must approve them before payment.</p>}
        {formError && <div className="sm:col-span-2"><Alert>{formError}</Alert></div>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
