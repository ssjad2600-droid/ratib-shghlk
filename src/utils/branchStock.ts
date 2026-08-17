import { increment } from 'firebase/firestore';
import { Product, MAIN_BRANCH_ID } from '../types';

/**
 * مخزون الفروع — طبقة مركزية واحدة تضمن الاتساق (المرحلة ٢).
 *
 * 🔴 القاعدة الذهبية: **كل** عملية مخزون تكتب الفارق في حقلين معاً داخل تحديث ذرّي واحد:
 *   · `quantity`                     → الإجمالي عبر كل الفروع (يبقى معنى الحقل القديم كما هو)
 *   · `branchStock.{الفرع}`          → مخزون ذلك الفرع
 * لأنهما يُكتبان في نفس العملية، يستحيل أن يتفرّقا (لا يوجد مصدرا حقيقة متعارضان).
 * وكلاهما increment ⇒ آمن أوفلاين ومع البيع المتزامن من عدّة أجهزة.
 */

/**
 * مخزون منتج في فرع محدّد.
 * التوافق الرجعي: منتج بلا `branchStock` (كل منتجاتك قبل الفروع) ⇒ كل كميته في الفرع الرئيسي،
 * والفروع الأخرى صفر. فلا يظهر رقم خاطئ قبل اكتمال الترحيل.
 */
export function stockOf(product: Pick<Product, 'quantity' | 'branchStock'>, branchId?: string): number {
  const branch = branchId?.trim() || MAIN_BRANCH_ID;
  const map = product.branchStock;
  if (!map || Object.keys(map).length === 0) {
    return branch === MAIN_BRANCH_ID ? (product.quantity ?? 0) : 0;
  }
  return map[branch] ?? 0;
}

/**
 * مخزون معروض حسب العرض الحالي: فرع محدّد، أو **الإجمالي** في وضع «كل الفروع» (branchId فارغ).
 */
export function visibleStock(
  product: Pick<Product, 'quantity' | 'branchStock'>,
  branchId?: string,
): number {
  if (!branchId) return product.quantity ?? 0; // كل الفروع ⇒ الإجمالي
  return stockOf(product, branchId);
}

/**
 * كائن التحديث لأي حركة مخزون. استخدمه في **كل** موضع بدل `{ quantity: increment(d) }`.
 * @param delta الفارق بوحدة الأساس (سالب = خصم، موجب = إضافة)
 */
export function stockUpdate(delta: number, branchId?: string): Record<string, unknown> {
  const branch = branchId?.trim() || MAIN_BRANCH_ID;
  return {
    quantity: increment(delta),
    [`branchStock.${branch}`]: increment(delta),
  };
}

/**
 * هل يحتاج المنتج تهيئة أولية لخريطة الفروع؟ (منتج قديم بلا branchStock)
 * مهم: بدون التهيئة، أول `increment` على `branchStock.main` سيبدأ من صفر فينتج رقماً سالباً
 * رغم توفّر المخزون فعلياً.
 */
export const needsBranchInit = (p: Pick<Product, 'branchStock'>): boolean =>
  !p.branchStock || Object.keys(p.branchStock).length === 0;

/** خريطة التهيئة الأولى: كل المخزون الحالي في الفرع الرئيسي. */
export const initialBranchStock = (p: Pick<Product, 'quantity'>): Record<string, number> => ({
  [MAIN_BRANCH_ID]: p.quantity ?? 0,
});

/**
 * نسخة «آمنة للمنتج القديم» من {@link stockUpdate} — تُستخدم حين يكون المنتج بين يديك.
 *
 * المشكلة التي تحلّها: منتج قديم بلا خريطة فروع (لم يمرّ عليه ترحيل المالك بعد) لو بِيع
 * من جلسة موظف، فإن `increment` على `branchStock.main` يبدأ من صفر ⇒ يصير سالباً بينما
 * `quantity` صحيح، فينكسر التطابق «مجموع الفروع = الإجمالي».
 *
 * الحل: في **أول** حركة فقط نكتب الخريطة مصفوفةً بقيمتها الحقيقية (المخزون كله في الرئيسي)
 * بعد تطبيق الفارق، ثم تعود كل الحركات التالية إلى `increment` الآمن أوفلاين وتزامنياً.
 */
export function stockUpdateSeeded(
  product: Pick<Product, 'quantity' | 'branchStock'>,
  delta: number,
  branchId?: string,
): Record<string, unknown> {
  const branch = branchId?.trim() || MAIN_BRANCH_ID;
  if (!needsBranchInit(product)) return stockUpdate(delta, branch);
  const seeded = initialBranchStock(product); // { main: الإجمالي }
  seeded[branch] = (seeded[branch] ?? 0) + delta;
  return { quantity: increment(delta), branchStock: seeded };
}

/** مجموع مخزون كل الفروع — للتحقق من الاتساق عند الحاجة. */
export const totalBranchStock = (p: Pick<Product, 'branchStock'>): number =>
  Object.values(p.branchStock ?? {}).reduce((s, v) => s + (v ?? 0), 0);
