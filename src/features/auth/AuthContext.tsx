/**
 * 登入狀態管理（Auth context）
 *
 * 提供目前使用者、登入、登出功能給整個應用程式使用。
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { repository } from '@/data';
import type { UserProfile } from '@/domain/types';

interface AuthState {
  user: UserProfile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  // 啟動時檢查是否已有登入工作階段
  useEffect(() => {
    repository.currentUser().then(setUser).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const profile = await repository.signIn(email, password);
    queryClient.clear();
    setUser(profile);
  }, [queryClient]);

  const signOut = useCallback(async () => {
    await repository.signOut();
    queryClient.clear(); // 清除快取，避免下一位使用者看到上一位的資料
    setUser(null);
  }, [queryClient]);

  return <AuthContext.Provider value={{ user, loading, signIn, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
