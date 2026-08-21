/**
 * 🔒 هروب HTML إلزامي لكل قيمة نصية من بيانات المستخدم قبل حقنها في مستند الطباعة
 * (نفس مبرّر printInvoices: منع حقن وسوم/سكربت عبر أسماء المواد).
 */
import { printWindowError } from './printSupport';

const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface PurchaseLine {
  name: string;
  currentQty: number;
  threshold: number;
  baseUnit: string;        // وحدة الأساس (قطعة/كيلو...)
  purchaseQty: number;     // الكمية المقترحة بوحدة الشراء
  purchaseUnit: string;    // وحدة الشراء (كارتون أو نفس وحدة الأساس)
  baseUnitsAcquired: number; // ما يعادلها بوحدة الأساس
  lineCost?: number;       // التكلفة التقديرية (undefined = تكلفة غير معروفة)
}

interface PrintPurchaseListParams {
  storeName: string;
  lines: PurchaseLine[];
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  onError?: (msg: string) => void;
}

/**
 * يبني ويطبع "قائمة تجهيز النواقص" في نافذة منفصلة — تُسلَّم للمجهّز.
 * يعرض لكل مادة: المخزون الحالي، حد الأمان، الكمية المقترحة بوحدة الشراء، والتكلفة التقديرية.
 */
export function printPurchaseList({ storeName, lines, currency, exchangeRate, onError }: PrintPurchaseListParams) {
  if (!lines.length) {
    onError?.('لا توجد مواد ناقصة للطباعة');
    return;
  }

  const currencySymbol = currency === 'IQD' ? 'د.ع' : '$';
  const fmt = (n: number) => currency === 'IQD'
    ? Math.round(n).toLocaleString('ar-IQ') + ' ' + currencySymbol
    : (n / exchangeRate).toFixed(2) + ' ' + currencySymbol;

  const printDate = new Date().toLocaleDateString('ar-IQ');
  const knownTotal = lines.reduce((s, l) => s + (l.lineCost ?? 0), 0);
  const unknownCount = lines.filter(l => l.lineCost === undefined).length;

  const rows = lines.map((l, i) => `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;color:#94a3b8;">${esc(i + 1)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:700;color:#0B1F4D;">${esc(l.name)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;color:#be123c;">${esc(l.currentQty)} / ${esc(l.threshold)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;font-weight:800;">
            ${esc(l.purchaseQty)} ${esc(l.purchaseUnit)}
            ${l.purchaseUnit !== l.baseUnit ? `<div style="font-size:9px;color:#94a3b8;font-weight:600;">= ${esc(l.baseUnitsAcquired)} ${esc(l.baseUnit)}</div>` : ''}
          </td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:left;font-weight:700;font-family:monospace;">
            ${l.lineCost !== undefined ? esc(fmt(l.lineCost)) : '<span style="color:#d97706;font-weight:700;">— غير محسوبة</span>'}
          </td>
        </tr>`).join('');

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>قائمة تجهيز النواقص — ${esc(storeName)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'IBM Plex Sans Arabic',Tahoma,sans-serif;direction:rtl;color:#1e293b;background:#fff;padding:20px;font-weight:500;line-height:1.6;}
    table{width:100%;border-collapse:collapse;font-size:12px;}
    thead tr{background:#EEF2F8;color:#0B1F4D;}
    th{padding:9px 10px;font-weight:700;}
    tr{page-break-inside:avoid;break-inside:avoid;}
    @media print{@page{size:A4;margin:12mm;}body{padding:0;}}
  </style>
</head>
<body>
  <!-- Header -->
  <div style="background:#0B1F4D;color:#fff;padding:20px 24px;border-radius:12px;margin-bottom:20px;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
      <div>
        <p style="font-size:11px;color:#94a3b8;margin-bottom:4px;">قائمة تجهيز وشراء النواقص 📋</p>
        <h2 style="font-size:22px;font-weight:700;">${esc(storeName)}</h2>
        <p style="font-size:12px;color:#cbd5e1;margin-top:4px;">مواد تحت حد الأمان — تُسلَّم للمجهّز</p>
      </div>
      <div style="text-align:left;font-size:11px;color:#94a3b8;">
        <p>تاريخ التجهيز:</p>
        <p style="font-weight:700;color:#e2e8f0;">${printDate}</p>
        <p style="margin-top:6px;">رتب شغلك 💎</p>
      </div>
    </div>
  </div>

  <!-- Summary -->
  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:20px;">
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:center;">
      <p style="font-size:10px;color:#64748b;margin-bottom:4px;">عدد المواد الناقصة</p>
      <p style="font-size:18px;font-weight:800;color:#0B1F4D;">${esc(lines.length)}</p>
    </div>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px;text-align:center;">
      <p style="font-size:10px;color:#64748b;margin-bottom:4px;">التكلفة التقديرية الإجمالية</p>
      <p style="font-size:16px;font-weight:800;color:#059669;font-family:monospace;">${esc(fmt(knownTotal))}</p>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="text-align:center;width:36px;">#</th>
        <th style="text-align:right;">المادة</th>
        <th style="text-align:center;">المتوفر / الحد</th>
        <th style="text-align:center;">الكمية المقترحة</th>
        <th style="text-align:left;">التكلفة التقديرية</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr style="background:#EEF2F8;font-weight:800;color:#0B1F4D;">
        <td colspan="4" style="padding:10px;text-align:left;">الإجمالي التقديري للفاتورة:</td>
        <td style="padding:10px;text-align:left;font-family:monospace;">${esc(fmt(knownTotal))}</td>
      </tr>
    </tfoot>
  </table>

  ${unknownCount > 0 ? `<p style="margin-top:14px;font-size:11px;color:#d97706;font-weight:700;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px;">
    ⚠️ ${esc(unknownCount)} مادة بلا سعر شراء مُدخَل — تكلفتها غير محسوبة في الإجمالي. أدخِل أسعار شرائها لتقدير أدق.
  </p>` : ''}

  <div style="margin-top:32px;padding-top:12px;border-top:1px solid #e2e8f0;text-align:center;color:#94a3b8;font-size:10px;">
    <p>رتب شغلك — نظام إدارة المشاريع العراقي ✨</p>
  </div>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) { onError?.(printWindowError()); return; }
  w.document.write(html);
  w.document.close();
  setTimeout(() => {
    w.focus();
    w.print();
    w.addEventListener('afterprint', () => { w.close(); window.focus(); });
    setTimeout(() => { if (!w.closed) { w.close(); window.focus(); } }, 30_000);
  }, 300);
}
