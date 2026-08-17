import { describe, it, expect } from 'vitest';
import { allocatePayment, invoicePaymentUpdate, remainingOf, paidOf, AllocatableInvoice } from '../debtAllocation';

/**
 * توزيع تسديد الدَّين — كل دينار يُحصَّل يجب أن يجد له مكاناً معلوماً.
 *
 * العلّتان الأصليتان كانتا تُنتجان **دفترين متعارضين**: رصيد الزبون يقول شيئاً وفواتيره
 * تقول آخر. وهذا أسوأ من رقم خاطئ واحد — لأن التاجر يرى الرقمين ولا يعرف أيهما يصدّق.
 */

const inv = (id: string, final: number, remaining?: number, paid?: number, createdAt?: number): AllocatableInvoice => ({
  id, finalAmount: final,
  ...(remaining !== undefined ? { remainingAmount: remaining } : {}),
  ...(paid !== undefined ? { paidAmount: paid } : {}),
  ...(createdAt !== undefined ? { createdAt } : {}),
});

/** ثابتة الاتّزان: مجموع ما وُزّع + ما لم يُوزَّع = المبلغ المدفوع، دائماً. */
const expectBalanced = (result: ReturnType<typeof allocatePayment>, amount: number) => {
  const sum = result.allocations.reduce((s, a) => s + a.amount, 0);
  expect(sum + result.unallocated, 'ضاع أو تولّد مال في التوزيع').toBe(amount);
};

describe('🔴 الفائض لا يتبخّر', () => {
  const two = [inv('a', 50000, 50000, 0, 1), inv('b', 50000, 50000, 0, 2)];

  it('تسديد ٨٠٬٠٠٠ على فاتورة ٥٠٬٠٠٠ يفيض على التالية', () => {
    const r = allocatePayment(two, 80000, 'a');
    expect(r.allocations).toEqual([
      { invoiceId: 'a', amount: 50000 },
      { invoiceId: 'b', amount: 30000 },
    ]);
    expect(r.unallocated).toBe(0);
    expectBalanced(r, 80000);
  });

  it('🔴 لا فاتورة تأخذ أكثر من متبقّيها أبداً', () => {
    for (const amount of [1, 49999, 50000, 50001, 99999, 100000]) {
      const r = allocatePayment(two, amount, 'a');
      for (const a of r.allocations) {
        const target = two.find(i => i.id === a.invoiceId)!;
        expect(a.amount, `فاتورة ${a.invoiceId} أخذت أكثر من متبقّيها`).toBeLessThanOrEqual(remainingOf(target));
      }
      expectBalanced(r, amount);
    }
  });

  it('ما يتجاوز كل الفواتير يبقى غير موزَّع — لا يُدسّ في فاتورة', () => {
    const r = allocatePayment(two, 120000, 'a');
    expect(r.unallocated).toBe(20000);
    expectBalanced(r, 120000);
  });

  it('زبون بلا فواتير (دين قديم يدوي) ⇒ كله غير موزَّع', () => {
    const r = allocatePayment([], 30000);
    expect(r.allocations).toEqual([]);
    expect(r.unallocated).toBe(30000);
  });
});

describe('الترتيب: المختارة أولاً ثم الأقدم', () => {
  const three = [
    inv('new', 10000, 10000, 0, 300),
    inv('old', 10000, 10000, 0, 100),
    inv('mid', 10000, 10000, 0, 200),
  ];

  it('بلا اختيار ⇒ الأقدم أولاً', () => {
    const r = allocatePayment(three, 25000);
    expect(r.allocations.map(a => a.invoiceId)).toEqual(['old', 'mid', 'new']);
  });

  it('مع اختيار ⇒ المختارة أولاً ثم الأقدم من الباقي', () => {
    const r = allocatePayment(three, 25000, 'new');
    expect(r.allocations.map(a => a.invoiceId)).toEqual(['new', 'old', 'mid']);
  });

  it('اختيار فاتورة مسدَّدة يُتجاهَل بهدوء', () => {
    const withPaid = [...three, inv('done', 5000, 0, 5000, 50)];
    const r = allocatePayment(withPaid, 5000, 'done');
    expect(r.allocations).toEqual([{ invoiceId: 'old', amount: 5000 }]);
  });

  it('اختيار معرّف غير موجود يعود للترتيب الافتراضي', () => {
    const r = allocatePayment(three, 5000, 'لا-وجود-له');
    expect(r.allocations).toEqual([{ invoiceId: 'old', amount: 5000 }]);
  });

  it('الفواتير القديمة بلا createdAt تُرتَّب بمعرّفها الرقمي', () => {
    const legacy = [inv('200', 5000, 5000), inv('100', 5000, 5000)];
    const r = allocatePayment(legacy, 5000);
    expect(r.allocations[0].invoiceId).toBe('100');
  });
});

