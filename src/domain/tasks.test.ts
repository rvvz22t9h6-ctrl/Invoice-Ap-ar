/**
 * 任務引擎測試：週期規則、去重複、延續逾期、提醒、生產力、快速新增。
 */
import { describe, expect, it } from 'vitest';
import { adjustForWeekend, describeRule, generateRecurringTasks, nextDueDate, occurrenceTaskId, resetFutureOccurrences, scheduledDates, type RecurrenceRule } from './recurrence';
import { buildProductivity, buildReminders, buildTaskOverview, parseQuickAdd } from './taskInsights';
import { newTask, validateTaskInput, withStatus, type Task } from './tasks';
import { RULE_TEMPLATES } from './taskTemplates';

const TODAY = '2026-11-12'; // 週四
const NOW = '2026-11-12T01:00:00Z';
const rule = (o: Partial<RecurrenceRule>): RecurrenceRule => ({
  id: 'r1', title: 'Task', description: '', category: 'GL', priority: 'Medium', remarks: '', frequency: 'daily', interval: 1, customUnit: 'day',
  weekdays: [], dayOfMonth: 0, month: 1, weekendAdjust: 'none', leadDays: 0, startDate: '2026-11-01', endDate: null, active: true,
  generatedThrough: null, skipDates: [], createdAt: NOW, updatedAt: NOW, ...o,
});
let n = 0;
const task = (o: Partial<Task>): Task => ({ ...newTask(`t${(n += 1)}`, { title: `T${n}`, category: 'AP', priority: 'Medium', dueDate: TODAY }, NOW, TODAY), ...o });

