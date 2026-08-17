import { describe, it, expect } from 'vitest';
import { generateSchedule, planStatus, isDueWithin, PlanInvoice } from '../installments';

/**
 * حالة خطة التقسيط — تُشتقّ من الفاتورة وحدها.
 *
 * 🔴 العلّة الأصلية: `plan.totalAmount` لقطةٌ تُجمَّد لحظة الإنشاء، وكان الحساب
 * `اللقطة − متبقّي الفاتورة`. فأي تعديل لاحق على الفاتورة يُنتج رقماً كاذباً في اتجاهين،
 * وأخطرهما الذي يبدو خبراً ساراً: **مرتجعٌ يجعل أقساطاً لم تُدفع تظهر «مسدَّدة»**،
 * فيكفّ التاجر عن مطالبة زبونٍ ما زال مديناً بها.
 */

const plan = (total: number, down: number, n = 3) => ({
  totalAmount: total,
  downPayment: down,
  schedule: generateSchedule(total, n, 'monthly' as const, '2026-01-01'),
});

const inv = (finalAmount: number, remainingAmount: number, paidAmount?: number): PlanInvoice => ({
  finalAmount, remainingAmount,
  ...(paidAmount !== undefined ? { paidAmount } : {}),
});

const TODAY = '2026-08-11';

describe('الحالة الطبيعية — لا تغيير على الفاتورة', () => {
  const p = plan(90000, 30000); // فاتورة ١٢٠٬٠٠٠، مقدَّم ٣٠٬٠٠٠

  it('قبل أي قسط: لم يُدفع من الأقساط شيء', () => {
    const st = planStatus(p, inv(120000, 90000, 30000), TODAY);
    expect(st.total).toBe(90000);
    expect(st.paidTotal).toBe(0);
    expect(st.remaining).toBe(90000);
    expect(st.scheduleStale).toBe(false);
  });

  it('بعد قسط واحد', () => {
    const st = planStatus(p, inv(120000, 60000, 60000), TODAY);
    expect(st.paidTotal).toBe(30000);
    expect(st.remaining).toBe(60000);
    expect(st.rows[0].state).toBe('paid');
    expect(st.rows[1].state).toBe('unpaid');
  });

  it('بعد السداد الكامل', () => {
    const st = planStatus(p, inv(120000, 0, 120000), TODAY);
    expect(st.isCompleted).toBe(true);
    expect(st.progressPct).toBe(100);
  });

  it('🔴 المتبقي المحسوب يطابق متبقّي الفاتورة دائماً', () => {
    for (const rem of [90000, 60000, 30000, 15000, 0]) {
      const st = planStatus(p, inv(120000, rem, 120000 - rem), TODAY);
      expect(st.remaining, `اختلّ عند متبقٍّ ${rem}`).toBe(rem);
    }
  });
});

describe('🔴 نقصت الفاتورة بعد الخطة (مرتجع) — أخطر الوجهين', () => {
  const p = plan(90000, 30000);
  // أُرجعت بضاعة بـ٣٠٬٠٠٠: الإجمالي ١٢٠٬٠٠٠ ⟵ ٩٠٬٠٠٠، والمدفوع ما زال ٣٠٬٠٠٠ (المقدَّم فقط)
  const afterReturn = inv(90000, 60000, 30000);

  it('يُكشف ويُوسم', () => {
    const st = planStatus(p, afterReturn, TODAY);
    expect(st.scheduleStale).toBe(true);
    expect(st.staleKind).toBe('shrank');
  });

  it('🔴 لا يُوسم قسطٌ «مسدَّداً» ولم يُسدَّد', () => {
    const st = planStatus(p, afterReturn, TODAY);
    expect(st.paidTotal, 'تضخّم المدفوع ⇒ أقساط تبدو مدفوعة وهي ليست كذلك').toBe(0);
    expect(st.rows.every(r => r.state === 'unpaid'), 'وُسم قسط بالسداد زوراً').toBe(true);
  });

  it('المتبقي يتبع الفاتورة الجديدة لا اللقطة', () => {
    expect(planStatus(p, afterReturn, TODAY).remaining).toBe(60000);
    expect(planStatus(p, afterReturn, TODAY).total).toBe(60000);
  });

  it('🔴 المتأخر لا يتجاوز المتبقي — لا نطالبه بأكثر مما عليه', () => {
    // الجدول ٩٠٬٠٠٠ (٣ أقساط فائتة) والدَّين الحقيقي بعد المرتجع ٣٠٬٠٠٠
    const bigReturn = inv(60000, 30000, 30000);
    const st = planStatus(p, bigReturn, TODAY);
    expect(st.overdueRows.length).toBe(3);
    expect(st.overdueAmount, 'طالبناه بأكثر من دَينه').toBe(30000);
    expect(st.overdueAmount).toBeLessThanOrEqual(st.remaining);
  });

  it('🔴 القسط القادم لا يتجاوز المتبقي أيضاً', () => {
    // خطة أقساطها ٣٠٬٠٠٠ والدَّين بعد المرتجع ١٠٬٠٠٠ فقط
    const st = planStatus(p, inv(40000, 10000, 30000), TODAY);
    expect(st.remaining).toBe(10000);
    expect(st.nextDueAmount, 'طالبناه بقسط أكبر من دَينه كلّه').toBe(10000);
  });

  it('🔴 المتأخر ≤ المتبقي في كل الحالات', () => {
    for (const [final, rem, paid] of [[120000, 90000, 30000], [60000, 30000, 30000],
      [90000, 0, 90000], [40000, 10000, 30000], [200000, 170000, 30000]] as const) {
      const st = planStatus(p, inv(final, rem, paid), TODAY);
      expect(st.overdueAmount, `اختلّ عند (${final}, ${rem})`).toBeLessThanOrEqual(st.remaining);
    }
  });

  it('المرتجع مع أقساط مدفوعة فعلاً يُبقيها مدفوعة', () => {
    // دُفع قسطان (٦٠٬٠٠٠ فوق المقدَّم) ثم أُرجعت بضاعة بـ١٠٬٠٠٠
    const st = planStatus(p, inv(110000, 20000, 90000), TODAY);
    expect(st.paidTotal).toBe(60000);
    expect(st.rows[0].state).toBe('paid');
    expect(st.rows[1].state).toBe('paid');
    expect(st.remaining).toBe(20000);
  });
});

