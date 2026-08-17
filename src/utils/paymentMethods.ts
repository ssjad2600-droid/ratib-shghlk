/**
 * طرق الدفع — مصدر موحّد تستخدمه الفواتير والتسديدات وتقفيل الصندوق والتقارير.
 *
 * 🔴 التمييز الجوهري: **الكاش يدخل الدرج، وغيره لا**. تقفيل الصندوق يعتمد على هذا التمييز
 * حصراً؛ فبدونه يُحتسب الدفع بالبطاقة كنقد في الدرج ويظهر «عجز» وهمي بقيمته.
 */

/** الكاش — الطريقة الوحيدة التي تزيد النقد في الدرج فعلياً. */
export const CASH_METHOD = 'كاش';

/** القائمة الافتراضية (يمكن للمالك إضافة طرق أخرى من الإعدادات). */
export const DEFAULT_PAYMENT_METHODS: string[] = [
  CASH_METHOD,
  'Visa',
  'MasterCard',
  'ZainCash',
  'FIB',
  'Qi Card',
  'تحويل بنكي',
];

/** سطر دفع واحد ضمن فاتورة (تدعم تقسيم الفاتورة على عدّة طرق). */
export interface PaymentSplit {
  method: string;
  amount: number;
}

/** هل هذه الطريقة نقد فعلي في الدرج؟ (المقارنة متسامحة مع المسافات) */
export const isCashMethod = (method?: string): boolean =>
  !method || method.trim() === '' || method.trim() === CASH_METHOD;

/**
 * الجزء النقدي من مبلغ محصَّل.
 * التوافق الرجعي: غياب `payments` (كل البيانات القديمة) ⇒ المبلغ كله كاش — وهو الصحيح
 * تاريخياً لأن البرنامج لم يكن يقبل غير الكاش أصلاً.
 */
export function cashPortion(paidAmount: number, payments?: PaymentSplit[]): number {
  if (!payments || payments.length === 0) return Math.max(0, paidAmount);
  return payments.reduce((s, p) => s + (isCashMethod(p.method) ? Math.max(0, p.amount) : 0), 0);
}

/** الجزء غير النقدي (بطاقات/محافظ/تحويل) — ما لا يدخل الدرج. */
export function electronicPortion(paidAmount: number, payments?: PaymentSplit[]): number {
  if (!payments || payments.length === 0) return 0;
  return payments.reduce((s, p) => s + (isCashMethod(p.method) ? 0 : Math.max(0, p.amount)), 0);
}

/** تجميع المبالغ حسب الطريقة (للتقارير ومطابقة كشف البنك). */
export function sumByMethod(
  entries: Array<{ paidAmount: number; payments?: PaymentSplit[] }>,
): Map<string, number> {
  const out = new Map<string, number>();
  const add = (m: string, v: number) => { if (v > 0) out.set(m, (out.get(m) ?? 0) + v); };
  for (const e of entries) {
    if (!e.payments || e.payments.length === 0) {
      add(CASH_METHOD, Math.max(0, e.paidAmount)); // قديم = كاش
      continue;
    }
    for (const p of e.payments) add(p.method?.trim() || CASH_METHOD, Math.max(0, p.amount));
  }
  return out;
}

/** دمج القائمة الافتراضية مع ما أضافه المالك، بلا تكرار وبترتيب ثابت. */
export function allPaymentMethods(custom?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...DEFAULT_PAYMENT_METHODS, ...(custom ?? [])]) {
    const v = (m ?? '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}
