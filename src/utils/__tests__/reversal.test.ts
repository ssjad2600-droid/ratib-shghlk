import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isReversed, isReversal, countsInStats, activeOnly, canReverse,
  markReversedUpdate, reversalReason,
} from '../reversal';
import { adjustmentStats } from '../adjustmentStats';
import { Product, StockAdjustment } from '../../types';

/**
 * 🔴 التراجع عن قيدٍ أثّر في المخزون.
 *
 * البند يمسّ المال: من كتب «تلف ١٠٠» وهو يقصد ١٠ كان يصحّحها بـ«إضافة ٩٠»، فتبقى
 * «قيمة الخسارة» ثمنَ ١٠٠ قطعة إلى الأبد — والإضافة لا تُخصم عمداً لأن الإضافة الحقيقية
 * حدثٌ مستقلّ. فالخطأ المطبعي يُضخّم الخسائر المعلنة، والتاجر يقرأ الرقم ويبني عليه.
 */

const rec = (id: string, extra: Partial<{ reversedById: string; reversalOfId: string }> = {}) =>
  ({ id, ...extra });

describe('قراءة حالة القيد', () => {
  it('يميّز الأصل من المضادّ من السليم', () => {
    expect(isReversed(rec('a', { reversedById: 'b' }))).toBe(true);
    expect(isReversal(rec('b', { reversalOfId: 'a' }))).toBe(true);
    expect(isReversed(rec('c'))).toBe(false);
    expect(isReversal(rec('c'))).toBe(false);
  });

  it('🔴 الطرفان معاً يسقطان من الحساب — لأنهما يساويان لا شيء', () => {
    expect(countsInStats(rec('a', { reversedById: 'b' }))).toBe(false);
    expect(countsInStats(rec('b', { reversalOfId: 'a' }))).toBe(false);
    expect(countsInStats(rec('c'))).toBe(true);
  });

  it('activeOnly يُبقي غير المتراجَع عنه وحده', () => {
    const all = [rec('a', { reversedById: 'b' }), rec('b', { reversalOfId: 'a' }), rec('c')];
    expect(activeOnly(all).map(r => r.id)).toEqual(['c']);
  });
});

describe('🔴 منع التراجع المُفسد', () => {
  it('التراجع مرّتين ممنوع — يُعيد البضاعة مرّتين فتُخلق من العدم', () => {
    const check = canReverse(rec('a', { reversedById: 'b' }));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/سابقاً/);
  });

  it('التراجع عن تراجُع ممنوع — سلسلة لا تنتهي', () => {
    const check = canReverse(rec('b', { reversalOfId: 'a' }));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/تراجُع/);
  });

  it('القيد السليم يجوز التراجع عنه', () => {
    expect(canReverse(rec('c')).ok).toBe(true);
  });

  it('الرسالة موجودة دائماً عند المنع — لا منعَ صامت', () => {
    for (const r of [rec('a', { reversedById: 'b' }), rec('b', { reversalOfId: 'a' })]) {
      expect(canReverse(r).reason.length).toBeGreaterThan(10);
    }
  });
});

describe('ختم القيد الأصلي وصياغة السبب', () => {
  it('الختم يربط بالمضادّ ولا يمسّ شيئاً آخر', () => {
    expect(markReversedUpdate('rev_1')).toEqual({ reversedById: 'rev_1' });
  });

  it('السبب يقتبس الأصل كي لا يضيع السياق بعد سنة', () => {
    expect(reversalReason('كسر ٥ قطع')).toBe('تراجُع عن قيد سابق: كسر ٥ قطع');
    expect(reversalReason('')).toMatch(/بلا سبب مكتوب/);
  });
});

/**
 * 🔴 صُلب البند: الخطأ المصحَّح لا يُضخّم «قيمة الخسارة».
 */
