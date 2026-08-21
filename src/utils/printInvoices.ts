import { Invoice } from '../types';
import { SUPPORT_PHONE } from '../config/adminConfig';
import { printWindowError } from './printSupport';

/**
 * 🔒 هروب HTML إلزامي لكل قيمة نصية تأتي من بيانات المستخدم قبل حقنها في مستند الطباعة.
 * بدونه يستطيع أي طرف يكتب نصاً (خصوصاً الموظف: أسماء زبائن/مواد) حقن وسوم أو سكربت
 * تُنفَّذ داخل نافذة الطباعة عند المالك (تصعيد صلاحيات من موظف إلى مالك).
 */
const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// عرض اسم المادة مع وحدة البيع إن وُجدت (مثال: "حليب - كارتون") — متوافق مع الفواتير القديمة بلا unitLabel
// يُرجع نصاً مهروباً جاهزاً للحقن مباشرة.
const itemDisplayName = (it: { name: string; unitLabel?: string }): string =>
  it.unitLabel ? `${esc(it.name)} - ${esc(it.unitLabel)}` : esc(it.name);

interface PrintInvoicesParams {
  label: string;                 // اسم الزبون / عنوان السجل
  phone?: string;
  invoices: Invoice[];           // فاتورة واحدة أو أكثر — تُطبع كلها في مستند واحد
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  // ترويسة المحل (المُصدِر) — اسم المحل + عنوان صاحب العمل + هاتفه. كل حقل يظهر فقط إن وُجد.
  store?: { name?: string; address?: string; phone?: string };
  onError?: (msg: string) => void;
}

/**
 * يبني ويطبع مستند سجل فواتير (زبون واحد) في نافذة منفصلة.
 * مصدر واحد للطباعة يستخدمه قسم الفواتير وسجل الزبون الشامل معاً — تفادياً للتكرار.
 * تمرير [inv] واحدة يطبع فاتورة مفردة؛ تمرير عدة فواتير يطبع السجل الكامل.
 */
