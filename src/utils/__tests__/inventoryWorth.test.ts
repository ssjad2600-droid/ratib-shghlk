import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inventoryValue } from '../decisionReports';
import { Product } from '../../types';

/**
 * قيمة المخزون والربح الكامن.
 *
 * 🔴 العلّة: شاشة المنتجات كانت تحسب رقماً موازياً بـ`(buyPriceOf(p) ?? 0)` — أي أن
 * **المنتج مجهول التكلفة تكلفته صفر**، فيصير كل سعر بيعه ربحاً صافياً. تاجر عنده مئة
 * منتج قديم بلا تكلفة يرى ربحاً متوقّعاً أضعاف الحقيقة، ويبني عليه قرار شراء.
 *
 * وكان المشروع قد حسم القاعدة في «تقارير القرار» — فوُجد رقمان لنفس الشيء وأحدهما يكذب.
 */

const prod = (id: string, sellPrice: number, quantity: number, branchStock?: Record<string, number>): Product => ({
  id, name: id, barcode: '', sellPrice, quantity, lowStockThreshold: 1,
  category: '', unit: 'قطعة', createdAt: '2026-01-01', hasWholesale: false,
  ...(branchStock ? { branchStock } : {}),
} as Product);

/** دالة تكلفة: تُرجع undefined لما ليس في الخريطة — أي «غير معروفة». */
const costs = (m: Record<string, number>) => (p: { id: string }) => m[p.id];

describe('🔴 التكلفة المجهولة ليست صفراً', () => {
  const products = [
    prod('معروف', 10000, 10),   // تكلفته ٦٠٠٠
    prod('مجهول', 20000, 5),    // بلا تكلفة
  ];
  const buyPriceOf = costs({ معروف: 6000 });

  it('رأس المال يشمل معروفة التكلفة وحدها', () => {
    const v = inventoryValue(products, buyPriceOf, undefined);
    expect(v.costValue).toBe(60000); // ١٠ × ٦٠٠٠ فقط
  });

  it('🔴 الربح الكامن لا يبتلع قيمة مجهول التكلفة', () => {
    const v = inventoryValue(products, buyPriceOf, undefined);
    // الخطأ القديم: (١٠٠٬٠٠٠ + ١٠٠٬٠٠٠) − ٦٠٬٠٠٠ = ١٤٠٬٠٠٠ ربحاً وهمياً
    expect(v.latentProfit, 'تضخّم الربح بقيمة مجهول التكلفة').toBe(40000);
  });

  it('مجهول التكلفة يُعدّ ويُعرَض لا يُخفى', () => {
    const v = inventoryValue(products, buyPriceOf, undefined);
    expect(v.unknownCostCount).toBe(1);
    expect(v.unknownCostUnits).toBe(5);
    expect(v.unknownCostSellValue).toBe(100000);
  });

  it('🔴 الربح الكامن لا يتجاوز ربح معروفة التكلفة مهما كثر المجهول', () => {
    for (const n of [1, 5, 50]) {
      const many = [prod('معروف', 10000, 10), ...Array.from({ length: n }, (_, i) => prod(`م${i}`, 99999, 100))];
      const v = inventoryValue(many, buyPriceOf, undefined);
      expect(v.latentProfit, `عند ${n} مجهولاً`).toBe(40000);
    }
  });

  it('كل التكاليف معروفة ⇒ الحساب الطبيعي', () => {
    const v = inventoryValue([prod('أ', 10000, 10)], costs({ أ: 6000 }), undefined);
    expect(v.costValue).toBe(60000);
    expect(v.sellValue).toBe(100000);
    expect(v.latentProfit).toBe(40000);
    expect(v.unknownCostCount).toBe(0);
  });

  it('التكلفة صفر **مكتوبة صراحةً** تُحتسب معروفة (هدية/عيّنة)', () => {
    const v = inventoryValue([prod('هدية', 5000, 4)], costs({ هدية: 0 }), undefined);
    expect(v.unknownCostCount, 'صفرٌ صريح ليس جهلاً').toBe(0);
    expect(v.latentProfit).toBe(20000);
  });

  it('المنتج بلا مخزون لا يدخل الحساب', () => {
    const v = inventoryValue([prod('نافد', 10000, 0)], costs({}), undefined);
    expect(v.productCount).toBe(0);
    expect(v.unknownCostCount, 'نافدٌ ومجهول ⇒ لا يُنبَّه عليه').toBe(0);
  });
});

