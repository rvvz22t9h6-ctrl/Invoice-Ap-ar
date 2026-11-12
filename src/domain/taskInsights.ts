/**
 * 任務總覽、提醒與生產力計算（Task insights）
 *
 *   今日任務     = 今天到期 + 逾期未完成（延續到今天，保留原到期日）
 *   已完成（今天）= 今天完成的任務（completedOn = 今天）
 *   待辦         = 尚未完成、未逾期的任務
 *   逾期         = 尚未完成且到期日已過
 *   即將到期     = 未來 7 天內到期、尚未完成
 *
 *   每日完成率 = 當天到期的任務中已完成的比例（已取消不計）
 *   每週完成率 = 本週（週一至今天）到期的任務中已完成的比例
 */
import { addDays, daysBetween, formatDate, type IsoDate } from './dates';
import { compareTasks, isOpen, isTaskOverdue, PRIORITY_RANK, type Task, type TaskCategory, type TaskPriority } from './tasks';

export interface TaskOverview {
  today: IsoDate;
  dueToday: Task[];
  carriedForward: Task[];
  /** 已開始（開始日已到）但尚未到期的任務。 */
  inProgress: Task[];
  completedToday: Task[];
  pending: Task[];
  overdue: Task[];
  upcoming: Task[];
  counts: { today: number; todayDone: number; completedToday: number; pending: number; overdue: number; upcoming: number };
}

export function buildTaskOverview(tasks: Task[], today: IsoDate, upcomingDays = 7): TaskOverview {
  const live = tasks.filter((t) => t.status !== 'cancelled');
  const horizon = addDays(today, upcomingDays);
  const dueTodayAll = live.filter((t) => t.dueDate === today);
  const overdue = live.filter((t) => isTaskOverdue(t, today)).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const pending = live.filter((t) => isOpen(t) && t.dueDate >= today).sort(compareTasks);
  return {
    today,
    dueToday: dueTodayAll.sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || compareTasks(a, b)),
    carriedForward: overdue,
    inProgress: pending.filter((t) => t.dueDate > today && (t.status === 'in_progress' || (t.startDate !== null && t.startDate <= today))),
    completedToday: live.filter((t) => t.completedOn === today).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')),
    pending,
    overdue,
    upcoming: pending.filter((t) => t.dueDate > today && t.dueDate <= horizon),
    counts: {
      today: dueTodayAll.length + overdue.length,
      todayDone: dueTodayAll.filter((t) => t.status === 'done').length,
      completedToday: live.filter((t) => t.completedOn === today).length,
      pending: pending.length,
      overdue: overdue.length,
      upcoming: pending.filter((t) => t.dueDate > today && t.dueDate <= horizon).length,
    },
  };
}

// ---------------------------------------------------------------------------
// 生產力
// ---------------------------------------------------------------------------

export interface DayStat {
  date: IsoDate;
  due: number;
  completed: number;
  /** 在到期日當天或之前完成。 */
  onTime: number;
  /** 當天實際完成的任務數（不論何時到期）。 */
  completedThatDay: number;
  rate: number | null;
}

function dayStat(tasks: Task[], date: IsoDate): DayStat {
  const due = tasks.filter((t) => t.status !== 'cancelled' && t.dueDate === date);
  const completed = due.filter((t) => t.status === 'done');
  return {
    date,
    due: due.length,
    completed: completed.length,
    onTime: completed.filter((t) => t.completedOn !== null && t.completedOn <= date).length,
    completedThatDay: tasks.filter((t) => t.completedOn === date).length,
    rate: due.length ? completed.length / due.length : null,
  };
}

export interface Productivity {
  todayRate: number | null;
  weekRate: number | null;
  weekStart: IsoDate;
  weekDue: number;
  weekCompleted: number;
  overdueCount: number;
  onTimeRate30: number | null;
  /** 近 14 天（舊 → 新）。 */
  history: DayStat[];
  /** 最近完成的任務（新 → 舊）。 */
  recentlyCompleted: Task[];
  /** 連續「當天到期任務全部完成」的天數（不含沒有任務的日子）。 */
  streak: number;
}

