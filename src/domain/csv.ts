/**
 * CSV 匯出（CSV export）
 *
 * - 加上 UTF-8 BOM，讓 Excel 正確顯示中文與特殊字元。
 * - 對以 = + - @ 開頭的文字加上單引號，防止「CSV 公式注入」攻擊。
 */
import { senToDecimalString } from './money';
import { APPROVAL_LABEL, TYPE_LABELS, type ComputedInvoice, type InvoiceType } from './types';

/** 跳脫單一儲存格內容。 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  const isPlainNumber = /^-?\d+(\.\d+)?$/.test(text);
  if (!isPlainNumber && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: unknown[][]): string {
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** 將發票清單轉為 CSV 文字（欄位依 AP / AR 調整名稱）。 */
export function invoicesToCsv(invoices: ComputedInvoice[], type: InvoiceType): string {
  const L = TYPE_LABELS[type];
  const header = [
    'Invoice Number', L.party, 'Invoice Date', 'Due Date', 'Description',
    'Invoice Amount (MYR)', 'Tax Amount (MYR)', 'Total Amount (MYR)', `${L.paid} (MYR)`, 'Outstanding Balance (MYR)',
    L.status, ...(type === 'AP' ? ['Approval Status'] : []), 'Days Overdue', 'Last Payment Date',
  ];
  const rows = invoices.map((i) => [
    i.invoiceNumber, i.counterpartyName, i.invoiceDate, i.dueDate, i.description,
    senToDecimalString(i.invoiceAmount), senToDecimalString(i.taxAmount), senToDecimalString(i.totalAmount),
    senToDecimalString(i.amountPaid), senToDecimalString(i.outstandingBalance),
    i.status, ...(type === 'AP' ? [i.approvalStatus ? APPROVAL_LABEL[i.approvalStatus] : ''] : []),
    i.daysOverdue, i.lastPaymentDate ?? '',
  ]);
  return toCsv([header, ...rows]);
}

/** 匯出檔名，例如 "AP-invoices-2026-11-12.csv"。 */
export function csvFileName(type: InvoiceType, today: string): string {
  return `${type}-invoices-${today}.csv`;
}
