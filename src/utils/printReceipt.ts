import { Invoice } from '../types';
import { SUPPORT_PHONE } from '../config/adminConfig';
import { cashPortion, electronicPortion } from './paymentMethods';
import { printInvoices } from './printInvoices';
import { printWindowError } from './printSupport';

/**
 * طباعة إيصال على **طابعة حرارية** (بكرة ٥٨ أو ٨٠ ملم) — منفصل تماماً عن قالب A4.
 *
 * لماذا ملف مستقل ولا تعديل على printInvoices؟
 * الاختلاف ليس في عرض الورقة بل في التصميم كله: بلا ألوان (الطابعة الحرارية لا حبر لها،
 * بل حرارة على ورق حسّاس فتتحوّل الخلفيات الملوّنة إلى رمادي متّسخ)، وبلا جداول (٤٨ملم
 * لا تتّسع لأربعة أعمدة)، وبطول مفتوح لا صفحة ثابتة. فصلُهما يحمي طباعة A4 القائمة من أي كسر.
 *
 * 🔴 قواعد حاسمة تعلّمناها من طبيعة هذه الطابعات:
 *  · `size: {عرض} auto` — الارتفاع **تلقائي**؛ رقم ثابت يُخرج ورقاً فارغاً طويلاً أو يقصّ الإيصال.
 *  · الهوامش صفر — الطابعة تدير هوامشها بنفسها، وأي هامش يلتهم العرض الضيّق أصلاً.
 *  · خطوط النظام لا خطوط الويب — الطابعة تطبع ما يُصيّره النظام، وخط ويب قد لا يُحمَّل وقت
 *    الطباعة فتخرج مربّعات فارغة.
 *  · اسم المادة يلتفّ ولا يُقصّ — «صوندة ٣\٤ تأسيس صيني» ينزل سطراً بدل أن يُبتر.
 *  · الأرقام بالصيغة اللاتينية في الأعمدة الرقمية — الأرقام العربية-الهندية تُصيَّر بعرض غير
 *    منتظم على ٢٠٣ نقطة/بوصة فتُزيح المحاذاة. النص كله يبقى عربياً.
 */

export type ReceiptWidth = '58' | '80';

/** عرض منطقة الطباعة الفعلية (لا عرض البكرة): ٨٠ملم ⇒ ٧٢، و٥٨ملم ⇒ ٤٨. */
const PRINTABLE: Record<ReceiptWidth, number> = { '58': 48, '80': 72 };

const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const itemDisplayName = (it: { name: string; unitLabel?: string }): string =>
  it.unitLabel ? `${esc(it.name)} - ${esc(it.unitLabel)}` : esc(it.name);

export interface PrintReceiptParams {
  invoice: Invoice;
  width: ReceiptWidth;
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  store?: { name?: string; address?: string; phone?: string };
  /** اسم البائع — يظهر في الإيصال لمعرفة من باع عند المراجعة */
  sellerName?: string;
  onError?: (msg: string) => void;
}

