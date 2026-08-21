import { Product } from '../types';
import { barcodeSvg, fitBarcode } from './barcode128';
import { printWindowError } from './printSupport';

/**
 * ملصقات الباركود — حساب التخطيط، توليد الأكواد الداخلية، وبناء صفحة الطباعة.
 *
 * 🔴 المبدأ: المقاس **حرّ**، والبرنامج يشتقّ منه كل شيء (عدد الأعمدة والصفوف، ارتفاع
 * الباركود، أحجام الخطوط). لا أرقام ثابتة — لأن ورق الملصقات في السوق غير موحّد.
 */

// ---------------------------------------------------------------- التخطيط

export interface LabelLayout {
  labelW: number;   // عرض الملصق (ملم)
  labelH: number;   // ارتفاعه (ملم)
  marginX: number;  // هامش الورقة الجانبي
  marginY: number;  // هامش الورقة العلوي/السفلي
  gapX: number;     // المسافة بين ملصق وآخر أفقياً
  gapY: number;     // ورأسياً
}

/**
 * نمط الطباعة:
 *  · 'sheet' ورق ملصقات A4 — شبكة أعمدة وصفوف على صفحة واحدة
 *  · 'roll'  طابعة ملصقات صغيرة — **ملصق واحد لكل صفحة** على بكرة متصلة، بلا هوامش
 * الفرق جوهري: الطابعة الصغيرة لا تعرف A4 أصلاً، وحجم صفحتها = حجم الملصق نفسه.
 */
export type PrintMode = 'sheet' | 'roll';

export interface LabelPreset extends LabelLayout { id: string; name: string }

/** مقاسات بكرات الملصقات المنتشرة في السوق — عرض × ارتفاع بالمليمتر. */
export const ROLL_PRESETS: Array<{ id: string; name: string; labelW: number; labelH: number }> = [
  { id: 'r40x30', name: '٤٠ × ٣٠ ملم', labelW: 40, labelH: 30 },
  { id: 'r50x30', name: '٥٠ × ٣٠ ملم', labelW: 50, labelH: 30 },
  { id: 'r60x40', name: '٦٠ × ٤٠ ملم', labelW: 60, labelH: 40 },
  { id: 'r30x20', name: '٣٠ × ٢٠ ملم', labelW: 30, labelH: 20 },
  { id: 'r58x40', name: '٥٨ × ٤٠ ملم', labelW: 58, labelH: 40 },
];

const A4_W = 210;
const A4_H = 297;

/** مقاسات شائعة في المكتبات — نقطة بداية سريعة لمن يعرف نوع ورقه. */
export const LABEL_PRESETS: LabelPreset[] = [
  { id: 'l65', name: '٦٥ ملصقاً (٣٨×٢١ ملم)', labelW: 38.1, labelH: 21.2, marginX: 4.75, marginY: 10.7, gapX: 2.5, gapY: 0 },
  { id: 'l40', name: '٤٠ ملصقاً (٤٦×٢٥ ملم)', labelW: 45.7, labelH: 25.4, marginX: 9.85, marginY: 21.5, gapX: 2.5, gapY: 0 },
  { id: 'l24', name: '٢٤ ملصقاً (٦٤×٣٤ ملم)', labelW: 63.5, labelH: 33.9, marginX: 7.25, marginY: 12.9, gapX: 2.5, gapY: 0 },
  { id: 'l12', name: '١٢ ملصقاً (٩٩×٤٢ ملم)', labelW: 99.1, labelH: 42.3, marginX: 4.9, marginY: 21.6, gapX: 2, gapY: 0 },
];

export interface GridInfo { cols: number; rows: number; perPage: number; fits: boolean }

/**
 * يحسب شبكة الورقة تلقائياً من مقاس الملصق — القلب الذي يجعل المقاس حرّاً.
 * (المسافة الأخيرة لا تُحتسب، ولهذا نضيف gap قبل القسمة.)
 */
