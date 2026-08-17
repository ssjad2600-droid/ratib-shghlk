import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { netProfitOf, ProfitInvoice } from '../profit';
import { periodRange, isInRange } from '../reportPeriod';

/**
 * أداء الفروع — كانت آخر جزيرة تحسب الربح والفترة والتواريخ بنفسها، بعد أن وُحِّدت
 * ثلاث شاشات في `profit.ts` و`reportPeriod.ts`.
 *
 * وأخطر ما فيها لم يكن حساباً بل **إسناداً**: سجلّ فرعٍ محذوف كان يسقط على أوّل فرع في
 * ترتيب المجموعة — في شاشة كل غرضها المقارنة العادلة.
 */

const inv = (over: Partial<ProfitInvoice> = {}): ProfitInvoice => ({
  id: 'i1', totalAmount: 100_000, finalAmount: 100_000, discount: 0, paidAmount: 100_000,
  items: [{ productId: 'p1', quantity: 10, price: 10_000 }],
  ...over,
});
const cost = (m: Record<string, number>) => (l: { productId?: string }) => m[l.productId ?? ''];

describe('🟠 النسخة الرابعة كانت قد افترقت فعلاً', () => {
  it('🔴 الفاتورة بلا بنود: كامل قيمتها «غير محتسب» لا صفر', () => {
    // الحلقة القديمة `for (const item of inv.items || [])` كانت تُنتج صفراً لفاتورة
    // بلا بنود، فيبدو الفرع أنظف ممّا هو. المحرّك المشترك يُعلنها كاملةً.
    const r = netProfitOf([inv({ items: [] })], [], cost({}));
    expect(r.unknownCostSales).toBe(100_000);
    expect(r.grossProfit).toBe(0);
  });

  it('صافي الفرع = ربح معروف + واصل يدوي − مصاريف', () => {
    const r = netProfitOf(
      [inv()],
      [{ type: 'revenue', amount: 20_000 }, { type: 'expense', amount: 30_000 }],
      cost({ p1: 6_000 }),
    );
    expect(r.grossProfit).toBe(40_000);
    expect(r.netProfit, 'المعادلة المعلنة في حاشية الشاشة').toBe(40_000 + 20_000 - 30_000);
  });

  it('المجهول لا يدخل الصافي ويُعرض منفصلاً', () => {
    const r = netProfitOf([inv()], [], cost({}));
    expect(r.netProfit).toBe(0);
    expect(r.unknownCostSales).toBe(100_000);
  });
});

describe('🟠 الفترة من المصدر الموحّد', () => {
  const NOW = new Date(2026, 7, 17, 12, 0);

  it('«آخر سنة» ٣٦٥ يوماً — كانت ٣٦٦ هنا و٣٦٥ في التقارير', () => {
    expect(periodRange('yearly', NOW).days).toBe(365);
  });

  it('«الكل» يشمل كل تاريخ صالح', () => {
    const r = periodRange('all', NOW);
    expect(isInRange('2020-01-05', r)).toBe(true);
  });

  it('🔴 التاريخ بأرقام عربية يُقرأ — المقارنة النصّية كانت تُسقطه بصمت', () => {
    const r = periodRange('monthly', NOW);
    expect(isInRange('٢٠٢٦-٠٨-١٧', r)).toBe(true);
  });

  it('🔴 صيغة يوم-شهر-سنة تُقرأ كذلك', () => {
    const r = periodRange('monthly', NOW);
    expect(isInRange('17-08-2026', r)).toBe(true);
  });
});

/**
 * 🔴 حارس: الشاشة موصولة بالمحرّكات، والسجل اليتيم مُعلَن.
 */
describe('حارس: شاشة أداء الفروع', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'components', 'BranchComparisonView.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import .*$/gm, '');

  it('المسح يرى الملف فعلاً', () => {
    expect(src).toContain('BranchRow');
    expect(src).toContain('rowFor');
  });

  it('🔴 السجل اليتيم لا يُسنَد لأوّل فرع', () => {
    expect(
      /base\.get\(branches\[0\]/.test(src),
      'مبيعات فرعٍ محذوف تُضاف لمنافسه بصمت فيتصدّر «الأعلى ربحاً» بأرقام ليست له',
    ).toBe(false);
    expect(/orphan/.test(src), 'لا صفّ صريح للسجلات اليتيمة').toBe(true);
  });

  it('🟠 الربح من المحرّك المشترك لا من نسخة محلّية', () => {
    expect(/netProfitOf\(/.test(src)).toBe(true);
    expect(
      /known \+= \(item\.price - cost\) \* item\.quantity/.test(src),
      'عادت النسخة الرابعة من حساب الربح',
    ).toBe(false);
  });

  it('🟠 الفترة والتواريخ من المصدر الموحّد', () => {
    expect(/periodRange\(/.test(src)).toBe(true);
    expect(/isInRange\(/.test(src)).toBe(true);
    expect(
      /dateStr >= startKey/.test(src),
      'المقارنة النصّية تُسقط أي تاريخ غير ISO لاتيني بصمت',
    ).toBe(false);
  });

  it('🟠 المخزون يعرض رأس المال ويُعلن المجهول', () => {
    expect(/inventoryValue\(/.test(src)).toBe(true);
    expect(/stockCost/.test(src)).toBe(true);
    expect(/unknownCostUnits/.test(src)).toBe(true);
  });

  it('🟠 المجموعات ضمن نافذة زمنية', () => {
    expect(/useCollection<Invoice>\('invoices',\s*dataWindow\)/.test(src)).toBe(true);
    expect(/useCollection<FinancialTx>\('financial_transactions',\s*dataWindow\)/.test(src)).toBe(true);
  });

  it('🟡 التصدير متاح', () => {
    expect(/exportAsWord\(|exportAsPdf\(/.test(src)).toBe(true);
  });
});
