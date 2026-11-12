/**
 * 通用資料表格（Reusable data table）
 *
 * - 以欄位定義（columns）描述每一欄，可排序、可設定對齊與手機版隱藏。
 * - 支援分頁、合計列（footer）、點擊整列開啟明細。
 * - 金額欄請設定 align: 'right'，數字會自動使用等寬字型。
 */
import { useMemo, useState, type ReactNode } from 'react';
import { cx, EmptyState } from './index';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** 排序用的值；未提供則該欄不可排序。 */
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right';
  /** 在小螢幕隱藏較次要的欄位。 */
  hideOnMobile?: boolean;
  /** 只在超寬螢幕（≥1536px）顯示的欄位，例如明細金額。 */
  wideOnly?: boolean;
  footer?: ReactNode;
  className?: string;
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  pageSize?: number;
  emptyTitle?: string;
  emptyDescription?: string;
  rowClassName?: (row: T) => string;
  testId?: string;
}

export function DataTable<T>({
  rows, columns, rowKey, onRowClick, initialSort, pageSize = 25, emptyTitle = 'No records found', emptyDescription, rowClassName, testId,
}: Props<T>) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = col.sortValue!(a);
      const y = col.sortValue!(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * factor;
    });
  }, [rows, columns, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const hasFooter = columns.some((c) => c.footer !== undefined);

  const toggleSort = (key: string) => {
    setPage(0);
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  };

  if (!rows.length) return <EmptyState title={emptyTitle} description={emptyDescription} />;

  const cellCls = (c: Column<T>) => cx('px-4 py-3', c.align === 'right' && 'text-right tabular whitespace-nowrap', c.hideOnMobile && 'hidden md:table-cell', c.wideOnly && 'hidden 2xl:table-cell', c.className);

  return (
    <div data-testid={testId}>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/80">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cx(cellCls(c), 'py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap')}
                  aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.sortValue ? (
                    <button type="button" onClick={() => toggleSort(c.key)} className={cx('inline-flex items-center gap-1 uppercase hover:text-slate-800', c.align === 'right' && 'flex-row-reverse')}>
                      {c.header}
                      <span className={cx('text-[10px]', sort?.key === c.key ? 'text-navy-700' : 'text-slate-300')} aria-hidden>
                        {sort?.key === c.key && sort.dir === 'desc' ? '▼' : '▲'}
                      </span>
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.map((row) => (
              <tr key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cx(onRowClick && 'cursor-pointer hover:bg-navy-50/50', rowClassName?.(row))}>
                {columns.map((c) => <td key={c.key} className={cx(cellCls(c), 'align-top text-slate-700')}>{c.render(row)}</td>)}
              </tr>
            ))}
          </tbody>
          {hasFooter && (
            <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-slate-900">
              <tr>{columns.map((c) => <td key={c.key} className={cellCls(c)}>{c.footer}</td>)}</tr>
            </tfoot>
          )}
        </table>
      </div>
      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
          <span>{safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, sorted.length)} of {sorted.length}</span>
          <div className="flex gap-2">
            <button type="button" className="rounded-md px-2.5 py-1 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-40" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Previous</button>
            <button type="button" className="rounded-md px-2.5 py-1 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-40" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
