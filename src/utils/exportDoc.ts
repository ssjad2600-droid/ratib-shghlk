/**
 * تصدير بيانات جدولية إلى **Word (.doc)** أو **PDF** — مصدر موحّد تستخدمه كل الشاشات
 * (المنتجات، الزبائن، الديون، النسخ الاحتياطي). خفيف بلا مكتبات:
 *   - Word: ملف HTML بترويسة Office XML يفتحه Word مباشرةً ويُنزَّل كـ .doc (تقنية معتمدة).
 *   - PDF: نافذة طباعة منسّقة، والمستخدم يختار «حفظ كـ PDF» (كما في طباعة الفواتير).
 * تصدير للقراءة/الأرشفة فقط — لا يمسّ أي بيانات (آمن تماماً).
 */

const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface ExportColumn {
  header: string;
  align?: 'right' | 'center' | 'left';
}

export interface ExportSpec {
  title: string;              // عنوان التقرير (اسم المحل مثلاً)
  subtitle?: string;          // وصف (نوع البيانات + العدد)
  columns: ExportColumn[];
  rows: (string | number)[][]; // كل صف = قيم بعدد الأعمدة نفسه
  note?: string;              // ملاحظة أسفل الجدول
}

const buildBodyHtml = (spec: ExportSpec): string => {
  const printDate = new Date().toLocaleDateString('ar-IQ');
  const thead = spec.columns
    .map(c => `<th style="text-align:${c.align ?? 'right'};">${esc(c.header)}</th>`)
    .join('');
  const tbody = spec.rows
    .map((row, i) => {
      const cells = spec.columns
        .map((c, ci) => `<td style="text-align:${c.align ?? 'right'};">${esc(row[ci] ?? '')}</td>`)
        .join('');
      const bg = i % 2 ? ' style="background:#f6f8fc;"' : '';
      return `<tr${bg}>${cells}</tr>`;
    })
    .join('');

  return `
    <div style="border-bottom:3px double #0B1F4D;padding-bottom:12px;margin-bottom:16px;">
      <h1 style="font-size:22px;font-weight:800;color:#0B1F4D;margin:0;">${esc(spec.title)}</h1>
      ${spec.subtitle ? `<p style="font-size:13px;color:#475569;margin:6px 0 0;">${esc(spec.subtitle)}</p>` : ''}
      <p style="font-size:12px;color:#64748b;margin:4px 0 0;">تاريخ التصدير: ${printDate}</p>
    </div>
    <table>
      <thead><tr>${thead}</tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    ${spec.note ? `<p style="font-size:12px;color:#475569;margin-top:14px;font-weight:600;">${esc(spec.note)}</p>` : ''}
    <p style="margin-top:24px;text-align:center;color:#94a3b8;font-size:11px;">رتب شغلك — نظام إدارة المشاريع العراقي ✨</p>`;
};

const TABLE_CSS = `
  body{font-family:'IBM Plex Sans Arabic','Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;color:#1e293b;background:#fff;padding:24px;}
  table{border-collapse:collapse;width:100%;font-size:13px;}
  th,td{border:1px solid #cbd5e1;padding:8px 10px;}
  th{background:#0B1F4D;color:#fff;font-weight:700;}
  @media print{@page{size:A4;margin:12mm;}body{padding:0;}}`;

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/** تصدير Word (.doc) — تنزيل ملف فعلي يفتحه Word. */
export function exportAsWord(spec: ExportSpec, filename: string) {
  const doc = `<!DOCTYPE html>
<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset='utf-8'><title>${esc(spec.title)}</title>
<style>${TABLE_CSS}</style></head>
<body dir="rtl">${buildBodyHtml(spec)}</body></html>`;
  // ﻿ (BOM) يضمن قراءة Word للعربية بترميز UTF-8 صحيح
  const blob = new Blob(['﻿', doc], { type: 'application/msword' });
  downloadBlob(blob, `${filename}.doc`);
}

// ---- تقرير متعدّد الأقسام (عدّة جداول في مستند واحد) — للنسخة الاحتياطية الشاملة ----
export interface ExportSection {
  heading: string;
  columns: ExportColumn[];
  rows: (string | number)[][];
  note?: string;
}

