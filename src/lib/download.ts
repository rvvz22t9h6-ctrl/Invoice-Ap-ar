/**
 * 檔案下載工具：將產生的檔案（CSV、Excel、備份）交給使用者儲存。
 *
 * 一般瀏覽器：建立暫時連結觸發下載。
 * claude.ai Artifact：頁面不能自行下載，改由平台的 downloads 功能顯示確認視窗（setFileSaver 設定）。
 */
type FileSaver = (fileName: string, data: Blob) => Promise<void>;
let saver: FileSaver | null = null;

export function setFileSaver(fn: FileSaver) {
  saver = fn;
}

export async function saveFile(fileName: string, data: Blob): Promise<void> {
  if (saver) return saver(fileName, data);
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadTextFile(content: string, fileName: string, mime = 'text/csv;charset=utf-8') {
  return saveFile(fileName, new Blob([content], { type: mime }));
}

/** 使用者在確認視窗按了「取消」：不是錯誤，不需顯示錯誤訊息。 */
export const isDeclined = (e: unknown) => (e as { code?: string })?.code === 'declined';
