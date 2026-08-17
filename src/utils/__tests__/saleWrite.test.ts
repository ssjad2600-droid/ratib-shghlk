import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { customerBalanceOps, saleOpCount, BATCH_LIMIT, BalanceInput, SalePlan } from '../saleWrite';
import { Invoice } from '../../types';

/**
 * 🔴 البيعة كانت أربع كتابات مستقلّة: الرصيد · الفاتورة · المخزون · مرآة الضمان.
 *
 * فرصيدٌ يزيد ٥٠٠ ألف بلا فاتورة تُسنده = دَينٌ لا سند له. أو فاتورةٌ بدين لا يظهر في
 * الرصيد = مالٌ ضائع من الدفتر. والانحراف صامت يظهر بعد أسابيع حين يقول الرصيد شيئاً
 * وتقول الفاتورة شيئاً آخر.
 */

const ops = (over: Partial<BalanceInput> = {}) => customerBalanceOps({
  isSameCustomer: true, oldRemaining: 0, delta: 0, foldDeferred: false, ...over,
});

describe('حركات الرصيد — نفس الزبون', () => {
  it('بيعٌ بدين ⟵ حركة واحدة موجبة', () => {
    expect(ops({ newCustomerId: 'c1', delta: 50000 })).toEqual([{ customerId: 'c1', delta: 50000 }]);
  });

  it('تعديل يُنقص الدين ⟵ حركة سالبة', () => {
    expect(ops({ newCustomerId: 'c1', delta: -20000 })).toEqual([{ customerId: 'c1', delta: -20000 }]);
  });

  it('بيعٌ نقدي (لا فرق) ⟵ لا حركة أصلاً', () => {
    expect(ops({ newCustomerId: 'c1', delta: 0 })).toEqual([]);
  });

  it('زبون عام بلا معرّف ⟵ لا حركة', () => {
    expect(ops({ delta: 50000 })).toEqual([]);
  });
});

describe('🔴 تبديل الزبون — أخطر حالة', () => {
  it('يعكس كامل الدين عن القديم ويطبّقه على الجديد **في نفس العملية**', () => {
    const r = ops({
      isSameCustomer: false, oldCustomerId: 'old', oldRemaining: 30000,
      newCustomerId: 'new', delta: 30000,
    });
    expect(r).toEqual([
      { customerId: 'old', delta: -30000 },
      { customerId: 'new', delta: 30000 },
    ]);
    expect(
      r.reduce((s, o) => s + o.delta, 0),
      'مجموع الحركات صفر: الدين انتقل ولم يُخلق ولم يُفنَ',
    ).toBe(0);
  });

  it('🔴 الفصل بينهما كان يترك ديناً معلّقاً على من لم يعد صاحب الفاتورة', () => {
    // لو نجح العكس وفشل التطبيق (كتابتان مستقلّتان) ⟵ الدين اختفى من الدفتر كلّه
    const r = ops({ isSameCustomer: false, oldCustomerId: 'old', oldRemaining: 30000, newCustomerId: 'new', delta: 30000 });
    expect(r).toHaveLength(2);
  });

  it('الزبون القديم بلا دين سابق ⟵ لا عكس', () => {
    const r = ops({ isSameCustomer: false, oldCustomerId: 'old', oldRemaining: 0, newCustomerId: 'new', delta: 40000 });
    expect(r).toEqual([{ customerId: 'new', delta: 40000 }]);
  });

  it('التحوّل إلى زبون عام ⟵ يُعكس القديم فقط', () => {
    expect(ops({ isSameCustomer: false, oldCustomerId: 'old', oldRemaining: 25000, delta: 25000 }))
      .toEqual([{ customerId: 'old', delta: -25000 }]);
  });
});

describe('🔴 دَين موظف غير مطوي — لا يُمسّ الرصيد إطلاقاً', () => {
  it('نفس الزبون ⟵ لا حركة', () => {
    expect(ops({ newCustomerId: 'c1', delta: 90000, foldDeferred: true })).toEqual([]);
  });

  it('تبديل الزبون ⟵ لا حركة، ولا حتى عكس القديم', () => {
    expect(
      ops({ isSameCustomer: false, oldCustomerId: 'old', oldRemaining: 90000, newCustomerId: 'new', delta: 90000, foldDeferred: true }),
      'الطي يضيف الدين لاحقاً بالقيمة النهائية — أي مسٍّ هنا يُضاعفه',
    ).toEqual([]);
  });
});

