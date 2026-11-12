/**
 * 登入頁（Login page）
 * 示範模式下會列出示範帳號，點一下即可以不同角色登入測試權限。
 */
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Button, TextInput } from '@/components/ui';
import { repository } from '@/data';
import { DEMO_USERS } from '@/data/demoRepository';
import { ROLE_LABEL } from '@/domain/types';
import { useAuth } from './AuthContext';

export function LoginPage() {
  const { user, signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e?: FormEvent, creds?: { email: string; password: string }) => {
    e?.preventDefault();
    const c = creds ?? { email, password };
    if (!c.email.trim() || !c.password) {
      setError('Please enter your email and password');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await signIn(c.email, c.password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <div className="hidden flex-col justify-between bg-navy-900 p-12 text-white lg:flex">
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-10 rounded-lg ring-1 ring-white/10" />
          <span className="font-semibold">Finance Portal</span>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl leading-tight font-semibold">Accounts Payable &amp; Receivable, in one place.</h1>
          <p className="mt-4 text-navy-200">Track supplier bills and customer invoices, record payments, and see what is outstanding and overdue — calculated live from your records.</p>
        </div>
        <p className="text-xs text-navy-300">Internal use only · Amounts in Malaysian Ringgit (MYR)</p>
      </div>

      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h2>
          <p className="mt-1 text-sm text-slate-500">Use your company finance account.</p>
          <form onSubmit={submit} className="mt-8 space-y-4" noValidate>
            <TextInput label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <TextInput label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {error && <Alert>{error}</Alert>}
            <Button type="submit" variant="primary" className="w-full" loading={busy}>Sign in</Button>
          </form>

          {repository.mode === 'demo' && (
            <div className="mt-10">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Demo accounts · password demo1234</p>
              <div className="mt-3 space-y-2">
                {DEMO_USERS.map((u) => (
                  <button key={u.id} type="button" disabled={busy} onClick={() => submit(undefined, { email: u.email, password: u.password })}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-3.5 py-2.5 text-left ring-1 ring-slate-200 hover:bg-navy-50 hover:ring-navy-200">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-800">{u.fullName}</span>
                      <span className="block text-xs text-slate-500">{u.description}</span>
                    </span>
                    <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{ROLE_LABEL[u.role]}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