const buildTable = (columns: ExportColumn[], rows: (string | number)[][]): string => {
  const thead = columns.map(c => `<th style="text-align:${c.align ?? 'right'};">${esc(c.header)}</th>`).join('');
  const tbody = rows.map((row, i) => {
    const cells = columns.map((c, ci) => `<td style="text-align:${c.align ?? 'right'};">${esc(row[ci] ?? '')}</td>`).join('');
    return `<tr${i % 2 ? ' style="background:#f6f8fc;"' : ''}>${cells}</tr>`;
  }).join('');
  return `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
};

const buildReportBody = (title: string, subtitle: string, sections: ExportSection[]): string => {
  const printDate = new Date().toLocaleDateString('ar-IQ');
  const header = `
    <div style="border-bottom:3px double #0B1F4D;padding-bottom:12px;margin-bottom:16px;">
      <h1 style="font-size:22px;font-weight:800;color:#0B1F4D;margin:0;">${esc(title)}</h1>
      ${subtitle ? `<p style="font-size:13px;color:#475569;margin:6px 0 0;">${esc(subtitle)}</p>` : ''}
      <p style="font-size:12px;color:#64748b;margin:4px 0 0;">تاريخ التصدير: ${printDate}</p>
    </div>`;
  const body = sections.map(s => `
    <h2 style="font-size:16px;font-weight:800;color:#0B1F4D;margin:22px 0 8px;border-right:4px solid #0B1F4D;padding-right:8px;">${esc(s.heading)}</h2>
    ${buildTable(s.columns, s.rows)}
    ${s.note ? `<p style="font-size:12px;color:#475569;margin-top:8px;font-weight:600;">${esc(s.note)}</p>` : ''}`).join('');
  return `${header}${body}<p style="margin-top:24px;text-align:center;color:#94a3b8;font-size:11px;">رتب شغلك — نظام إدارة المشاريع العراقي ✨</p>`;
};

export function exportReportAsWord(title: string, subtitle: string, sections: ExportSection[], filename: string) {
  const doc = `<!DOCTYPE html>
<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset='utf-8'><title>${esc(title)}</title><style>${TABLE_CSS}</style></head>
<body dir="rtl">${buildReportBody(title, subtitle, sections)}</body></html>`;
  const blob = new Blob(['﻿', doc], { type: 'application/msword' });
  downloadBlob(blob, `${filename}.doc`);
}

export function exportReportAsPdf(title: string, subtitle: string, sections: ExportSection[], onError?: (msg: string) => void) {
  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8"/><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700;800&display=swap" rel="stylesheet"/>
<style>*{box-sizing:border-box;margin:0;padding:0;}${TABLE_CSS}</style></head>
<body>${buildReportBody(title, subtitle, sections)}</body></html>`;
  const w = window.open('', '_blank', 'width=980,height=720');
  if (!w) { onError?.('تعذّر فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة'); return; }
  w.document.write(html); w.document.close();
  setTimeout(() => {
    w.focus(); w.print();
    w.addEventListener('afterprint', () => { w.close(); window.focus(); });
    setTimeout(() => { if (!w.closed) { w.close(); window.focus(); } }, 60_000);
  }, 400);
}

/** تصدير PDF — نافذة طباعة، يختار المستخدم «حفظ كـ PDF». */
export function exportAsPdf(spec: ExportSpec, onError?: (msg: string) => void) {
  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8"/>
<title>${esc(spec.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700;800&display=swap" rel="stylesheet"/>
<style>*{box-sizing:border-box;margin:0;padding:0;}${TABLE_CSS}</style></head>
<body>${buildBodyHtml(spec)}</body></html>`;
  const w = window.open('', '_blank', 'width=980,height=720');
  if (!w) { onError?.('تعذّر فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة'); return; }
  w.document.write(html);
  w.document.close();
  setTimeout(() => {
    w.focus();
    w.print();
    w.addEventListener('afterprint', () => { w.close(); window.focus(); });
    setTimeout(() => { if (!w.closed) { w.close(); window.focus(); } }, 60_000);
  }, 400);
}