describe('الحالات الحديّة', () => {
  const one = [inv('a', 50000, 50000, 0)];

  it('مبلغ صفر أو سالب لا يوزّع شيئاً', () => {
    expect(allocatePayment(one, 0).allocations).toEqual([]);
    expect(allocatePayment(one, -100).allocations).toEqual([]);
  });

  it('الفواتير المسدَّدة تُستثنى', () => {
    const paidOff = [inv('a', 50000, 0, 50000), inv('b', 50000, 50000, 0)];
    expect(allocatePayment(paidOff, 10000).allocations).toEqual([{ invoiceId: 'b', amount: 10000 }]);
  });

  it('الفاتورة بلا remainingAmount تُعامَل مسدَّدة (توافق رجعي)', () => {
    expect(allocatePayment([inv('legacy', 50000)], 10000).unallocated).toBe(10000);
  });

  it('الكسور تُقرَّب فلا يتسرّب فلس', () => {
    const r = allocatePayment([inv('a', 100, 100, 0)], 33.7);
    expectBalanced(r, 34);
  });
});

describe('🔴 كائن التحديث — فوارق لا قيماً مطلقة', () => {
  it('الفاتورة الحديثة تُحدَّث بالفوارق (تتراكب مع تحصيل متزامن)', () => {
    const u = invoicePaymentUpdate(inv('a', 50000, 50000, 0), 20000);
    // FieldValue من Firestore — نتحقّق أنه ليس رقماً مطلقاً
    expect(typeof u.remainingAmount, 'قيمة مطلقة ⇒ يمحوها التحصيل المتزامن').not.toBe('number');
    expect(typeof u.paidAmount).not.toBe('number');
  });

  it('🔴 الفاتورة القديمة بلا الحقلين تُبذَر بقيمة مطلقة مرة واحدة', () => {
    // increment على حقل غائب يبدأ من صفر فيمحو ما دُفع سابقاً — لذا نبذر أولاً
    const legacy = inv('old', 50000); // بلا remainingAmount ولا paidAmount
    const u = invoicePaymentUpdate(legacy, 10000);
    expect(u.remainingAmount).toBe(0);
    expect(u.paidAmount, 'ضاع المدفوع السابق').toBe(60000);
  });

  it('فاتورة لها متبقٍّ بلا paidAmount تُبذر المدفوع المستنتج', () => {
    const partial = inv('p', 50000, 20000); // دُفع ٣٠٬٠٠٠ ضمناً
    expect(paidOf(partial)).toBe(30000);
    const u = invoicePaymentUpdate(partial, 5000);
    expect(u.paidAmount).toBe(35000);
    expect(typeof u.remainingAmount, 'الحقل موجود ⇒ يجب أن يكون فارقاً').not.toBe('number');
  });
});

describe('🔴 الدفتران لا ينحرفان — محاكاة تحصيلين متزامنين', () => {
  it('مجموع ما يُخصم من الفواتير يساوي ما يُخصم من الرصيد', () => {
    const invoices = [inv('a', 50000, 50000, 0, 1), inv('b', 50000, 50000, 0, 2)];
    // الكاشير يحصّل ٢٠٬٠٠٠ وأنت تحصّل ٣٠٬٠٠٠ — كلٌّ يرى نفس اللقطة
    const r1 = allocatePayment(invoices, 20000, 'a');
    const r2 = allocatePayment(invoices, 30000, 'a');
    const sum1 = r1.allocations.reduce((s, x) => s + x.amount, 0) + r1.unallocated;
    const sum2 = r2.allocations.reduce((s, x) => s + x.amount, 0) + r2.unallocated;
    // كل تحصيل متّزن بذاته، والفوارق تتراكب على الخادم فيبلغ المجموع ٥٠٬٠٠٠
    expect(sum1).toBe(20000);
    expect(sum2).toBe(30000);
    expect(sum1 + sum2).toBe(50000);
  });
});
