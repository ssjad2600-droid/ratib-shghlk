import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  allocatePurchaseNumber, duplicatePurchaseNumbers, PURCHASE_PREFIX,
  blankFormItem, amountOf, lineTotal, validFormItems, buildInvoiceItem,
  purchaseTotals, paymentTypeOf, costAfterCancelling, cancellationShortages,
  PurchaseFormItem,
} from '../purchaseInvoice';
import { PurchaseInvoice, PurchaseInvoiceItem } from '../../types';

/**
 * 🔴 فواتير الشراء — ثلاث علل قِسْتُها في الشاشة الحيّة، كلها تمسّ المال.
 */

const item = (over: Partial<PurchaseFormItem> = {}): PurchaseFormItem =>
  ({ ...blankFormItem(), productName: 'مادة', ...over });

describe('🔴 الرقم لم يكن يتقدّم أبداً', () => {
  const inv = (invoiceNumber: string, deviceTag?: string) => ({ invoiceNumber, deviceTag });

  it('التجريد القديم بـ\\d يمحو الأرقام العربية — هذا أصل العلّة', () => {
    // البرهان على السبب: `\d` لا تطابق إلا 0-9 اللاتينية
    expect('P-١٠٠١'.replace(/[^\d]/g, '')).toBe('');
    expect(parseInt('', 10)).toBeNaN();
  });

  it('🔴 الرقم يتقدّم فعلاً مع أرقام مخزَّنة عربية', () => {
    expect(allocatePurchaseNumber([])).toBe('P-١٠٠١');
    expect(allocatePurchaseNumber([inv('P-١٠٠١')])).toBe('P-١٠٠٢');
    expect(allocatePurchaseNumber([inv('P-١٠٠١'), inv('P-١٠٠٢')])).toBe('P-١٠٠٣');
  });

  it('يقرأ اللاتيني أيضاً (رقم كتبه المستخدم يدوياً)', () => {
    expect(allocatePurchaseNumber([inv('P-1005')])).toBe('P-١٠٠٦');
  });

  it('الأرضية ١٠٠٠ محفوظة — لا تختلف أرقام حسابٍ قائم', () => {
    expect(allocatePurchaseNumber([inv('P-٥')])).toBe('P-١٠٠١');
  });

  it('الحذف لا يُعيد استعمال رقم', () => {
    expect(allocatePurchaseNumber([inv('P-١٠٠١'), inv('P-١٠٠٣')])).toBe('P-١٠٠٤');
  });

  it('التالف لا يُوقف التسلسل', () => {
    expect(allocatePurchaseNumber([inv('P-١٠٠٢'), inv('خربان'), inv('')])).toBe('P-١٠٠٣');
  });

  it('جهاز ثانٍ ⇒ يوسم الطرفان', () => {
    const data = [inv('P-١٠٠١', '73'), inv('P-١٠٠٢', '16')];
    expect(allocatePurchaseNumber(data, '73')).toBe('P-١٠٠٣/٧٣');
    expect(allocatePurchaseNumber(data, '16')).toBe('P-١٠٠٣/١٦');
  });

  it('جهاز واحد ⇒ لا وسم إطلاقاً', () => {
    expect(allocatePurchaseNumber([inv('P-١٠٠١', '73')], '73')).toBe('P-١٠٠٢');
  });

  it('الرقم المُصدَر لم يكن مستعملاً — خاصيّة على أشكال مختلفة', () => {
    const shapes = [[], [inv('P-١٠٠١')], [inv('P-١٠٠١'), inv('P-١٠٠١')], [inv('P-2000')], [inv('تالف')]];
    for (const list of shapes) {
      const issued = allocatePurchaseNumber(list, '73');
      expect(list.map(x => x.invoiceNumber), `أُعيد ${issued}`).not.toContain(issued);
    }
  });

  it('يكشف التكرار الذي وقع قبل الإصلاح (كل الفواتير P-١٠٠١)', () => {
    const dups = duplicatePurchaseNumbers([inv('P-١٠٠١'), inv('P-١٠٠١'), inv('P-١٠٠١')]);
    expect(dups).toEqual([{ number: 'P-١٠٠١', count: 3 }]);
  });

  it('البادئة ثابتة', () => expect(PURCHASE_PREFIX).toBe('P-'));
});

