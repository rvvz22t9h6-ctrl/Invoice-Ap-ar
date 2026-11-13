/**
 * 私人筆記（Notes）頁面：像便利貼一樣記下特殊處理方式、要記得的事。
 * 搜尋、類別篩選、釘選；點卡片即可編輯。只有本人看得到。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Alert, Button, cx, Modal, PageHeader, SelectInput, Spinner, TextArea, TextInput } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { repository } from '@/data';
import { formatDate, todayIso } from '@/domain/dates';
import { filterNotes, NOTE_BODY_MAX, NOTE_CATEGORIES, NOTE_TITLE_MAX, notesToText, validateNote, type Note, type NoteCategory, type NoteErrors } from '@/domain/notes';
import { downloadTextFile, isDeclined } from '@/lib/download';
import { useQuickNew } from '@/lib/quickRecord';

const notesKey = ['notes'] as const;

/** 每個類別一個粉彩色（卡片上方色條與標籤）。 */
const TINT: Record<NoteCategory, { bar: string; chip: string }> = {
  General: { bar: 'bg-[#dccdf2]', chip: 'bg-[#f1eafb] text-[#5b4496]' },
  AP: { bar: 'bg-[#f9c9b9]', chip: 'bg-[#fdeeea] text-[#a8452f]' },
  AR: { bar: 'bg-[#bfe0f5]', chip: 'bg-[#e8f3fb] text-[#1f5f8a]' },
  Payroll: { bar: 'bg-[#b8e7d2]', chip: 'bg-[#e3f5ec] text-[#1c6a4a]' },
  Claims: { bar: 'bg-[#f6b6c6]', chip: 'bg-[#fde6ec] text-[#9c2f52]' },
  Closing: { bar: 'bg-[#fff0a3]', chip: 'bg-[#fff8d6] text-[#7a5a00]' },
  Banking: { bar: 'bg-[#bfe9f2]', chip: 'bg-[#e4f6f9] text-[#16616f]' },
};

