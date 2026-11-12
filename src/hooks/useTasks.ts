/**
 * 任務資料 Hooks：讀取、寫入，以及「自動產生週期任務」的排程。
 *
 * 自動產生時機：開啟系統時、每分鐘檢查一次是否已跨日（馬來西亞時間），以及切回此分頁時。
 * 產生器本身保證不重複，因此多次執行也安全。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { repository } from '@/data';
import type { RecurrenceInput } from '@/data/repository';
import { todayIso } from '@/domain/dates';
import type { TaskInput, TaskStatus } from '@/domain/tasks';

export const taskKeys = { tasks: ['tasks'] as const, recurrences: ['recurrences'] as const };

/** 馬來西亞時區的今天；跨日時自動更新。 */
export function useToday() {
  const [today, setToday] = useState(() => repository.today());
  useEffect(() => {
    const t = setInterval(() => setToday((cur) => (repository.today() !== cur ? repository.today() : cur)), 60_000);
    return () => clearInterval(t);
  }, []);
  return today;
}

export function useTasks() {
  const q = useQuery({ queryKey: taskKeys.tasks, queryFn: () => repository.listTasks() });
  return { ...q, tasks: q.data ?? [] };
}

export function useRecurrences() {
  const q = useQuery({ queryKey: taskKeys.recurrences, queryFn: () => repository.listRecurrences() });
  return { ...q, rules: q.data ?? [] };
}

export function useTaskMutations() {
  const qc = useQueryClient();
  const refresh = async () => {
    await Promise.all([qc.cancelQueries({ queryKey: taskKeys.tasks }), qc.cancelQueries({ queryKey: taskKeys.recurrences })]);
    await Promise.all([qc.invalidateQueries({ queryKey: taskKeys.tasks }), qc.invalidateQueries({ queryKey: taskKeys.recurrences })]);
  };
  return {
    save: useMutation({ mutationFn: ([input, id]: [TaskInput, string?]) => repository.saveTask(input, id), onSuccess: refresh }),
    setStatus: useMutation({ mutationFn: ([id, status]: [string, TaskStatus]) => repository.setTaskStatus(id, status), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => repository.deleteTask(id), onSuccess: refresh }),
    saveRule: useMutation({ mutationFn: ([input, id]: [RecurrenceInput, string?]) => repository.saveRecurrence(input, id), onSuccess: refresh }),
    removeRule: useMutation({ mutationFn: (id: string) => repository.deleteRecurrence(id), onSuccess: refresh }),
  };
}

/** 全域：自動產生週期任務（放在主版面，登入後一直執行）。 */
export function useAutoGenerateTasks() {
  const qc = useQueryClient();
  const lastRun = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const today = todayIso();
      if (lastRun.current === today) return;
      lastRun.current = today;
      try {
        const created = await repository.generateTasks();
        if (!cancelled && created > 0) await qc.invalidateQueries({ queryKey: taskKeys.tasks });
        if (!cancelled) await qc.invalidateQueries({ queryKey: taskKeys.recurrences });
      } catch {
        lastRun.current = null; // 失敗時下次再試
      }
    };
    void run();
    const timer = setInterval(run, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void run(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [qc]);
}
