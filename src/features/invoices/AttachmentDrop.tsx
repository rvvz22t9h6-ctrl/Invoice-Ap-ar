/**
 * 附件上傳區（可拖放或點擊選擇檔案），以及附件清單。
 */
import { useRef, useState, type ReactNode } from 'react';
import { cx, Spinner } from '@/components/ui';
import type { Attachment } from '@/domain/types';
import { ACCEPT_ATTR, attachmentUrl } from '@/lib/attachments';

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentDrop({ onFile, busy, label, hint }: { onFile: (f: File) => void; busy?: boolean; label: string; hint: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f && !busy) onFile(f); }}
      className={cx('flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed px-4 py-3 transition-colors',
        over ? 'border-navy-500 bg-navy-50' : 'border-slate-300 bg-slate-50/60')}
    >
      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-white text-navy-700 ring-1 ring-slate-200" aria-hidden>
        {busy ? <Spinner className="size-4" /> : (
          <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 13.5 10 9.5l4 4M10 9.5V17M4.5 13A3.5 3.5 0 0 1 5 6a5 5 0 0 1 9.6 1.2A3 3 0 0 1 15.5 13" strokeLinecap="round" strokeLinejoin="round" /></svg>
        )}
      </div>
      <div className="min-w-0 flex-1 text-sm">
        <button type="button" disabled={busy} onClick={() => input.current?.click()} className="font-medium text-navy-700 hover:underline disabled:opacity-60" data-testid="attach-button">
          {label}
        </button>
        <span className="text-slate-500"> or drag a file here</span>
        <p className="text-xs text-slate-500">{hint}</p>
      </div>
      <input ref={input} type="file" accept={ACCEPT_ATTR} className="hidden" data-testid="attach-input" id="attach-input"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
    </div>
  );
}

export function AttachmentList({ items, onRemove }: { items: Attachment[]; onRemove?: (a: Attachment) => void }) {
  if (!items.length) return null;
  return (
    <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200" data-testid="attachment-list">
      {items.map((a) => (
        <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-sm">
          <span className={cx('rounded px-1.5 py-0.5 text-[10px] font-bold text-white', a.contentType === 'application/pdf' ? 'bg-red-700' : 'bg-navy-600')}>
            {a.contentType === 'application/pdf' ? 'PDF' : 'IMG'}
          </span>
          <a href={attachmentUrl(a.id)} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-medium text-navy-800 hover:underline" title={`Open ${a.name}`}>
            {a.name}
          </a>
          <span className="shrink-0 text-xs text-slate-500">{formatBytes(a.sizeBytes)}</span>
          {onRemove && (
            <button type="button" onClick={() => onRemove(a)} className="shrink-0 rounded px-1.5 text-xs font-medium text-slate-500 hover:bg-red-50 hover:text-red-700" aria-label={`Remove ${a.name}`}>
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
