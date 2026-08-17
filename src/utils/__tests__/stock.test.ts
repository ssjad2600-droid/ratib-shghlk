import { describe, it, expect } from 'vitest';
import { stockOf, visibleStock, stockUpdate, stockUpdateSeeded, needsBranchInit, totalBranchStock } from '../branchStock';
import { transferUpdate, negativeBranches } from '../stockTransfer';
import { MAIN_BRANCH_ID } from '../../types';

/**
 * 🔴 الثابت الأهم في النظام كله: **مجموع مخزون الفروع = الإجمالي، دائماً**.
 * انكساره يعني أرقام فروع كاذبة وقيمة مخزون خاطئة وقرارات شراء مبنية على وهم.
 *
 * هذه الاختبارات تحرسه بعد كل عملية: بيع، إرجاع، شراء، تسوية، نقل بين الفروع.
 */

const BASRA = 'branch_basra';

/** محاكي بسيط لسلوك Firestore: يطبّق كائن التحديث على وثيقة منتج محلية. */
function apply(product: any, update: Record<string, any>) {
  const next = { ...product, branchStock: { ...(product.branchStock ?? {}) } };
  for (const [key, val] of Object.entries(update)) {
    // increment() يعيد سنتينل — نقرأ منه المقدار لنحاكي ما يفعله الخادم
    const isIncrement = !!val && typeof val === 'object' && (val as any)._methodName === 'increment';
    const amount = isIncrement ? (val as any)._operand : val;

    if (key === 'quantity') {
      next.quantity = isIncrement ? (next.quantity ?? 0) + amount : amount;
    } else if (key === 'branchStock') {
      next.branchStock = { ...amount }; // كتابة مطلقة للخريطة (مسار البذر)
    } else if (key.startsWith('branchStock.')) {
      const b = key.slice('branchStock.'.length);
      next.branchStock[b] = isIncrement ? (next.branchStock[b] ?? 0) + amount : amount;
    }
  }
  return next;
}

/**
 * الثابت المركزي — يُستدعى بعد كل عملية في كل اختبار.
 * منتج بلا خريطة فروع بعد يُستثنى: الثابت يبدأ من أول بذر للخريطة.
 */
const expectInvariant = (p: any) => {
  if (needsBranchInit(p as { branchStock?: Record<string, number> })) return;
  expect(totalBranchStock(p)).toBe(p.quantity);
};

describe('قراءة المخزون', () => {
  it('منتج قديم بلا خريطة فروع: كل كميته في الفرع الرئيسي والفروع الأخرى صفر', () => {
    const legacy = { quantity: 50 };
    expect(stockOf(legacy, MAIN_BRANCH_ID)).toBe(50);
    expect(stockOf(legacy, BASRA)).toBe(0);
    expect(needsBranchInit(legacy as { branchStock?: Record<string, number> })).toBe(true);
  });

  it('وضع «كل الفروع» يعرض الإجمالي لا رصيد فرع', () => {
    const p = { quantity: 30, branchStock: { [MAIN_BRANCH_ID]: 10, [BASRA]: 20 } };
    expect(visibleStock(p, '')).toBe(30);
    expect(visibleStock(p, BASRA)).toBe(20);
  });

  it('فرع غير موجود في الخريطة يقرأ صفراً لا undefined', () => {
    const p = { quantity: 10, branchStock: { [MAIN_BRANCH_ID]: 10 } };
    expect(stockOf(p, 'branch_unknown')).toBe(0);
  });
});

