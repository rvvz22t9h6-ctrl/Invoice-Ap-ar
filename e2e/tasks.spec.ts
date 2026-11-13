/**
 * 每日工作與提醒中心：端對端測試。
 */
import { expect, test, type Page } from '@playwright/test';
import { addDays, formatDate } from '../src/domain/dates';
import { login, today, openNav } from './helpers';

async function openMyDay(page: Page) {
  await login(page, 'admin');
  await openNav(page, 'Dashboard');
  await expect(page.getByTestId('task-kpi-today')).toBeVisible();
}
const kpiNum = async (page: Page, id: string) => Number(await page.getByTestId(`${id}-value`).textContent());

test('quick add parses shortcuts; completing and reopening updates the counts', async ({ page }) => {
  await openMyDay(page);
  const before = await kpiNum(page, 'task-kpi-completed');
  await page.getByTestId('quick-add-input').fill('Pay Indah Water bill today #banking !high');
  await expect(page.getByTestId('quick-add')).toContainText(`Will add Pay Indah Water bill · Banking · High · due ${formatDate(today)}`);
  await page.getByTestId('quick-add-submit').click();
  await expect(page.getByText(`Added "Pay Indah Water bill"`)).toBeVisible();
  const item = page.getByTestId('today-list').getByTestId('task-item').filter({ hasText: 'Pay Indah Water bill' });
  await expect(item).toContainText('Due today');
  await item.getByTestId('task-check').click();
  await expect(page.getByTestId('completed-list')).toContainText('Pay Indah Water bill');
  await expect(page.getByTestId('task-kpi-completed-value')).toHaveText(String(before + 1));
  await page.getByTestId('completed-list').getByTestId('task-item').filter({ hasText: 'Pay Indah Water bill' }).getByTestId('task-check').click();
  await expect(page.getByTestId('task-kpi-completed-value')).toHaveText(String(before));
});

test('overdue tasks carry forward with their original due date and are never removed', async ({ page }) => {
  await openMyDay(page);
  const carried = page.getByTestId('carried-list').getByTestId('task-item');
  const n = await carried.count();
  expect(n).toBeGreaterThan(0);
  await expect(carried.first()).toContainText(/\d+ days? overdue · was due \d{2} \w+ \d{4}/);
  await expect(page.getByTestId('task-kpi-overdue-value')).toHaveText(String(n));
  // 重新整理（會再次執行自動產生）後仍在，且數量不變
  await page.reload();
  await expect(page.getByTestId('carried-list').getByTestId('task-item')).toHaveCount(n);
  // 開啟一筆：顯示保留的原到期日
  await carried.first().getByRole('button').nth(1).click();
  await expect(page.getByRole('dialog')).toContainText('The original due date is kept.');
});

test('full task form with validation, edit and delete', async ({ page }) => {
  await openMyDay(page);
  await page.getByTestId('new-task').click();
  const d = page.getByRole('dialog');
  await d.getByTestId('save-task').click();
  await expect(d.getByText('Title is required')).toBeVisible();
  await d.getByLabel('Task title *').fill('Prepare EA forms draft');
  await d.getByLabel('Category *').selectOption('Payroll');
  await d.getByLabel('Priority *').selectOption('Urgent');
  await d.getByLabel('Due date *').fill(addDays(today, 5));
  await d.getByLabel('Start date').fill(addDays(today, 6));
  await d.getByTestId('save-task').click();
  await expect(d.getByText('Start date cannot be after the due date')).toBeVisible();
  await d.getByLabel('Start date').fill(today);
  await d.getByLabel('Remarks').fill('Check new joiners');
  await d.getByTestId('save-task').click();
  await expect(page.getByText('Task added')).toBeVisible();
  await openNav(page, 'All Tasks');
  await page.getByLabel('Search tasks').fill('EA forms');
  await expect(page.getByTestId('task-table').locator('tbody tr')).toHaveCount(1);
  await page.getByTestId('task-table').locator('tbody tr').first().click();
  await page.getByRole('dialog').getByLabel('Status').selectOption('in_progress');
  await page.getByRole('dialog').getByTestId('save-task').click();
  await expect(page.getByTestId('task-table')).toContainText('In progress');
  await page.getByTestId('task-table').locator('tbody tr').first().click();
  await page.getByRole('dialog').getByTestId('delete-task').click();
  await page.getByTestId('confirm-delete-task').click();
  await expect(page.getByText('No tasks match these filters')).toBeVisible();
});

