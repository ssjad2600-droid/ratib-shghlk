import { describe, it, expect } from 'vitest';
import {
  shelfLifeDays, alertDaysFor, expiryStatus, buildBatchRows, expirySummary,
  oldestActiveBatch, daysBetweenKeys, STAGE_LABEL, liveBatchQuantities, isStaleExpired,
} from '../expiry';
import { ExpiryBatch, Product } from '../../types';

/**
 * 🔴 الادّعاء المركزي لهذه الميزة: **قاعدة واحدة تخدم كل الأعمال**.
 * لا «وضع بقالة» و«وضع صيدلية» — بل نسبة من عمر المادة نفسها، بحدّين.
 * هذه الاختبارات تُثبت الادّعاء بالأرقام لا بالنيّة.
 */

const batch = (o: Partial<ExpiryBatch>): ExpiryBatch => ({
  id: 'b', productId: 'p', productName: 'مادة', expiryDate: '2026-12-31', receivedDate: '2026-01-01',
  quantity: 10, note: '', status: 'active', createdAt: 0, ...o,
});

const prod = (o: Partial<Product>): Product => ({
  id: 'p', name: 'مادة', barcode: '', sellPrice: 0, quantity: 0, lowStockThreshold: 1,
  category: 'عام', unit: 'قطعة', createdAt: '', ...o,
} as Product);

/** يبني شحنة بعمر محدّد بالأيام انطلاقاً من تاريخ ثابت. */
const withLife = (lifeDays: number): ExpiryBatch => {
  const start = new Date(2026, 0, 1);
  const end = new Date(2026, 0, 1 + lifeDays);
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return batch({ receivedDate: key(start), expiryDate: key(end) });
};

describe('عمر المادة', () => {
  it('يُحسب من الاستلام إلى الانتهاء', () => {
    expect(shelfLifeDays(batch({ receivedDate: '2026-01-01', expiryDate: '2026-04-01' }))).toBe(90);
  });

  it('تاريخ انتهاء قبل الاستلام ⇒ عمر غير معروف لا رقم سالب', () => {
    expect(shelfLifeDays(batch({ receivedDate: '2026-05-01', expiryDate: '2026-01-01' }))).toBeNull();
  });

  it('تاريخ ناقص أو مشوّه ⇒ غير معروف لا انهيار', () => {
    expect(shelfLifeDays(batch({ receivedDate: '', expiryDate: '2026-01-01' }))).toBeNull();
    expect(daysBetweenKeys('كلام', '2026-01-01')).toBeNull();
  });
});

describe('🔴 قاعدة واحدة تخدم كل الأعمال — الحساب التلقائي', () => {
  const auto = (lifeDays: number) => alertDaysFor(withLife(lifeDays)).days;

  it('الخبز (٥ أيام) ⇒ يومان — الحدّ الأدنى يمنعه من الصمت التام', () => {
    expect(auto(5)).toBe(2);
  });

  it('الحليب (٩٠ يوماً) ⇒ ~١٣ يوماً — وقت يكفي لتصريفه', () => {
    expect(auto(90)).toBe(14); // ٩٠ × ١٥٪ ≈ ١٣.٥ ⇒ ١٤
  });

  it('المعلّبات (سنتان) ⇒ ~٤ أشهر', () => {
    expect(auto(730)).toBe(110);
  });

  it('الدواء (٣ سنوات) ⇒ ١٦٤ يوماً ≈ ٥.٥ أشهر — قبل أن يرفض المورّد الاستبدال', () => {
    expect(auto(1095)).toBe(164);
  });

  it('الحدّ الأعلى يمنع تنبيهاً بلا فائدة لعمر طويل جداً', () => {
    expect(auto(5000)).toBe(180);
  });

  it('كل الحالات تبقى ضمن الحدّين مهما كان العمر', () => {
    for (const life of [1, 3, 7, 30, 90, 365, 730, 1095, 3650]) {
      const d = auto(life);
      expect(d).toBeGreaterThanOrEqual(2);
      expect(d).toBeLessThanOrEqual(180);
    }
  });

  it('العمر الأطول لا يعطي تنبيهاً أقصر أبداً (تدرّج سليم)', () => {
    const lives = [5, 30, 90, 365, 730, 1095];
    const days = lives.map(auto);
    for (let i = 1; i < days.length; i++) expect(days[i]).toBeGreaterThanOrEqual(days[i - 1]);
  });
});