export function buildProductivity(tasks: Task[], today: IsoDate): Productivity {
  const weekStart = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const weekDue = tasks.filter((t) => t.status !== 'cancelled' && t.dueDate >= weekStart && t.dueDate <= today);
  const weekCompleted = weekDue.filter((t) => t.status === 'done').length;
  const history = Array.from({ length: 14 }, (_, i) => dayStat(tasks, addDays(today, i - 13)));
  const last30 = tasks.filter((t) => t.status === 'done' && t.dueDate > addDays(today, -30) && t.dueDate <= today);
  let streak = 0;
  for (let i = 0; i < 365; i += 1) {
    const s = dayStat(tasks, addDays(today, -i));
    if (s.due === 0) continue; // 沒有到期任務的日子不影響連續紀錄
    if (s.completed === s.due) streak += 1;
    else if (i === 0) continue; // 今天尚未結束，不中斷紀錄
    else break;
  }
  return {
    todayRate: dayStat(tasks, today).rate,
    weekRate: weekDue.length ? weekCompleted / weekDue.length : null,
    weekStart,
    weekDue: weekDue.length,
    weekCompleted,
    overdueCount: tasks.filter((t) => isTaskOverdue(t, today)).length,
    onTimeRate30: last30.length ? last30.filter((t) => t.completedOn !== null && t.completedOn <= t.dueDate).length / last30.length : null,
    history,
    recentlyCompleted: tasks.filter((t) => t.status === 'done' && t.completedAt).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')).slice(0, 30),
    streak,
  };
}

// ---------------------------------------------------------------------------
// 提醒中心
// ---------------------------------------------------------------------------