test('recurring task: create, generated without duplicates, deleted occurrence stays deleted', async ({ page }) => {
  await openMyDay(page);
  await openNav(page, 'Reminders');
  await page.getByTestId('new-rule').click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Task title *').fill('Review petty cash vouchers');
  await d.getByLabel('Category').selectOption('GL');
  await d.getByTestId('rule-frequency').selectOption('custom');
  await d.getByLabel('Every').fill('10');
  await d.getByLabel('Unit').selectOption('day');
  await d.getByLabel('First date').fill(today);
  await d.getByLabel('If it falls on a weekend').selectOption('none');
  await expect(d.getByTestId('rule-preview')).toContainText('Every 10 days');
  await expect(d.getByTestId('rule-preview')).toContainText(formatDate(addDays(today, 10)));
  await d.getByTestId('save-rule').click();
  await expect(page.getByTestId('rule-list')).toContainText('Review petty cash vouchers');

  await openNav(page, 'All Tasks');
  await page.getByLabel('View', { exact: true }).selectOption('all');
  await page.getByLabel('Search tasks').fill('petty cash vouchers');
  const rows = page.getByTestId('task-table').locator('tbody tr');
  await expect(rows).toHaveCount(4); // 今天、+10、+20、+30（30 天內）
  await page.reload();
  await page.getByLabel('View', { exact: true }).selectOption('all');
  await page.getByLabel('Search tasks').fill('petty cash vouchers');
  await expect(rows).toHaveCount(4); // 重新整理不會重複
  await rows.nth(1).click();
  await page.getByRole('dialog').getByTestId('delete-task').click();
  await page.getByTestId('confirm-delete-task').click();
  await expect(rows).toHaveCount(3);
  await page.reload();
  await page.getByLabel('View', { exact: true }).selectOption('all');
  await page.getByLabel('Search tasks').fill('petty cash vouchers');
  await expect(rows).toHaveCount(3); // 被刪除的日期不會再產生
});

test('templates add Malaysian statutory tasks', async ({ page }) => {
  await openMyDay(page);
  await openNav(page, 'Reminders');
  await page.getByTestId('open-templates').click();
  await expect(page.getByRole('dialog')).toContainText('Pay EPF (KWSP) contribution');
  await expect(page.getByRole('dialog')).toContainText('(already added)'); // 範例資料已有 EPF
  await page.getByTestId('add-templates').click();
  await expect(page.getByTestId('rule-list')).toContainText('Issue Form EA to all employees');
  await expect(page.getByTestId('rule-list')).toContainText('Yearly on the last day of Feb');
});

test('calendar daily / weekly / monthly views, and add from a day', async ({ page }) => {
  await openMyDay(page);
  await openNav(page, 'Task Calendar');
  await expect(page.getByTestId('cal-month')).toBeVisible();
  await expect(page.getByTestId('cal-task').first()).toBeVisible();
  await page.getByTestId('view-week').click();
  await expect(page.getByTestId('cal-week')).toBeVisible();
  await page.getByTestId('view-day').click();
  await expect(page.getByTestId('cal-title')).toContainText(new Date(`${today}T00:00:00Z`).toLocaleDateString('en-MY', { weekday: 'long', timeZone: 'UTC' }));
  await page.getByTestId('view-month').click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('gridcell').nth(15).click();
  await expect(page.getByRole('dialog')).toContainText('New task');
});

