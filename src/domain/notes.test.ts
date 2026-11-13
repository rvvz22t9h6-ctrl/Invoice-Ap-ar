import { describe, expect, it } from 'vitest';
import { filterNotes, isValidNoteRecord, notesToText, sortNotes, validateNote, type Note } from './notes';

const note = (over: Partial<Note>): Note => ({ id: 'n1', title: 'T', body: '', category: 'General', pinned: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...over });

describe('notes', () => {
  it('validates and uses the first line as the title when none is given', () => {
    expect(validateNote({ title: '', body: '  ', category: 'General', pinned: false })).toMatchObject({ ok: false });
    const r = validateNote({ title: '  ', body: 'Call Ms Lim first\nthen send cheque', category: 'AP', pinned: true });
    expect(r.ok && r.value).toMatchObject({ title: 'Call Ms Lim first', body: 'Call Ms Lim first\nthen send cheque', pinned: true });
    expect(validateNote({ title: 'x'.repeat(121), body: '', category: 'AP', pinned: false }).ok).toBe(false);
    expect(validateNote({ title: 'ok', body: 'x'.repeat(5001), category: 'AP', pinned: false }).ok).toBe(false);
    expect(isValidNoteRecord(note({}))).toBe(true);
    expect(isValidNoteRecord(note({ title: '' }))).toBe(false);
  });
  it('sorts pinned first, then newest; searches every word in title or text; filters by category', () => {
    const a = note({ id: 'a', title: 'Supplier ABC payment', body: 'Cheque only', category: 'AP', updatedAt: '2026-11-02T00:00:00Z' });
    const b = note({ id: 'b', title: 'EPF steps', body: 'Login to i-Akaun, upload Form A', category: 'Payroll', updatedAt: '2026-11-05T00:00:00Z' });
    const c = note({ id: 'c', title: 'Bank token', body: 'Kept in drawer', category: 'Banking', pinned: true });
    expect(sortNotes([a, b, c]).map((n) => n.id)).toEqual(['c', 'b', 'a']);
    expect(filterNotes([a, b, c], 'cheque abc', '').map((n) => n.id)).toEqual(['a']);
    expect(filterNotes([a, b, c], 'FORM', '').map((n) => n.id)).toEqual(['b']);
    expect(filterNotes([a, b, c], '', 'Banking').map((n) => n.id)).toEqual(['c']);
    expect(filterNotes([a, b, c], 'zzz', '')).toEqual([]);
    expect(notesToText([a, c])).toMatch(/^\[Pinned\] Bank token[\s\S]*Supplier ABC payment/);
  });
});
