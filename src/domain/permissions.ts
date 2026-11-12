/**
 * 角色權限（Role permissions）
 *
 * 此表僅用於「畫面顯示哪些按鈕」；真正的權限由資料庫 RLS 強制執行。
 * 兩者必須保持一致（見 supabase/migrations/*_row_level_security.sql）。
 */
import type { UserRole } from './types';

export type Action =
  | 'invoice.create' | 'invoice.edit' | 'invoice.cancel' | 'invoice.delete'
  | 'invoice.approve' | 'payment.record' | 'payment.reverse';

const MATRIX: Record<Action, UserRole[]> = {
  'invoice.create': ['admin', 'finance'],
  'invoice.edit': ['admin', 'finance'],
  'invoice.cancel': ['admin', 'finance'],
  'invoice.delete': ['admin'],
  'invoice.approve': ['admin'],
  'payment.record': ['admin', 'finance'],
  'payment.reverse': ['admin'],
};

export function can(role: UserRole | undefined, action: Action): boolean {
  return !!role && MATRIX[action].includes(role);
}
