/**
 * 共用 UI 元件（Reusable UI components）
 *
 * 所有頁面共用這些元件，確保外觀一致、方便維護。
 * 只負責「呈現」，不包含任何業務邏輯或資料存取。
 */
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import type { ApprovalStatus, PaymentStatus } from '@/domain/types';
import { APPROVAL_LABEL } from '@/domain/types';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

// ---------------------------------------------------------------------------
// 按鈕
// ---------------------------------------------------------------------------
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-navy-800 text-white hover:bg-navy-700 shadow-sm disabled:bg-navy-300',
  secondary: 'bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 shadow-sm',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-white text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-50',
  success: 'bg-emerald-700 text-white hover:bg-emerald-600 shadow-sm',
};

export function Button({
  variant = 'secondary', size = 'md', loading, icon, children, className, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors whitespace-nowrap',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy-600 disabled:cursor-not-allowed disabled:opacity-60',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm',
        BUTTON_STYLES[variant], className,
      )}
    >
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ className = 'size-5' }: { className?: string }) {
  return (
    <svg className={cx('animate-spin text-current', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 卡片與版面
// ---------------------------------------------------------------------------
export function Card({ children, className, title, action, padded = true }: {
  children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode; padded?: boolean;
}) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,31,61,0.04)]', className)}>
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
          {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
          {action}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** KPI 卡片：顯示單一指標與補充說明。accent 為左側色條。 */
export function StatCard({ label, value, hint, accent = 'slate', testId }: {
  label: string; value: ReactNode; hint?: ReactNode; accent?: 'ar' | 'ap' | 'red' | 'navy' | 'slate' | 'green'; testId?: string;
}) {
  const bar: Record<string, string> = {
    ar: 'bg-series-ar', ap: 'bg-series-ap', red: 'bg-red-600', navy: 'bg-navy-800', slate: 'bg-slate-300', green: 'bg-emerald-600',
  };
  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-[0_1px_2px_rgba(15,31,61,0.04)]" data-testid={testId}>
      <span className={cx('absolute inset-y-0 left-0 w-1', bar[accent])} aria-hidden />
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="tabular mt-1.5 text-[1.6rem] leading-tight font-semibold text-slate-900" data-testid={testId ? `${testId}-value` : undefined}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <div className="grid size-10 place-items-center rounded-full bg-slate-100 text-slate-400" aria-hidden>
        <svg viewBox="0 0 20 20" className="size-5" fill="currentColor"><path d="M4 3h9l3 3v11H4z" opacity=".35" /><path d="M7 9h6v1.5H7zm0 3h6v1.5H7z" /></svg>
      </div>
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && <p className="max-w-sm text-sm text-slate-500">{description}</p>}
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 狀態標籤：顏色 + 文字（不只靠顏色辨識）
// ---------------------------------------------------------------------------
const STATUS_STYLES: Record<PaymentStatus, string> = {
  Pending: 'bg-slate-100 text-slate-700 ring-slate-300',
  'Partially Paid': 'bg-amber-50 text-amber-800 ring-amber-300',
  Paid: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  Overdue: 'bg-red-50 text-red-700 ring-red-300',
  Cancelled: 'bg-white text-slate-500 ring-slate-300 line-through decoration-slate-400',
};
const STATUS_DOT: Record<PaymentStatus, string> = {
  Pending: 'bg-slate-400', 'Partially Paid': 'bg-amber-500', Paid: 'bg-emerald-600', Overdue: 'bg-red-600', Cancelled: 'bg-slate-300',
};

export function StatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', STATUS_STYLES[status])}>
      <span className={cx('size-1.5 rounded-full', STATUS_DOT[status])} aria-hidden />
      {status}
    </span>
  );
}

const APPROVAL_STYLES: Record<ApprovalStatus, string> = {
  pending: 'bg-sky-50 text-sky-800 ring-sky-200',
  approved: 'bg-navy-50 text-navy-700 ring-navy-200',
  rejected: 'bg-rose-50 text-rose-700 ring-rose-200',
};

export function ApprovalBadge({ status }: { status: ApprovalStatus | null }) {
  if (!status) return null;
  const icon = status === 'approved' ? '✓' : status === 'rejected' ? '✕' : '…';
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', APPROVAL_STYLES[status])}>
      <span aria-hidden>{icon}</span>{APPROVAL_LABEL[status]}
    </span>
  );
}