const newId = () => globalThis.crypto?.randomUUID?.() ?? `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function NotesPage() {
  const available = repository.notesAvailable();
  const q = useQuery({ queryKey: notesKey, queryFn: () => repository.listNotes(), enabled: available });
  const notes = useMemo(() => q.data ?? [], [q.data]);
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<NoteCategory | ''>('');
  const [editing, setEditing] = useState<Note | null>(null);
  const [creating, setCreating] = useState(false);
  useQuickNew('note', () => { if (available) setCreating(true); });

  const save = useMutation({
    mutationFn: (n: Note) => repository.saveNote(n),
    onMutate: async (n) => {
      await qc.cancelQueries({ queryKey: notesKey });
      const prev = qc.getQueryData<Note[]>(notesKey) ?? [];
      qc.setQueryData<Note[]>(notesKey, [...prev.filter((x) => x.id !== n.id), n]);
      return { prev };
    },
    onError: (e, _n, ctx) => { if (ctx) qc.setQueryData(notesKey, ctx.prev); toast(e instanceof Error ? e.message : 'Could not save the note', 'error'); },
    onSettled: () => qc.invalidateQueries({ queryKey: notesKey }),
  });
  const remove = async (n: Note) => {
    const prev = qc.getQueryData<Note[]>(notesKey) ?? [];
    qc.setQueryData<Note[]>(notesKey, prev.filter((x) => x.id !== n.id));
    try { await repository.deleteNote(n.id); toast(`Deleted: ${n.title}`); } catch (e) { qc.setQueryData(notesKey, prev); toast(e instanceof Error ? e.message : 'Could not delete', 'error'); } finally { void qc.invalidateQueries({ queryKey: notesKey }); }
  };
  const shown = useMemo(() => filterNotes(notes, search, category), [notes, search, category]);
  const counts = useMemo(() => { const m = new Map<string, number>(); notes.forEach((n) => m.set(n.category, (m.get(n.category) ?? 0) + 1)); return m; }, [notes]);
  const exportAll = async () => {
    try { await downloadTextFile(notesToText(notes), `my-notes-${todayIso()}.txt`, 'text/plain;charset=utf-8'); toast('Notes downloaded'); } catch (e) { if (!isDeclined(e)) toast('Download failed', 'error'); }
  };

  if (!available) {
    return (<><PageHeader eyebrow="Private" title="Notes" /><Alert tone="info">Notes are private to the person who writes them and are not available in view-only access.</Alert></>);
  }
  return (
    <>
      <PageHeader eyebrow="Private · only you can see these" title="Notes"
        subtitle="Write down anything you need to remember: a special way to handle a supplier, steps for a task, who to call."
        actions={<>
          {notes.length > 0 && <Button onClick={() => void exportAll()} data-testid="notes-export">Download all</Button>}
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="new-note">+ New note</Button>
        </>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search your notes" aria-label="Search notes" data-testid="notes-search"
          className="min-w-[200px] flex-1 rounded-xl border-0 bg-white px-4 py-2.5 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-navy-600" />
      </div>
      <div className="mb-5 flex flex-wrap gap-1.5" role="tablist" aria-label="Category">
        {(['', ...NOTE_CATEGORIES] as const).map((c) => {
          const n = c ? counts.get(c) ?? 0 : notes.length;
          if (c && !n) return null;
          return (
            <button key={c || 'all'} type="button" role="tab" aria-selected={category === c} onClick={() => setCategory(c)} data-testid={`notes-cat-${c || 'all'}`}
              className={cx('rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-inset', category === c ? 'bg-navy-600 text-white ring-navy-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-navy-50')}>
              {c || 'All'} <span className="opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {q.isLoading ? <div className="grid h-40 place-items-center text-slate-400"><Spinner /></div>
        : q.isError ? <Alert>Your notes could not be loaded. Check your connection and reload the page.</Alert>
          : shown.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-navy-200 bg-white/60 px-6 py-12 text-center" data-testid="notes-empty">
              <p className="font-display text-lg font-semibold text-navy-950">{notes.length ? 'No notes match' : 'No notes yet'}</p>
              <p className="mt-1 text-sm text-slate-500">{notes.length ? 'Try a different word or category.' : 'For example: "Supplier ABC only accepts cheques. Call Ms Lim before sending."'}</p>
              {!notes.length && <Button variant="primary" className="mt-4" onClick={() => setCreating(true)}>Write your first note</Button>}
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="notes-grid">
              {shown.map((n) => (
                <li key={n.id} data-testid="note-card" className="warm-card warm-card-hover group relative flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white transition-shadow" onClick={() => setEditing(n)}>
                  <span className={cx('h-1.5 w-full', TINT[n.category].bar)} aria-hidden />
                  <div className="flex flex-1 flex-col p-4">
                    <div className="flex items-start gap-2">
                      <h2 className="min-w-0 flex-1 text-[15px] leading-snug font-semibold text-slate-900">{n.title}</h2>
                      <button type="button" aria-label={n.pinned ? `Unpin "${n.title}"` : `Pin "${n.title}" to the top`} aria-pressed={n.pinned} data-testid="note-pin"
                        onClick={(e) => { e.stopPropagation(); save.mutate({ ...n, pinned: !n.pinned, updatedAt: n.updatedAt }); }}
                        className={cx('grid size-8 shrink-0 place-items-center rounded-lg', n.pinned ? 'bg-amber-50 text-amber-600' : 'text-slate-300 hover:bg-slate-50 hover:text-slate-500')}>
                        <svg viewBox="0 0 24 24" className="size-4" fill={n.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden><path d="m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8z" /></svg>
                      </button>
                    </div>
                    {n.body && <p className="mt-1.5 line-clamp-6 text-sm whitespace-pre-line text-slate-600">{n.body}</p>}
                    <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-xs text-slate-400">
                      <span className={cx('rounded-full px-2 py-0.5 font-semibold', TINT[n.category].chip)}>{n.category}</span>
                      <span>{formatDate(n.updatedAt.slice(0, 10))}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

      {(creating || editing) && <NoteModal note={editing} defaultCategory={category || 'General'} onClose={() => { setCreating(false); setEditing(null); }}
        onSave={async (n) => { await save.mutateAsync(n); }} onDelete={editing ? async () => { await remove(editing); } : undefined} />}
    </>
  );
}

function NoteModal({ note, defaultCategory, onClose, onSave, onDelete }: { note: Note | null; defaultCategory: NoteCategory; onClose: () => void; onSave: (n: Note) => Promise<void>; onDelete?: () => Promise<void> }) {
  const toast = useToast();
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [category, setCategory] = useState<NoteCategory>(note?.category ?? defaultCategory);
  const [pinned, setPinned] = useState(note?.pinned ?? false);
  const [errors, setErrors] = useState<NoteErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const submit = async () => {
    const r = validateNote({ title, body, category, pinned });
    if (!r.ok) { setErrors(r.errors); return; }
    setBusy(true);
    try {
      const now = new Date().toISOString();
      await onSave({ id: note?.id ?? newId(), ...r.value, createdAt: note?.createdAt ?? now, updatedAt: now });
      toast(note ? 'Note saved' : 'Note added');
      onClose();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save the note');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="md" title={note ? 'Edit note' : 'New note'} subtitle="Private: only you can see this."
      footer={<>
        {onDelete && (askDelete ? (
          <span className="mr-auto flex items-center gap-1.5 text-xs"><span className="text-slate-600">Delete this note?</span>
            <button type="button" className="rounded-md bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-700" data-testid="note-delete-yes" onClick={async () => { await onDelete(); onClose(); }}>Yes</button>
            <button type="button" className="rounded-md px-2 py-1 font-medium text-slate-600 ring-1 ring-slate-200" onClick={() => setAskDelete(false)}>No</button></span>
        ) : <Button variant="danger" className="mr-auto" onClick={() => setAskDelete(true)} data-testid="note-delete">Delete</Button>)}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void submit()} loading={busy} data-testid="save-note">{note ? 'Save' : 'Add note'}</Button>
      </>}>
      <div className="space-y-4">
        <TextInput label="Title" value={title} maxLength={NOTE_TITLE_MAX} error={errors.title} placeholder="e.g. How to pay Supplier ABC" onChange={(e) => { setTitle(e.target.value); setErrors({}); }} data-testid="note-title" />
        <TextArea label="Note" rows={8} value={body} maxLength={NOTE_BODY_MAX} error={errors.body} placeholder={'Write anything you need to remember.\nOne step per line works well.'} onChange={(e) => { setBody(e.target.value); setErrors({}); }} data-testid="note-body" />
        <div className="flex flex-wrap items-end gap-4">
          <SelectInput label="Category" containerClassName="min-w-[160px] flex-1" value={category} onChange={(e) => setCategory(e.target.value as NoteCategory)} data-testid="note-category">
            {NOTE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </SelectInput>
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
            <input type="checkbox" className="size-4 rounded border-slate-300 accent-navy-700" checked={pinned} onChange={(e) => setPinned(e.target.checked)} data-testid="note-pinned" />
            Pin to the top
          </label>
        </div>
        {formError && <Alert>{formError}</Alert>}
      </div>
    </Modal>
  );
}