describe('recurrence schedules', () => {
  it('daily and every N days', () => {
    expect(scheduledDates(rule({}), '2026-11-10', '2026-11-12')).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
    expect(scheduledDates(rule({ interval: 3 }), '2026-11-01', '2026-11-12')).toEqual(['2026-11-01', '2026-11-04', '2026-11-07', '2026-11-10']);
    expect(scheduledDates(rule({ frequency: 'custom', customUnit: 'day', interval: 10, startDate: '2026-10-01' }), '2026-11-01', '2026-11-30')).toEqual(['2026-11-10', '2026-11-20', '2026-11-30']);
  });
  it('weekly on chosen weekdays, and fortnightly', () => {
    const weekdays = rule({ frequency: 'weekly', weekdays: [1, 2, 3, 4, 5] });
    expect(scheduledDates(weekdays, '2026-11-13', '2026-11-17')).toEqual(['2026-11-13', '2026-11-16', '2026-11-17']); // 週五、下週一、二
    const fortnight = rule({ frequency: 'weekly', interval: 2, weekdays: [4], startDate: '2026-11-05' }); // 每兩週四
    expect(scheduledDates(fortnight, '2026-11-01', '2026-12-10')).toEqual(['2026-11-05', '2026-11-19', '2026-12-03']);
  });
  it('monthly on a day, the last day, and day 31 in short months', () => {
    expect(scheduledDates(rule({ frequency: 'monthly', dayOfMonth: 15 }), '2026-11-01', '2027-01-31')).toEqual(['2026-11-15', '2026-12-15', '2027-01-15']);
    expect(scheduledDates(rule({ frequency: 'monthly', dayOfMonth: -1, startDate: '2027-01-01' }), '2027-01-01', '2027-04-30')).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    expect(scheduledDates(rule({ frequency: 'monthly', dayOfMonth: 31, startDate: '2028-01-01' }), '2028-02-01', '2028-02-29')).toEqual(['2028-02-29']); // 閏年
    // 開始日在當月日期之後 → 從下個月開始
    expect(scheduledDates(rule({ frequency: 'monthly', dayOfMonth: 5, startDate: '2026-11-12' }), '2026-11-01', '2026-12-31')).toEqual(['2026-12-05']);
  });
  it('quarterly, yearly (incl. Feb 29) and custom every 2 months', () => {
    expect(scheduledDates(rule({ frequency: 'quarterly', dayOfMonth: 30, startDate: '2026-01-01' }), '2026-01-01', '2026-12-31')).toEqual(['2026-01-30', '2026-04-30', '2026-07-30', '2026-10-30']);
    expect(scheduledDates(rule({ frequency: 'yearly', month: 2, dayOfMonth: 29, startDate: '2026-01-01' }), '2026-01-01', '2028-12-31')).toEqual(['2026-02-28', '2027-02-28', '2028-02-29']);
    expect(scheduledDates(rule({ frequency: 'yearly', month: 3, dayOfMonth: 31, startDate: '2026-11-12' }), '2026-11-12', '2028-12-31')).toEqual(['2027-03-31', '2028-03-31']);
    expect(scheduledDates(rule({ frequency: 'custom', customUnit: 'month', interval: 2, dayOfMonth: -1, startDate: '2026-11-01' }), '2026-11-01', '2027-05-31')).toEqual(['2026-11-30', '2027-01-31', '2027-03-31', '2027-05-31']);
  });
  it('respects start and end dates', () => {
    expect(scheduledDates(rule({ startDate: '2026-11-11', endDate: '2026-11-12' }), '2026-11-01', '2026-11-30')).toEqual(['2026-11-11', '2026-11-12']);
  });
  it('moves weekend due dates to Friday or Monday', () => {
    expect(adjustForWeekend('2026-11-15', 'previous')).toBe('2026-11-13'); // 週日 → 週五
    expect(adjustForWeekend('2026-11-14', 'previous')).toBe('2026-11-13'); // 週六 → 週五
    expect(adjustForWeekend('2026-11-14', 'next')).toBe('2026-11-16'); // 週六 → 週一
    expect(adjustForWeekend('2026-11-12', 'previous')).toBe('2026-11-12');
  });
  it('describes rules in plain language', () => {
    expect(describeRule(rule({ frequency: 'monthly', dayOfMonth: 15, weekendAdjust: 'previous' }))).toBe('Monthly on day 15 · moved to Friday if it falls on a weekend');
    expect(describeRule(rule({ frequency: 'weekly', weekdays: [5, 1] }))).toBe('Every week on Mon, Fri');
    expect(describeRule(rule({ frequency: 'yearly', month: 2, dayOfMonth: -1 }))).toBe('Yearly on the last day of Feb');
    expect(nextDueDate(rule({ frequency: 'monthly', dayOfMonth: 15, weekendAdjust: 'previous' }), TODAY)).toBe('2026-11-13');
  });
});

