/**
 * 全域搜尋（Global search）：一次搜尋發票、報銷、任務、筆記、供應商／客戶與頁面。
 *
 * 規則：輸入的每個字詞都要出現（不分大小寫）；金額可輸入 1234.5、1,234.50 或 RM1234 皆可。
 */
import type { StaffClaim } from './claims';
import { CLAIM_STATUS_LABEL } from './claims';
import { formatDate } from './dates';
import { formatMYR } from './money';
import type { Note } from './notes';
import { TASK_STATUS_LABEL, type Task } from './tasks';
import type { ComputedInvoice, Counterparty } from './types';

export type SearchKind = 'ap' | 'ar' | 'claim' | 'task' | 'note' | 'contact' | 'page';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  /** 右側顯示（金額或狀態）。 */
  meta?: string;
  /** 前往的頁面。 */
  to: string;
}

export interface SearchGroup { kind: SearchKind; label: string; hits: SearchHit[]; total: number }

export const GROUP_LABEL: Record<SearchKind, string> = {
  ap: 'Supplier bills (AP)', ar: 'Customer invoices (AR)', claim: 'Staff claims', task: 'Tasks', note: 'Notes', contact: 'Suppliers & customers', page: 'Pages',
};

export interface SearchData {
  invoices: ComputedInvoice[];
  claims: StaffClaim[];
  tasks: Task[];
  notes: Note[];
  counterparties: Counterparty[];
  pages: { to: string; label: string }[];
}

/** 金額的搜尋文字：「1234.50」與「1,234.50」都能找到。 */
const amountText = (sen: number) => `${(sen / 100).toFixed(2)} ${formatMYR(sen)}`;

/** 把輸入拆成字詞；像金額的字詞去掉 RM 與逗號。 */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean).map((w) => {
    const n = w.replace(/^rm/, '').replace(/,/g, '');
    return /^\d+(\.\d+)?$/.test(n) ? n : w;
  });
}

const matches = (hay: string, words: string[]) => { const h = hay.toLowerCase(); const plain = h.replace(/,/g, ''); return words.every((w) => h.includes(w) || plain.includes(w)); };

export function search(query: string, data: SearchData, perGroup = 5): SearchGroup[] {
  const words = searchWords(query);
  if (!words.length || words.join('').length < 2) return [];
  const groups: SearchGroup[] = [];
  const add = (kind: SearchKind, all: SearchHit[]) => { if (all.length) groups.push({ kind, label: GROUP_LABEL[kind], hits: all.slice(0, perGroup), total: all.length }); };

  add('page', data.pages.filter((p) => matches(p.label, words)).map((p) => ({ kind: 'page' as const, id: p.to, title: p.label, subtitle: 'Go to page', to: p.to })));

  for (const type of ['AR', 'AP'] as const) {
    const hits = data.invoices.filter((i) => i.type === type && matches([i.invoiceNumber, i.counterpartyName, i.description, i.remarks ?? '', amountText(i.totalAmount), amountText(i.outstandingBalance), i.status].join(' '), words))
      .sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate))
      .map((i): SearchHit => ({ kind: type === 'AP' ? 'ap' : 'ar', id: i.id, title: `${i.invoiceNumber} · ${i.counterpartyName}`, subtitle: `${formatDate(i.invoiceDate)} · ${i.status}${i.description ? ` · ${i.description}` : ''}`, meta: formatMYR(i.totalAmount), to: type === 'AP' ? '/ap' : '/ar' }));
    add(type === 'AP' ? 'ap' : 'ar', hits);
  }

  add('claim', data.claims.filter((c) => matches([c.claimNo, c.staffName, c.category, c.description, c.remarks, c.paymentRef, amountText(c.amount), CLAIM_STATUS_LABEL[c.status]].join(' '), words))
    .sort((a, b) => b.expenseDate.localeCompare(a.expenseDate))
    .map((c): SearchHit => ({ kind: 'claim', id: c.id, title: `${c.claimNo} · ${c.staffName}`, subtitle: `${formatDate(c.expenseDate)} · ${CLAIM_STATUS_LABEL[c.status]} · ${c.description}`, meta: formatMYR(c.amount), to: '/claims' })));

  add('task', data.tasks.filter((t) => matches([t.title, t.description, t.remarks, t.category].join(' '), words))
    .sort((a, b) => Number(a.status === 'done' || a.status === 'cancelled') - Number(b.status === 'done' || b.status === 'cancelled') || b.dueDate.localeCompare(a.dueDate))
    .map((t): SearchHit => ({ kind: 'task', id: t.id, title: t.title, subtitle: `${t.category} · due ${formatDate(t.dueDate)}`, meta: TASK_STATUS_LABEL[t.status], to: '/tasks/all' })));

  add('note', data.notes.filter((n) => matches(`${n.title} ${n.body} ${n.category}`, words))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
    .map((n): SearchHit => ({ kind: 'note', id: n.id, title: n.title, subtitle: n.body.replace(/\s+/g, ' ').slice(0, 90) || n.category, meta: n.category, to: '/notes' })));

  add('contact', data.counterparties.filter((c) => matches([c.name, c.contactPerson ?? '', c.email ?? '', c.phone ?? '', c.notes ?? ''].join(' '), words))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c): SearchHit => ({ kind: 'contact', id: c.id, title: c.name, subtitle: [c.kind === 'supplier' ? 'Supplier' : 'Customer', c.contactPerson, c.phone].filter(Boolean).join(' · '), to: '/contacts' })));

  return groups;
}
