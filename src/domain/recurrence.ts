/**
 * 週期任務引擎（Recurring task engine）
 *
 * 規則支援：每日、每週（可選星期幾）、每月（指定日期或月底）、每季、每年、自訂（每 N 天／週／月）。
 * 週末調整：到期日遇到週六日時，可提前到週五或延後到週一（財務常見做法）。
 *
 * 自動產生任務的保證：
 *   1. 不重複：任務 ID = rec-<規則ID>-<排程日期>；已存在就不再建立。
 *   2. 不遺漏：記錄 generatedThrough（已處理到哪一天）；多天沒開系統，下次開啟會補產生，並顯示為逾期。
 *   3. 不刪除逾期任務：產生器只會新增；重新設定規則時，只移除「未來、尚未開始、未修改過」的任務。
 *   4. 保留原到期日：逾期任務的日期永遠不被改寫。
 *   5. 使用者刪除的單次任務記入 skipDates，不會被重新產生。
 */
import { addDays, daysBetween, type IsoDate } from './dates';
import type { Task, TaskCategory, TaskPriority } from './tasks';

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom';
export type CustomUnit = 'day' | 'week' | 'month';
export type WeekendAdjust = 'none' | 'previous' | 'next';

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly', custom: 'Custom',
};
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface RecurrenceRule {
  id: string;
  title: string;
  description: string;
  category: TaskCategory;
  priority: TaskPriority;
  remarks: string;
  frequency: Frequency;
  /** 每隔幾個單位（≥1）。每季 = 每 3 個月 × interval。 */
  interval: number;
  /** 自訂頻率的單位。 */
  customUnit: CustomUnit;
  /** 每週（或自訂「週」）要在哪幾天：0 = 週日 … 6 = 週六。 */
  weekdays: number[];
  /** 每月／每季／每年的日期：1–31，−1 = 該月最後一天。超過該月天數時以月底計。 */
  dayOfMonth: number;
  /** 每年的月份（1–12）。 */
  month: number;
  weekendAdjust: WeekendAdjust;
  /** 提前幾天開始（任務開始日 = 到期日 − leadDays）。 */
  leadDays: number;
  startDate: IsoDate;
  endDate: IsoDate | null;
  active: boolean;
  /** 已產生到哪一個排程日期（含）。 */
  generatedThrough: IsoDate | null;
  /** 使用者刪除過、不再產生的排程日期。 */
  skipDates: IsoDate[];
  createdAt: string;
  updatedAt: string;
}

/** 預設往後產生多少天的任務（讓「即將到期」與行事曆看得到）。 */
export const GENERATION_HORIZON_DAYS = 30;
/** 單次執行每條規則最多產生的任務數（防止錯誤設定造成大量資料）。 */
const MAX_PER_RUN = 400;

// ---------------------------------------------------------------------------
// 日期工具
// ---------------------------------------------------------------------------

const parts = (d: IsoDate) => d.split('-').map(Number) as [number, number, number];
const iso = (y: number, m: number, day: number) => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** 0 = 週日 … 6 = 週六。 */
export const weekday = (d: IsoDate) => new Date(`${d}T00:00:00Z`).getUTCDay();
/** 該月第 dayOfMonth 天（−1 或超過天數 → 月底）。 */
function monthDay(y: number, m: number, dayOfMonth: number): IsoDate {
  const last = daysInMonth(y, m);
  return iso(y, m, dayOfMonth < 0 || dayOfMonth > last ? last : dayOfMonth);
}
/** 加 n 個月（只用於年月計算）。 */
function addMonthsYM(y: number, m: number, n: number): [number, number] {
  const t = y * 12 + (m - 1) + n;
  return [Math.floor(t / 12), (t % 12) + 1];
}
/** 該日所在週的週一。 */
const mondayOf = (d: IsoDate) => addDays(d, -((weekday(d) + 6) % 7));

/** 週末調整：週六／日 → 前一個週五或下一個週一。 */
export function adjustForWeekend(d: IsoDate, mode: WeekendAdjust): IsoDate {
  const w = weekday(d);
  if (mode === 'none' || (w !== 0 && w !== 6)) return d;
  if (mode === 'previous') return addDays(d, w === 6 ? -1 : -2);
  return addDays(d, w === 6 ? 2 : 1);
}