describe('التجاوز اليدوي — الأولوية الصحيحة', () => {
  it('ضبط المادة يتقدّم على ضبط الفئة وعلى التلقائي', () => {
    const r = alertDaysFor(withLife(90), prod({ expiryAlertDays: 45, category: 'الأدوية' }), { 'الأدوية': 180 });
    expect(r).toEqual({ days: 45, origin: 'product' });
  });

  it('ضبط الفئة يتقدّم على التلقائي — ضبط واحد يخدم مئات المواد', () => {
    const r = alertDaysFor(withLife(1095), prod({ category: 'الأدوية' }), { 'الأدوية': 180 });
    expect(r).toEqual({ days: 180, origin: 'category' });
  });

  it('بلا أي ضبط ⇒ التلقائي، ويُعلن مصدره للمستخدم', () => {
    expect(alertDaysFor(withLife(90)).origin).toBe('auto');
  });

  it('بلا تاريخ استلام ⇒ افتراضي معلن لا تخمين صامت', () => {
    const r = alertDaysFor(batch({ receivedDate: '', expiryDate: '2026-12-31' }));
    expect(r).toEqual({ days: 30, origin: 'default' });
  });
});

describe('الحالات الأربع', () => {
  const status = (lifeDays: number, daysLeftWanted: number) => {
    // نثبّت «اليوم» ونبني الانتهاء بعده بالعدد المطلوب
    const today = new Date(2026, 5, 1);
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const expiry = new Date(2026, 5, 1 + daysLeftWanted);
    const received = new Date(expiry.getTime() - lifeDays * 86400000);
    return expiryStatus(batch({ receivedDate: key(received), expiryDate: key(expiry) }), key(today));
  };

  it('انتهت أمس ⇒ منتهية', () => {
    const s = status(90, -1);
    expect(s.stage).toBe('expired');
    expect(s.daysLeft).toBe(-1);
  });

  it('عند حدّ التنبيه بالضبط ⇒ صرّفها الآن', () => {
    expect(status(90, 14).stage).toBe('act');
  });

  it('بين مرّة ومرّتين من الحدّ ⇒ راقبها', () => {
    expect(status(90, 20).stage).toBe('watch');
  });

  it('بعيدة ⇒ سليمة', () => {
    expect(status(90, 60).stage).toBe('ok');
  });

  it('الدواء لا يُنبَّه عنه بمقياس الحليب — نفس عدد الأيام حالتان مختلفتان', () => {
    // ٦٠ يوماً متبقّية: للحليب (عمر ٩٠) سليمة، وللدواء (عمر ١٠٩٥) «صرّفها الآن»
    expect(status(90, 60).stage).toBe('ok');
    expect(status(1095, 60).stage).toBe('act');
  });

  it('لكل حالة تسمية عربية معروضة', () => {
    expect(Object.values(STAGE_LABEL).every(v => v.length > 0)).toBe(true);
  });
});

