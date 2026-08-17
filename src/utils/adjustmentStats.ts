import { Product, StockAdjustment } from '../types';
import { activeOnly } from './reversal';

/**
 * إحصاءات تسويات المخزون — بالوحدات **وبالدينار**.
 *
 * 🔴 لماذا؟ شاشة التسوية كانت تعرض «إجمالي الوحدات المخصومة: ١٢٠» ولا شيء غيره، رغم
 * أنها تستقبل العملة وسعر الصرف وتتجاهلهما. و١٢٠ علبة كبريت ليست كـ١٢٠ هاتفاً — وأهمّ
 * سؤال يطرحه التاجر على شاشة خسائر هو «**كم خسرت بالدينار؟**».
 *
 * ⚠️ التكلفة المجهولة **لا تُحتسب صفراً** — نفس القاعدة المحسومة في قيمة المخزون
 *   والربح الكامن. صفرٌ هنا يعني «تلفت مجاناً»، وهو تجميلٌ للخسارة لا حساب لها.
 */

export interface AdjustmentStats {
  /** عدد التسويات المحسوبة. */
  count: number;
  /** مجموع الوحدات المخصومة (الموجب = خسارة). */
  lostUnits: number;
  /** قيمة المخصوم بسعر الشراء — لمعروفة التكلفة فقط. */
  lostValue: number;
  /** تسويات خصمٍ لمنتجات بلا سعر شراء — قيمتها غير محتسبة. */
  unknownCostCount: number;
  /** وحدات تلك التسويات — تُعرَض كي لا يبدو النقص خطأً في الحساب. */
  unknownCostUnits: number;
  /** مجموع الوحدات المضافة (مرتجع/تصحيح بالزيادة). */
  addedUnits: number;
  /** قيود مُستثناة لأنها طرفا تراجُع — تُعرَض كي لا يبدو النقص خطأً في الحساب. */
  reversedCount: number;
}

type CostFn = (p: Pick<Product, 'id' | 'buyPrice'>) => number | undefined;

/**
 * يحسب إحصاءات مجموعة تسويات.
 *
 * 🔴 الاستثناء يجري **هنا** لا عند المُنادي، عمداً: القيد المتراجَع عنه وقيدُه المضادّ
 * يساويان معاً لا شيء، ولو تُرك الاستثناء للشاشات لَنسيته إحداها فعاد الخطأ المصحَّح
 * يُضخّم «قيمة الخسارة» — وهو الرقم الذي يبني عليه التاجر قراره. الاستثناء داخل الدالة
 * يجعل النسيان مستحيلاً. (والسجل يعرضهما معاً: الإحصاء يستثني والتاريخ لا يُخفي.)
 *
 * @param adjustments التسويات (مصفّاة بالفرع قبل الاستدعاء)
 */
export function adjustmentStats(
  adjustments: StockAdjustment[],
  products: Product[],
  buyPriceOf: CostFn,
): AdjustmentStats {
  const byId = new Map(products.map(p => [p.id, p]));
  const counted = activeOnly(adjustments);
  const out: AdjustmentStats = {
    count: counted.length, lostUnits: 0, lostValue: 0,
    unknownCostCount: 0, unknownCostUnits: 0, addedUnits: 0,
    reversedCount: adjustments.length - counted.length,
  };

  for (const a of counted) {
    const delta = a.quantityDelta ?? 0;
    if (delta > 0) { out.addedUnits += delta; continue; }
    if (delta === 0) continue;

    const units = Math.abs(delta);
    out.lostUnits += units;

    // المنتج قد يكون حُذف بعد التسوية — التكلفة عندها غير معروفة، لا صفر
    const product = byId.get(a.productId);
    const cost = product ? buyPriceOf(product) : undefined;
    if (cost !== undefined && cost >= 0) out.lostValue += units * cost;
    else { out.unknownCostCount += 1; out.unknownCostUnits += units; }
  }

  return out;
}