describe('🔴 زادت الفاتورة بعد الخطة — لا يُمحى ما دُفع', () => {
  const p = plan(90000, 30000);
  // أُضيفت أصناف بـ٤٠٬٠٠٠ بعد دفع قسط: الإجمالي ١٦٠٬٠٠٠، المدفوع ٦٠٬٠٠٠
  const afterGrowth = inv(160000, 100000, 60000);

  it('يُكشف ويُوسم', () => {
    const st = planStatus(p, afterGrowth, TODAY);
    expect(st.scheduleStale).toBe(true);
    expect(st.staleKind).toBe('grew');
  });

  it('🔴 القسط المدفوع يبقى مدفوعاً (كان يُقصّ إلى صفر)', () => {
    const st = planStatus(p, afterGrowth, TODAY);
    expect(st.paidTotal, 'ضاع ما دفعه الزبون').toBe(30000);
    expect(st.rows[0].state).toBe('paid');
    expect(st.progressPct).toBeGreaterThan(0);
  });

  it('المتبقي يشمل الزيادة', () => {
    expect(planStatus(p, afterGrowth, TODAY).remaining).toBe(100000);
  });
});

describe('الحالات الحديّة', () => {
  it('فاتورة مفقودة: لا نزعم أنها سُدِّدت', () => {
    const st = planStatus(plan(90000, 30000), null, TODAY);
    expect(st.staleKind).toBe('missing');
    expect(st.isCompleted, 'خطة بلا فاتورة ظهرت مكتملة').toBe(false);
    expect(st.paidTotal).toBe(0);
  });

  it('فاتورة قديمة بلا paidAmount يُستنتج مدفوعها', () => {
    const st = planStatus(plan(90000, 30000), inv(120000, 60000), TODAY);
    expect(st.paidTotal).toBe(30000); // (١٢٠٬٠٠٠ − ٦٠٬٠٠٠) − ٣٠٬٠٠٠ مقدَّم
  });

  it('خطة بلا مقدَّم', () => {
    const st = planStatus(plan(90000, 0), inv(90000, 30000, 60000), TODAY);
    expect(st.total).toBe(90000);
    expect(st.paidTotal).toBe(60000);
  });

  it('لا يتجاوز المدفوع الإجمالي مهما كانت البيانات', () => {
    const st = planStatus(plan(90000, 30000), inv(120000, 0, 999999), TODAY);
    expect(st.paidTotal).toBeLessThanOrEqual(st.total);
    expect(st.remaining).toBeGreaterThanOrEqual(0);
  });
});

describe('التأخير والاستحقاق', () => {
  const p = {
    totalAmount: 90000, downPayment: 0,
    schedule: generateSchedule(90000, 3, 'monthly' as const, '2026-05-01'),
  };

  it('الأقساط الفائتة غير المدفوعة متأخرة', () => {
    const st = planStatus(p, inv(90000, 90000, 0), TODAY);
    expect(st.overdueRows.length).toBe(3); // مايو ويونيو ويوليو فاتت
    expect(st.overdueAmount).toBe(90000);
    expect(st.daysLateOfOldest).toBeGreaterThan(90);
  });

  it('المدفوع يُطفئ التأخير من الأقدم', () => {
    const st = planStatus(p, inv(90000, 60000, 30000), TODAY);
    expect(st.overdueRows.map(r => r.seq)).toEqual([2, 3]);
  });

  it('لا تأخير على خطة مكتملة', () => {
    const st = planStatus(p, inv(90000, 0, 90000), TODAY);
    expect(st.overdueRows).toEqual([]);
    expect(st.daysLateOfOldest).toBe(0);
  });

  it('isDueWithin يحترم النافذة', () => {
    expect(isDueWithin('2026-08-15', 7, TODAY)).toBe(true);
    expect(isDueWithin('2026-08-25', 7, TODAY)).toBe(false);
    expect(isDueWithin('2026-08-01', 7, TODAY), 'الماضي ليس «قريباً»').toBe(false);
  });
});

describe('توليد الجدول', () => {
  it('المجموع يطابق الإجمالي تماماً — لا يضيع دينار', () => {
    for (const [total, n] of [[100000, 3], [99999, 7], [1, 5], [777777, 12]] as const) {
      expect(generateSchedule(total, n, 'monthly', '2026-01-31').reduce((s, d) => s + d.amount, 0)).toBe(total);
    }
  });

  it('انزلاق نهاية الشهر يُصحَّح (٣١ يناير + شهر ⇒ آخر فبراير)', () => {
    const s = generateSchedule(3000, 3, 'monthly', '2026-01-31');
    expect(s[1].dueDate).toBe('2026-02-28');
    expect(s[2].dueDate).toBe('2026-03-31');
  });

  it('الأسبوعي يزيد سبعة أيام', () => {
    const s = generateSchedule(3000, 3, 'weekly', '2026-08-01');
    expect(s.map(d => d.dueDate)).toEqual(['2026-08-01', '2026-08-08', '2026-08-15']);
  });
});