export function printReceipt({
  invoice, width, currency, exchangeRate, store, sellerName, onError,
}: PrintReceiptParams) {
  const mm = PRINTABLE[width];
  // ٥٨ملم ضيّقة: نصغّر الخط درجة ونضغط التباعد لتدخل الأصناف دون التفاف مزعج
  const narrow = width === '58';
  const base = narrow ? 10 : 11.5;

  /** الأرقام لاتينية داخل الأعمدة الرقمية — مقصود، انظر تعليق الرأس. */
  const fmt = (n: number) => {
    const v = currency === 'USD' ? n / (exchangeRate || 1) : n;
    const s = currency === 'USD'
      ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : Math.round(v).toLocaleString('en-US');
    return `${s} ${currency === 'USD' ? '$' : 'د.ع'}`;
  };
  const num = (n: number) => n.toLocaleString('en-US');

  const when = (() => {
    const d = invoice.createdAt ? new Date(invoice.createdAt) : new Date(`${invoice.date}T00:00:00`);
    if (isNaN(d.getTime())) return { date: esc(invoice.date), time: '' };
    const pad = (x: number) => String(x).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  })();

  const paid = invoice.paidAmount ?? invoice.finalAmount ?? 0;
  const remaining = Math.max(0, (invoice.finalAmount ?? 0) - paid);
  const cash = cashPortion(paid, invoice.payments);
  const electronic = electronicPortion(paid, invoice.payments);

  // ---- الأصناف: سطران لكل صنف (الاسم ثم الحساب) — لا جدول، فالعرض لا يتّسع ----
  const itemsHtml = (invoice.items || []).map(it => {
    const lineTotal = it.total ?? it.price * it.quantity;
    const serials = it.serials?.length
      ? `<div class="ser">السيريال: <span dir="ltr">${it.serials.map(s => esc(s)).join(' · ')}</span></div>`
      : '';
    return `<div class="item">
      <div class="nm">${itemDisplayName(it)}</div>
      <div class="calc"><span dir="ltr">${num(it.quantity)} × ${num(it.price)}</span><span dir="ltr">${fmt(lineTotal)}</span></div>
      ${serials}
    </div>`;
  }).join('');

  const row = (label: string, value: string, cls = '') =>
    `<div class="row ${cls}"><span>${label}</span><span dir="ltr">${value}</span></div>`;

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8"/>
<title>إيصال ${esc(invoice.invoiceNumber)}</title>
<style>
  /* الارتفاع auto إلزاماً: البكرة تُقطع عند نهاية المحتوى */
  @page { size: ${width}mm auto; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    /* خطوط النظام فقط — لا خط ويب قد لا يُحمَّل وقت الطباعة */
    font-family: Tahoma, "Segoe UI", Arial, sans-serif;
    direction: rtl; color: #000;
    width: ${mm}mm;
    font-size: ${base}px; line-height: 1.5; font-weight: 600;
    padding: 2mm 1mm 4mm;
  }
  .c { text-align: center; }
  .shop { font-size: ${base + 4}px; font-weight: 800; letter-spacing: .2px; }
  .sub  { font-size: ${base - 1}px; font-weight: 600; }
  .sep  { border-top: 1px dashed #000; margin: 2mm 0; }
  .meta { display: flex; justify-content: space-between; font-size: ${base - 1}px; }
  .item { margin-bottom: 1.6mm; }
  /* الاسم يلتفّ ولا يُقصّ */
  .nm   { font-weight: 700; word-wrap: break-word; overflow-wrap: anywhere; }
  .calc { display: flex; justify-content: space-between; font-size: ${base - 0.5}px; font-weight: 600; }
  .ser  { font-size: ${base - 2}px; font-weight: 600; word-wrap: break-word; overflow-wrap: anywhere; }
  .row  { display: flex; justify-content: space-between; font-size: ${base}px; }
  .tot  { font-size: ${base + 3}px; font-weight: 800; border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 1.2mm 0; margin: 1.2mm 0; }
  .due  { font-weight: 800; border: 1px solid #000; padding: 1mm; margin-top: 1.2mm; }
  .thanks { font-size: ${base + 1}px; font-weight: 800; margin-top: 2mm; }
  .tiny { font-size: ${base - 2}px; font-weight: 600; }
</style>
</head>
<body>
  <div class="c">
    ${store?.name?.trim() ? `<div class="shop">${esc(store.name)}</div>` : ''}
    ${store?.address?.trim() ? `<div class="sub">${esc(store.address)}</div>` : ''}
    ${store?.phone?.trim() ? `<div class="sub" dir="ltr">${esc(store.phone)}</div>` : ''}
  </div>

  <div class="sep"></div>

  <div class="meta"><span>فاتورة رقم</span><span dir="ltr">${esc(invoice.invoiceNumber)}</span></div>
  <div class="meta"><span>التاريخ</span><span dir="ltr">${when.date}${when.time ? ` — ${when.time}` : ''}</span></div>
  ${invoice.customerName?.trim() ? `<div class="meta"><span>الزبون</span><span>${esc(invoice.customerName)}</span></div>` : ''}
  ${sellerName?.trim() ? `<div class="meta"><span>البائع</span><span>${esc(sellerName)}</span></div>` : ''}

  <div class="sep"></div>

  ${itemsHtml}

  <div class="sep"></div>

  ${row('المجموع', fmt(invoice.totalAmount ?? 0))}
  ${(invoice.discount ?? 0) > 0 ? row('الخصم', `- ${fmt(invoice.discount)}`) : ''}
  ${(invoice.tax ?? 0) > 0 ? row('الضريبة', fmt(invoice.tax)) : ''}
  ${row('الإجمالي', fmt(invoice.finalAmount ?? 0), 'tot')}
  ${row('المدفوع', fmt(paid))}
  ${electronic > 0 ? row('منه نقداً', fmt(cash), 'tiny') : ''}
  ${electronic > 0 ? row('منه إلكتروني', fmt(electronic), 'tiny') : ''}
  ${remaining > 0 ? `<div class="row due"><span>المتبقي (دين)</span><span dir="ltr">${fmt(remaining)}</span></div>` : ''}

  <div class="c thanks">شكراً لتعاملكم معنا</div>
  <div class="c tiny">نظام «رتب شغلك» — للدعم: <span dir="ltr">${esc(SUPPORT_PHONE)}</span></div>
</body>
</html>`;

  const w = window.open('', '_blank', `width=420,height=760`);
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
 * صيغة الطباعة الافتراضية للمحل. غيابها = 'a4' ⇒ سلوك البرنامج قبل هذه الميزة حرفياً.
 */
export type PrintFormat = 'a4' | 'thermal80' | 'thermal58';

export const PRINT_FORMAT_LABEL: Record<PrintFormat, string> = {
  a4: 'ورقة A4 عادية',
  thermal80: 'إيصال حراري ٨٠ ملم',
  thermal58: 'إيصال حراري ٥٨ ملم',
};

export const normalizePrintFormat = (v?: string): PrintFormat =>
  v === 'thermal80' || v === 'thermal58' ? v : 'a4';

/**
 * موزّع الطباعة لفاتورة **واحدة**: يوجّهها للقالب الحراري أو لقالب A4 حسب إعداد المحل.
 *
 * كشف الحساب متعدّد الفواتير يبقى A4 دائماً ولا يمرّ من هنا — لا معنى لطباعة عشرين
 * فاتورة على بكرة بطول متر.
 */
export function printSingleInvoice(params: {
  format?: string;
  invoice: Invoice;
  label: string;
  phone?: string;
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  store?: { name?: string; address?: string; phone?: string };
  sellerName?: string;
  onError?: (msg: string) => void;
}) {
  const format = normalizePrintFormat(params.format);
  if (format === 'a4') {
    printInvoices({
      label: params.label,
      phone: params.phone ?? '',
      invoices: [params.invoice],
      currency: params.currency,
      exchangeRate: params.exchangeRate,
      store: params.store,
      onError: params.onError,
    });
    return;
  }
  printReceipt({
    invoice: params.invoice,
    width: format === 'thermal58' ? '58' : '80',
    currency: params.currency,
    exchangeRate: params.exchangeRate,
    store: params.store,
    sellerName: params.sellerName,
    onError: params.onError,
  });
}