// ---------------------------------------------------------------------------
// 排程日期
// ---------------------------------------------------------------------------

/** 有效頻率：把每季、自訂等統一成「每 N 天／週／月」。 */
function normalize(rule: RecurrenceRule): { unit: 'day' | 'week' | 'month' | 'year'; every: number } {
  const n = Math.max(1, Math.floor(rule.interval || 1));
  switch (rule.frequency) {
    case 'daily': return { unit: 'day', every: n };
    case 'weekly': return { unit: 'week', every: n };
    case 'monthly': return { unit: 'month', every: n };
    case 'quarterly': return { unit: 'month', every: 3 * n };
    case 'yearly': return { unit: 'year', every: n };
    case 'custom': return { unit: rule.customUnit, every: n };
    default: return { unit: 'day', every: n };
  }
}

/**
 * 列出 [from, to] 之間的排程日期（週末調整前），並限制在規則的開始／結束日期內。
 */
export function scheduledDates(rule: RecurrenceRule, from: IsoDate, to: IsoDate, limit = MAX_PER_RUN): IsoDate[] {
  const lo = from > rule.startDate ? from : rule.startDate;
  const hi = rule.endDate && rule.endDate < to ? rule.endDate : to;
  if (lo > hi) return [];
  const { unit, every } = normalize(rule);
  const out: IsoDate[] = [];
  const push = (d: IsoDate) => { if (d >= lo && d <= hi && d >= rule.startDate && out.length < limit) out.push(d); };

  if (unit === 'day') {
    // 從開始日起每 every 天；直接跳到 lo 附近
    const offset = Math.max(0, daysBetween(rule.startDate, lo));
    let k = Math.ceil(offset / every);
    for (let d = addDays(rule.startDate, k * every); d <= hi && out.length < limit; k += 1, d = addDays(rule.startDate, k * every)) push(d);
  } else if (unit === 'week') {
    const days = (rule.weekdays.length ? rule.weekdays : [weekday(rule.startDate)]).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const week0 = mondayOf(rule.startDate);
    let w = Math.max(0, Math.floor(daysBetween(week0, mondayOf(lo)) / 7));
    w -= w % every;
    for (let monday = addDays(week0, w * 7); monday <= hi && out.length < limit; w += every, monday = addDays(week0, w * 7)) {
      for (const wd of days) push(addDays(monday, (wd + 6) % 7));
    }
  } else {
    const [sy, sm] = parts(rule.startDate);
    const stepMonths = unit === 'year' ? 12 * every : every;
    // 每年：以規則指定的月份為準；其他：以開始日的月份為基準
    const baseMonth = unit === 'year' ? rule.month || sm : sm;
    let [by, bm] = [sy, baseMonth];
    if (unit === 'year' && baseMonth < sm) [by, bm] = [sy + 1, baseMonth];
    const [ly, lm] = parts(lo);
    let k = Math.max(0, Math.floor(((ly * 12 + lm) - (by * 12 + bm)) / stepMonths) - 1);
    for (;; k += 1) {
      const [y, m] = addMonthsYM(by, bm, k * stepMonths);
      const d = monthDay(y, m, rule.dayOfMonth || parts(rule.startDate)[2]);
      if (d > hi || out.length >= limit) break;
      push(d);
    }
  }
  return out;
}

/** 週期任務的固定 ID：同一規則、同一排程日期 → 同一個 ID。 */
export const occurrenceTaskId = (ruleId: string, occurrence: IsoDate) => `rec-${ruleId}-${occurrence}`;

/**
 * 產生到期的週期任務。
 * @returns 新任務（不含已存在者）與更新後的規則（generatedThrough 前進）。
 */