describe('🔴 قراءة المبالغ — parseFloat كانت تُفسدها', () => {
  it('الأرقام العربية تُقرأ صحيحةً', () => {
    expect(amountOf('٥٠٠٠')).toBe(5000);
    expect(parseFloat('٥٠٠٠'), 'هذا ما كان يحدث: NaN ⟵ صفر').toBeNaN();
  });

  it('🔴 المختلط `5٠٠٠` كان يُقرأ ٥ بصمت — أقلّ بألف مرّة', () => {
    expect(parseFloat('5٠٠٠')).toBe(5);
    expect(amountOf('5٠٠٠')).toBe(5000);
    expect(amountOf('50٠٠')).toBe(5000);
  });

  it('الكسور والفواصل', () => {
    expect(amountOf('١٫٥')).toBeCloseTo(1.5);
    expect(amountOf('1,500')).toBe(1500);
  });

  it('التالف والسالب يُعدّان صفراً لا NaN', () => {
    for (const bad of ['', 'أبجد', '-5', '   ']) expect(amountOf(bad)).toBe(0);
  });

  it('إجمالي السطر من النصوص الخام', () => {
    expect(lineTotal(item({ quantity: '١٠', buyPrice: '٥٠٠٠' }))).toBe(50000);
  });
});

describe('البنود الصالحة', () => {
  it('السعر صفراً مسموح — هدية أو عيّنة من المورد', () => {
    expect(validFormItems([item({ quantity: '5', buyPrice: '' })])).toHaveLength(1);
  });

  it('بلا اسم أو بكمية صفر ⇒ يُسقَط', () => {
    expect(validFormItems([
      item({ productName: '  ', quantity: '5' }),
      item({ quantity: '0' }),
      item({ quantity: 'أبجد' }),
    ])).toHaveLength(0);
  });
});

describe('🔴 بناء البند لا يكتب undefined — وهو ما كان يُفشل الحفظ كلّه', () => {
  const hasUndefined = (o: object) => Object.values(o).some(v => v === undefined);

  it('بند حرّ بلا منتج: المفتاح يُسقَط لا يُكتب فارغاً', () => {
    const built = buildInvoiceItem(item({ productName: 'مادة حرة', quantity: '2', buyPrice: '100' }));
    expect('productId' in built, 'productId: undefined كان يرمي Unsupported field value').toBe(false);
    expect(hasUndefined(built)).toBe(false);
    expect(built).toMatchObject({ productName: 'مادة حرة', quantity: 2, buyPrice: 100, total: 200 });
  });

  it('منتج بلا سعر جملة: المفتاح يُسقَط', () => {
    const built = buildInvoiceItem(item({ productId: 'p1', quantity: '1', buyPrice: '50', wholesaleUnitPrice: '' }));
    expect('wholesaleUnitPrice' in built).toBe(false);
    expect(hasUndefined(built)).toBe(false);
  });

  it('المعروف يُكتب', () => {
    const built = buildInvoiceItem(item({
      productId: 'p1', unitName: 'قطعة', expiryDate: '2027-01-01',
      quantity: '٣', buyPrice: '١٠٠٠', wholesaleUnitPrice: '٩٠٠',
    }));
    expect(built).toMatchObject({
      productId: 'p1', unitName: 'قطعة', expiryDate: '2027-01-01',
      quantity: 3, buyPrice: 1000, wholesaleUnitPrice: 900, total: 3000,
    });
  });

  it('🔴 خاصيّة: لا يخرج `undefined` من هذا البنّاء أبداً', () => {
    const combos: PurchaseFormItem[] = [
      item(), item({ productId: 'p' }), item({ unitName: 'كغم' }),
      item({ expiryDate: '2027-01-01' }), item({ wholesaleUnitPrice: '5' }),
      item({ quantity: 'أبجد', buyPrice: 'أبجد' }),
    ];
    for (const c of combos) expect(hasUndefined(buildInvoiceItem(c)), JSON.stringify(c)).toBe(false);
  });
});