export function computeGrid(l: LabelLayout): GridInfo {
  // هامش تسامح ٠٫٠٥ملم: أبعاد الملصقات كسرية (٢١٫٢ · ٣٣٫٩) ودقّة الفاصلة العائمة
  // تُسقط صفاً كاملاً عند الحدّ تماماً — فتُطبع ٦٠ ملصقاً على ورقة سعتها ٦٥.
  const EPS = 0.05;
  const usableW = A4_W - l.marginX * 2 + EPS;
  const usableH = A4_H - l.marginY * 2 + EPS;
  const cols = Math.max(0, Math.floor((usableW + l.gapX) / (l.labelW + l.gapX)));
  const rows = Math.max(0, Math.floor((usableH + l.gapY) / (l.labelH + l.gapY)));
  return { cols, rows, perPage: cols * rows, fits: cols > 0 && rows > 0 };
}

// ---------------------------------------------------------------- توليد الأكواد

/**
 * بادئة النطاق الداخلي للمتاجر. الأكواد التي تبدأ بـ ٢ محجوزة عالمياً للاستخدام
 * الداخلي، فلا تصطدم أبداً بباركود مصنع.
 */
const INTERNAL_PREFIX = '22';
const CODE_DIGITS = 8; // ٢٢ + ٦ أرقام — **طول زوجي** ⇒ يُرمَّز Code C فينضغط للنصف

/**
 * يولّد كوداً داخلياً فريداً لمنتج بلا باركود.
 * يفحص التفرّد على كل الأكواد القائمة (وعلى ما وُلِّد للتوّ في نفس العملية).
 */
export function generateInternalBarcode(taken: Set<string>): string {
  const width = CODE_DIGITS - INTERNAL_PREFIX.length;
  // نبدأ من أعلى رقم مستخدم ضمن النطاق الداخلي، فتبقى الأكواد متسلسلة ومقروءة
  let next = 1;
  for (const code of taken) {
    if (code.startsWith(INTERNAL_PREFIX) && code.length === CODE_DIGITS && /^\d+$/.test(code)) {
      const n = parseInt(code.slice(INTERNAL_PREFIX.length), 10);
      if (!isNaN(n) && n >= next) next = n + 1;
    }
  }
  let candidate = INTERNAL_PREFIX + String(next).padStart(width, '0');
  // حارس تصادم: لو وُجد الرقم لأي سبب (كود مُدخل يدوياً) نتخطّاه
  while (taken.has(candidate)) {
    next += 1;
    candidate = INTERNAL_PREFIX + String(next).padStart(width, '0');
  }
  return candidate;
}

// ---------------------------------------------------------------- بناء الملصقات

export interface LabelItem {
  barcode: string;
  name: string;
  price: number;
  unit?: string;
}

export interface LabelContent {
  showStore: boolean;
  showName: boolean;
  showPrice: boolean;
  showCode: boolean;
  storeName?: string;
}

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface LabelFitIssue {
  barcode: string;
  name: string;
  /** 'unencodable' = محارف لا يدعمها المعيار (عربية مثلاً) · 'tooNarrow' = الشريط أدقّ من حدّ القراءة */
  reason: 'unencodable' | 'tooNarrow';
  neededMm: number;  // أقلّ عرض ملصق يجعله مقروءاً (يخصّ tooNarrow)
  moduleMm: number;
}

/** فحص جودة القراءة لكل كود ضمن عرض الملصق — تحذير قبل الهدر لا اكتشاف بعده. */
export function checkLabelFit(items: LabelItem[], labelW: number): LabelFitIssue[] {
  const avail = labelW - 2; // حشوة داخلية ١ملم من كل جانب
  const bad: LabelFitIssue[] = [];
  for (const it of items) {
    const f = fitBarcode(it.barcode, avail);
    // Code 128 يرمّز ASCII القابل للطباعة فقط — كود بحروف عربية لا يُرمَّز أصلاً
    if (!f) { bad.push({ barcode: it.barcode, name: it.name, reason: 'unencodable', neededMm: 0, moduleMm: 0 }); continue; }
    if (!f.ok) {
      bad.push({
        barcode: it.barcode, name: it.name, reason: 'tooNarrow',
        neededMm: +(f.neededMm + 2).toFixed(1), moduleMm: +f.moduleMm.toFixed(3),
      });
    }
  }
  return bad;
}