export function TypeTag({ type }: { type: 'AP' | 'AR' }) {
  return (
    <span className={cx('inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white', type === 'AR' ? 'bg-series-ar' : 'bg-series-ap')}>
      {type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 表單欄位
// ---------------------------------------------------------------------------
const inputBase = 'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-inset placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-navy-600 disabled:bg-slate-50 disabled:text-slate-500';

export function Field({ label, error, hint, children, className, htmlFor }: {
  label: string; error?: string; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-slate-700">{label}</label>
      {children}
      {error ? <p className="mt-1 text-xs text-red-600" role="alert">{error}</p> : hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

type WithLabel = { label: string; error?: string; hint?: ReactNode; containerClassName?: string };

export function TextInput({ label, error, hint, containerClassName, ...props }: InputHTMLAttributes<HTMLInputElement> & WithLabel) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} className={containerClassName} htmlFor={id}>
      <input id={id} {...props} aria-invalid={!!error} className={cx(inputBase, error ? 'ring-red-400' : 'ring-slate-300', props.className)} />
    </Field>
  );
}

export function SelectInput({ label, error, hint, containerClassName, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & WithLabel) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} className={containerClassName} htmlFor={id}>
      <select id={id} {...props} aria-invalid={!!error} className={cx(inputBase, 'pr-8', error ? 'ring-red-400' : 'ring-slate-300')}>{children}</select>
    </Field>
  );
}

export function TextArea({ label, error, hint, containerClassName, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & WithLabel) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} className={containerClassName} htmlFor={id}>
      <textarea id={id} rows={3} {...props} aria-invalid={!!error} className={cx(inputBase, error ? 'ring-red-400' : 'ring-slate-300')} />
    </Field>
  );
}

/** 篩選列用的精簡下拉選單（無標籤文字，使用 aria-label）。 */
export function FilterSelect({ value, onChange, children, label }: { value: string; onChange: (v: string) => void; children: ReactNode; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border-0 bg-white py-2 pr-8 pl-3 text-sm text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-navy-600">
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------------
// 對話框
// ---------------------------------------------------------------------------
export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // 開啟時鎖定背景捲動、按 Esc 關閉、焦點移入對話框
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const first = panelRef.current?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), select, textarea');
    (first ?? panelRef.current)?.focus();
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [open, onClose]);

  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}
        className={cx('flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-2xl outline-none sm:rounded-2xl', width)}>
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-slate-500">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <svg viewBox="0 0 20 20" className="size-5" fill="currentColor"><path d="M5.3 4.2 10 8.9l4.7-4.7 1.1 1.1-4.7 4.7 4.7 4.7-1.1 1.1-4.7-4.7-4.7 4.7-1.1-1.1 4.7-4.7-4.7-4.7z" /></svg>
          </button>
        </header>
        <div className="overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3 sm:rounded-b-2xl sm:px-6">{footer}</footer>}
      </div>
    </div>
  );
}

/** 錯誤訊息方塊（表單整體錯誤用）。 */
export function Alert({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'info' | 'warning' }) {
  const styles = { error: 'bg-red-50 text-red-800 ring-red-200', info: 'bg-navy-50 text-navy-800 ring-navy-200', warning: 'bg-amber-50 text-amber-900 ring-amber-200' }[tone];
  return <div role={tone === 'error' ? 'alert' : 'status'} className={cx('rounded-lg px-3.5 py-2.5 text-sm ring-1 ring-inset', styles)}>{children}</div>;
}
