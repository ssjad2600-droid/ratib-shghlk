import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invoiceProfit, salesProfit, netProfitOf, costLookup, ProfitInvoice } from '../profit';

/**
 * 🔴🔴 الربح الصافي.
 *
 * كانت شاشة «المصاريف والأرباح» تحسب «المبيعات − المصاريف» بلا تكلفة بضاعة، وشاشة
 * التقارير تحسبها صحيحةً — فرقما ربحٍ متناقضان في برنامج واحد، الفارق بينهما تكلفة
 * البضاعة كلها. قِسْتُ الأثر حيّاً: الحقيقة ١٠٠٬٠٠٠ والمعروض ٩٠٠٬٠٠٠.
 */

const inv = (over: Partial<ProfitInvoice> = {}): ProfitInvoice => ({
  id: 'i1', totalAmount: 1_000_000, finalAmount: 1_000_000, discount: 0, paidAmount: 1_000_000,
  items: [{ productId: 'p1', name: 'مادة', quantity: 100, price: 10_000 }],
  ...over,
});

const cost = (m: Record<string, number>) => (line: { productId?: string }) => m[line.productId ?? ''];

describe('🔴 السيناريو المقيس حيّاً', () => {
  it('تكلفة ٨٬٠٠٠ · بيع ١٠٬٠٠٠ · ١٠٠ قطعة · مصروف ١٠٠ ألف', () => {
    const r = netProfitOf([inv()], [{ type: 'expense', amount: 100_000 }], cost({ p1: 8_000 }));
    expect(r.sales).toBe(1_000_000);
    expect(r.cogs, 'تكلفة البضاعة المباعة كانت غائبة تماماً').toBe(800_000);
    expect(r.grossProfit).toBe(200_000);
    expect(r.netProfit, 'المعادلة القديمة كانت تعطي ٩٠٠٬٠٠٠ — تسعة أضعاف').toBe(100_000);
  });

  it('🔴 برهان الفرق: المعادلة القديمة تُنتج تسعة أضعاف', () => {
    const r = netProfitOf([inv()], [{ type: 'expense', amount: 100_000 }], cost({ p1: 8_000 }));
    const القديمة = r.sales + r.manualRevenue - r.expenses;   // بلا تكلفة بضاعة
    expect(القديمة).toBe(900_000);
    expect(القديمة / r.netProfit).toBe(9);
  });

  it('بهامش ٢٠٪ الواقعي يبقى التضخيم مضاعفات', () => {
    const r = netProfitOf([inv()], [], cost({ p1: 8_000 }));
    expect(r.grossProfit).toBe(200_000);
    expect(r.sales / r.grossProfit).toBe(5);   // المعروض كان خمسة أضعاف الحقيقي
  });
});

describe('🔴 القاعدة ١: التكلفة المجهولة تُستثنى ولا تُخمَّن', () => {
  it('مادة بلا سعر شراء ⇒ مبيعاتها غير محتسبة ولا تدخل الربح', () => {
    const r = invoiceProfit(inv(), cost({}));
    expect(r.grossProfit, 'صفرٌ للتكلفة يعني «بضاعة مجانية» فيصير كل بيعها ربحاً').toBe(0);
    expect(r.cogs).toBe(0);
    expect(r.unknownCostSales).toBe(1_000_000);
  });

  it('التكلفة صفر **مكتوبة صراحةً** معروفة (هدية من المورد)', () => {
    const r = invoiceProfit(inv(), cost({ p1: 0 }));
    expect(r.grossProfit).toBe(1_000_000);
    expect(r.unknownCostSales).toBe(0);
  });

  it('خليط: المعروف يُحسب والمجهول يُبوَّب', () => {
    const mixed = inv({
      items: [
        { productId: 'p1', quantity: 10, price: 10_000 },
        { productId: 'مجهول', quantity: 5, price: 20_000 },
      ],
    });
    const r = invoiceProfit(mixed, cost({ p1: 8_000 }));
    expect(r.grossProfit).toBe(20_000);
    expect(r.cogs).toBe(80_000);
    expect(r.unknownCostSales).toBe(100_000);
  });

  it('فاتورة بلا بنود (بيانات قديمة) ⇒ كلها غير محتسبة', () => {
    const r = invoiceProfit(inv({ items: [] }), cost({ p1: 8_000 }));
    expect(r.unknownCostSales).toBe(1_000_000);
    expect(r.grossProfit).toBe(0);
  });
});

describe('🔴 القاعدة ٢: سطر الجملة بتكلفة الجملة', () => {
  const products = [{ id: 'p1' }];
  const lookup = costLookup(
    () => products[0],
    () => 8_000,          // تكلفة القطعة
    () => 200_000,        // تكلفة الكرتون
  );

  it('سطر الجملة يُحاسَب بتكلفة الكرتون لا القطعة', () => {
    const wholesale = inv({
      totalAmount: 750_000, finalAmount: 750_000,
      items: [{ productId: 'p1', quantity: 3, price: 250_000, unitConversionQty: 30 }],
    });
    const r = invoiceProfit(wholesale, lookup);
    expect(r.cogs, 'خصم المورد يجعل تكلفة الكرتون ≠ تكلفة القطعة').toBe(600_000);
    expect(r.grossProfit).toBe(150_000);
  });

  it('🔴 غياب تكلفة الجملة ⇒ غير محتسب ولو كانت تكلفة المفرد معروفة', () => {
    const noWholesale = costLookup(() => products[0], () => 8_000, () => undefined);
    const r = invoiceProfit(inv({
      items: [{ productId: 'p1', quantity: 3, price: 250_000, unitConversionQty: 30 }],
    }), noWholesale);
    expect(r.grossProfit).toBe(0);
    expect(r.unknownCostSales).toBe(750_000);
  });

  it('المنتج المحذوف ⇒ تكلفة مجهولة', () => {
    const gone = costLookup(() => undefined, () => 8_000, () => 1);
    expect(invoiceProfit(inv(), gone).unknownCostSales).toBe(1_000_000);
  });
});

