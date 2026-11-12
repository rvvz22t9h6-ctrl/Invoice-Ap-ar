/**
 * 示範用範例資料（Sample data）
 *
 * - 以固定亂數種子產生，每次結果相同，方便測試與比對。
 * - 所有日期都以「相對今天的天數」表示（例如 -45 代表 45 天前），
 *   因此無論何時開啟示範，都會有「逾期」「即將到期」「已付清」等各種情境。
 * - 同一份資料同時用於：
 *     1. 瀏覽器示範模式（DemoRepository）
 *     2. Supabase 資料庫種子檔 supabase/seed.sql（由 scripts/generate-seed.ts 產生）
 * - 公司名稱皆為虛構，與真實企業無關。
 */
import type { ApprovalStatus, CounterpartyKind, InvoiceType } from '@/domain/types';
import type { Sen } from '@/domain/money';

export interface SampleCounterparty {
  id: string;
  kind: CounterpartyKind;
  name: string;
  /** 用於產生發票號碼與描述。 */
  prefix: string;
  descriptions: string[];
  /** 金額範圍（令吉）。 */
  range: [number, number];
  /** 稅率（%），0 代表免稅。 */
  taxRate: number;
}

export interface SamplePayment {
  id: string;
  dayOffset: number;
  amount: Sen;
  method: string;
  reference: string;
}

export interface SampleInvoice {
  id: string;
  type: InvoiceType;
  invoiceNumber: string;
  counterpartyId: string;
  invoiceDayOffset: number;
  dueDayOffset: number;
  description: string;
  invoiceAmount: Sen;
  taxAmount: Sen;
  approvalStatus: ApprovalStatus | null;
  isCancelled: boolean;
  cancelReason: string;
  payments: SamplePayment[];
}

/** 產生固定格式的 UUID，方便種子檔與示範模式使用相同 ID。 */
const uuid = (group: number, n: number) => `00000000-0000-4000-8${String(group).padStart(3, '0')}-${String(n).padStart(12, '0')}`;

export const SAMPLE_SUPPLIERS: SampleCounterparty[] = [
  { id: uuid(1, 1), kind: 'supplier', name: 'Syarikat Maju Logistik Sdn Bhd', prefix: 'SML', descriptions: ['Inbound freight – Port Klang', 'Last-mile delivery – Klang Valley', 'Warehouse handling charges'], range: [2_500, 18_000], taxRate: 6 },
  { id: uuid(1, 2), kind: 'supplier', name: 'Kilang Plastik Sentosa Sdn Bhd', prefix: 'KPS/INV/', descriptions: ['HDPE packaging bottles (5,000 pcs)', 'PET containers – batch order', 'Custom moulded trays'], range: [6_000, 32_000], taxRate: 10 },
  { id: uuid(1, 3), kind: 'supplier', name: 'Cahaya Office Supplies Enterprise', prefix: 'COS', descriptions: ['Office stationery – monthly', 'Printer toner & paper', 'Pantry supplies'], range: [350, 2_400], taxRate: 0 },
  { id: uuid(1, 4), kind: 'supplier', name: 'Nusantara Cloud Services Sdn Bhd', prefix: 'NCS-', descriptions: ['Cloud hosting – monthly subscription', 'Microsoft 365 licences (45 users)', 'Managed backup service'], range: [3_200, 9_800], taxRate: 8 },
  { id: uuid(1, 5), kind: 'supplier', name: 'Mewah Packaging Industries Sdn Bhd', prefix: 'MPI', descriptions: ['Corrugated carton boxes', 'Shrink wrap rolls', 'Printed labels & stickers'], range: [4_000, 21_000], taxRate: 10 },
  { id: uuid(1, 6), kind: 'supplier', name: 'Perkasa Security Services Sdn Bhd', prefix: 'PSS', descriptions: ['Security guard services – monthly', 'CCTV maintenance contract'], range: [7_500, 12_500], taxRate: 8 },
  { id: uuid(1, 7), kind: 'supplier', name: 'Seri Utama Electrical & Engineering', prefix: 'SUE', descriptions: ['Electrical wiring – factory extension', 'Aircond servicing (12 units)', 'Genset preventive maintenance'], range: [1_800, 26_000], taxRate: 8 },
  { id: uuid(1, 8), kind: 'supplier', name: 'Harmoni Facility Management Sdn Bhd', prefix: 'HFM', descriptions: ['Office cleaning services – monthly', 'Pest control – quarterly', 'Landscaping maintenance'], range: [2_200, 6_400], taxRate: 8 },
];

