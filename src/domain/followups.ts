/**
 * 催款／付款跟進紀錄（Follow-ups）
 *
 * 每張發票可以記錄多次跟進：哪天聯絡了誰、對方答應哪天付款、下次什麼時候再追。
 * 設定「下次跟進日」時，會自動建立一個任務，到期當天出現在 Dashboard。
 */
import { isValidIsoDate, type IsoDate } from './dates';

export interface FollowUp {
  id: string;
  /** 聯絡日期。 */
  date: IsoDate;
  /** 聯絡的人（選填）。 */
  contact: string;
  /** 談了什麼。 */
  note: string;
  /** 對方答應的付款日（選填）。 */
  promisedDate: IsoDate | null;
  /** 下次跟進日（選填）。 */
  nextDate: IsoDate | null;
  createdAt: string;
}

export interface FollowUpInput { date: string; contact: string; note: string; promisedDate: string; nextDate: string }
export type FollowUpErrors = Partial<Record<keyof FollowUpInput, string>>;
export type ValidFollowUp = Omit<FollowUp, 'id' | 'createdAt'>;

export function validateFollowUp(v: FollowUpInput, today: IsoDate): { ok: true; value: ValidFollowUp } | { ok: false; errors: FollowUpErrors } {
  const errors: FollowUpErrors = {};
  if (!isValidIsoDate(v.date)) errors.date = 'Enter the date you followed up';
  else if (v.date > today) errors.date = 'The follow-up date cannot be in the future';
  const note = v.note.trim();
  if (!note) errors.note = 'Write what was said, e.g. "Will pay after month-end"';
  else if (note.length > 500) errors.note = 'Keep the note under 500 characters';
  const contact = v.contact.trim();
  if (contact.length > 80) errors.contact = 'Keep the name under 80 characters';
  if (v.promisedDate && !isValidIsoDate(v.promisedDate)) errors.promisedDate = 'Enter a valid date';
  if (v.nextDate && !isValidIsoDate(v.nextDate)) errors.nextDate = 'Enter a valid date';
  else if (v.nextDate && isValidIsoDate(v.date) && v.nextDate < v.date) errors.nextDate = 'The next follow-up must be after this one';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { date: v.date as IsoDate, contact, note, promisedDate: (v.promisedDate || null) as IsoDate | null, nextDate: (v.nextDate || null) as IsoDate | null } };
}

/** 最新的在前。 */
export function sortFollowUps(list: FollowUp[]): FollowUp[] {
  return [...list].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export function latestFollowUp(list: FollowUp[] | undefined): FollowUp | null {
  return list?.length ? sortFollowUps(list)[0]! : null;
}

/** 對方最近一次答應的付款日；若已過期（今天之後仍未付）即為「失約」。 */
export function promiseStatus(list: FollowUp[] | undefined, today: IsoDate): { date: IsoDate; broken: boolean } | null {
  const withPromise = sortFollowUps(list ?? []).find((f) => f.promisedDate);
  return withPromise?.promisedDate ? { date: withPromise.promisedDate, broken: withPromise.promisedDate < today } : null;
}

export function isValidFollowUpRecord(f: FollowUp): boolean {
  return typeof f.id === 'string' && !!f.id && isValidIsoDate(f.date) && typeof f.note === 'string' && !!f.note.trim() && f.note.length <= 500
    && typeof f.contact === 'string' && f.contact.length <= 80 && (f.promisedDate === null || isValidIsoDate(f.promisedDate)) && (f.nextDate === null || isValidIsoDate(f.nextDate));
}
