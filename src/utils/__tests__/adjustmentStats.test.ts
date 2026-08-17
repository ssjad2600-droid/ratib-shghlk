import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adjustmentStats } from '../adjustmentStats';
import { Product, StockAdjustment } from '../../types';

/**
 * إحصاءات تسوية المخزون.
 *
 * 🔴 علّتان: الشاشة كانت تعرض الوحدات وحدها (و١٢٠ علبة كبريت ليست كـ١٢٠ هاتفاً)، وكانت
 * تسويات التلف/السرقة تُحفظ **بلا فرع** — ونوع البيانات يقول «غياب الفرع = الرئيسي»،
 * فخسارة المخزن تُسجَّل على المحل: المخزون يخرج من مكان والدفتر يقول مكاناً آخر.
 */

const prod = (id: string, name = id): Product => ({
  id, name, barcode: '', sellPrice: 1000, quantity: 100, lowStockThreshold: 1,
  category: '', unit: 'قطعة', createdAt: '2026-01-01', hasWholesale: false,
} as Product);

const adj = (id: string, productId: string, delta: number): StockAdjustment => ({
  id, productId, productName: productId, quantityDelta: delta,
  quantityBefore: 100, quantityAfter: 100 + delta, type: 'damage',
  reason: 'اختبار', date: '2026-08-01', createdAt: Date.now(),
  createdByUid: 'u', createdByName: 'م',
} as StockAdjustment);

const costs = (m: Record<string, number>) => (p: { id: string }) => m[p.id];

describe('قيمة الخسارة بالدينار', () => {
  const products = [prod('غالٍ'), prod('رخيص')];
  const buyPriceOf = costs({ غالٍ: 500000, رخيص: 250 });

  it('يميّز الغالي من الرخيص — وهو سبب وجود الحساب أصلاً', () => {
    const cheap = adjustmentStats([adj('a', 'رخيص', -120)], products, buyPriceOf);
    const dear = adjustmentStats([adj('b', 'غالٍ', -2)], products, buyPriceOf);
    expect(cheap.lostUnits).toBe(120);
    expect(dear.lostUnits).toBe(2);
    expect(cheap.lostValue).toBe(30000);
    expect(dear.lostValue).toBe(1000000);
    expect(dear.lostValue, 'الوحدات وحدها تُخفي أن قطعتين أغلى من مئة').toBeGreaterThan(cheap.lostValue);
  });

  it('يجمع عدّة تسويات', () => {
    const s = adjustmentStats([adj('a', 'رخيص', -10), adj('b', 'غالٍ', -1)], products, buyPriceOf);
    expect(s.lostUnits).toBe(11);
    expect(s.lostValue).toBe(502500);
  });

  it('الإضافة تُعدّ منفصلة ولا تُخصم من الخسارة', () => {
    const s = adjustmentStats([adj('a', 'رخيص', -10), adj('b', 'رخيص', 4)], products, buyPriceOf);
    expect(s.lostUnits, 'الإضافة قلّلت الخسارة المسجّلة').toBe(10);
    expect(s.addedUnits).toBe(4);
    expect(s.lostValue).toBe(2500);
  });

  it('لا تسويات ⇒ أصفار نظيفة', () => {
    const s = adjustmentStats([], products, buyPriceOf);
    expect(s).toEqual({ count: 0, lostUnits: 0, lostValue: 0, unknownCostCount: 0, unknownCostUnits: 0, addedUnits: 0, reversedCount: 0 });
  });
});