/** ملصق واحد — كل الأحجام مشتقّة من مقاس الملصق نفسه، لا أرقام ثابتة. */
export function labelHtml(item: LabelItem, l: LabelLayout, c: LabelContent, formatPrice: (n: number) => string): string {
  const innerW = l.labelW - 2;
  // توزيع الارتفاع: النصوص تأخذ ما تحتاجه، والباركود يأخذ الباقي (بحدّ أدنى معقول)
  const textLines = (c.showStore && c.storeName ? 1 : 0) + (c.showName ? 1 : 0) + (c.showPrice ? 1 : 0);
  const fontBase = Math.max(4.5, Math.min(9, l.labelH * 0.16));
  const codeFont = Math.max(4, fontBase * 0.8);
  const textH = textLines * fontBase * 1.25 + (c.showCode ? codeFont * 1.3 : 0);
  const barH = Math.max(6, l.labelH - textH - 2.5);

  return `<div class="lbl">
    ${c.showStore && c.storeName ? `<div class="st">${esc(c.storeName)}</div>` : ''}
    ${c.showName ? `<div class="nm">${esc(item.name)}</div>` : ''}
    ${c.showPrice ? `<div class="pr">${esc(formatPrice(item.price))}</div>` : ''}
    <div class="bc">${barcodeSvg(item.barcode, innerW, barH)}</div>
    ${c.showCode ? `<div class="cd">${esc(item.barcode)}</div>` : ''}
  </div>`;
}

/** يفتح نافذة الطباعة ويطبع — مشترك بين نمطي الورقة والبكرة. */
function openAndPrint(html: string, onError?: (msg: string) => void) {
  const w = window.open('', '_blank', 'width=900,height=760');
  if (!w) { onError?.(printWindowError()); return; }
  w.document.write(html);
  w.document.close();
  // setTimeout أوثق من onload بعد document.write داخل Electron/Chromium
  setTimeout(() => {
    w.focus();
    w.print();
    w.addEventListener('afterprint', () => { w.close(); window.focus(); });
    setTimeout(() => { if (!w.closed) { w.close(); window.focus(); } }, 30_000);
  }, 300);
}

/**
 * طباعة على **طابعة ملصقات صغيرة** (بكرة).
 *
 * الفرق الجوهري عن ورق A4: الطابعة لا تعرف A4 إطلاقاً — حجم صفحتها هو حجم الملصق نفسه.
 * فنضبط `@page` على مقاس الملصق بهوامش صفر، ونضع **ملصقاً واحداً لكل صفحة**،
 * فتقطع الطابعة بينها تلقائياً بلا أي ضبط من المستخدم.
 * ولا معنى لـ«ابدأ من الملصق رقم» هنا: البكرة متصلة ولا مواضع مستعملة فيها.
 */