describe('🔴 أثر التراجع على قيمة الخسارة', () => {
  const products = [{ id: 'هاتف', name: 'هاتف' } as Product];
  const buyPriceOf = () => 200000;

  const adj = (id: string, delta: number, extra = {}): StockAdjustment => ({
    id, productId: 'هاتف', productName: 'هاتف', quantityDelta: delta,
    quantityBefore: 100, quantityAfter: 100 + delta, type: 'damage',
    reason: 'اختبار', date: '2026-08-01', createdAt: 1, ...extra,
  } as StockAdjustment);

  it('العلاج القديم كان يُبقي الخسارة كاملة — وهذا هو الضرر', () => {
    // كتب «تلف ١٠٠» وقصد ١٠، فصحّحها بـ«إضافة ٩٠» كقيدٍ مستقلّ
    const s = adjustmentStats([adj('خطأ', -100), adj('تصحيح', +90)], products, buyPriceOf);
    expect(s.lostUnits, 'الإضافة لا تُخصم من الخسارة — عمداً وبحقّ').toBe(100);
    expect(s.lostValue).toBe(20_000_000);
  });

  it('🔴 بالتراجع: القيدان يسقطان فتعود الخسارة إلى الصفر', () => {
    const s = adjustmentStats([
      adj('خطأ', -100, { reversedById: 'مضادّ' }),
      adj('مضادّ', +100, { reversalOfId: 'خطأ' }),
    ], products, buyPriceOf);
    expect(s.lostValue, 'خطأ مطبعي واحد كان يُضخّم الخسائر المعلنة بلا رجعة').toBe(0);
    expect(s.lostUnits).toBe(0);
    expect(s.addedUnits, 'القيد المضادّ ليس إضافةً حقيقية').toBe(0);
    expect(s.count).toBe(0);
    expect(s.reversedCount, 'يُعرَض كي لا يبدو النقص خطأً في الحساب').toBe(2);
  });

  it('التسوية الحقيقية بعد التراجع تُحسب وحدها', () => {
    const s = adjustmentStats([
      adj('خطأ', -100, { reversedById: 'مضادّ' }),
      adj('مضادّ', +100, { reversalOfId: 'خطأ' }),
      adj('الصحيح', -10),
    ], products, buyPriceOf);
    expect(s.lostUnits).toBe(10);
    expect(s.lostValue).toBe(2_000_000);
    expect(s.count).toBe(1);
  });

  it('بلا تراجع: لا شيء يتغيّر عمّا كان — لا انحدار', () => {
    const s = adjustmentStats([adj('أ', -10), adj('ب', +4)], products, buyPriceOf);
    expect(s).toMatchObject({ count: 2, lostUnits: 10, addedUnits: 4, reversedCount: 0 });
  });
});

/**
 * 🔴 حارس: الاستثناء داخل الدالة، والتراجع لا يكتب قيمةً مطلقة.
 *
 * اختبار الوحدة يُثبت أن الآلية تعمل، لا أن الشاشات تستعملها. والخطأ الواقعي هو النسيان.
 */
describe('حارس: الآلية مطبَّقة حيث يجب', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import .*$/gm, '');

  const stats = read('src/utils/adjustmentStats.ts');
  const adjView = read('src/components/InventoryAdjustmentsView.tsx');
  const trView = read('src/components/StockTransfersView.tsx');

  it('المسح يرى الملفات فعلاً', () => {
    expect(stats).toContain('lostValue');
    expect(adjView).toContain('StockAdjustment');
    expect(trView).toContain('StockTransfer');
  });

  it('🔴 الاستثناء داخل adjustmentStats لا عند المُنادي', () => {
    expect(
      /activeOnly\(\s*adjustments\s*\)/.test(stats),
      'لو تُرك الاستثناء للشاشات لنسيته إحداها فعاد الخطأ المصحَّح يُضخّم قيمة الخسارة',
    ).toBe(true);
  });

  it('🔴 كل شاشة تفحص canReverse قبل الكتابة', () => {
    for (const [name, src] of [['التسوية', adjView], ['النقل', trView]] as const) {
      expect(
        /canReverse\(/.test(src),
        `${name}: بلا فحص ⇒ تراجع مرّتين يُعيد البضاعة مرّتين، أو سلسلة تراجعات لا تنتهي`,
      ).toBe(true);
      expect(/markReversedUpdate\(/.test(src), `${name}: القيد الأصلي لا يُختم فيُتراجع عنه مراراً`).toBe(true);
    }
  });

  it('🔴 التراجع يعيد المخزون بفارق لا بقيمة مطلقة', () => {
    expect(
      /stockUpdateSeeded\(product, delta, branch\)/.test(adjView),
      'كتابة مطلقة تمحو بيعاً متزامناً وتفشل أوفلاين',
    ).toBe(true);
    expect(
      /transferUpdate\(p, it\.quantity, original\.toBranchId, original\.fromBranchId\)/.test(trView),
      'النقل المعاكس يجب أن يسحب من الوجهة إلى المصدر — بالاتجاه المعكوس بالضبط',
    ).toBe(true);
  });

  it('🔴 التراجع لا يحذف السجل — الحذف يُخفي أن الخطأ وقع', () => {
    for (const [name, src] of [['التسوية', adjView], ['النقل', trView]] as const) {
      expect(
        /deleteDoc\(|removeAdjustment\(|removeTransfer\(/.test(src),
        `${name}: ظهر حذفٌ في مسار التراجع — والسجل وُجد ليكشف الخطأ لا ليمحوه`,
      ).toBe(false);
    }
  });

  it('🔴 شطب الصلاحية المتراجَع عنه يُعيد فتح الشحنة', () => {
    expect(
      /writtenOffAdjustmentId === original\.id/.test(adjView),
      'البضاعة تعود للمخزون وشاشة الصلاحية تبقى تقول «مشطوبة» ⇒ شاشتان تتناقضان',
    ).toBe(true);
    expect(/status: 'active'/.test(adjView)).toBe(true);
  });
});
