import { describe, expect, it } from 'vitest';
import { buildExtractionPrompt, normalizeExtraction } from './extraction';

describe('invoice extraction', () => {
  it('builds a prompt that names the right party for AP and AR', () => {
    expect(buildExtractionPrompt('AP', 'Total RM 100', false)).toMatch(/SELLER/);
    expect(buildExtractionPrompt('AR', '', true)).toMatch(/CUSTOMER being billed[\s\S]*use the attached image/);
  });

  it('normalizes a complete reply into form fields', () => {
    const r = normalizeExtraction({
      invoiceNumber: 'INV-2026/0456', counterpartyName: '  Syarikat  Maju Sdn Bhd ', invoiceDate: '2026-10-01', dueDate: '2026-10-31',
      description: 'Freight charges', subtotal: 1000, taxAmount: 60, total: 1060, currency: 'MYR',
    });
    expect(r.fields).toEqual({ invoiceNumber: 'INV-2026/0456', counterpartyName: 'Syarikat Maju Sdn Bhd', invoiceDate: '2026-10-01', dueDate: '2026-10-31', description: 'Freight charges', invoiceAmount: '1000.00', taxAmount: '60.00' });
    expect(r.warnings).toEqual([]);
  });

  it('derives missing values and accepts DD/MM/YYYY', () => {
    const r = normalizeExtraction({ invoiceDate: '03/04/2026', paymentTermsDays: 30, total: '1,080.00', taxAmount: 80 });
    expect(r.fields).toMatchObject({ invoiceDate: '2026-04-03', dueDate: '2026-05-03', invoiceAmount: '1000.00', taxAmount: '80.00' });
    const noTax = normalizeExtraction({ subtotal: 500, total: 540 });
    expect(noTax.fields.taxAmount).toBe('40.00');
  });

  it('warns about foreign currency, mismatched totals and missing data; ignores junk', () => {
    const r = normalizeExtraction({ subtotal: 100, taxAmount: 10, total: 200, currency: 'usd', invoiceDate: 'yesterday' });
    expect(r.warnings.join(' ')).toMatch(/USD/);
    expect(r.warnings.join(' ')).toMatch(/does not match/);
    expect(r.warnings.join(' ')).toMatch(/No due date/);
    expect(r.fields.invoiceDate).toBeUndefined();
    expect(normalizeExtraction(null).fields).toEqual({});
    expect(normalizeExtraction({ subtotal: -5 }).fields.invoiceAmount).toBeUndefined();
  });
});
