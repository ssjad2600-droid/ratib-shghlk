import { toLatinDigits } from './arabicFormatters';

/**
 * اتجاه رصيد المورد — مصدر حقيقة واحد لكل نصّ يصف الدين.
 *
 * 🔴 العلّة التي وُجد هذا الملف لأجلها: رسالة الواتساب كانت **تقلب الدين على المورد**.
 * فالتاجر الذي يدين لمورّده بخمسة ملايين كان يرسل إليه رسالةً باسم محلّه نصّها
 * «متبقي عليك للمحل: ٥٬٠٠٠٬٠٠٠» — أي يطالبه بما عليه هو نفسه.
 *
 * وهذا أخطر من غلط حسابي داخلي: الرسالة **تغادر البرنامج** إلى طرفٍ ثانٍ، والمورد في
 * السوق العراقي هو خطّ ائتمان التاجر. ثم إن الشاشة تعرض الرقم صحيحاً والخطأ في النصّ
 * المُرسَل وحده — فلا يكتشفه التاجر أبداً إلا من المورد نفسه.
 *
 * ⚖️ الاتجاه محسوم من الكود الذي **يكتب** الرصيد، لا من التسميات:
 *   · فاتورة شراء آجلة  ⟵ `balance: increment(remaining)`
 *   · تسديد للمورد      ⟵ `balance: increment(-paid)`
 * إذن: **الموجب = المحل يدين للمورد**. والسالب = دفعنا زيادة، فالمال لنا عنده.
 *
 * وكل نصّ يصف هذا الرصيد يمرّ من هنا — فلا يعود ممكناً أن تختلف شاشتان في الاتجاه.
 */

export type BalanceDirection =
  /** المحل يدين للمورد (الرصيد موجب) */
  | 'shop_owes'
  /** المورد يدين للمحل — دفعنا له زيادة (الرصيد سالب) */
  | 'supplier_owes'
  /** لا ذمّة بين الطرفين */
  | 'settled';

export function balanceDirection(balance: number): BalanceDirection {
  if (!Number.isFinite(balance) || balance === 0) return 'settled';
  return balance > 0 ? 'shop_owes' : 'supplier_owes';
}

/** وصفٌ مختصر للعرض داخل البرنامج (جدول، بطاقة، تصدير). */
export function balanceLabel(balance: number): string {
  switch (balanceDirection(balance)) {
    case 'shop_owes': return 'علينا له';
    case 'supplier_owes': return 'لنا عنده';
    default: return 'متزن';
  }
}

/** وصفٌ أطول يشرح الاتجاه بلا لبس — للتصدير وحيث تتّسع المساحة. */
export function balanceStatus(balance: number): string {
  switch (balanceDirection(balance)) {
    case 'shop_owes': return 'دين علينا للمورد';
    case 'supplier_owes': return 'رصيد لنا عند المورد';
    default: return 'الحساب متزن';
  }
}

/**
 * سطر الدين داخل الرسالة المُرسَلة **إلى المورد** — بصيغة المخاطَب.
 * @param money دالة تنسيق المبلغ (العملة وسعر الصرف من الشاشة)
 */
export function debtLineForSupplier(balance: number, money: (n: number) => string): string {
  switch (balanceDirection(balance)) {
    case 'shop_owes':
      // نحن المدينون — فالمبلغ **لك علينا**، لا «عليك لنا»
      return `المتبقّي لكم علينا: *${money(balance)}*`;
    case 'supplier_owes':
      return `دفعنا لكم زيادةً عن المستحق: *${money(Math.abs(balance))}* — تُحتسب على المشتريات القادمة`;
    default:
      return 'الحساب متزن ✅ لا مستحقات بين الطرفين';
  }
}

/** نصّ رسالة الواتساب كاملاً — مصدر واحد كي لا يتفرّق الاتجاه بين الشاشات. */
export function supplierWhatsappText(params: {
  storeName?: string;
  supplierName: string;
  balance: number;
  notes?: string;
  dateText: string;
  money: (n: number) => string;
}): string {
  const { storeName, supplierName, balance, notes, dateText, money } = params;
  const sep = '----------------------------------';
  return [
    `📦 *كشف حساب مورد${storeName ? ` — ${storeName}` : ' — رتب شغلك'}*`,
    `المورّد: *${supplierName}*`,
    `التاريخ: ${dateText}`,
    sep,
    debtLineForSupplier(balance, money),
    sep,
    ...(notes?.trim() ? [`ملاحظات: ${notes.trim()}`] : []),
    '',
    'شكراً لتعاملكم معنا 🙏',
  ].join('\n');
}

/* ------------------------------------------------------------------ */

/**
 * 🟠 المورد المكرَّر.
 *
 * «أبو أحمد» يُسجَّل مرتين برقمين، فتنقسم ديونه على سجلّين ولا يرى التاجر انكشافه
 * الحقيقي على هذا المورد. المفتاح الهاتف (بأرقام لاتينية مجرّدة من الفواصل) لأنه
 * المعرّف العملي في السوق؛ فإن غاب فالاسم المجرّد من المسافات.
 */
export const supplierKey = (s: { name?: string; phone?: string }): string => {
  const phone = toLatinDigits(s.phone ?? '').replace(/[^0-9]/g, '');
  if (phone) return `p:${phone}`;
  return `n:${(s.name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()}`;
};

/**
 * مورد قائم يطابق المُدخَل — أو null.
 * @param excludeId معرّف يُستثنى (عند التعديل: المورد نفسه ليس تكراراً لذاته)
 */
export function findDuplicateSupplier<T extends { id: string; name?: string; phone?: string }>(
  suppliers: T[],
  candidate: { name?: string; phone?: string },
  excludeId?: string,
): T | null {
  const key = supplierKey(candidate);
  if (key === 'n:') return null; // بلا اسم ولا هاتف — لا شيء يُقارن
  return suppliers.find(s => s.id !== excludeId && supplierKey(s) === key) ?? null;
}