export type ReminderKind = 'summary' | 'overdue' | 'due_today' | 'upcoming' | 'payroll' | 'month_end';
export interface Reminder {
  id: string;
  kind: ReminderKind;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  message: string;
  tasks: Task[];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** 月底前 3 天至次月第 5 天為「月結期間」。 */
export function inMonthEndWindow(today: IsoDate): boolean {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= last - 2 || d <= 5;
}

/**
 * 產生提醒：逾期、今天到期、即將到期（3 天內）、薪資相關期限（7 天內）、月結（月結期間或 7 天內）、每日摘要。
 */
export function buildReminders(tasks: Task[], today: IsoDate): Reminder[] {
  const o = buildTaskOverview(tasks, today);
  const open = tasks.filter(isOpen);
  const within = (t: Task, days: number) => t.dueDate >= today && t.dueDate <= addDays(today, days);
  const out: Reminder[] = [];

  out.push({
    id: `summary-${today}`, kind: 'summary', severity: 'info',
    title: `Today, ${formatDate(today)}`,
    message: o.counts.today === 0 && o.counts.overdue === 0
      ? `Nothing is due today. ${o.counts.upcoming ? `${plural(o.counts.upcoming, 'task')} due in the next 7 days.` : 'Enjoy the clear day.'}`
      : `${plural(o.dueToday.filter(isOpen).length, 'task')} due today, ${o.counts.overdue} overdue, ${o.counts.completedToday} completed so far.`,
    tasks: [],
  });
  if (o.overdue.length) {
    const worst = Math.max(...o.overdue.map((t) => daysBetween(t.dueDate, today)));
    out.push({ id: `overdue-${today}`, kind: 'overdue', severity: 'critical', title: `${plural(o.overdue.length, 'overdue task')}`,
      message: `Oldest is ${plural(worst, 'day')} overdue. These stay on your list until completed.`, tasks: o.overdue });
  }
  const today_ = o.dueToday.filter(isOpen);
  if (today_.length) out.push({ id: `today-${today}`, kind: 'due_today', severity: 'warning', title: `${plural(today_.length, 'task')} due today`, message: today_.slice(0, 3).map((t) => t.title).join(' · ') + (today_.length > 3 ? ' …' : ''), tasks: today_ });

  const payroll = open.filter((t) => t.category === 'Payroll' && within(t, 7)).sort(compareTasks);
  if (payroll.length) out.push({ id: `payroll-${today}`, kind: 'payroll', severity: payroll.some((t) => t.dueDate <= addDays(today, 2)) ? 'warning' : 'info',
    title: 'Payroll deadlines this week', message: payroll.map((t) => `${t.title} (${formatDate(t.dueDate)})`).slice(0, 4).join(' · '), tasks: payroll });

  const monthEnd = open.filter((t) => t.category === 'Month-End Closing' && (within(t, 7) || (inMonthEndWindow(today) && within(t, 10)))).sort(compareTasks);
  if (monthEnd.length) out.push({ id: `monthend-${today}`, kind: 'month_end', severity: 'info',
    title: inMonthEndWindow(today) ? 'Month-end closing in progress' : 'Month-end closing coming up', message: monthEnd.map((t) => `${t.title} (${formatDate(t.dueDate)})`).slice(0, 4).join(' · '), tasks: monthEnd });

  const shown = new Set([...payroll, ...monthEnd].map((t) => t.id));
  const soon = open.filter((t) => t.dueDate > today && within(t, 3) && !shown.has(t.id)).sort(compareTasks);
  if (soon.length) out.push({ id: `upcoming-${today}`, kind: 'upcoming', severity: 'info', title: `${plural(soon.length, 'deadline')} in the next 3 days`, message: soon.slice(0, 4).map((t) => `${t.title} (${formatDate(t.dueDate)})`).join(' · '), tasks: soon });
  return out;
}

/** 提醒中心徽章數字：逾期 + 今天到期（未完成）。 */
export const reminderBadgeCount = (tasks: Task[], today: IsoDate) => tasks.filter((t) => isOpen(t) && t.dueDate <= today).length;

// ---------------------------------------------------------------------------
// 快速新增：解析「Pay TNB bill tomorrow #banking !high」這類輸入
// ---------------------------------------------------------------------------

const CATEGORY_TAGS: Record<string, TaskCategory> = {
  ap: 'AP', ar: 'AR', gl: 'GL', payroll: 'Payroll', banking: 'Banking', bank: 'Banking', admin: 'Administration', administration: 'Administration',
  monthend: 'Month-End Closing', 'month-end': 'Month-End Closing', closing: 'Month-End Closing',
};
const PRIORITY_TAGS: Record<string, TaskPriority> = { low: 'Low', medium: 'Medium', med: 'Medium', high: 'High', urgent: 'Urgent' };
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface QuickAddResult { title: string; category?: TaskCategory; priority?: TaskPriority; dueDate?: IsoDate }

export function parseQuickAdd(text: string, today: IsoDate): QuickAddResult {
  let s = ` ${text.trim()} `;
  const out: QuickAddResult = { title: '' };
  s = s.replace(/\s#([a-z-]+)\b/gi, (m, tag: string) => { const c = CATEGORY_TAGS[tag.toLowerCase()]; if (c) { out.category = c; return ' '; } return m; });
  s = s.replace(/\s!!+(?=\s)/g, () => { out.priority = 'Urgent'; return ' '; });
  s = s.replace(/\s!([a-z]+)\b/gi, (m, tag: string) => { const p = PRIORITY_TAGS[tag.toLowerCase()]; if (p) { out.priority = p; return ' '; } return m; });

  const [ty, tm] = today.split('-').map(Number) as [number, number];
  const setDate = (d: IsoDate) => { if (!out.dueDate) out.dueDate = d; return ' '; };
  s = s.replace(/\s(?:due\s+|by\s+|on\s+)?(today|tdy)\b/i, () => setDate(today));
  s = s.replace(/\s(?:due\s+|by\s+|on\s+)?(tomorrow|tmr|tmrw)\b/i, () => setDate(addDays(today, 1)));
  s = s.replace(/\s(?:due\s+|by\s+)?in\s+(\d{1,3})\s+(day|days|week|weeks)\b/i, (_, n: string, u: string) => setDate(addDays(today, Number(n) * (u.startsWith('week') ? 7 : 1))));
  s = s.replace(/\s(?:due\s+|by\s+)?(eom|end of month)\b/i, () => setDate(`${today.slice(0, 7)}-${String(new Date(Date.UTC(ty, tm, 0)).getUTCDate()).padStart(2, '0')}`));
  s = s.replace(/\s(?:due\s+|by\s+|on\s+)?(?:next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i, (_m, d: string) => {
    const target = WEEKDAYS.indexOf(d.toLowerCase().slice(0, 3));
    const cur = new Date(`${today}T00:00:00Z`).getUTCDay();
    return setDate(addDays(today, (target - cur + 7) % 7));
  });
  // 25/11、25-11-2026、25 nov
  s = s.replace(/\s(?:due\s+|by\s+|on\s+)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?\b/, (m, d: string, mo: string, y?: string) => {
    const yy = y ? Number(y) : ty;
    const iso = `${yy}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const ok = !Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) && new Date(`${iso}T00:00:00Z`).toISOString().startsWith(iso);
    if (!ok) return m;
    return setDate(!y && iso < today ? `${yy + 1}${iso.slice(4)}` : iso);
  });
  s = s.replace(/\s(?:due\s+|by\s+|on\s+)?(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i, (_m, d: string, mon: string) => {
    const iso = `${ty}-${String(MONTHS.indexOf(mon.toLowerCase().slice(0, 3)) + 1).padStart(2, '0')}-${d.padStart(2, '0')}`;
    return setDate(iso < today ? `${ty + 1}${iso.slice(4)}` : iso);
  });
  out.title = s.replace(/\s+/g, ' ').trim();
  return out;
}