describe('🟠 الدفع الزائد كان يتبخّر', () => {
  const items = [item({ quantity: '1', buyPrice: '1000' })];

  it('دفعٌ ناقص ⇒ دين على المحل', () => {
    const t = purchaseTotals(items, '', '', '400');
    expect(t).toMatchObject({ finalTotal: 1000, remaining: 600, overpaid: 0, supplierDelta: 600 });
  });

  it('🔴 دفعٌ زائد ⇒ رصيد لنا عند المورد لا صفر صامت', () => {
    const t = purchaseTotals(items, '', '', '1500');
    expect(t.remaining, 'Math.max(0,…) كانت تُخفي الزيادة').toBe(0);
    expect(t.overpaid).toBe(500);
    expect(t.supplierDelta, 'الأثر بالإشارة — سالب = لنا عنده').toBe(-500);
  });

  it('الخصم والضريبة بأرقام عربية', () => {
    const t = purchaseTotals(items, '١٠٠', '٥٠', '٠');
    expect(t.finalTotal).toBe(950);
  });

  it('الخصم الأكبر من المجموع لا يُنتج إجمالياً سالباً', () => {
    expect(purchaseTotals(items, '99999', '', '').finalTotal).toBe(0);
  });

  it('نوع الدفع مشتقّ لا محفوظ', () => {
    expect(paymentTypeOf(1000, 0)).toBe('credit');
    expect(paymentTypeOf(1000, 400)).toBe('partial');
    expect(paymentTypeOf(1000, 1000)).toBe('cash');
    expect(paymentTypeOf(1000, 1500)).toBe('cash');
  });
});

describe('🟠 التكلفة بعد الإلغاء', () => {
  const inv = (id: string, createdAt: number, buyPrice: number, status = 'received'): PurchaseInvoice => ({
    id, invoiceNumber: id, supplierId: 's', supplierName: 'س', date: '2026-08-01',
    subtotal: 0, discount: 0, tax: 0, total: 0, paidAmount: 0, remainingAmount: 0,
    paymentType: 'cash', notes: '', status, createdAt,
    items: [{ productId: 'p1', productName: 'م', quantity: 1, buyPrice, total: buyPrice }],
  } as PurchaseInvoice);

  it('تعود إلى سعر أحدث فاتورة مستلَمة أخرى', () => {
    const list = [inv('a', 1, 700), inv('b', 2, 900), inv('c', 3, 1200)];
    expect(costAfterCancelling(list, 'c', 'p1')).toEqual({ buyPrice: 900 });
  });

  it('الملغاة لا تصلح مرجعاً', () => {
    const list = [inv('a', 1, 700), inv('b', 2, 900, 'cancelled'), inv('c', 3, 1200)];
    expect(costAfterCancelling(list, 'c', 'p1')).toEqual({ buyPrice: 700 });
  });

  it('🔴 بلا مرجع ⇒ null لا صفر (صفرٌ يجعل كل بيع ربحاً كاملاً)', () => {
    expect(costAfterCancelling([inv('c', 3, 1200)], 'c', 'p1')).toBeNull();
  });

  it('مادة لا تظهر في فواتير أخرى ⇒ null', () => {
    expect(costAfterCancelling([inv('a', 1, 700)], 'c', 'مادة-أخرى')).toBeNull();
  });
});