describe('حدّ الدفعة', () => {
  const inv = (serials: string[][] = []): Invoice => ({
    id: 'i1', invoiceNumber: 'INV-1', customerName: 'ز', totalAmount: 0, discount: 0, tax: 0,
    finalAmount: 0, paidAmount: 0, remainingAmount: 0, date: '2026-08-17', createdAt: 1,
    type: 'general',
    items: serials.map((s, n) => ({ name: `م${n}`, quantity: 1, price: 1, total: 1, serials: s })),
  } as unknown as Invoice);

  const plan = (over: Partial<SalePlan> = {}): SalePlan =>
    ({ invoice: inv(), balanceOps: [], ...over });

  it('فاتورة بسيطة ⟵ عملية واحدة', () => {
    expect(saleOpCount(plan())).toBe(1);
  });

  it('يعدّ الزبون الجديد ومرآته وحركات الرصيد', () => {
    expect(saleOpCount(plan({
      balanceOps: [{ customerId: 'a', delta: 1 }, { customerId: 'b', delta: -1 }],
      newCustomer: { id: 'c', name: 'ز' } as never,
    }))).toBe(2 + 2 + 1);
  });

  it('🔴 يعدّ السيريالات بنفس الدالة التي تكتبها — لا بتقدير يفترق عنها', () => {
    expect(saleOpCount(plan({ invoice: inv([['s1', 's2'], ['s3']]) }))).toBe(1 + 3);
  });

  it('والمحذوفة تُحسب أيضاً', () => {
    expect(saleOpCount(plan({ removedSerialKeys: ['x', 'y'] }))).toBe(1 + 2);
  });

  it('الحدّ هو حدّ فايرستور المعلن', () => {
    expect(BATCH_LIMIT).toBe(500);
  });
});

/**
 * 🔴 حارس: البيعة ذرّية، والمخزون **يبقى منفصلاً عمداً**.
 */
describe('حارس: كتابة البيعة', () => {
  const root = join(process.cwd(), 'src');
  const strip = (s: string) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const view = strip(readFileSync(join(root, 'components', 'InvoicesView.tsx'), 'utf8'));
  const util = strip(readFileSync(join(root, 'utils', 'saleWrite.ts'), 'utf8'));
  const emp = strip(readFileSync(join(root, 'components', 'EmployeeInvoicesView.tsx'), 'utf8'));

  it('المسح يرى الملفات فعلاً', () => {
    expect(view).toContain('handleSubmitForm');
    expect(util).toContain('stageSale');
    expect(emp).toContain('invoiceBatch');
  });

  it('🔴 مسارا الإنشاء والتعديل يمرّان من الدفعة الذرّية', () => {
    expect((view.match(/stageSale\(saleBatch/g) ?? []).length).toBe(2);
  });

  it('🔴 لا كتابة مباشرة لرصيد الزبون خارج الدفعة', () => {
    expect(
      /updateDoc\(doc\(db, 'users', uid, 'customers'[\s\S]{0,80}balance: increment/.test(view),
      'كتابة الرصيد وحدها تُعيد الانحراف: رصيدٌ يزيد بلا فاتورة تُسنده',
    ).toBe(false);
  });

  it('🔴 الفاتورة لا تُحفظ عبر useCollection.save بعد الآن', () => {
    expect(
      /await saveInvoice\(/.test(view),
      'الحفظ المنفصل يُخرج الفاتورة من ذرّية البيعة',
    ).toBe(false);
  });

  it('🔴 الرصيد بـincrement لا بقيمة مطلقة', () => {
    expect(/balance: increment\(op\.delta\)/.test(util)).toBe(true);
  });

  it('🛡️ المخزون **ليس** في دفعة البيعة — درسٌ مكتوب بثمنه', () => {
    expect(
      /products/.test(util),
      'ضمّ المخزون يُعيد علّة أخطر: منتجٌ محذوف يُفشل الدفعة عند المزامنة ⟵ تختفي الفاتورة بصمت',
    ).toBe(false);
    expect(
      /syncInventory\(/.test(view),
      'المخزون يبقى مساراً مستقلاً كما في شاشة الموظف',
    ).toBe(true);
  });

  it('🔴 وفشل الدفعة يُعرض للتاجر (لا يُبتلع)', () => {
    expect(/guardWrite\(saleBatch\.commit\(\)/.test(view)).toBe(true);
  });

  it('🟠 تجاوز حدّ الدفعة يُقال بدل أن يفشل الحفظ بلا تفسير', () => {
    expect((view.match(/saleOpCount\(plan\) > BATCH_LIMIT/g) ?? []).length).toBe(2);
  });

  it('🔧 حسم الهوية لا يكتب شيئاً', () => {
    expect(/const resolveSaleCustomer = \(/.test(view)).toBe(true);
    expect(
      /applyDebtDelta/.test(view),
      'الدالة القديمة كانت تكتب الرصيد وتُنشئ الزبون خارج الدفعة',
    ).toBe(false);
  });

  it('🔴 الزبون الجديد يُنشأ برصيد صفر — والدين من balanceOps وحدها', () => {
    expect(
      /balance: foldDeferred \? 0 : delta/.test(view),
      'قيمة ابتدائية غير صفرية مع increment في نفس الدفعة تحتسب الدين مرّتين',
    ).toBe(false);
    expect(/balance: 0,/.test(view)).toBe(true);
  });
});