export const SAMPLE_CUSTOMERS: SampleCounterparty[] = [
  { id: uuid(2, 1), kind: 'customer', name: 'Gemilang Retail Holdings Bhd', prefix: '', descriptions: ['Supply of packaged goods – PO', 'Seasonal promotion stock', 'Replenishment order – Central region'], range: [18_000, 85_000], taxRate: 10 },
  { id: uuid(2, 2), kind: 'customer', name: 'Tropika Foods Manufacturing Sdn Bhd', prefix: '', descriptions: ['Food-grade containers', 'Packaging supply contract – monthly'], range: [12_000, 46_000], taxRate: 10 },
  { id: uuid(2, 3), kind: 'customer', name: 'Lestari Hotels & Resorts Sdn Bhd', prefix: '', descriptions: ['Amenity kits – 3 properties', 'Housekeeping supplies'], range: [6_500, 24_000], taxRate: 10 },
  { id: uuid(2, 4), kind: 'customer', name: 'Puncak Healthcare Sdn Bhd', prefix: '', descriptions: ['Medical supply packaging', 'Sterile pouch order'], range: [9_000, 38_000], taxRate: 0 },
  { id: uuid(2, 5), kind: 'customer', name: 'Delima Property Development Sdn Bhd', prefix: '', descriptions: ['Show-unit fit-out materials', 'Site office supplies'], range: [15_000, 60_000], taxRate: 10 },
  { id: uuid(2, 6), kind: 'customer', name: 'Wawasan Automotive Parts Sdn Bhd', prefix: '', descriptions: ['Protective packaging for components', 'Custom foam inserts'], range: [8_000, 30_000], taxRate: 10 },
  { id: uuid(2, 7), kind: 'customer', name: 'Sinar Education Group Sdn Bhd', prefix: '', descriptions: ['Event logistics & merchandise', 'Printed materials – semester intake'], range: [3_500, 14_000], taxRate: 8 },
  { id: uuid(2, 8), kind: 'customer', name: 'Kembara Travel & Tours Sdn Bhd', prefix: '', descriptions: ['Corporate gift sets', 'Branded travel kits'], range: [2_800, 11_000], taxRate: 10 },
];

/** 固定種子亂數產生器（mulberry32），確保每次產生的資料相同。 */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const METHODS = ['Bank Transfer (IBG/DuitNow)', 'Bank Transfer (IBG/DuitNow)', 'FPX', 'Cheque'];

/** 產生所有範例發票。 */
export function buildSampleInvoices(): SampleInvoice[] {
  const rand = rng(20261112);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const invoices: SampleInvoice[] = [];
  let invSeq = 0;
  let paySeq = 0;
  let arNumber = 10201;
  const apNumbers = new Map<string, number>();

  for (const type of ['AR', 'AP'] as const) {
    const parties = type === 'AR' ? SAMPLE_CUSTOMERS : SAMPLE_SUPPLIERS;
    // 由約 11 個月前開始，每隔 3–8 天產生一張發票，一直到昨天
    for (let day = -335; day <= -1; day += between(3, 8)) {
      invSeq += 1;
      const party = pick(parties);
      const term = type === 'AR' ? pick([30, 30, 45, 60]) : pick([30, 30, 45]);
      const dueDay = day + term;
      // 金額取整至十令吉，看起來較像真實發票
      const amount = Math.round(between(party.range[0], party.range[1]) / 10) * 10 * 100;
      const tax = Math.round((amount * party.taxRate) / 100);
      const total = amount + tax;

      let invoiceNumber: string;
      if (type === 'AR') {
        invoiceNumber = `INV-${arNumber}`;
        arNumber += 1;
      } else {
        const n = (apNumbers.get(party.id) ?? between(1200, 8800)) + between(1, 40);
        apNumbers.set(party.id, n);
        // 供應商各自的發票號碼格式，例如 "SML-1234"、"KPS/INV/5678"
        invoiceNumber = /[-/]$/.test(party.prefix) ? `${party.prefix}${n}` : `${party.prefix}-${n}`;
      }

      // AP 審批：較新的帳單可能仍在等待審批；少數被退回
      let approval: ApprovalStatus | null = null;
      if (type === 'AP') {
        const r = rand();
        approval = day > -25 ? (r < 0.5 ? 'pending' : 'approved') : r < 0.03 ? 'rejected' : 'approved';
      }

      // 取消：極少數（尚未付款的）發票被取消
      const cancelled = approval !== 'rejected' && rand() < 0.03;

      // 付款行為：依到期日距今長短決定
      const payments: SamplePayment[] = [];
      const canPay = !cancelled && approval !== 'pending' && approval !== 'rejected';
      if (canPay) {
        const r = rand();
        const addPayment = (offset: number, amt: number) => {
          paySeq += 1;
          payments.push({
            id: uuid(4, paySeq),
            dayOffset: Math.min(Math.max(offset, day), -1), // 付款日介於發票日與昨天之間
            amount: amt,
            method: pick(METHODS),
            reference: `${type === 'AR' ? 'RCPT' : 'PV'}-${String(100000 + paySeq * 37).slice(-6)}`,
          });
        };
        const partial = () => Math.round((total * between(30, 70)) / 100 / 100) * 100;
        if (dueDay < -20) {
          if (r < 0.78) addPayment(dueDay + between(-12, 14), total);
          else if (r < 0.92) addPayment(dueDay + between(-5, 10), partial());
          // 其餘 8%：長期未付（帳齡較久）
        } else if (dueDay <= 0) {
          if (r < 0.45) addPayment(dueDay + between(-10, 0), total);
          else if (r < 0.7) addPayment(dueDay + between(-10, 0), partial());
        } else if (r < 0.18) {
          addPayment(day + between(3, 15), partial());
        } else if (r < 0.26) {
          addPayment(day + between(5, 20), total);
        }
        // 已付一部分的舊發票，有時會再收／付第二筆
        if (payments.length === 1 && payments[0]!.amount < total && rand() < 0.35) {
          const second = Math.round(((total - payments[0]!.amount) * 0.5) / 100) * 100;
          if (second > 0) addPayment(payments[0]!.dayOffset + between(7, 25), second);
        }
      }

      invoices.push({
        id: uuid(3, invSeq),
        type,
        invoiceNumber,
        counterpartyId: party.id,
        invoiceDayOffset: day,
        dueDayOffset: dueDay,
        description: pick(party.descriptions),
        invoiceAmount: amount,
        taxAmount: tax,
        approvalStatus: approval,
        isCancelled: cancelled,
        cancelReason: cancelled ? pick(['Duplicate billing – replaced by new invoice', 'Order cancelled by customer', 'Incorrect pricing – reissued']) : '',
        payments: payments.sort((a, b) => a.dayOffset - b.dayOffset),
      });
    }
  }
  return invoices;
}