export function printInvoices({ label, phone = '', invoices, currency, exchangeRate, store, onError }: PrintInvoicesParams) {
  if (!invoices.length) {
    onError?.('لا توجد فواتير للطباعة');
    return;
  }

  // ترويسة المحل — تُبنى مهروبةً، ويظهر كل سطر فقط إن أدخله المستخدم (العنوان اختياري كما طُلب)
  const storeName = esc(store?.name ?? '');
  const storeAddress = esc(store?.address ?? '');
  const storePhone = esc(store?.phone ?? '');
  const hasStoreHead = !!(store?.name?.trim() || store?.address?.trim() || store?.phone?.trim());
  const storeLetterhead = hasStoreHead ? `
  <div style="text-align:center;margin-bottom:18px;padding-bottom:14px;border-bottom:3px double #0B1F4D;">
    ${store?.name?.trim() ? `<h1 style="font-family:'IBM Plex Sans Arabic',Tahoma,sans-serif;font-size:24px;font-weight:800;color:#0B1F4D;letter-spacing:0.3px;">${storeName}</h1>` : ''}
    ${(store?.address?.trim() || store?.phone?.trim()) ? `<div style="margin-top:6px;font-size:12px;color:#475569;display:flex;justify-content:center;gap:18px;flex-wrap:wrap;">
      ${store?.address?.trim() ? `<span>📍 ${storeAddress}</span>` : ''}
      ${store?.phone?.trim() ? `<span dir="ltr" style="font-family:monospace;">📞 ${storePhone}</span>` : ''}
    </div>` : ''}
  </div>` : '';

  const totalAmount = invoices.reduce((s, inv) => s + inv.finalAmount, 0);
  const totalPaid = invoices.reduce((s, inv) => s + (inv.paidAmount ?? inv.finalAmount), 0);
  const totalRemaining = invoices.reduce((s, inv) => s + (inv.remainingAmount ?? 0), 0);
  const printDate = new Date().toLocaleDateString('ar-IQ');

  // دفعة متعددة الزبائن (اختيار يدوي/فترة زمنية) → نعرض اسم الزبون داخل كل فاتورة.
  // دفعة زبون واحد (سجل زبون) → الاسم في الترويسة العلوية يكفي، فلا نكرّره.
  const multiCustomer = new Set(invoices.map(inv => inv.customerId ?? `name:${inv.customerName}`)).size > 1;

  const currencySymbol = currency === 'IQD' ? 'د.ع' : '$';
  const fmt = (n: number) => currency === 'IQD'
    ? n.toLocaleString('ar-IQ') + ' ' + currencySymbol
    : (n / exchangeRate).toFixed(2) + ' ' + currencySymbol;

  // ترتيب زمني تصاعدي. لا فواصل صفحات إجبارية بين الفواتير — تدفّق مستمر يملأ الصفحة،
  // وكل فاتورة داخل حاوية .invoice-block تأخذ ارتفاعها الفعلي فقط مع منع قطعها في المنتصف.
  const invoiceBlocks = [...invoices]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((inv) => {
      const paid = inv.paidAmount ?? inv.finalAmount;
      const remaining = inv.remainingAmount ?? 0;

      const invDateLabel = /^\d{4}-\d{2}-\d{2}/.test(inv.date)
        ? new Date(inv.date).toLocaleDateString('ar-IQ')
        : inv.date;

      const itemRows = inv.items.map(it => `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#0f172a;">${itemDisplayName(it)}${
              (it.serials?.length)
                ? `<div style="font-size:11px;color:#334155;margin-top:4px;font-weight:600;">🛡️ السيريال: <span style="font-family:monospace;" dir="ltr">${it.serials.map(s => esc(s)).join(' · ')}</span>${
                    it.warrantyMonths ? ` — ضمان ${esc(it.warrantyMonths)} شهر` : ''
                  }</div>`
                : ''
            }</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#0f172a;">${esc(it.quantity)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#0f172a;font-family:monospace;">${fmt(it.price)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;text-align:left;font-weight:800;color:#0B1F4D;font-family:monospace;">${fmt(it.total)}</td>
          </tr>`).join('');

      return `
          <div class="invoice-block">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0B1F4D;padding-bottom:10px;margin-bottom:16px;">
              <div>
                <span style="font-size:16px;font-weight:800;color:#0B1F4D;">فاتورة رقم: ${esc(inv.invoiceNumber)}</span>
                ${multiCustomer ? `<div style="font-size:13px;color:#334155;margin-top:4px;">الزبون: <span style="font-weight:700;color:#0B1F4D;">${esc(inv.customerName)}</span></div>` : ''}
              </div>
              <div style="text-align:left;color:#334155;font-size:13px;font-weight:600;">
                <span>التاريخ: ${esc(invDateLabel)}</span>
              </div>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px;">
              <thead>
                <tr style="background:#0B1F4D;color:#fff;font-size:13px;">
                  <th style="padding:10px 12px;text-align:right;font-weight:700;border-radius:6px 0 0 6px;">المادة</th>
                  <th style="padding:10px 12px;text-align:center;font-weight:700;">الكمية</th>
                  <th style="padding:10px 12px;text-align:center;font-weight:700;">السعر</th>
                  <th style="padding:10px 12px;text-align:left;font-weight:700;border-radius:0 6px 6px 0;">المجموع</th>
                </tr>
              </thead>
              <tbody>${itemRows}</tbody>
            </table>
            <div style="display:flex;justify-content:flex-end;">
              <div style="width:300px;font-size:13px;color:#1e293b;font-weight:600;">
                <div style="display:flex;justify-content:space-between;padding:4px 0;">
                  <span>المجموع الفرعي:</span>
                  <span style="font-family:monospace;">${fmt(inv.totalAmount)}</span>
                </div>
                ${inv.discount > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;color:#dc2626;"><span>الخصم:</span><span style="font-family:monospace;">-${fmt(inv.discount)}</span></div>` : ''}
                ${inv.tax > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;color:#4338ca;"><span>الضريبة:</span><span style="font-family:monospace;">+${fmt(inv.tax)}</span></div>` : ''}
                <div style="display:flex;justify-content:space-between;padding:9px 12px;margin-top:6px;background:#EEF2F8;border-radius:8px;font-weight:800;color:#0B1F4D;font-size:15px;">
                  <span>المبلغ النهائي:</span>
                  <span style="font-family:monospace;">${fmt(inv.finalAmount)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;padding:5px 0;margin-top:2px;color:#047857;font-weight:700;">
                  <span>المدفوع:</span>
                  <span style="font-family:monospace;">${fmt(paid)}</span>
                </div>
                ${remaining > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 12px;margin-top:3px;background:#fff1f2;border:1px solid #fecdd3;border-radius:8px;color:#be123c;font-weight:800;font-size:14px;"><span>المتبقي (دين):</span><span style="font-family:monospace;">${fmt(remaining)}</span></div>` : ''}
              </div>
            </div>
          </div>`;
    }).join('');

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>سجل فواتير — ${esc(label)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    /* Tahoma كخط احتياطي نظيف عربياً — يعمل حتى بدون إنترنت إذا فشل تحميل خط Google */
    body{font-family:'IBM Plex Sans Arabic',Tahoma,sans-serif;direction:rtl;color:#1e293b;background:#fff;padding:20px;font-weight:500;line-height:1.75;font-size:14px;}
    h1,h2,h3,h4{font-family:'IBM Plex Sans Arabic',Tahoma,sans-serif;font-weight:700;}
    /* كل فاتورة تأخذ ارتفاعها الفعلي فقط. page-break-inside:avoid يمنع قطعها في المنتصف طالما
       تسع في صفحة؛ وإن كانت أطول من صفحة كاملة (مواد كثيرة) يضطر المتصفح لتقسيمها تلقائياً —
       وهو السلوك المعقول المطلوب. الفاصل المتقطّع يميّز كل فاتورة عن التالية في التدفق المستمر. */
    .invoice-block{page-break-inside:avoid;break-inside:avoid;padding-bottom:18px;margin-bottom:18px;border-bottom:1px dashed #cbd5e1;}
    .invoice-block:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0;}
    @media print{@page{size:A4;margin:12mm;}body{padding:0;}}
  </style>
</head>
<body>
  <!-- Store letterhead (اسم المحل + عنوان صاحب العمل + الهاتف) — يظهر عند إدخاله فقط -->
  ${storeLetterhead}

  <!-- Customer Header -->
  <div style="background:#0B1F4D;color:#fff;padding:20px 24px;border-radius:12px;margin-bottom:20px;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
      <div>
        <p style="font-size:12px;color:#cbd5e1;margin-bottom:4px;">${multiCustomer ? 'كشف فواتير' : 'سجل الفواتير الكامل'}</p>
        <h2 style="font-family:'IBM Plex Sans Arabic',Tahoma,sans-serif;font-size:24px;font-weight:800;">${esc(label)}</h2>
        ${phone ? `<p style="font-size:13px;color:#e2e8f0;margin-top:4px;font-family:monospace;">${esc(phone)}</p>` : ''}
      </div>
      <div style="text-align:left;font-size:12px;color:#cbd5e1;">
        <p>تاريخ الطباعة:</p>
        <p style="font-weight:700;color:#fff;font-size:13px;">${printDate}</p>
        <p style="margin-top:6px;font-weight:700;">رتب شغلك 💎</p>
      </div>
    </div>
  </div>

  <!-- Summary Block -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;">
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:center;">
      <p style="font-size:12px;color:#475569;margin-bottom:5px;font-weight:600;">عدد الفواتير</p>
      <p style="font-size:20px;font-weight:800;color:#0B1F4D;">${invoices.length}</p>
    </div>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px;text-align:center;">
      <p style="font-size:12px;color:#475569;margin-bottom:5px;font-weight:600;">إجمالي المشتريات</p>
      <p style="font-size:16px;font-weight:800;color:#047857;font-family:monospace;">${fmt(totalAmount)}</p>
    </div>
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:14px;text-align:center;">
      <p style="font-size:12px;color:#475569;margin-bottom:5px;font-weight:600;">إجمالي المدفوع</p>
      <p style="font-size:16px;font-weight:800;color:#1d4ed8;font-family:monospace;">${fmt(totalPaid)}</p>
    </div>
    <div style="background:${totalRemaining > 0 ? '#fff1f2' : '#f0fdf4'};border:1px solid ${totalRemaining > 0 ? '#fecdd3' : '#bbf7d0'};border-radius:10px;padding:14px;text-align:center;">
      <p style="font-size:12px;color:#475569;margin-bottom:5px;font-weight:600;">إجمالي المتبقي</p>
      <p style="font-size:16px;font-weight:800;color:${totalRemaining > 0 ? '#be123c' : '#047857'};font-family:monospace;">${fmt(totalRemaining)}</p>
    </div>
  </div>

  <hr style="border:none;border-top:2px solid #e2e8f0;margin-bottom:24px;"/>

  <!-- Invoice Blocks -->
  ${invoiceBlocks}

  <!-- Footer: اسم البرنامج + رقم التواصل -->
  <div style="margin-top:32px;padding-top:14px;border-top:2px solid #e2e8f0;text-align:center;color:#475569;font-size:12px;">
    <p style="font-weight:800;color:#0B1F4D;font-size:13px;">رتب شغلك — نظام إدارة المشاريع العراقي ✨</p>
    <p style="margin-top:5px;font-weight:600;">📞 للتواصل والدعم: <span dir="ltr" style="font-family:monospace;font-weight:800;color:#0B1F4D;">${esc(SUPPORT_PHONE)}</span></p>
  </div>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) { onError?.(printWindowError()); return; }
  w.document.write(html);
  w.document.close();
  // setTimeout is more reliable than w.onload after document.write() in Electron/Chromium
  setTimeout(() => {
    w.focus();
    w.print();
    w.addEventListener('afterprint', () => {
      w.close();
      window.focus(); // restore focus to main Electron window
    });
    // Safety fallback: close orphan window after 30s if afterprint never fires
    setTimeout(() => { if (!w.closed) { w.close(); window.focus(); } }, 30_000);
  }, 300);
}
