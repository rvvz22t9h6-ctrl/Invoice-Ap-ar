/**
 * 金額工具（Money utilities）
 *
 * 設計原則：
 * - 系統內所有金額一律以「仙（sen）」的整數儲存與計算，RM 1.00 = 100 sen。
 * - 這樣可避免 JavaScript 浮點數誤差（例如 0.1 + 0.2 !== 0.3）。
 * - 只有在「輸入」（使用者輸入 / 資料庫回傳）與「輸出」（畫面顯示 / CSV）時才轉換。
 */

/** 以「仙」為單位的整數金額。 */
export type Sen = number;

/** 單筆金額上限：與資料庫 numeric(14,2) 一致（最多 12 位整數）。 */
export const MAX_SEN: Sen = 999_999_999_999_99;

/**
 * 將「令吉」數值（可為數字或字串，例如 "1,234.50"）轉為整數仙。
 * 無法解析時回傳 null，由呼叫端決定如何顯示錯誤。
 */
export function toSen(value: number | string | null | undefined): Sen | null {
  if (value === null || value === undefined) return null;
  // 移除千分位逗號、貨幣符號 RM 與空白
  const text = typeof value === 'number' ? String(value) : value.replace(/,/g, '').replace(/^\s*RM\s*/i, '').trim();
  if (text === '') return null;
  // 只接受最多兩位小數的數字，避免 "1.005" 之類造成四捨五入爭議
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) {
    // 數字型別可能帶有浮點誤差（例如 1234.5000000001），改用四捨五入處理
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
    return null;
  }
  const negative = text.startsWith('-');
  const [whole = '0', frac = ''] = text.replace('-', '').split('.');
  const sen = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -sen : sen;
}

/** 整數仙 → 令吉數值（僅用於傳送到資料庫或 CSV，勿用於計算）。 */
export function fromSen(sen: Sen): number {
  return sen / 100;
}

/** 整數仙 → 固定兩位小數字串，例如 123450 → "1234.50"。 */
export function senToDecimalString(sen: Sen): string {
  const negative = sen < 0;
  const abs = Math.abs(sen);
  const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

const myrFormatter = new Intl.NumberFormat('en-MY', {
  style: 'currency',
  currency: 'MYR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const myrCompactFormatter = new Intl.NumberFormat('en-MY', {
  style: 'currency',
  currency: 'MYR',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** 以馬來西亞令吉格式顯示，例如 123450 → "RM 1,234.50"。 */
export function formatMYR(sen: Sen): string {
  // Intl 在部分環境輸出 "RM1,234.50"（無空格），統一補上空格以利閱讀
  return myrFormatter.format(sen / 100).replace(/^(-?)RM\s?/, '$1RM ');
}

/** 精簡格式（圖表座標軸用），例如 12_345_600 → "RM 123.5K"。 */
export function formatMYRCompact(sen: Sen): string {
  return myrCompactFormatter.format(sen / 100).replace(/^(-?)RM\s?/, '$1RM ');
}

/** 加總多筆金額（仍為整數，無誤差）。 */
export function sumSen(values: Iterable<Sen>): Sen {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** 依稅率（百分比）計算稅額，四捨五入至仙。例如 SST 8%。 */
export function taxFromRate(amountSen: Sen, ratePercent: number): Sen {
  return Math.round((amountSen * ratePercent) / 100);
}