describe('حركات المخزون تحفظ الثابت', () => {
  it('البيع يخصم من الإجمالي ومن الفرع بنفس المقدار', () => {
    let p: any = { quantity: 100, branchStock: { [MAIN_BRANCH_ID]: 60, [BASRA]: 40 } };
    p = apply(p, stockUpdate(-7, BASRA));
    expect(p.quantity).toBe(93);
    expect(stockOf(p, BASRA)).toBe(33);
    expect(stockOf(p, MAIN_BRANCH_ID)).toBe(60);
    expectInvariant(p);
  });

  it('الإرجاع يعيد الكمية لفرع الفاتورة نفسه', () => {
    let p: any = { quantity: 93, branchStock: { [MAIN_BRANCH_ID]: 60, [BASRA]: 33 } };
    p = apply(p, stockUpdate(7, BASRA));
    expect(stockOf(p, BASRA)).toBe(40);
    expectInvariant(p);
  });

  it('استلام فاتورة شراء يزيد الفرع المستلِم وحده', () => {
    let p: any = { quantity: 100, branchStock: { [MAIN_BRANCH_ID]: 60, [BASRA]: 40 } };
    p = apply(p, stockUpdate(25, MAIN_BRANCH_ID));
    expect(stockOf(p, MAIN_BRANCH_ID)).toBe(85);
    expect(stockOf(p, BASRA)).toBe(40);
    expectInvariant(p);
  });

  it('سلسلة عمليات متتابعة لا تكسر الثابت', () => {
    let p: any = { quantity: 100, branchStock: { [MAIN_BRANCH_ID]: 100 } };
    const ops: Array<[number, string]> = [[-5, MAIN_BRANCH_ID], [20, BASRA], [-3, BASRA], [10, MAIN_BRANCH_ID], [-12, MAIN_BRANCH_ID]];
    for (const [d, b] of ops) { p = apply(p, stockUpdate(d, b)); expectInvariant(p); }
    expect(p.quantity).toBe(110);
    expect(stockOf(p, MAIN_BRANCH_ID)).toBe(93);
    expect(stockOf(p, BASRA)).toBe(17);
  });
});

describe('بذر المنتج القديم (stockUpdateSeeded)', () => {
  it('أول بيع لمنتج بلا خريطة يبذرها بقيمتها الحقيقية بدل أن يبدأ من صفر', () => {
    const legacy = { quantity: 50 };
    const update = stockUpdateSeeded(legacy, -5, MAIN_BRANCH_ID);
    const p = apply(legacy, update);
    expect(p.quantity).toBe(45);
    expect(stockOf(p, MAIN_BRANCH_ID)).toBe(45); // لا -5
    expectInvariant(p);
  });

  it('المنتج المُرحَّل يعود لصيغة increment الآمنة أوفلاين', () => {
    const migrated = { quantity: 50, branchStock: { [MAIN_BRANCH_ID]: 30, [BASRA]: 20 } };
    const update = stockUpdateSeeded(migrated, -5, BASRA);
    expect(Object.keys(update)).toEqual(['quantity', `branchStock.${BASRA}`]);
    expectInvariant(apply(migrated, update));
  });
});

describe('النقل بين الفروع', () => {
  it('🔴 الإجمالي لا يتغيّر إطلاقاً — البضاعة تحرّكت داخل الملك لا خرجت منه', () => {
    let p: any = { quantity: 199, branchStock: { [MAIN_BRANCH_ID]: 199, [BASRA]: 0 } };
    const before = p.quantity;
    p = apply(p, transferUpdate(p, 50, MAIN_BRANCH_ID, BASRA));
    expect(p.quantity).toBe(before);
    expect(stockOf(p, MAIN_BRANCH_ID)).toBe(149);
    expect(stockOf(p, BASRA)).toBe(50);
    expectInvariant(p);
  });

  it('كائن تحديث النقل لا يحوي quantity إطلاقاً', () => {
    const p = { quantity: 100, branchStock: { [MAIN_BRANCH_ID]: 100 } };
    expect('quantity' in transferUpdate(p, 10, MAIN_BRANCH_ID, BASRA)).toBe(false);
  });

  it('نقل من منتج قديم بلا خريطة يبذرها ويبقي الإجمالي ثابتاً', () => {
    const legacy = { quantity: 80 };
    const p = apply(legacy, transferUpdate(legacy, 30, MAIN_BRANCH_ID, BASRA));
    expect(p.quantity).toBe(80);
    expect(stockOf(p, MAIN_BRANCH_ID)).toBe(50);
    expect(stockOf(p, BASRA)).toBe(30);
    expectInvariant(p);
  });

  it('نقل ذهاب وإياب يعيد الحالة كما كانت بالضبط', () => {
    const start = { quantity: 100, branchStock: { [MAIN_BRANCH_ID]: 70, [BASRA]: 30 } };
    let p: any = apply(start, transferUpdate(start, 25, MAIN_BRANCH_ID, BASRA));
    p = apply(p, transferUpdate(p, 25, BASRA, MAIN_BRANCH_ID));
    expect(p.branchStock).toEqual(start.branchStock);
    expect(p.quantity).toBe(start.quantity);
  });

  it('يكشف الأرصدة السالبة للتصحيح', () => {
    const p = { branchStock: { [MAIN_BRANCH_ID]: 199, [BASRA]: -1 } };
    expect(negativeBranches(p)).toEqual([{ branchId: BASRA, qty: -1 }]);
  });
});
