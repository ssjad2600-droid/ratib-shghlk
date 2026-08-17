/**
 * قراءة وكتابة CSV — بلا أي مكتبة خارجية (صفر تبعيات، يعمل أوفلاين تماماً).
 *
 * يعالج مشاكل العربية المعروفة مع Excel:
 *  · BOM في بداية الملف (يضعه Excel، ويجب تجاهله عند القراءة ووضعه عند الكتابة).
 *  · الفاصلة المنقوطة `;` التي يستخدمها Excel في الويندوز العربي بدل الفاصلة.
 *  · الأرقام العربية-الهندية (٠-٩) والفواصل الألفية داخل خانات الأرقام.
 *  · الحقول المقتبسة التي تحوي فواصل أو أسطراً جديدة.
 */

import { toLatinDigits } from './arabicFormatters';

/** يزيل BOM ويوحّد فواصل الأسطر. */
const clean = (text: string): string =>
  text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

/** يكتشف الفاصل المستخدم من السطر الأول (خارج الاقتباسات). */
const detectDelimiter = (firstLine: string): string => {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && ch in counts) counts[ch]++;
  }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[1] ?? 0) > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ',';
};

/** يحلّل نص CSV إلى صفوف من الخانات (يدعم الاقتباس والأسطر داخل الخانة). */
export function parseCsv(raw: string): string[][] {
  const text = clean(raw);
  if (!text.trim()) return [];
  const delimiter = detectDelimiter(text.split('\n')[0]);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // اقتباس مهروب ""
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  row.push(field);
  rows.push(row);

  // إسقاط الأسطر الفارغة تماماً
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

/** يحوّل صفوف CSV إلى كائنات مفاتيحها من سطر الترويسة. */
export function csvToObjects(raw: string): Array<Record<string, string>> {
  const rows = parseCsv(raw);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
    return obj;
  });
}

/**
 * تحويل خانة نصية إلى رقم: يدعم الأرقام العربية **والفارسية** والفواصل الألفية والمسافات
 * ومحارف اتجاه النص الخفيّة التي يدسّها Excel في الملفات العربية.
 *
 * الفارسية (۰-۹) تصل فعلاً: ملفات تُصدَّر من هواتف أو تُنسخ من واتساب. وكانت تُقرأ نصاً
 * لا رقماً فيُرفض الصف كله بلا سبب مفهوم للتاجر.
 */
export function csvNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const s = toLatinDigits(value)
    .replace(/[,،\s‏‎]/g, '')
    .trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const escapeCell = (v: unknown): string => {
  const s = String(v ?? '');
  return /["\n,;\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * يبني نص CSV. نستخدم الفاصلة المنقوطة `;` لأن Excel العربي/الويندوزي يفتحها بأعمدة
 * صحيحة مباشرةً (الفاصلة تُبقي كل السطر في خانة واحدة على كثير من الأجهزة).
 */
export function buildCsv(headers: string[], rows: Array<Array<string | number>>): string {
  const delimiter = ';';
  const lines = [headers.map(escapeCell).join(delimiter)];
  for (const r of rows) lines.push(r.map(escapeCell).join(delimiter));
  return lines.join('\r\n');
}

/** ينزّل نص CSV كملف — مع BOM ليقرأ Excel العربية صحيحةً. */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob(['﻿', content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** يقرأ ملفاً نصياً مع محاولة ترميز windows-1256 إن ظهرت العربية مشوّهة. */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const tryRead = (encoding: string) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? '');
        // مؤشّر التشويه: حرف الاستبدال U+FFFD يعني أن الترميز خاطئ
        if (encoding === 'utf-8' && text.includes('�')) { tryRead('windows-1256'); return; }
        resolve(text);
      };
      reader.onerror = () => reject(new Error('تعذّر قراءة الملف'));
      reader.readAsText(file, encoding);
    };
    tryRead('utf-8');
  });
}
