import { PurchaseInvoice, PurchaseInvoiceItem } from '../types';
import { allocateNumber, duplicateNumbersOf, NumberedDoc } from './sequenceNumber';
import { parseAmount } from './arabicFormatters';

/**
 * منطق فاتورة الشراء — الحساب والترقيم وبناء البنود، بمعزل عن الواجهة.
 *
 * ثلاث علل قِسْتُها في الشاشة الحيّة، كلها تمسّ المال:
 *  ١) الفاتورة **لا تُحفظ** حين يحمل بندٌ حقلاً `undefined` (بند حرّ، أو منتج بلا سعر جملة).
 *  ٢) كل الفواتير تحمل الرقم `P-١٠٠١` لأن تجريد `\d` يمحو الأرقام العربية.
 *  ٣) المبالغ تُقرأ بـ`parseFloat`، فـ`٥٠٠٠` تصير صفراً و`5٠٠٠` تصير **٥** بصمت.
 */

export const PURCHASE_PREFIX = 'P-';
/** أرضية الترقيم — تبقى كما كانت لئلا تختلف أرقام حسابٍ قائم. */
export const PURCHASE_FLOOR = 1000;

const asDocs = (invoices: Array<{ invoiceNumber?: string; deviceTag?: string }>): NumberedDoc[] =>
  invoices.map(i => ({ number: i.invoiceNumber, deviceTag: i.deviceTag }));

/** الرقم التالي — من أعلى رقم مستعمل، موسوماً بالجهاز عند تعدّد الأجهزة. */
export const allocatePurchaseNumber = (
  invoices: Array<{ invoiceNumber?: string; deviceTag?: string }>, myTag = '',
): string => allocateNumber(PURCHASE_PREFIX, asDocs(invoices), myTag, PURCHASE_FLOOR);

export const duplicatePurchaseNumbers = (
  invoices: Array<{ invoiceNumber?: string; deviceTag?: string }>,
) => duplicateNumbersOf(asDocs(invoices));

/* ------------------------------------------------------------------ */

/** سطر النموذج: المبالغ **نصوص خام** كي يكتب التاجر بحرّية (عربي، كسور، تصحيح). */
export interface PurchaseFormItem {
  productId?: string;
  productName: string;
  quantity: string;
  buyPrice: string;
  wholesaleUnitPrice: string;
  expiryDate?: string;
  unitName?: string;
}

export const blankFormItem = (): PurchaseFormItem => ({
  productName: '', quantity: '1', buyPrice: '', wholesaleUnitPrice: '',
});