function printRollLabels({ items, layout: l, content: c, formatPrice, onError }: {
  items: LabelItem[]; layout: LabelLayout; content: LabelContent;
  formatPrice: (n: number) => string; onError?: (msg: string) => void;
}) {
  const fontBase = Math.max(4.5, Math.min(9, l.labelH * 0.16));
  const codeFont = Math.max(4, fontBase * 0.8);

  const pages = items.map(it => `<div class="pg">${labelHtml(it, l, c, formatPrice)}</div>`).join('');

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8"/>
<title>ملصقات الباركود</title>
<style>
  /* حجم الصفحة = حجم الملصق. بلا هوامش — الطابعة تدير حوافها بنفسها */
  @page { size: ${l.labelW}mm ${l.labelH}mm; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: Tahoma, "Segoe UI", Arial, sans-serif; direction: rtl; color: #000; }
  /* ملصق واحد لكل صفحة — الطابعة تقطع بينها تلقائياً */
  .pg { width: ${l.labelW}mm; height: ${l.labelH}mm; break-after: page; page-break-after: always; }
  .pg:last-child { break-after: auto; page-break-after: auto; }
  .lbl {
    width: ${l.labelW}mm; height: ${l.labelH}mm;
    padding: 1mm; overflow: hidden;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; background: #fff;
  }
  .st { font-size: ${(fontBase * 0.85).toFixed(2)}px; font-weight: 700; line-height: 1.15; width: 100%;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nm { font-size: ${fontBase.toFixed(2)}px; font-weight: 700; line-height: 1.15; width: 100%;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pr { font-size: ${(fontBase * 1.15).toFixed(2)}px; font-weight: 800; line-height: 1.2; direction: ltr; }
  .bc { line-height: 0; margin-top: .4mm; }
  .bc svg { display: block; }
  .cd { font-size: ${codeFont.toFixed(2)}px; font-weight: 700; letter-spacing: .3px;
        font-family: "Courier New", monospace; direction: ltr; line-height: 1.2; }
</style>
</head>
<body>${pages}</body>
</html>`;

  openAndPrint(html, onError);
}

export interface PrintLabelsParams {
  items: LabelItem[];          // مكرّرة بعدد النسخ المطلوبة
  layout: LabelLayout;
  content: LabelContent;
  formatPrice: (n: number) => string;
  /** تخطّي أول N ملصقاً — لاستكمال ورقة استُعمل جزء منها بدل هدرها (نمط الورقة فقط) */
  skip: number;
  mode?: PrintMode;            // غيابه = 'sheet' (السلوك السابق حرفياً)
  onError?: (msg: string) => void;
}

export function printLabels({ items, layout: l, content, formatPrice, skip, mode = 'sheet', onError }: PrintLabelsParams) {
  if (items.length === 0) { onError?.('لا توجد ملصقات للطباعة'); return; }

  // ---- نمط البكرة: الطابعة الصغيرة لا تعرف A4. حجم الصفحة = حجم الملصق، بلا هوامش،
  //      وملصق واحد لكل صفحة، والطابعة تقطع بينها تلقائياً. ----
  if (mode === 'roll') {
    printRollLabels({ items, layout: l, content, formatPrice, onError });
    return;
  }

  const grid = computeGrid(l);
  if (!grid.fits) { onError?.('مقاس الملصق أكبر من الورقة — راجع الأبعاد والهوامش'); return; }

  const fontBase = Math.max(4.5, Math.min(9, l.labelH * 0.16));
  const codeFont = Math.max(4, fontBase * 0.8);

  // الملصقات المتخطّاة تُطبع فارغة فتُحفظ مواضعها على الورقة المستعملة جزئياً
  const blanks = Array.from({ length: Math.max(0, skip) }, () => '<div class="lbl blank"></div>');
  const cells = [...blanks, ...items.map(it => labelHtml(it, l, content, formatPrice))];

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8"/>
<title>ملصقات الباركود</title>
<style>
  @page { size: A4; margin: ${l.marginY}mm ${l.marginX}mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: Tahoma, "Segoe UI", Arial, sans-serif; direction: rtl; color: #000; }
  .sheet {
    display: grid;
    grid-template-columns: repeat(${grid.cols}, ${l.labelW}mm);
    column-gap: ${l.gapX}mm;
    row-gap: ${l.gapY}mm;
  }
  .lbl {
    width: ${l.labelW}mm; height: ${l.labelH}mm;
    padding: 1mm; overflow: hidden;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; background: #fff; break-inside: avoid;
  }
  .blank { visibility: hidden; }
  .st { font-size: ${(fontBase * 0.85).toFixed(2)}px; font-weight: 700; line-height: 1.15; width: 100%;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nm { font-size: ${fontBase.toFixed(2)}px; font-weight: 700; line-height: 1.15; width: 100%;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pr { font-size: ${(fontBase * 1.15).toFixed(2)}px; font-weight: 800; line-height: 1.2; direction: ltr; }
  .bc { line-height: 0; margin-top: .4mm; }
  .bc svg { display: block; }
  .cd { font-size: ${codeFont.toFixed(2)}px; font-weight: 700; letter-spacing: .3px;
        font-family: "Courier New", monospace; direction: ltr; line-height: 1.2; }
</style>
</head>
<body><div class="sheet">${cells.join('')}</div></body>
</html>`;

  openAndPrint(html, onError);
}

/** المنتجات التي بلا باركود — مرشّحة للتوليد. */
export const missingBarcode = (products: Product[]): Product[] =>
  products.filter(p => !p.barcode?.trim());