describe('🔴 الإلغاء لا يجعل الرصيد سالباً', () => {
  const it1 = (productId: string, quantity: number): PurchaseInvoiceItem =>
    ({ productId, productName: productId, quantity, buyPrice: 1, total: quantity });

  it('البضاعة بِيعت بعد الاستلام ⇒ يُكشف النقص', () => {
    const out = cancellationShortages([it1('p1', 50)], () => 20);
    expect(out).toEqual([{ productId: 'p1', name: 'p1', needed: 50, available: 20 }]);
  });

  it('المخزون كافٍ ⇒ لا مانع', () => {
    expect(cancellationShortages([it1('p1', 50)], () => 50)).toEqual([]);
  });

  it('🔴 بندان لنفس المادة يُجمعان — كلٌّ وحده كافٍ ومجموعهما لا', () => {
    const out = cancellationShortages([it1('p1', 30), it1('p1', 30)], () => 50);
    expect(out[0], 'الفحص لكل سطر وحده يمرّر خصماً يتجاوز الرصيد').toMatchObject({ needed: 60, available: 50 });
  });

  it('مادة محذوفة ليست نقصاً', () => {
    expect(cancellationShortages([it1('p1', 50)], () => null)).toEqual([]);
  });

  it('بند حرّ بلا منتج يُتجاهل', () => {
    expect(cancellationShortages([{ productName: 'حر', quantity: 5, buyPrice: 1, total: 5 }], () => 0)).toEqual([]);
  });
});

/**
 * 🔴 حارس: الشاشة تستعمل المنطق الصحيح — والخطأ الواقعي هو النسيان.
 */
describe('حارس: شاشة فواتير الشراء', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'components', 'PurchaseInvoicesView.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import .*$/gm, '');
  const fb = readFileSync(join(process.cwd(), 'src', 'firebase.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('المسح يرى الملفات فعلاً', () => {
    expect(src).toContain('PurchaseInvoice');
    expect(fb).toContain('initializeFirestore');
  });

  it('🔴 شبكة الأمان: undefined يُتجاهل ولا يُفشل الكتابة', () => {
    expect(
      /ignoreUndefinedProperties:\s*true/.test(fb),
      'حقل undefined يرمي متزامناً فيقفز فوق رسالة النجاح: التاجر يضغط «حفظ» ولا يحدث شيء',
    ).toBe(true);
  });

  it('🔴 لا `parseFloat` على أي مبلغ أو كمية', () => {
    expect(
      /parseFloat\(/.test(src),
      '`٥٠٠٠` تصير صفراً و`5٠٠٠` تصير ٥ بصمت — وهذا سعر الشراء الذي يُبنى عليه كل حساب ربح',
    ).toBe(false);
  });

  it('🔴 الترقيم لا يجرّد بـ\\d ويمرّ من المخصّص', () => {
    expect(
      /replace\(\/\[\^\\d\]\/g/.test(src),
      'التجريد يمحو الأرقام العربية فيبقى العدّاد ثابتاً وكل فاتورة تأخذ P-١٠٠١',
    ).toBe(false);
    expect(/allocatePurchaseNumber\(/.test(src)).toBe(true);
  });

  it('🔴 البنود تُبنى بالبنّاء الذي يُسقط المجهول', () => {
    expect(/formItems\.map\(buildInvoiceItem\)/.test(src)).toBe(true);
  });

  it('🔴 الإلغاء يفحص النقص ويُبطل شحنات الصلاحية ويُعيد التكلفة', () => {
    expect(/cancellationShortages\(/.test(src), 'الإلغاء يخصم بلا فحص ⇒ رصيد سالب').toBe(true);
    expect(/purchaseInvoiceId === inv\.id/.test(src), 'شحنات تُنذر عن بضاعة أُلغي استلامها').toBe(true);
    expect(/costAfterCancelling\(/.test(src), 'تكلفة فاتورة ملغاة تبقى أساساً لحساب الربح').toBe(true);
  });

  it('🟠 رصيد المورد يُكتب بالإشارة لا بالباقي الموجب وحده', () => {
    expect(
      /increment\(supplierDelta\)/.test(src),
      'الدفع الزائد يتبخّر: لا دين عليه ولا رصيد لنا عنده',
    ).toBe(true);
  });

  it('🟡 المسارات من مصدر واحد لا actor.uid', () => {
    expect(
      /'users',\s*actor\.uid/.test(src),
      'يكتب في شجرة الموظف يوم تُفتح الشاشة لموظف',
    ).toBe(false);
  });
});