describe('صفوف العرض والملخّص', () => {
  const products = [prod({ id: 'p1', name: 'حليب' }), prod({ id: 'p2', name: 'دواء' })];
  const cost = (p: Product) => (p.id === 'p1' ? 1000 : undefined); // p2 تكلفته مجهولة عمداً
  const today = '2026-06-01';

  const rows = () => buildBatchRows([
    batch({ id: 'b1', productId: 'p1', productName: 'حليب', receivedDate: '2026-03-01', expiryDate: '2026-05-20', quantity: 10 }), // منتهية
    batch({ id: 'b2', productId: 'p1', productName: 'حليب', receivedDate: '2026-05-01', expiryDate: '2026-06-05', quantity: 5 }),  // قريبة
    batch({ id: 'b3', productId: 'p2', productName: 'دواء', receivedDate: '2026-01-01', expiryDate: '2029-01-01', quantity: 3 }),  // سليمة
    batch({ id: 'b4', productId: 'p1', productName: 'حليب', expiryDate: '2026-05-01', status: 'written_off', quantity: 99 }),      // مشطوبة
  ], products, cost, today);

  it('المشطوبة تُستبعد — أثرها انتقل إلى تسوية المخزون', () => {
    expect(rows().map(r => r.batch.id)).not.toContain('b4');
    expect(rows()).toHaveLength(3);
  });

  it('الترتيب: الأخطر أولاً ثم الأقرب انتهاءً', () => {
    expect(rows().map(r => r.batch.id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('قيمة الخطر بسعر الشراء، والمجهولة تكلفتها تُعدّ ولا تُخمَّن', () => {
    const s = expirySummary(rows());
    expect(s.expiredCount).toBe(1);
    expect(s.atRiskValue).toBe(10 * 1000 + 5 * 1000); // الدواء ليس على الخطر أصلاً
    const rowsWithUnknown = buildBatchRows([
      batch({ id: 'x', productId: 'p2', productName: 'دواء', receivedDate: '2026-05-01', expiryDate: '2026-05-20', quantity: 3 }),
    ], products, cost, today);
    const s2 = expirySummary(rowsWithUnknown);
    expect(s2.atRiskValue).toBe(0);
    expect(s2.unknownCostCount).toBe(1);
  });

  it('شحنة لمنتج محذوف لا تُسقط الشاشة', () => {
    const r = buildBatchRows([batch({ productId: 'ghost', productName: 'مادة محذوفة' })], products, cost, today);
    expect(r).toHaveLength(1);
    expect(r[0].product).toBeUndefined();
    expect(r[0].costKnown).toBe(false);
  });
});

describe('بِع بالأقدم أولاً', () => {
  it('يعطي الشحنة الأقرب انتهاءً للمنتج', () => {
    const list = [
      batch({ id: 'a', productId: 'p1', expiryDate: '2026-12-01' }),
      batch({ id: 'b', productId: 'p1', expiryDate: '2026-07-01' }),
      batch({ id: 'c', productId: 'p2', expiryDate: '2026-01-01' }),
    ];
    expect(oldestActiveBatch(list, 'p1')?.id).toBe('b');
  });

  it('يتجاهل المشطوبة', () => {
    const list = [
      batch({ id: 'a', productId: 'p1', expiryDate: '2026-07-01', status: 'written_off' }),
      batch({ id: 'b', productId: 'p1', expiryDate: '2026-12-01' }),
    ];
    expect(oldestActiveBatch(list, 'p1')?.id).toBe('b');
  });

  it('منتج بلا شحنات ⇒ لا شيء (لا انهيار)', () => {
    expect(oldestActiveBatch([], 'p9')).toBeUndefined();
  });
});

/**
 * 🔴 الكمية الحيّة للشحنة — توزيع المخزون الفعلي على الشحنات.
 *
 * العلّة: كمية الشحنة تُسجَّل يوم الاستلام ولا تنقص بالبيع، وكانت قيمة «بضاعة على الخطر»
 * تضربها في التكلفة كما هي. فشحنة ٥٠ علبة بِيع منها ٤٥ تبقى تُحسب ٥٠ — والتوثيق يسمّي
 * هذا «الرقم الذي يُحرّك التاجر»، فيرى خطراً بمليون ويخصم أسعار بضاعة لم تعد عنده.
 */
describe('🔴 توزيع المخزون الحيّ على الشحنات', () => {
  const b = (id: string, expiryDate: string, quantity: number) => ({ id, expiryDate, quantity });

  it('المخزون الكافي يُبقي كل شحنة بكميتها', () => {
    const m = liveBatchQuantities([b('a', '2026-09-01', 30), b('b', '2026-12-01', 20)], 50);
    expect(m.get('a')).toBe(30);
    expect(m.get('b')).toBe(20);
  });

  it('🔴 الأقدم يُستنزف أولاً — فالمتبقّي يخصّ الأحدث', () => {
    // سُجّل ٥٠، بقي ٢٠ ⇒ الأقدم (a) نفد والباقي من الأحدث (b)
    const m = liveBatchQuantities([b('a', '2026-09-01', 30), b('b', '2026-12-01', 20)], 20);
    expect(m.get('a'), 'الأقدم بِيع أولاً فيجب أن ينفد').toBe(0);
    expect(m.get('b')).toBe(20);
  });

  it('نفاد كامل ⇒ كل الشحنات صفر', () => {
    const m = liveBatchQuantities([b('a', '2026-09-01', 30), b('b', '2026-12-01', 20)], 0);
    expect([...m.values()]).toEqual([0, 0]);
  });

  it('🔴 المجموع لا يتجاوز الرصيد أبداً', () => {
    for (const stock of [0, 7, 20, 49, 50, 999]) {
      const m = liveBatchQuantities([b('a', '2026-09-01', 30), b('b', '2026-12-01', 20)], stock);
      const total = [...m.values()].reduce((s, v) => s + v, 0);
      expect(total, `عند رصيد ${stock}`).toBeLessThanOrEqual(Math.max(0, stock));
      expect(total).toBeLessThanOrEqual(50); // ولا يتجاوز المسجَّل
    }
  });

  it('رصيد أكبر من المسجَّل لا يُضخّم الشحنات', () => {
    const m = liveBatchQuantities([b('a', '2026-09-01', 30)], 500);
    expect(m.get('a')).toBe(30);
  });

  it('الرصيد السالب يُعامَل صفراً', () => {
    const m = liveBatchQuantities([b('a', '2026-09-01', 30)], -5);
    expect(m.get('a')).toBe(0);
  });

  it('ثلاث شحنات: القسمة تتدرّج من الأحدث', () => {
    const m = liveBatchQuantities(
      [b('قديم', '2026-08-01', 10), b('وسط', '2026-09-01', 10), b('جديد', '2026-10-01', 10)], 15);
    expect(m.get('جديد')).toBe(10);
    expect(m.get('وسط')).toBe(5);
    expect(m.get('قديم')).toBe(0);
  });
});

describe('🔴 الملخّص يستثني ما نفد وما تقادم', () => {
  const mkBatch = (id: string, expiryDate: string, quantity: number, productId = 'p1') => ({
    id, productId, productName: 'مادة', expiryDate, receivedDate: '2026-01-01',
    quantity, note: '', branchId: 'main', status: 'active' as const,
    createdAt: 1, createdByName: 'م',
  });
  const products = [{ id: 'p1', name: 'مادة', sellPrice: 100, quantity: 0 } as never];
  const cost = () => 1000;
  const TODAY = '2026-08-11';

  it('شحنة نفد رصيدها لا تُحسب خطراً', () => {
    const rows = buildBatchRows([mkBatch('a', '2026-08-15', 50)], products, cost, TODAY, undefined, () => 0);
    expect(rows[0].liveQuantity).toBe(0);
    const s = expirySummary(rows);
    expect(s.atRiskValue, 'حُسبت بضاعة بِيعت خطراً قائماً').toBe(0);
    expect(s.soldOutCount).toBe(1);
  });

  it('🔴 القيمة على الكمية الحيّة: ٥٠ سُجّلت و٥ باقية ⇒ ٥ فقط', () => {
    const rows = buildBatchRows([mkBatch('a', '2026-08-15', 50)], products, cost, TODAY, undefined, () => 5);
    expect(rows[0].liveQuantity).toBe(5);
    expect(rows[0].partiallySold).toBe(true);
    expect(rows[0].value, 'القيمة على ٥٠ بدل ٥ ⇒ عشرة أضعاف').toBe(5000);
  });

  it('بلا قارئ مخزون تبقى الكمية المسجَّلة (توافق رجعي)', () => {
    const rows = buildBatchRows([mkBatch('a', '2026-08-15', 50)], products, cost, TODAY);
    expect(rows[0].liveQuantity).toBe(50);
    expect(rows[0].partiallySold).toBe(false);
  });

  it('المنتهية منذ زمن طويل تُطوى عن العدّاد', () => {
    const rows = buildBatchRows([mkBatch('old', '2026-01-01', 10)], products, cost, TODAY, undefined, () => 10);
    expect(isStaleExpired(rows[0])).toBe(true);
    const s = expirySummary(rows);
    expect(s.expiredCount, 'شحنة عمرها سبعة أشهر ما زالت تلوّث العدّاد').toBe(0);
    expect(s.staleCount).toBe(1);
  });

  it('المنتهية حديثاً تبقى في العدّاد', () => {
    const rows = buildBatchRows([mkBatch('recent', '2026-08-01', 10)], products, cost, TODAY, undefined, () => 10);
    expect(isStaleExpired(rows[0])).toBe(false);
    expect(expirySummary(rows).expiredCount).toBe(1);
  });
});
