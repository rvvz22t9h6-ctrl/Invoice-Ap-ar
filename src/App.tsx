/**
 * 路由設定（Routes）
 * 未登入時一律導向登入頁；登入後才能進入各功能頁。
 */
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spinner } from '@/components/ui';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/features/auth/AuthContext';
import { LoginPage } from '@/features/auth/LoginPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { InvoicesPage } from '@/features/invoices/InvoicesPage';
import { AgingPage } from '@/features/aging/AgingPage';
import { ContactsPage } from '@/features/contacts/ContactsPage';
import { CashFlowPage } from '@/features/cashflow/CashFlowPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { MyDayPage } from '@/features/tasks/MyDayPage';
import { ChecklistPage } from '@/features/checklists/ChecklistPage';
import { TaskCalendarPage } from '@/features/tasks/TaskCalendarPage';
import { AllTasksPage } from '@/features/tasks/AllTasksPage';
import { RecurringPage } from '@/features/tasks/RecurringPage';
import { ProductivityPage } from '@/features/tasks/ProductivityPage';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid min-h-screen place-items-center text-slate-400"><Spinner /></div>;
  return user ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        {/* 首頁 = 每日工作儀表板；財務總覽移到 /finance */}
        <Route index element={<MyDayPage />} />
        <Route path="finance" element={<DashboardPage />} />
        <Route path="payroll" element={<ChecklistPage key="payroll" kind="payroll" />} />
        <Route path="closing" element={<ChecklistPage key="closing" kind="closing" />} />
        {/* key 讓 AP 與 AR 切換時重新建立元件，篩選狀態不會互相影響 */}
        <Route path="ap" element={<InvoicesPage key="AP" type="AP" />} />
        <Route path="ar" element={<InvoicesPage key="AR" type="AR" />} />
        <Route path="aging" element={<AgingPage />} />
        <Route path="contacts" element={<ContactsPage />} />
        <Route path="cash-flow" element={<CashFlowPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="tasks" element={<MyDayPage />} />
        <Route path="tasks/calendar" element={<TaskCalendarPage />} />
        <Route path="tasks/all" element={<AllTasksPage />} />
        <Route path="tasks/recurring" element={<RecurringPage />} />
        <Route path="tasks/productivity" element={<ProductivityPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
