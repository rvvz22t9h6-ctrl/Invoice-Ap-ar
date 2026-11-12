/**
 * 公司設定（Settings）：公司名稱、預設付款期限、期初銀行餘額。
 * 只有管理員可以修改；其他角色可以檢視。
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Card, PageHeader, TextInput } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { formatDate } from '@/domain/dates';
import { formatMYR } from '@/domain/money';
import { can } from '@/domain/permissions';
import { ROLE_LABEL } from '@/domain/types';
import { useAuth } from '@/features/auth/AuthContext';
import { OpeningBalanceForm } from '@/features/cashflow/CashFlowPage';
import { useSettings, useSettingsMutation } from '@/hooks/useFinanceData';

export function SettingsPage() {
  const { settings, isLoading } = useSettings();
  const { user } = useAuth();
  const isAdmin = can(user?.role, 'invoice.approve');
  const save = useSettingsMutation();
  const toast = useToast();
  const [v, setV] = useState({ companyName: '', ar: '30', ap: '30' });
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isLoading) setV({ companyName: settings.companyName, ar: String(settings.defaultTermsAR), ap: String(settings.defaultTermsAP) });
  }, [isLoading, settings.companyName, settings.defaultTermsAR, settings.defaultTermsAP]);

  const submit = async () => {
    const ar = Number(v.ar);
    const ap = Number(v.ap);
    if (![ar, ap].every((n) => Number.isInteger(n) && n >= 0 && n <= 365)) { setError('Payment terms must be whole days between 0 and 365'); return; }
    if (v.companyName.trim().length > 150) { setError('Company name is too long'); return; }
    setError('');
    await save.mutateAsync({ companyName: v.companyName.trim(), defaultTermsAR: ar, defaultTermsAP: ap });
    toast('Settings saved');
  };

  return (
    <>
      <PageHeader eyebrow="Settings" title="Company Settings" subtitle={isAdmin ? 'These settings apply to everyone using the portal.' : `You are signed in as ${user ? ROLE_LABEL[user.role] : ''}. Only an admin can change settings.`} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="Company">
          <form className="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
            <TextInput label="Company name" containerClassName="sm:col-span-2" value={v.companyName} disabled={!isAdmin} maxLength={150} placeholder="e.g. Sample Trading Sdn Bhd"
              hint="Shown in the sidebar and on Excel reports and statements." onChange={(e) => setV((x) => ({ ...x, companyName: e.target.value }))} />
            <TextInput label="Default customer terms (days)" inputMode="numeric" value={v.ar} disabled={!isAdmin} onChange={(e) => setV((x) => ({ ...x, ar: e.target.value }))}
              hint="For new customer invoices without their own terms." />
            <TextInput label="Default supplier terms (days)" inputMode="numeric" value={v.ap} disabled={!isAdmin} onChange={(e) => setV((x) => ({ ...x, ap: e.target.value }))}
              hint="For new supplier invoices without their own terms." />
            {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
            {isAdmin && <div className="flex justify-end sm:col-span-2"><Button type="submit" variant="primary" loading={save.isPending} data-testid="save-settings">Save settings</Button></div>}
          </form>
        </Card>
        <div>
          {isAdmin ? <OpeningBalanceForm /> : (
            <Card title="Bank balance">
              <p className="text-sm text-slate-700">{settings.openingBalanceDate ? `${formatMYR(settings.openingBalance)} as of ${formatDate(settings.openingBalanceDate)}` : 'Not set'}</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