export const SAMPLE_COUNTERPARTIES: SampleCounterparty[] = [...SAMPLE_SUPPLIERS, ...SAMPLE_CUSTOMERS];

export interface SampleActivity {
  invoiceId: string;
  action: string;
  summary: string;
  dayOffset: number;
  /** 當天的分鐘數（例如 9:30 = 570），讓排序更自然。 */
  minuteOfDay: number;
  actorName: string;
}

/**
 * 依範例發票產生「歷史活動紀錄」，文字格式與資料庫觸發器 audit_* 完全一致。
 * 只保留最近的 limit 筆。
 */
export function buildSampleActivity(invoices: SampleInvoice[], formatMoney: (sen: Sen) => string, limit = 40): SampleActivity[] {
  const names = new Map(SAMPLE_COUNTERPARTIES.map((c) => [c.id, c.name]));
  const out: SampleActivity[] = [];
  invoices.forEach((inv, idx) => {
    const party = names.get(inv.counterpartyId) ?? '';
    const label = `${inv.type} invoice ${inv.invoiceNumber} · ${party}`;
    const total = inv.invoiceAmount + inv.taxAmount;
    out.push({ invoiceId: inv.id, action: 'invoice.created', summary: `Created ${label} · ${formatMoney(total)}`, dayOffset: inv.invoiceDayOffset, minuteOfDay: 540 + (idx % 7) * 23, actorName: inv.type === 'AP' ? 'Nurul Aina (AP Executive)' : 'Jason Lim (AR Executive)' });
    if (inv.approvalStatus === 'approved' || inv.approvalStatus === 'rejected') {
      out.push({ invoiceId: inv.id, action: `invoice.${inv.approvalStatus}`, summary: `${inv.approvalStatus === 'approved' ? 'Approved' : 'Rejected'} ${label}`, dayOffset: Math.min(inv.invoiceDayOffset + 2, -1), minuteOfDay: 900 + (idx % 5) * 11, actorName: 'Mei Ling Tan (Finance Manager)' });
    }
    if (inv.isCancelled) {
      out.push({ invoiceId: inv.id, action: 'invoice.cancelled', summary: `Cancelled ${label}`, dayOffset: Math.min(inv.invoiceDayOffset + 4, -1), minuteOfDay: 960, actorName: 'Mei Ling Tan (Finance Manager)' });
    }
    inv.payments.forEach((p, j) => {
      out.push({ invoiceId: inv.id, action: 'payment.recorded', summary: `${inv.type === 'AR' ? 'Collected' : 'Paid'} ${formatMoney(p.amount)} on ${label}`, dayOffset: p.dayOffset, minuteOfDay: 660 + ((idx + j) % 9) * 17, actorName: inv.type === 'AP' ? 'Nurul Aina (AP Executive)' : 'Jason Lim (AR Executive)' });
    });
  });
  return out.sort((a, b) => b.dayOffset - a.dayOffset || b.minuteOfDay - a.minuteOfDay).slice(0, limit);
}