/** قراءة مبلغ من نصّ — تقبل العربية والفارسية والكسور، وترفض التالف بصفر. */
export const amountOf = (text: string): number => {
  const n = parseAmount(text);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

export const lineTotal = (item: PurchaseFormItem): number =>
  amountOf(item.quantity) * amountOf(item.buyPrice);

/** بنود صالحة: لها اسم وكمية موجبة. (السعر صفراً مسموح — هدية من المورد.) */
export const validFormItems = (items: PurchaseFormItem[]): PurchaseFormItem[] =>
  items.filter(it => it.productName.trim() && amountOf(it.quantity) > 0);

/**
 * 🔴 يبني بند الوثيقة **بإسقاط المفاتيح غير المعروفة** بدل كتابتها `undefined`.
 *
 * `{ productId: undefined }` كان يُفشل الكتابة كلها ويُبقي النموذج مفتوحاً بلا رسالة.
 * وحتى مع `ignoreUndefinedProperties` تبقى هذه هي الصياغة الصحيحة: الحقل الغائب يُحذف،
 * لا يُكتب فارغاً — فتبقى الوثيقة نظيفة ويبقى معنى «اختياري» صادقاً.
 */
export function buildInvoiceItem(item: PurchaseFormItem): PurchaseInvoiceItem {
  const quantity = amountOf(item.quantity);
  const buyPrice = amountOf(item.buyPrice);
  const out: PurchaseInvoiceItem = {
    productName: item.productName.trim(),
    quantity,
    buyPrice,
    total: quantity * buyPrice,
  };
  if (item.productId) out.productId = item.productId;
  if (item.unitName) out.unitName = item.unitName;
  if (item.expiryDate) out.expiryDate = item.expiryDate;
  const wholesale = item.wholesaleUnitPrice.trim();
  if (wholesale) out.wholesaleUnitPrice = amountOf(wholesale);
  return out;
}

/* ------------------------------------------------------------------ */

export interface PurchaseTotals {
  subtotal: number;
  finalTotal: number;
  /** الباقي على المحل للمورد (صفر إن سُدّد كاملاً أو زيادة) */
  remaining: number;
  /** ما دُفع زيادةً عن قيمة الفاتورة — رصيدٌ لنا عند المورد */
  overpaid: number;
  /** أثر الفاتورة على رصيد المورد: موجب = علينا له، سالب = لنا عنده */
  supplierDelta: number;
}

/**
 * 🟠 الدفع الزائد كان يتبخّر: `remaining = Math.max(0, total - paid)` ثم
 * `if (remaining > 0) increment(remaining)` — فمن دفع أكثر من قيمة الفاتورة خسر الفرق
 * من دفاتره. ونظام الموردين يعرف هذه الحالة أصلاً (رصيد سالب = «لنا عنده»)، فالمفهوم
 * موجود والشاشة لم تكن تغذّيه. الأثر الآن `total - paid` بإشارته، وهو يعمل في الاتجاهين.
 */
export function purchaseTotals(
  items: PurchaseFormItem[], discountText: string, taxText: string, paidText: string,
): PurchaseTotals {
  const subtotal = items.reduce((s, it) => s + lineTotal(it), 0);
  const finalTotal = Math.max(0, subtotal - amountOf(discountText) + amountOf(taxText));
  const paid = amountOf(paidText);
  const supplierDelta = finalTotal - paid;
  return {
    subtotal,
    finalTotal,
    remaining: Math.max(0, supplierDelta),
    overpaid: Math.max(0, -supplierDelta),
    supplierDelta,
  };
}

export const paymentTypeOf = (finalTotal: number, paid: number): 'cash' | 'credit' | 'partial' => {
  if (paid <= 0) return 'credit';
  if (paid >= finalTotal) return 'cash';
  return 'partial';
};

/* ------------------------------------------------------------------ */

/**
 * 🟠 تكلفة المادة بعد إلغاء فاتورة.
 *
 * الحفظ يكتب `product_costs`، والإلغاء كان يتركها على سعر فاتورةٍ ملغاة — فيبقى سعر شراء
 * خاطئ أساساً لحساب ربح كل بيعة قادمة. نُعيدها إلى سعر **أحدث فاتورة مستلَمة أخرى**
 * لنفس المادة؛ فإن لم توجد فلا نعرف التكلفة الصحيحة، ولا نخترعها صفراً
 * (صفرٌ يعني «مجانية» فيصير كل بيع ربحاً كاملاً).
 */
export function costAfterCancelling(
  invoices: PurchaseInvoice[], cancelledId: string, productId: string,
): { buyPrice: number; wholesaleBuyPrice?: number } | null {
  const candidates = invoices
    .filter(inv => inv.id !== cancelledId && inv.status === 'received')
    .filter(inv => inv.items.some(it => it.productId === productId))
    .sort((a, b) => b.createdAt - a.createdAt);

  for (const inv of candidates) {
    const it = [...inv.items].reverse().find(x => x.productId === productId);
    if (!it) continue;
    const out: { buyPrice: number; wholesaleBuyPrice?: number } = { buyPrice: it.buyPrice };
    if (it.wholesaleUnitPrice !== undefined) out.wholesaleBuyPrice = it.wholesaleUnitPrice;
    return out;
  }
  return null;
}

/**
 * 🔴 هل يجعل الإلغاء رصيد مادةٍ سالباً؟ (بضاعة استُلمت ثم بِيعت ثم أُلغيت فاتورتها)
 * @param stockOfProduct رصيد المادة في فرع الفاتورة
 */
export function cancellationShortages(
  items: PurchaseInvoiceItem[], stockOfProduct: (productId: string) => number | null,
): Array<{ productId: string; name: string; needed: number; available: number }> {
  const needed = new Map<string, { name: string; qty: number }>();
  for (const it of items) {
    if (!it.productId) continue;
    const entry = needed.get(it.productId);
    if (entry) entry.qty += it.quantity;
    else needed.set(it.productId, { name: it.productName, qty: it.quantity });
  }
  const out: Array<{ productId: string; name: string; needed: number; available: number }> = [];
  for (const [productId, { name, qty }] of needed) {
    const available = stockOfProduct(productId);
    if (available === null) continue;      // مادة محذوفة — ليست نقصاً
    if (qty > available) out.push({ productId, name, needed: qty, available });
  }
  return out;
}
