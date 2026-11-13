/**
 * 給主管的每週摘要：一鍵產生，可複製文字（WhatsApp／電郵）或下載 Excel。
 * 可切換「本週」與「上週」（週一至週日）。
 */
import { useMemo, useRef, useState } from 'react';
import { Button, cx, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { formatDate } from '@/domain/dates';
import { buildWeeklySummary, weeklySummaryText } from '@/domain/weeklySummary';
import type { ComputedInvoice } from '@/domain/types';
import { useClaims } from '@/features/claims/ClaimsPage';
import { isDeclined } from '@/lib/download';

export function WeeklySummaryModal({ invoices, today, companyName, onClose }: { invoices: ComputedInvoice[]; today: string; companyName?: string; onClose: () => void }) {
  const { claims } = useClaims();
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const summary = useMemo(() => buildWeeklySummary(invoices, claims, today, offset), [invoices, claims, today, offset]);
  const text = useMemo(() => weeklySummaryText(summary, companyName), [summary, companyName]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Summary copied. Paste it into WhatsApp or email.');
    } catch {
      // 剪貼簿不可用（例如在內嵌頁面中）：選取文字，讓使用者自行複製
      area.current?.focus();
      area.current?.select();
      const ok = (() => { try { return document.execCommand('copy'); } catch { return false; } })();
      toast(ok ? 'Summary copied. Paste it into WhatsApp or email.' : 'The text is selected. Press and hold (or Ctrl+C) to copy it.');
    }
  };
  const excel = async () => {
    setBusy(true);
    try {
      const { buildWeeklySummaryWorkbook, downloadWorkbook } = await import('@/lib/excelExport');
      await downloadWorkbook(await buildWeeklySummaryWorkbook(summary, companyName), `Weekly-Summary-${summary.from}.xlsx`);
      toast('Excel file downloaded');
    } catch (e) {
      if (!isDeclined(e)) toast(e instanceof Error ? e.message : 'Export failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} size="md" title="Weekly summary for management" subtitle={`${formatDate(summary.from)} to ${formatDate(summary.to)} · figures as of ${formatDate(today)}`}
      footer={<><Button onClick={onClose}>Close</Button><Button onClick={() => void excel()} loading={busy} data-testid="summary-excel">Download Excel</Button><Button variant="primary" onClick={() => void copy()} data-testid="summary-copy">Copy text</Button></>}>
      <div className="mb-3 inline-flex rounded-lg bg-slate-100 p-0.5 text-sm" role="tablist" aria-label="Week">
        {[[0, 'This week'], [-1, 'Last week']].map(([o, label]) => (
          <button key={o} type="button" role="tab" aria-selected={offset === o} onClick={() => setOffset(o as number)} data-testid={`summary-week-${o}`}
            className={cx('rounded-md px-3 py-1.5 font-medium', offset === o ? 'bg-white text-navy-800 shadow-sm' : 'text-slate-500')}>{label}</button>
        ))}
      </div>
      <textarea ref={area} readOnly value={text} rows={18} aria-label="Summary text" data-testid="summary-text"
        className="block w-full rounded-xl border-0 bg-slate-50 px-4 py-3 font-mono text-[12.5px] leading-relaxed text-slate-800 ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-navy-500" />
      <p className="mt-2 text-xs text-slate-500">The *stars* make headings bold in WhatsApp. Everything is calculated from your invoices, payments and claims.</p>
    </Modal>
  );
}