test('reminder centre: badge, panel, payroll reminder and desktop notifications', async ({ page }) => {
  // 以替身取代瀏覽器通知：記錄送出的通知（無頭瀏覽器不允許真正的通知）
  await page.addInitScript(() => {
    const sent: { title: string; body: string }[] = [];
    (window as unknown as { __sent: unknown }).__sent = sent;
    // 與真實瀏覽器相同：權限在重新整理後仍保留
    class FakeNotification {
      static get permission() { return sessionStorage.getItem('fake-perm') ?? 'default'; }
      static async requestPermission() { sessionStorage.setItem('fake-perm', 'granted'); return 'granted'; }
      constructor(title: string, opts?: { body?: string }) { sent.push({ title, body: opts?.body ?? '' }); }
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  });
  await openMyDay(page);
  // 自建一筆明天到期的薪資任務，避免依賴樣本資料的日期
  await page.getByTestId('quick-add-input').fill('Pay EPF test tomorrow #payroll');
  await page.getByTestId('quick-add-submit').click();
  await expect(page.getByText('Added "Pay EPF test"')).toBeVisible();
  const overdue = await kpiNum(page, 'task-kpi-overdue');
  const todayOpen = await page.getByTestId('today-list').getByTestId('task-item').count();
  await expect(page.locator('[data-testid=reminder-badge]:visible')).toHaveText(String(overdue + todayOpen));
  await expect(page.getByTestId('daily-summary')).toBeVisible();
  await page.locator('[data-testid=reminder-bell]:visible').click();
  const panel = page.getByTestId('reminder-panel');
  await expect(panel.getByTestId('reminder-overdue')).toBeVisible();
  await expect(panel.getByTestId('reminder-payroll')).toContainText('Pay EPF');
  await panel.getByTestId('enable-notifications').click();
  await expect(panel).toContainText('Desktop notifications are on.');
  await page.keyboard.press('Escape');

  // 開啟後：每日摘要 + 每個逾期／今天到期任務各一則；重新整理不重複通知
  await page.reload();
  await expect(page.getByTestId('task-kpi-today')).toBeVisible();
  const sent = () => page.evaluate(() => (window as unknown as { __sent: { title: string }[] }).__sent);
  await expect.poll(async () => (await sent()).length).toBe(1 + Math.min(overdue + todayOpen, 10));
  const titles = (await sent()).map((n) => n.title);
  expect(titles[0]).toBe('Your finance tasks today');
  expect(titles.some((t) => t.startsWith('Overdue: '))).toBe(true);
  await page.reload();
  await expect(page.getByTestId('task-kpi-today')).toBeVisible();
  await page.waitForTimeout(500);
  expect((await sent()).length).toBe(0); // 今天已通知過

  await page.getByRole('button', { name: 'Dismiss for today' }).click();
  await expect(page.getByTestId('daily-summary')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('task-kpi-today')).toBeVisible();
  await expect(page.getByTestId('daily-summary')).toHaveCount(0); // 今天已關閉
});

test('productivity shows rates and history', async ({ page }) => {
  await openMyDay(page);
  await openNav(page, 'Productivity');
  await expect(page.getByTestId('prod-week-value')).toHaveText(/\d+%|—/);
  await expect(page.getByTestId('prod-table').locator('tbody tr')).toHaveCount(14);
  await expect(page.getByTestId('history-list').locator('li').first()).toBeVisible();
});

test('delete button on each task row, with a quick confirm, on Dashboard and All Tasks', async ({ page }) => {
  await openMyDay(page);
  await page.getByTestId('quick-add-input').fill('Throwaway task today');
  await page.getByTestId('quick-add-submit').click();
  const row = page.getByTestId('today-list').getByTestId('task-item').filter({ hasText: 'Throwaway task' });
  await row.getByTestId('task-delete').click();
  await row.getByRole('button', { name: 'No' }).click(); // 取消不會刪除
  await expect(row).toBeVisible();
  await row.getByTestId('task-delete').click();
  await row.getByTestId('task-delete-yes').click();
  await expect(page.getByText('Deleted: Throwaway task')).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0); // 不會誤開編輯視窗

  await page.getByTestId('quick-add-input').fill('Second throwaway today');
  await page.getByTestId('quick-add-submit').click();
  await openNav(page, 'All Tasks');
  const tr = page.getByTestId('task-table').getByRole('row').filter({ hasText: 'Second throwaway' });
  await tr.getByTestId('task-delete').click();
  await tr.getByTestId('task-delete-yes').click();
  await expect(tr).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('task-table')).not.toContainText('Second throwaway');
});
