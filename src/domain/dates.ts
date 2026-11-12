/**
 * 日期工具（Date utilities）
 *
 * 所有日期均以 ISO 字串 "YYYY-MM-DD" 表示（不含時間），可直接以字串比較大小。
 * 「今天」以公司所在時區（馬來西亞，Asia/Kuala_Lumpur）計算，
 * 確保所有使用者看到的「是否逾期」結果一致，不受個人電腦時區影響。
 */

export const COMPANY_TIME_ZONE = 'Asia/Kuala_Lumpur';

/** ISO 日期字串，例如 "2026-11-12"。 */
export type IsoDate = string;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 取得公司時區的「今天」。 */
export function todayIso(now: Date = new Date(), timeZone: string = COMPANY_TIME_ZONE): IsoDate {
  // en-CA 語系的日期格式剛好是 YYYY-MM-DD
  return now.toLocaleDateString('en-CA', { timeZone });
}

/** 檢查是否為真實存在的日期（例如排除 2026-02-30）。 */
export function isValidIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** 兩個日期相差天數（to − from）。以 UTC 計算以避開夏令時間問題。 */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** 日期加減天數。 */
export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 取得月份鍵值，例如 "2026-11-12" → "2026-11"。 */
export function monthKey(date: IsoDate): string {
  return date.slice(0, 7);
}

/** 由今天往回推 n 個月（含本月）的月份鍵值，由舊到新排序。 */
export function lastNMonths(today: IsoDate, n: number): string[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  return keys;
}

/** 顯示用日期格式，例如 "12 Nov 2026"。 */
export function formatDate(date: IsoDate | null | undefined): string {
  if (!date) return '—';
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** 顯示用月份格式，例如 "2026-11" → "Nov 26"。 */
export function formatMonth(key: string): string {
  const d = new Date(`${key}-01T00:00:00Z`);
  return d.toLocaleDateString('en-MY', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

/** 顯示用日期時間（活動紀錄用），以公司時區呈現。 */
export function formatDateTime(isoTimestamp: string | null | undefined): string {
  if (!isoTimestamp) return '—';
  return new Date(isoTimestamp).toLocaleString('en-MY', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: COMPANY_TIME_ZONE,
  });
}