describe('automatic generation', () => {
  const monthly = rule({ id: 'epf', frequency: 'monthly', dayOfMonth: 15, weekendAdjust: 'previous', leadDays: 5, startDate: '2026-10-01', category: 'Payroll' });

  it('creates tasks up to the horizon with fixed ids, weekend-adjusted due dates and start dates', () => {
    const { tasks, rules } = generateRecurringTasks([monthly], new Set(), TODAY, NOW);
    expect(tasks.map((t) => [t.id, t.occurrenceDate, t.dueDate, t.startDate])).toEqual([
      ['rec-epf-2026-10-15', '2026-10-15', '2026-10-15', '2026-10-10'],
      ['rec-epf-2026-11-15', '2026-11-15', '2026-11-13', '2026-11-08'],
    ]);
    expect(rules[0]!.generatedThrough).toBe('2026-12-12');
  });

  it('never creates duplicates: running again, or with the ids already present, adds nothing', () => {
    const first = generateRecurringTasks([monthly], new Set(), TODAY, NOW);
    const again = generateRecurringTasks(first.rules, new Set(first.tasks.map((t) => t.id)), TODAY, NOW);
    expect(again.tasks).toHaveLength(0);
    // 即使 generatedThrough 遺失（例如另一台裝置），固定 ID 仍可防止重複
    const lost = generateRecurringTasks([monthly], new Set(first.tasks.map((t) => t.id)), TODAY, NOW);
    expect(lost.tasks).toHaveLength(0);
    expect(new Set([...first.tasks.map((t) => t.id)]).size).toBe(first.tasks.length);
  });

  it('catches up missed days after the app was not opened, and they show as overdue', () => {
    const daily = rule({ id: 'd', startDate: '2026-11-01', generatedThrough: '2026-11-08' });
    const { tasks } = generateRecurringTasks([daily], new Set(), TODAY, NOW, 0);
    expect(tasks.map((t) => t.dueDate)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
    const o = buildTaskOverview(tasks, TODAY);
    expect(o.overdue.map((t) => t.dueDate)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11']);
    expect(o.overdue.every((t) => t.dueDate < TODAY)).toBe(true); // 保留原到期日
  });

  it('skips occurrences the user deleted, and inactive rules', () => {
    const r = rule({ id: 's', startDate: '2026-11-10', skipDates: ['2026-11-11'] });
    expect(generateRecurringTasks([r], new Set(), TODAY, NOW, 0).tasks.map((t) => t.occurrenceDate)).toEqual(['2026-11-10', '2026-11-12']);
    expect(generateRecurringTasks([{ ...r, active: false }], new Set(), TODAY, NOW).tasks).toHaveLength(0);
  });

  it('after a rule change, only future untouched tasks are removed; past, overdue and edited ones stay', () => {
    const daily = rule({ id: 'x', startDate: '2026-11-10' });
    const gen = generateRecurringTasks([daily], new Set(), TODAY, NOW, 3).tasks; // 11/10 … 11/15
    const edited = gen.map((t) => (t.dueDate === '2026-11-14' ? { ...t, remarks: 'note', updatedAt: '2026-11-12T02:00:00Z' } : t));
    const { keep, removedIds, rule: reset } = resetFutureOccurrences({ ...daily, generatedThrough: '2026-11-15' }, edited, TODAY);
    expect(removedIds).toEqual([occurrenceTaskId('x', '2026-11-13'), occurrenceTaskId('x', '2026-11-15')]);
    expect(keep.map((t) => t.dueDate)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-14']);
    expect(reset.generatedThrough).toBe('2026-11-11');
    // 重新產生：只補回被移除的日期，不會重複
    const regen = generateRecurringTasks([reset], new Set(keep.map((t) => t.id)), TODAY, NOW, 3).tasks;
    expect(regen.map((t) => t.dueDate)).toEqual(['2026-11-13', '2026-11-15']);
  });

  it('all templates produce valid schedules', () => {
    for (const t of RULE_TEMPLATES) {
      const r = rule({ ...t, id: t.key, startDate: TODAY });
      expect(scheduledDates(r, TODAY, '2028-12-31').length, t.key).toBeGreaterThan(0);
    }
  });
});

describe('overview, carry-forward and reminders', () => {
  const list = [
    task({ title: 'Old', dueDate: '2026-11-05', priority: 'High' }),
    task({ title: 'Older', dueDate: '2026-11-01' }),
    task({ title: 'Today A', dueDate: TODAY }),
    withStatus(task({ title: 'Today done', dueDate: TODAY }), 'done', NOW, TODAY),
    task({ title: 'Payroll', dueDate: '2026-11-13', category: 'Payroll' }),
    task({ title: 'Started', dueDate: '2026-11-20', startDate: '2026-11-10' }),
    task({ title: 'Far', dueDate: '2026-12-30' }),
    task({ title: 'Cancelled overdue', dueDate: '2026-11-01', status: 'cancelled' }),
    task({ title: 'Month-end', dueDate: '2026-11-17', category: 'Month-End Closing' }),
  ];
  const o = buildTaskOverview(list, TODAY);
  it('classifies today, carried forward, completed, pending, overdue and upcoming', () => {
    expect(o.carriedForward.map((t) => t.title)).toEqual(['Older', 'Old']);
    expect(o.dueToday.map((t) => t.title)).toEqual(['Today A', 'Today done']);
    expect(o.counts).toEqual({ today: 4, todayDone: 1, completedToday: 1, pending: 5, overdue: 2, upcoming: 2 }); // 11/20 超過 7 天，不算即將到期
    expect(o.inProgress.map((t) => t.title)).toEqual(['Started']);
  });
  it('builds reminders for overdue, today, payroll, month-end and upcoming', () => {
    const r = buildReminders(list, TODAY);
    // 3 天內的其他到期任務只有薪資（已在薪資提醒中），所以沒有另外的 upcoming 提醒
    expect(r.map((x) => x.kind)).toEqual(['summary', 'overdue', 'due_today', 'payroll', 'month_end']);
    expect(buildReminders([...list, task({ title: 'Soon', dueDate: '2026-11-14' })], TODAY).at(-1)).toMatchObject({ kind: 'upcoming', message: 'Soon (14 Nov 2026)' });
    expect(r[0]!.message).toBe('1 task due today, 2 overdue, 1 completed so far.');
    expect(r[1]!.message).toMatch(/Oldest is 11 days overdue/);
  });
});

describe('productivity', () => {
  it('computes daily and weekly completion rates and history', () => {
    const list = [
      withStatus(task({ dueDate: TODAY }), 'done', NOW, TODAY),
      task({ dueDate: TODAY }),
      withStatus(task({ dueDate: '2026-11-09' }), 'done', '2026-11-09T05:00:00Z', '2026-11-09'), // 週一，準時
      task({ dueDate: '2026-11-10' }), // 逾期
      task({ dueDate: '2026-11-10', status: 'cancelled' }), // 不計
      withStatus(task({ dueDate: '2026-11-11' }), 'done', NOW, TODAY), // 遲一天完成
    ];
    const p = buildProductivity(list, TODAY);
    expect(p.todayRate).toBe(0.5);
    expect(p.weekStart).toBe('2026-11-09');
    expect([p.weekDue, p.weekCompleted]).toEqual([5, 3]);
    expect(p.weekRate).toBeCloseTo(0.6);
    expect(p.overdueCount).toBe(1);
    expect(p.history).toHaveLength(14);
    expect(p.history.at(-1)).toMatchObject({ date: TODAY, due: 2, completed: 1, completedThatDay: 2 });
    expect(p.history.at(-2)).toMatchObject({ date: '2026-11-11', due: 1, completed: 1, onTime: 0 });
    expect(p.onTimeRate30).toBeCloseTo(2 / 3);
  });
});

describe('quick add', () => {
  it('parses dates, categories and priorities', () => {
    expect(parseQuickAdd('Pay TNB bill tomorrow #banking !high', TODAY)).toEqual({ title: 'Pay TNB bill', category: 'Banking', priority: 'High', dueDate: '2026-11-13' });
    expect(parseQuickAdd('EPF submission by fri #payroll !!', TODAY)).toEqual({ title: 'EPF submission', category: 'Payroll', priority: 'Urgent', dueDate: '2026-11-13' });
    expect(parseQuickAdd('Accrual review eom #monthend', TODAY)).toMatchObject({ dueDate: '2026-11-30', category: 'Month-End Closing' });
    expect(parseQuickAdd('Send SOA 25/11', TODAY)).toMatchObject({ title: 'Send SOA', dueDate: '2026-11-25' });
    expect(parseQuickAdd('Renew licence 3 jan', TODAY)).toMatchObject({ dueDate: '2027-01-03' });
    expect(parseQuickAdd('Call auditor in 2 weeks', TODAY)).toMatchObject({ title: 'Call auditor', dueDate: '2026-11-26' });
    expect(parseQuickAdd('Plain task #unknown', TODAY)).toEqual({ title: 'Plain task #unknown' });
  });
  it('validates task input', () => {
    expect(validateTaskInput({ title: '', category: 'AP', priority: 'Low', dueDate: TODAY })).toHaveProperty('title');
    expect(validateTaskInput({ title: 'x', category: 'AP', priority: 'Low', dueDate: '2026-11-10', startDate: '2026-11-11' })).toHaveProperty('startDate');
    expect(validateTaskInput({ title: 'x', category: 'AP', priority: 'Low', dueDate: TODAY })).toEqual({});
  });
});
