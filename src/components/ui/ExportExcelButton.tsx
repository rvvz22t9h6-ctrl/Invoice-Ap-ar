/**
 * 「匯出 Excel」按鈕：按下時才載入 Excel 函式庫並產生檔案。
 */
import { useState } from 'react';
import type { Workbook } from 'exceljs';
import { downloadWorkbook } from '@/lib/excelExport';
import { Button } from './index';
import { useToast } from './Toast';

export function ExportExcelButton({ build, fileName, label = 'Export to Excel', variant = 'secondary', disabled, testId }: {
  build: () => Promise<Workbook>; fileName: string; label?: string; variant?: 'primary' | 'secondary'; disabled?: boolean; testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const run = async () => {
    setBusy(true);
    try {
      await downloadWorkbook(await build(), fileName);
      toast(`Downloaded ${fileName}`);
    } catch (e) {
      toast(e instanceof Error ? `Export failed: ${e.message}` : 'Export failed', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant={variant} onClick={run} loading={busy} disabled={disabled} data-testid={testId}
      icon={<svg viewBox="0 0 20 20" className="size-4" aria-hidden><rect x="2" y="2" width="16" height="16" rx="3" fill="#1e7b4f" /><path d="M6.5 6.5l7 7m0-7l-7 7" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></svg>}>
      {label}
    </Button>
  );
}
