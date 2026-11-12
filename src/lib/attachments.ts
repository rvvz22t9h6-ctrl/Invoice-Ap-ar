/**
 * 附件服務（Attachments）
 *
 * - 上傳：檔案存放在平台的 assets（每檔上限 20 MB），發票只記錄 asset id。
 * - 自動填寫：讀取附件內容並請 Claude 擷取發票欄位（平台的 sample 功能）。
 *     PDF  → 用 PDF.js 讀出文字（前 3 頁），並把第 1 頁轉成圖片，兩者一起送出
 *            （掃描版 PDF 沒有文字，就靠圖片）
 *     照片 → 直接送出圖片
 * - 只有在 claude.ai 雲端模式才提供；其他模式 attachmentsEnabled() 為 false，畫面會隱藏此功能。
 */
import { buildExtractionPrompt, normalizeExtraction, type ExtractionResult } from '@/domain/extraction';
import type { Attachment, InvoiceType } from '@/domain/types';

interface AssetsCap {
  upload(blob: Blob, options?: { type?: string }): Promise<{ id: string; url: string; sizeBytes: number; contentType: string }>;
  delete(ref: string): Promise<{ deleted: boolean }>;
}
interface SampleCap {
  json<T = unknown>(input: string, options?: { images?: Blob[]; modelTier?: 'default' | 'quick' | 'complex' }): Promise<T>;
  limits(): Promise<{ images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] } }>;
}

let assets: AssetsCap | null = null;
let sample: SampleCap | null = null;

export function setAttachmentServices(a: AssetsCap | null, s: SampleCap | null) {
  assets = a;
  sample = s;
}

export const attachmentsEnabled = () => !!assets;
export const autoFillEnabled = () => !!sample;
/** 由 asset id 組出顯示網址（平台保證此路徑長期有效）。 */
export const attachmentUrl = (id: string) => `/_blob/${id}`;

export const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const ACCEPT_ATTR = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';
const MAX_BYTES = 20 * 1024 * 1024;

/** 使用者看得懂的錯誤。 */
export class AttachmentError extends Error {}

function typeOf(file: File): string {
  if (ACCEPTED_TYPES.includes(file.type)) return file.type;
  const ext = file.name.toLowerCase().split('.').pop();
  return ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as Record<string, string>)[ext ?? ''] ?? '';
}

/** 上傳附件；回傳要記錄在發票上的資訊。 */
export async function uploadAttachment(file: File): Promise<Attachment> {
  if (!assets) throw new AttachmentError('Attachments are not available here.');
  const type = typeOf(file);
  if (!type) throw new AttachmentError(`${file.name} is not supported. Upload a PDF, JPG, PNG or WebP file.`);
  if (file.size > MAX_BYTES) throw new AttachmentError(`${file.name} is larger than 20 MB. Please upload a smaller file.`);
  try {
    const res = await assets.upload(file, { type });
    return { id: res.id, name: file.name, contentType: res.contentType || type, sizeBytes: res.sizeBytes, uploadedAt: new Date().toISOString() };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    throw new AttachmentError(
      code === 'too_large' ? `${file.name} is larger than 20 MB.`
        : code === 'unsupported_type' ? `${file.name} is not a supported file type.`
          : code === 'quota_or_state' ? 'Attachment storage is full. Remove old attachments to make room.'
            : code === 'rate_limited' ? 'Too many uploads at once. Wait a moment and try again.'
              : `${file.name} could not be uploaded. Please try again.`,
    );
  }
}

/** 刪除附件檔案（只在使用者明確移除或取消時呼叫）。 */
export async function deleteAttachmentFile(id: string) {
  if (!assets) return;
  await assets.delete(id).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// 讀取 PDF
// ---------------------------------------------------------------------------

async function readPdf(file: File): Promise<{ text: string; image: Blob | null }> {
  const pdfjs = await import('pdfjs-dist');
  // 以內嵌的 Web Worker 執行 PDF.js（不從外部網站載入）
  const { default: PdfWorker } = await import('pdfjs-dist/build/pdf.worker.min.mjs?worker&inline');
  if (!pdfjs.GlobalWorkerOptions.workerPort) pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const parts: string[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, 3); n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join(''));
  }
  let image: Blob | null = null;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1600 / base.width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    image = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  } catch {
    image = null; // 文字仍可使用
  }
  await doc.destroy();
  return { text: parts.join('\n').replace(/[ \t]+/g, ' ').trim(), image };
}

/** 讀取附件並擷取發票欄位。 */
export async function extractInvoiceDetails(file: File, type: InvoiceType): Promise<ExtractionResult> {
  if (!sample) throw new AttachmentError('Auto-fill is not available here.');
  const mime = typeOf(file);
  let text = '';
  let image: Blob | null = null;
  if (mime === 'application/pdf') {
    try {
      ({ text, image } = await readPdf(file));
    } catch {
      throw new AttachmentError('This PDF could not be opened. It may be password-protected or damaged.');
    }
  } else {
    image = file;
  }
  const limits = await sample.limits().catch(() => ({ images: undefined }));
  const canSendImage = !!image && !!limits.images && image.size <= limits.images.maxInputBytes;
  if (!text && !canSendImage) {
    throw new AttachmentError(mime === 'application/pdf'
      ? 'No text could be read from this PDF. Fill in the details manually.'
      : 'Photos cannot be read here. Upload a PDF, or fill in the details manually.');
  }
  try {
    const raw = await sample.json(buildExtractionPrompt(type, text, canSendImage), canSendImage ? { images: [image!], modelTier: 'default' } : { modelTier: 'default' });
    return normalizeExtraction(raw);
  } catch (e) {
    if (e instanceof AttachmentError) throw e;
    const code = (e as { code?: string })?.code;
    throw new AttachmentError(
      code === 'not_granted' || code === 'sampling_disabled' ? 'Auto-fill needs permission to use Claude. Allow it in this page\'s Permissions menu, or fill in the details manually.'
        : code === 'rate_limited' ? 'Auto-fill is busy. Wait a minute and try again, or fill in the details manually.'
          : code === 'image_rejected' ? 'This image could not be read. Try a clearer photo or a PDF.'
            : 'The details could not be read from this file. Please fill them in manually.',
    );
  }
}
