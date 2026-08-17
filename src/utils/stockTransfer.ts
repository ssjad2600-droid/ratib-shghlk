import { increment } from 'firebase/firestore';
import { Product, MAIN_BRANCH_ID } from '../types';
import { stockOf, needsBranchInit, initialBranchStock } from './branchStock';

/**
 * نقل بضاعة بين موقعين (محل ⇄ مخزن، مخزن ⇄ مخزن، محل ⇄ محل).
 *
 * 🔴 المبدأ المحاسبي الذي يحكم هذا الملف كله:
 * البضاعة **لم تدخل ولم تخرج من ملك صاحب العمل**، بل تحرّكت داخله.
 * لذلك `quantity` (الإجمالي) **لا يُلمس إطلاقاً** — ينقص رصيد المصدر ويزيد رصيد الوجهة
 * بنفس المقدار في تحديث ذرّي واحد. النتيجة: قيمة المخزون والأرباح وكل التقارير
 * لا تتأثّر بأي نقل داخلي مهما تكرّر. وهذا بالضبط السلوك الصحيح محاسبياً.
 *
 * كلا الطرفين `increment` ⇒ آمن أوفلاين، وآمن مع نقل متزامن من جهازين.
 */
export function transferUpdate(
  product: Pick<Product, 'quantity' | 'branchStock'>,
  qty: number,
  fromBranchId: string,
  toBranchId: string,
): Record<string, unknown> {
  const from = fromBranchId?.trim() || MAIN_BRANCH_ID;
  const to = toBranchId?.trim() || MAIN_BRANCH_ID;

  // منتج قديم بلا خريطة فروع: نبذر الخريطة بقيمتها الحقيقية أولاً (كل المخزون في الرئيسي)
  // ثم نطبّق النقل عليها — وإلا بدأ increment من صفر فظهر رصيد سالب وهمي.
  if (needsBranchInit(product)) {
    const seeded = initialBranchStock(product);
    seeded[from] = (seeded[from] ?? 0) - qty;
    seeded[to] = (seeded[to] ?? 0) + qty;
    return { branchStock: seeded }; // quantity غائب عمداً — الإجمالي لا يتغيّر
  }

  return {
    [`branchStock.${from}`]: increment(-qty),
    [`branchStock.${to}`]: increment(qty),
  };
}

/** رصيد المنتج في موقع — واجهة مختصرة تُستخدم في شاشة النقل. */
export const atBranch = (p: Pick<Product, 'quantity' | 'branchStock'>, branchId: string): number =>
  stockOf(p, branchId);

/** أي مواقع فيها رصيد سالب لهذا المنتج؟ (خلل يحتاج تصحيحاً بنقل) */
export const negativeBranches = (p: Pick<Product, 'branchStock'>): Array<{ branchId: string; qty: number }> =>
  Object.entries(p.branchStock ?? {})
    .filter(([, v]) => (v ?? 0) < 0)
    .map(([branchId, qty]) => ({ branchId, qty: qty ?? 0 }));