describe('حسب الفرع', () => {
  const products = [prod('أ', 10000, 80, { main: 50, wh: 30 })];
  const buyPriceOf = costs({ أ: 6000 });

  it('فرع محدّد يحسب مخزونه هو', () => {
    expect(inventoryValue(products, buyPriceOf, 'main').units).toBe(50);
    expect(inventoryValue(products, buyPriceOf, 'wh').units).toBe(30);
  });

  it('بلا فرع = الإجمالي', () => {
    expect(inventoryValue(products, buyPriceOf, undefined).units).toBe(80);
  });

  it('مجموع الفروع يساوي الإجمالي', () => {
    const a = inventoryValue(products, buyPriceOf, 'main');
    const b = inventoryValue(products, buyPriceOf, 'wh');
    const all = inventoryValue(products, buyPriceOf, undefined);
    expect(a.sellValue + b.sellValue).toBe(all.sellValue);
    expect(a.costValue + b.costValue).toBe(all.costValue);
  });
});

/**
 * 🔴 حارس: لا حساب موازٍ لقيمة المخزون داخل الشاشات.
 *
 * `(buyPriceOf(p) ?? 0)` هو التوقيع النصّي للعلّة: احتياطٌ بصفر على تكلفة مجهولة.
 * وُجد في شاشة المنتجات بينما القاعدة محسومة في `decisionReports` — رقمان لنفس الشيء
 * وأحدهما يكذب.
 */
describe('حارس: التكلفة المجهولة لا تُحتسب صفراً', () => {
  const dirs = ['src/components', 'src/utils'];

  it('المسح يرى الملفات فعلاً', () => {
    const n = dirs.reduce((s, d) => s + readdirSync(join(process.cwd(), d)).length, 0);
    expect(n).toBeGreaterThan(30);
  });

  it('🔴 لا `buyPriceOf(...) ?? 0` في أي حساب', () => {
    const offenders: string[] = [];
    for (const d of dirs) {
      const dir = join(process.cwd(), d);
      for (const f of readdirSync(dir).filter(n => /\.(ts|tsx)$/.test(n))) {
        const src = readFileSync(join(dir, f), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        // نستثني العرض المفرد لمنتج مختار (رقم واحد على الشاشة لا تجميع مالي)
        const re = /\b(?:buyPriceOf|wholesaleBuyPriceOf)\([^)]*\)\s*\?\?\s*0/g;
        for (const hit of src.match(re) ?? []) {
          if (f === 'ProductsView.tsx' && /selectedProduct/.test(src.slice(Math.max(0, src.indexOf(hit) - 120), src.indexOf(hit)))) continue;
          offenders.push(`${f}: ${hit}`);
        }
      }
    }
    expect(
      offenders,
      'تكلفة مجهولة تُحتسب صفراً ⇒ ربح وهمي بكامل سعر البيع. استعمل inventoryValue: '
      + offenders.join(' | '),
    ).toEqual([]);
  });
});

/**
 * 🔴 الصيغة الثلاثية — الثغرة التي تسلّل منها `inventoryByCategory`.
 *
 * الحارس أعلاه يمنع `buyPriceOf(...) ?? 0`، فمرّ من تحته
 * `cost !== undefined ? cost * stock : 0` — وهو **نفس الخطأ بصياغة أخرى**: فئة كاملة
 * بلا أسعار شراء تُعرض برأس مال صفر كأنها لا تحوي مالاً. نُغلق الصياغتين معاً.
 */
describe('حارس: لا تخمين للتكلفة المجهولة بأي صياغة', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'utils', 'decisionReports.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('المسح يرى الملف فعلاً', () => {
    expect(src).toContain('inventoryByCategory');
    expect(src).toContain('costValue');
  });

  it('🔴 لا `cost !== undefined ? … : 0` في تجميع مالي', () => {
    // الحارس على **التجميع** (`+=`) وحده. أما `frozenCapital` في الراكد فيُرافقه
    // `costKnown` يميّز «صفرٌ لأنه مجهول» من «صفرٌ لأنه بلا قيمة» — مُعلَنٌ لا مُخمَّن.
    const hits = src.match(/\+=\s*cost\s*!==\s*undefined\s*\?[^;]*:\s*0/g) ?? [];
    expect(
      hits,
      'المجهول يُضاف بصفر فيختفي رأس المال بلا تنبيه — استعمل عدّاداً منفصلاً كما في inventoryValue: '
      + hits.join(' | '),
    ).toEqual([]);
  });

  it('🔴 التجميع حسب الفئة يحمل عدّاد المجهول', () => {
    expect(/unknownCostCount/.test(src)).toBe(true);
    expect(/unknownCostUnits/.test(src)).toBe(true);
  });
});