describe('🔴 التكلفة المجهولة لا تُحتسب صفراً', () => {
  const products = [prod('معروف'), prod('مجهول')];
  const buyPriceOf = costs({ معروف: 1000 });

  it('تُستثنى من القيمة وتُعدّ على حدة', () => {
    const s = adjustmentStats([adj('a', 'معروف', -5), adj('b', 'مجهول', -8)], products, buyPriceOf);
    expect(s.lostValue, 'صفرٌ للمجهول يعني «تلفت مجاناً»').toBe(5000);
    expect(s.unknownCostCount).toBe(1);
    expect(s.unknownCostUnits).toBe(8);
    expect(s.lostUnits, 'الوحدات تشمل الجميع — النقص في القيمة لا في العدّ').toBe(13);
  });

  it('🔴 المنتج المحذوف بعد التسوية تكلفته مجهولة لا صفر', () => {
    const s = adjustmentStats([adj('a', 'مادة-محذوفة', -3)], products, buyPriceOf);
    expect(s.lostValue).toBe(0);
    expect(s.unknownCostCount).toBe(1);
    expect(s.unknownCostUnits).toBe(3);
  });

  it('التكلفة صفر **مكتوبة صراحةً** معروفة (هدية من المورد)', () => {
    const s = adjustmentStats([adj('a', 'معروف', -5)], products, costs({ معروف: 0 }));
    expect(s.unknownCostCount, 'صفرٌ صريح ليس جهلاً').toBe(0);
    expect(s.lostValue).toBe(0);
  });
});

/**
 * 🔴 حارس: كل تسوية تُكتب تحمل فرعها.
 *
 * كان مسار الجرد يكتب `branchId` ومسار التلف لا يكتبه — ولا اختبار وحدة يكشف حقلاً
 * منسياً في كائن يُبنى داخل مكوّن. فنفحص المصدر: كل كائن `StockAdjustment` يُنشأ
 * يجب أن يذكر الفرع.
 */
describe('حارس: التسوية تعرف فرعها', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'components', 'InventoryAdjustmentsView.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('المسح يرى الملف فعلاً', () => {
    expect(src).toContain('StockAdjustment');
    expect(src).toContain('quantityDelta');
  });

  it('🔴 كل كائن تسوية يحمل branchId', () => {
    const objects = src.match(/const\s+adjustment\s*:\s*StockAdjustment\s*=\s*\{[\s\S]*?\n\s*\};/g) ?? [];
    expect(objects.length, 'لم يُعثر على كائنات التسوية — تغيّر الشكل فالحارس أعمى').toBeGreaterThanOrEqual(2);
    const missing = objects.filter(o => !/branchId\s*:/.test(o));
    expect(
      missing.length,
      'تسوية تُكتب بلا فرع ⇒ «غيابه = الرئيسي» فتُنسب خسارة المخزن للمحل. '
      + `عدد الكائنات الناقصة: ${missing.length}`,
    ).toBe(0);
  });

  it('🔴 السجل والإحصاءات مصفّاة بالفرع', () => {
    expect(
      /adjustments\.filter\(matchesActiveBranch\)/.test(src),
      'السجل يقرأ كل التسويات ⇒ مبدّل الفروع بلا أثر وخسائر الفروع تختلط',
    ).toBe(true);
  });

  /**
   * 🔴 الجرد الفعلي يتحقّق من الخادم بقراءة تفرضه، لا بتخمين المتصفح.
   *
   * قِسْتُ الحالة ولم أظنّها: مع راوتر يعمل واشتراك مقطوع يبقى `navigator.onLine === true`،
   * و**`runTransaction` لا تفشل** بل تقرأ من الذاكرة المحلية وتُكمل (قرأت ٥٠ وكتبت بنجاح
   * والشبكة مقطوعة). و`syncState` يبقى `'synced'` لأن لا حدث `offline` يقع،
   * و`metadata.fromCache` تعود `false` في الحالتين. فلا يصلح أيٌّ منها حارساً.
   *
   * `getDocFromServer` وحدها ترمي `[code=unavailable]` عند انعدام النفاذ الحقيقي.
   */
  it('🔴 الجرد يشترط قراءة من الخادم لا `isOnline` وحدها', () => {
    expect(
      /getDocFromServer\s*\(/.test(src),
      'المنع يعتمد على تخمين المتصفح ⇒ يمرّ الجرد على رصيد قديم مع شبكة بلا إنترنت',
    ).toBe(true);
    // ولا يبقى المنع القديم وحده بوّابةً للجرد
    expect(
      /if\s*\(\s*!isOnline\s*\)\s*\{?\s*\n?\s*return notify\(\s*'الجرد/.test(src),
      'عاد المنع ليعتمد على isOnline وحدها',
    ).toBe(false);
  });
});