export function generateRecurringTasks(
  rules: RecurrenceRule[], existingIds: Set<string>, today: IsoDate, nowIso: string, horizonDays = GENERATION_HORIZON_DAYS,
): { tasks: Task[]; rules: RecurrenceRule[] } {
  const until = addDays(today, horizonDays);
  const created: Task[] = [];
  const updated = rules.map((rule) => {
    if (!rule.active) return rule;
    const from = rule.generatedThrough ? addDays(rule.generatedThrough, 1) : rule.startDate;
    const to = rule.endDate && rule.endDate < until ? rule.endDate : until;
    if (from > to) return rule;
    const dates = scheduledDates(rule, from, to);
    for (const occ of dates) {
      if (rule.skipDates.includes(occ)) continue;
      const id = occurrenceTaskId(rule.id, occ);
      if (existingIds.has(id)) continue; // 不重複
      existingIds.add(id);
      const due = adjustForWeekend(occ, rule.weekendAdjust);
      created.push({
        id, title: rule.title, description: rule.description, category: rule.category, priority: rule.priority,
        startDate: rule.leadDays > 0 ? addDays(due, -rule.leadDays) : null, dueDate: due, status: 'todo', remarks: rule.remarks,
        createdAt: nowIso, updatedAt: nowIso, completedAt: null, completedOn: null, recurrenceId: rule.id, occurrenceDate: occ,
      });
    }
    // 若因上限而截斷，只前進到最後一筆，下次繼續
    const through = dates.length >= MAX_PER_RUN ? dates[dates.length - 1]! : to;
    return { ...rule, generatedThrough: through };
  });
  return { tasks: created, rules: updated };
}

/**
 * 規則修改後：移除「未來、尚未開始且未修改過」的已產生任務，並把 generatedThrough 退回今天，
 * 讓未來的任務依新設定重新產生。過去與逾期任務一律保留。
 */
export function resetFutureOccurrences(rule: RecurrenceRule, tasks: Task[], today: IsoDate): { keep: Task[]; removedIds: string[]; rule: RecurrenceRule } {
  const removed = tasks.filter((t) => t.recurrenceId === rule.id && t.status === 'todo' && t.dueDate > today && t.createdAt === t.updatedAt);
  const ids = new Set(removed.map((t) => t.id));
  const yesterday = addDays(today, -1);
  const through = rule.generatedThrough && rule.generatedThrough < yesterday ? rule.generatedThrough : (rule.startDate > yesterday ? null : yesterday);
  return { keep: tasks.filter((t) => !ids.has(t.id)), removedIds: [...ids], rule: { ...rule, generatedThrough: through } };
}

/** 規則的白話描述，例如「Monthly on day 15 · moved to Friday if weekend」。 */
export function describeRule(r: Pick<RecurrenceRule, 'frequency' | 'interval' | 'customUnit' | 'weekdays' | 'dayOfMonth' | 'month' | 'weekendAdjust' | 'startDate'>): string {
  const n = Math.max(1, r.interval || 1);
  const dom = r.dayOfMonth === -1 ? 'the last day' : `day ${r.dayOfMonth || parts(r.startDate)[2]}`;
  const days = (r.weekdays.length ? r.weekdays : [weekday(r.startDate)]).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WEEKDAY_SHORT[d]).join(', ');
  let base: string;
  switch (r.frequency) {
    case 'daily': base = n === 1 ? 'Every day' : `Every ${n} days`; break;
    case 'weekly': base = `${n === 1 ? 'Every week' : `Every ${n} weeks`} on ${days}`; break;
    case 'monthly': base = `${n === 1 ? 'Monthly' : `Every ${n} months`} on ${dom}`; break;
    case 'quarterly': base = `${n === 1 ? 'Quarterly' : `Every ${n} quarters`} on ${dom}`; break;
    case 'yearly': base = `${n === 1 ? 'Yearly' : `Every ${n} years`} on ${r.dayOfMonth === -1 ? 'the last day of' : `${r.dayOfMonth || parts(r.startDate)[2]}`} ${MONTHS[(r.month || parts(r.startDate)[1]) - 1]}`; break;
    default:
      base = r.customUnit === 'day' ? `Every ${n} day${n === 1 ? '' : 's'}`
        : r.customUnit === 'week' ? `Every ${n} week${n === 1 ? '' : 's'} on ${days}`
          : `Every ${n} month${n === 1 ? '' : 's'} on ${dom}`;
  }
  const adj = r.weekendAdjust === 'previous' ? ' · moved to Friday if it falls on a weekend' : r.weekendAdjust === 'next' ? ' · moved to Monday if it falls on a weekend' : '';
  return base + adj;
}

/** 下一次的到期日（顯示用）。 */
export function nextDueDate(rule: RecurrenceRule, today: IsoDate): IsoDate | null {
  const d = scheduledDates(rule, today, addDays(today, 800), 1)[0];
  return d ? adjustForWeekend(d, rule.weekendAdjust) : null;
}
