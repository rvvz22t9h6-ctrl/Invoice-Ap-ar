/**
 * 檔案下載工具：將文字內容（例如 CSV）以檔案形式下載到使用者電腦。
 */
export function downloadTextFile(content: string, fileName: string, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
