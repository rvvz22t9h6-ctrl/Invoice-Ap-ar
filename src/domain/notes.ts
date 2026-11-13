/**
 * 私人筆記（Notes）：記下特殊處理方式、提醒自己的事項。
 * 筆記只有本人看得到（雲端模式存放在個人專屬空間，檢視者與備份都不包含）。
 */
export const NOTE_CATEGORIES = ['General', 'AP', 'AR', 'Payroll', 'Claims', 'Closing', 'Banking'] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

export interface Note {
  id: string;
  title: string;
  body: string;
  category: NoteCategory;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NoteInput { title: string; body: string; category: NoteCategory; pinned: boolean }
export type NoteErrors = Partial<Record<'title' | 'body' | 'category', string>>;

export const NOTE_TITLE_MAX = 120;
export const NOTE_BODY_MAX = 5000;

export function validateNote(v: NoteInput): { ok: true; value: NoteInput } | { ok: false; errors: NoteErrors } {
  const errors: NoteErrors = {};
  const title = v.title.trim().replace(/\s+/g, ' ');
  const body = v.body.replace(/\r\n/g, '\n').trim();
  if (!title && !body) errors.title = 'Write a title or some text';
  if (title.length > NOTE_TITLE_MAX) errors.title = `Keep the title under ${NOTE_TITLE_MAX} characters`;
  if (body.length > NOTE_BODY_MAX) errors.body = `Keep the note under ${NOTE_BODY_MAX} characters`;
  if (!NOTE_CATEGORIES.includes(v.category)) errors.category = 'Choose a category';
  if (Object.keys(errors).length) return { ok: false, errors };
  // 沒有標題時，以內文第一行當標題
  return { ok: true, value: { title: title || body.split('\n')[0]!.slice(0, 60), body, category: v.category, pinned: v.pinned } };
}

export function isValidNoteRecord(n: Note): boolean {
  return typeof n.id === 'string' && !!n.id && typeof n.title === 'string' && !!n.title && n.title.length <= NOTE_TITLE_MAX
    && typeof n.body === 'string' && n.body.length <= NOTE_BODY_MAX && NOTE_CATEGORIES.includes(n.category) && typeof n.pinned === 'boolean';
}

/** 釘選的在前，其次最近修改的在前。 */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** 搜尋（標題與內文，每個字詞都要出現）與類別篩選。 */
export function filterNotes(notes: Note[], query: string, category: NoteCategory | ''): Note[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return sortNotes(notes.filter((n) => (!category || n.category === category)
    && words.every((w) => n.title.toLowerCase().includes(w) || n.body.toLowerCase().includes(w))));
}

/** 匯出成純文字（自行保存一份）。 */
export function notesToText(notes: Note[]): string {
  return sortNotes(notes).map((n) => `${n.pinned ? '[Pinned] ' : ''}${n.title}\n(${n.category} · updated ${n.updatedAt.slice(0, 10)})\n\n${n.body}`).join('\n\n----------------------------------------\n\n');
}