describe('🔴 القاعدة ٣: الخصم يُوزَّع بالنسبة', () => {
  it('خصم ١٠٪ يُنقص الربح المعروف ١٠٪ لا أكثر', () => {
    const discounted = inv({ totalAmount: 1_000_000, finalAmount: 900_000, discount: 100_000 });
    const r = invoiceProfit(discounted, cost({ p1: 8_000 }));
    expect(r.grossProfit, 'طرح الخصم كاملاً من ربحٍ جزئي يقلبه خسارة وهمية').toBe(180_000);
  });

  it('بلا خصم لا يتغيّر شيء', () => {
    expect(invoiceProfit(inv(), cost({ p1: 8_000 })).grossProfit).toBe(200_000);
  });

  it('الخصم لا يُطبَّق على ربحٍ سالب أو صفر', () => {
    const loss = inv({ discount: 100_000, items: [{ productId: 'p1', quantity: 10, price: 5_000 }] });
    const r = invoiceProfit(loss, cost({ p1: 8_000 }));
    expect(r.grossProfit).toBe(-30_000);   // بيعٌ بخسارة يبقى بخسارته
  });
});

describe('الأساسان: استحقاق ونقد', () => {
  it('المبيعات بالاستحقاق والمحصَّل بالنقد — كلاهما متاح', () => {
    const partial = inv({ finalAmount: 1_000_000, paidAmount: 400_000 });
    const r = invoiceProfit(partial, cost({ p1: 8_000 }));
    expect(r.sales).toBe(1_000_000);
    expect(r.collected).toBe(400_000);
  });

  it('غياب paidAmount = مدفوعة بالكامل (توافق رجعي)', () => {
    const r = invoiceProfit(inv({ paidAmount: undefined }), cost({ p1: 8_000 }));
    expect(r.collected).toBe(1_000_000);
  });
});

describe('التجميع', () => {
  it('يجمع الفواتير ويعدّها', () => {
    const r = salesProfit([inv({ id: 'a' }), inv({ id: 'b' })], cost({ p1: 8_000 }));
    expect(r.invoiceCount).toBe(2);
    expect(r.grossProfit).toBe(400_000);
    expect(r.cogs).toBe(1_600_000);
  });

  it('بلا فواتير ⇒ أصفار نظيفة', () => {
    const r = netProfitOf([], [], cost({}));
    expect(r).toMatchObject({ sales: 0, cogs: 0, grossProfit: 0, netProfit: 0, invoiceCount: 0 });
  });

  it('الإيرادات اليدوية تُضاف والمصاريف تُطرح', () => {
    const r = netProfitOf([], [
      { type: 'revenue', amount: 50_000 },
      { type: 'expense', amount: 20_000 },
    ], cost({}));
    expect(r.netProfit).toBe(30_000);
  });
});

/**
 * 🔴 حارس: الشاشتان تستدعيان المحرّك نفسه — وهذا وحده ما يمنع عودة رقمَي ربحٍ متناقضين.
 */
describe('حارس: مصدر ربح واحد', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import .*$/gm, '');

  const ev = read('src/components/ExpensesView.tsx');
  const rv = read('src/components/ReportsView.tsx');

  it('المسح يرى الملفين فعلاً', () => {
    expect(ev).toContain('netProfit');
    expect(rv).toContain('netEarnings');
  });

  it('🔴 الشاشتان من `netProfitOf` لا من حساب محلّي', () => {
    for (const [name, src] of [['المصاريف والأرباح', ev], ['التقارير', rv]] as const) {
      expect(/netProfitOf\(/.test(src), `${name}: تحسب الربح بنفسها ⇒ يعود التناقض`).toBe(true);
    }
  });

  it('🔴 لا تعود معادلة «المبيعات − المصاريف»', () => {
    expect(
      /const netProfit = totalWasil - totalMasroof/.test(ev),
      'الربح بلا تكلفة بضاعة — تسعة أضعاف الحقيقة في القياس الحيّ',
    ).toBe(false);
  });

  it('🔴 الفواتير مصفّاة بالفرع', () => {
    expect(
      /allInvoices\.filter\(matchesActiveBranch\)/.test(ev),
      'الإيرادات من كل الفروع والمصاريف من فرعٍ واحد، والشاشة تحمل شارة فرع',
    ).toBe(true);
  });

  it('🔴 للشاشة فترة زمنية', () => {
    expect(/isInPeriod\(/.test(ev), 'الأرقام كانت عمر المحل كلّه').toBe(true);
  });

  it('🟠 تكلفة البضاعة معروضة لا مطروحة خلف ستار', () => {
    expect(/profit\.cogs/.test(ev)).toBe(true);
    expect(/profit\.unknownCostSales/.test(ev), 'المبيعات مجهولة التكلفة تُصرَّح لا تُبتلع').toBe(true);
  });

  it('🟠 حذف الحركة المالية يُوثَّق', () => {
    expect(
      /logAudit\(\{[\s\S]{0,120}action: 'delete', entity: 'expense'/.test(ev),
      'مصروف يُحذف = مال يختفي من الدفتر بلا أثر لمن حذفه',
    ).toBe(true);
  });
});
