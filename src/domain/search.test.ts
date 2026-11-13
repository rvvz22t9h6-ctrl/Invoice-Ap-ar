import { describe, expect, it } from 'vitest';
import { buildInitialDemoState } from '@/data/demoRepository';
import { computeInvoices } from './invoice';
import { search, searchWords, type SearchData } from './search';
import type { Invoice } from './types';

const today = '2026-11-14';
const state = buildInitialDemoState(today);
const names = new Map(state.counterparties.map((c) => [c.id, c.name]));
const invoices = computeInvoices(state.invoices.map((i): Invoice => ({ ...i, counterpartyName: names.get(i.counterpartyId) ?? '' })), today);
const data: SearchData = {
  invoices, claims: state.claims ?? [], tasks: state.tasks ?? [], counterparties: state.counterparties,
  notes: [{ id: 'n1', title: 'How to pay Supplier ABC', body: 'Cheque only. Call Ms Lim.', category: 'AP', pinned: false, createdAt: '', updatedAt: '2026-11-01' }],
  pages: [{ to: '/aging', label: 'Aging Report' }, { to: '/claims', label: 'Staff Claims' }],
};
const kinds = (q: string) => search(q, data).map((g) => g.kind);

describe('global search', () => {
  it('needs at least two characters and every word to match', () => {
    expect(search('', data)).toEqual([]);
    expect(search('a', data)).toEqual([]);
    expect(search('zzzz-nothing', data)).toEqual([]);
    expect(searchWords('RM1,234.50  Lim')).toEqual(['1234.50', 'lim']);
  });
  it('finds invoices by number, party and amount (with or without commas)', () => {
    const inv = invoices.find((i) => i.totalAmount >= 100_000)!;
    const byNo = search(inv.invoiceNumber, data).flatMap((g) => g.hits);
    expect(byNo.some((h) => h.id === inv.id && h.to === (inv.type === 'AP' ? '/ap' : '/ar'))).toBe(true);
    const plain = (inv.totalAmount / 100).toFixed(2);
    const withComma = Number(plain).toLocaleString('en-MY', { minimumFractionDigits: 2 });
    for (const q of [plain, withComma, `RM${plain}`]) expect(search(q, data).flatMap((g) => g.hits).some((h) => h.id === inv.id)).toBe(true);
    expect(search(`${inv.counterpartyName.split(' ')[0]} ${inv.invoiceNumber}`, data).flatMap((g) => g.hits)[0]!.id).toBe(inv.id);
  });
  it('finds claims, tasks, notes, contacts and pages, grouped and capped', () => {
    expect(kinds('siti hajar')).toEqual(['claim']);
    expect(kinds('ms lim')).toEqual(['note']);
    expect(kinds('aging')).toContain('page');
    expect(kinds('insurance')).toEqual(['task']);
    const g = search('sdn', data, 3);
    const contact = g.find((x) => x.kind === 'contact')!;
    expect(contact.hits).toHaveLength(3);
    expect(contact.total).toBeGreaterThan(3);
    expect(search('claims', data).find((x) => x.kind === 'page')!.hits[0]).toMatchObject({ to: '/claims' });
  });
});
