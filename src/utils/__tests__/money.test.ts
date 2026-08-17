import { describe, it, expect } from 'vitest';
import { cashPortion, electronicPortion, sumByMethod, isCashMethod, CASH_METHOD } from '../paymentMethods';
import { aggregateSales, inventoryValue, abcAnalysis, coverage, topCustomers, customerBadge, deadStock } from '../decisionReports';
import { generateSchedule, planStatus } from '../installments';
import { Invoice, Product, Customer, MAIN_BRANCH_ID } from '../../types';

/**
 * حسابات المال — أخطر ما في النظام لأن خطأها **صامت**: لا ينهار شيء، بل يظهر رقم
 * خاطئ يبني عليه التاجر قرار شراء أو تسعير.
 *
 * القاعدة المحروسة هنا فوق كل شيء: **التكلفة غير المعروفة لا تُخمَّن أبداً** —
 * تُبوَّب منفصلة، ولا تتسرّب إلى الربح ولا إلى الربح الكامن.
 */

const inv = (o: Partial<Invoice>): Invoice => ({
  id: 'i', invoiceNumber: '1', customerName: 'زبون', totalAmount: 0, discount: 0, tax: 0,
  finalAmount: 0, date: '2026-08-01', type: 'general', items: [], ...o,
} as Invoice);

const prod = (o: Partial<Product>): Product => ({
  id: 'p', name: 'مادة', barcode: '', sellPrice: 0, quantity: 0, lowStockThreshold: 1,
  category: 'عام', unit: 'قطعة', createdAt: '', ...o,
} as Product);

describe('تقسيم الدفع: النقد في الدرج مقابل الإلكتروني', () => {
  it('فاتورة قديمة بلا payments تُحسب كاشاً كاملاً — صحيح تاريخياً', () => {
    expect(cashPortion(50000, undefined)).toBe(50000);
    expect(electronicPortion(50000, undefined)).toBe(0);
  });

  it('الدفع المقسّم يفصل الدرج عن البطاقة', () => {
    const payments = [{ method: CASH_METHOD, amount: 30000 }, { method: 'ماستر كارد', amount: 20000 }];
    expect(cashPortion(50000, payments)).toBe(30000);
    expect(electronicPortion(50000, payments)).toBe(20000);
  });

  it('النقد + الإلكتروني = المحصَّل دائماً', () => {
    const cases = [
      { paid: 90000, payments: [{ method: CASH_METHOD, amount: 40000 }, { method: 'زين كاش', amount: 50000 }] },
      { paid: 1000, payments: undefined },
      { paid: 7500, payments: [{ method: 'كي كارد', amount: 7500 }] },
    ];
    for (const c of cases) {
      expect(cashPortion(c.paid, c.payments) + electronicPortion(c.paid, c.payments)).toBe(c.paid);
    }
  });

  it('«كاش» وحدها تُعدّ نقداً — أي طريقة أخرى إلكترونية', () => {
    expect(isCashMethod(CASH_METHOD)).toBe(true);
    expect(isCashMethod('ماستر كارد')).toBe(false);
    expect(isCashMethod(undefined)).toBe(true); // غياب الطريقة = كاش (توافق رجعي)
  });

  it('التجميع حسب الطريقة يطابق مجموع المحصَّل', () => {
    const rows = [
      { paidAmount: 10000, payments: [{ method: CASH_METHOD, amount: 10000 }] },
      { paidAmount: 5000, payments: [{ method: 'فيزا', amount: 5000 }] },
      { paidAmount: 3000, payments: undefined },
    ];
    const m = sumByMethod(rows);
    expect([...m.values()].reduce((s, v) => s + v, 0)).toBe(18000);
    expect(m.get(CASH_METHOD)).toBe(13000);
  });
});

describe('الربح — ولا تخمين للتكلفة المجهولة', () => {
  const products = [
    prod({ id: 'p1', name: 'صوندة', sellPrice: 1000, quantity: 100, branchStock: { [MAIN_BRANCH_ID]: 100 } }),
    prod({ id: 'p2', name: 'سلك', sellPrice: 300, quantity: 500, branchStock: { [MAIN_BRANCH_ID]: 500 } }),
  ];
  const cost: Record<string, number | undefined> = { p1: 700, p2: undefined }; // p2 تكلفته مجهولة عمداً
  const buy = (p: Product) => cost[p.id];

  it('ربح البند = (سعر البيع − التكلفة) × الكمية', () => {
    const sales = aggregateSales(
      [inv({ items: [{ itemId: 'a', name: 'صوندة', productId: 'p1', quantity: 50, price: 1000, total: 50000 }] })],
      products, buy, buy,
    );
    expect(sales.get('p1')!.knownProfit).toBe(15000);
    expect(sales.get('p1')!.unknownRevenue).toBe(0);
  });

  it('🔴 التكلفة المجهولة لا تُخمَّن: صفر ربح ومبيعات مبوّبة منفصلة', () => {
    const sales = aggregateSales(
      [inv({ items: [{ itemId: 'b', name: 'سلك', productId: 'p2', quantity: 10, price: 300, total: 3000 }] })],
      products, buy, buy,
    );
    expect(sales.get('p2')!.knownProfit).toBe(0);
    expect(sales.get('p2')!.unknownRevenue).toBe(3000);
  });

  it('الخصم يُوزَّع تناسبياً على الربح لا يُهمَل', () => {
    const sales = aggregateSales(
      [inv({
        totalAmount: 50000, discount: 5000, // خصم ١٠٪
        items: [{ itemId: 'a', name: 'صوندة', productId: 'p1', quantity: 50, price: 1000, total: 50000 }],
      })],
      products, buy, buy,
    );
    expect(sales.get('p1')!.knownProfit).toBeCloseTo(15000 * 0.9, 5);
  });

  it('سطر الجملة يُحسب بتكلفة الجملة لا بتكلفة القطعة', () => {
    const wholesale = (p: Product) => (p.id === 'p1' ? 11000 : undefined); // كرتون بـ ١١٠٠٠
    const sales = aggregateSales(
      [inv({ items: [{ itemId: 'a', name: 'صوندة', productId: 'p1', quantity: 2, price: 13000, total: 26000, unitConversionQty: 12 }] })],
      products, buy, wholesale,
    );
    expect(sales.get('p1')!.knownProfit).toBe(2 * (13000 - 11000));
    expect(sales.get('p1')!.qty).toBe(24); // بوحدة الأساس
  });

  it('غياب تكلفة الجملة ⇒ غير محتسب حتى لو كانت تكلفة القطعة معروفة', () => {
    const noWholesale = () => undefined;
    const sales = aggregateSales(
      [inv({ items: [{ itemId: 'a', name: 'صوندة', productId: 'p1', quantity: 2, price: 13000, total: 26000, unitConversionQty: 12 }] })],
      products, buy, noWholesale,
    );
    expect(sales.get('p1')!.knownProfit).toBe(0);
    expect(sales.get('p1')!.unknownRevenue).toBe(26000);
  });
});

describe('قيمة المخزون والربح الكامن', () => {
  const products = [
    prod({ id: 'a', sellPrice: 1000, quantity: 100, branchStock: { [MAIN_BRANCH_ID]: 100 } }),
    prod({ id: 'b', sellPrice: 5000, quantity: 20, branchStock: { [MAIN_BRANCH_ID]: 20 } }),
    prod({ id: 'c', sellPrice: 300, quantity: 500, branchStock: { [MAIN_BRANCH_ID]: 500 } }), // بلا تكلفة
  ];
  const buy = (p: Product) => ({ a: 700, b: 3000 } as Record<string, number>)[p.id];

  it('رأس المال المجمّد يحسب معروفة التكلفة فقط', () => {
    const v = inventoryValue(products, buy, MAIN_BRANCH_ID);
    expect(v.costValue).toBe(100 * 700 + 20 * 3000);
    expect(v.unknownCostCount).toBe(1);
    expect(v.unknownCostSellValue).toBe(500 * 300);
  });

  it('🔴 الربح الكامن يستثني المواد مجهولة التكلفة — وإلا ظهر ربح وهمي', () => {
    const v = inventoryValue(products, buy, MAIN_BRANCH_ID);
    const knownSell = 100 * 1000 + 20 * 5000;
    expect(v.latentProfit).toBe(knownSell - v.costValue);
    // الخطأ الذي كان: sellValue الكامل − costValue ⇒ يضخّم بمقدار قيمة المجهولة
    expect(v.latentProfit).not.toBe(v.sellValue - v.costValue);
  });
});

describe('تحليل أ ب ج (٨٠/٢٠)', () => {
  it('يصنّف حسب النسبة التراكمية ويغطّي ١٠٠٪', () => {
    const sales = new Map([
      ['p1', { productId: 'p1', name: 'أ', unit: '', category: '', qty: 1, revenue: 200000, knownProfit: 0, unknownRevenue: 0, lastSaleDate: '', invoiceCount: 1 }],
      ['p2', { productId: 'p2', name: 'ب', unit: '', category: '', qty: 1, revenue: 50000, knownProfit: 0, unknownRevenue: 0, lastSaleDate: '', invoiceCount: 1 }],
      ['p3', { productId: 'p3', name: 'ج', unit: '', category: '', qty: 1, revenue: 20000, knownProfit: 0, unknownRevenue: 0, lastSaleDate: '', invoiceCount: 1 }],
    ]);
    const { rows, total, counts } = abcAnalysis(sales as any, 'revenue');
    expect(total).toBe(270000);
    /**
     * 🔴 تغيّر متعمَّد: التصنيف صار بالتراكم **قبل** المادة لا بعدها.
     *
     * كان هذا الاختبار يثبّت الحدّ القديم (`cumulative <= 80` بعد الإضافة)، وقد ثبت أنه
     * ينقلب عند الأطراف: مادة واحدة تصنع ١٠٠٪ من المبيعات كانت تُصنَّف **«ج»**، ومحلٌّ
     * بمادتين (٩٠٪ و١٠٪) لم يكن يحصل على **أي** مادة «أ».
     *
     * والقاعدة الصحيحة: المادة من «أ» إذا كان التراكم قبلها أقلّ من ٨٠٪ — أي أنها ما زالت
     * لازمة لبلوغ الـ٨٠. فهنا: «أ» عند ٠٪ و«ب» عند ٧٤٪ كلتاهما لازمتان للـ٨٠ (مجموعهما
     * ٩٢٫٦٪)، والثالثة تبدأ بعد الحدّ فتنزل لفئة «ب».
     */
    expect(rows.map(r => r.grade)).toEqual(['أ', 'أ', 'ب']);
    expect(rows[rows.length - 1].cumulative).toBeCloseTo(100, 5);
    expect(counts).toEqual({ أ: 2, ب: 1, ج: 0 });
  });

  it('يستبعد ما لا قيمة له (لا يلوّث التصنيف بأصفار)', () => {
    const sales = new Map([
      ['p1', { productId: 'p1', name: 'أ', unit: '', category: '', qty: 1, revenue: 100, knownProfit: 0, unknownRevenue: 0, lastSaleDate: '', invoiceCount: 1 }],
      ['p2', { productId: 'p2', name: 'ب', unit: '', category: '', qty: 0, revenue: 0, knownProfit: 0, unknownRevenue: 0, lastSaleDate: '', invoiceCount: 0 }],
    ]);
    expect(abcAnalysis(sales as any, 'revenue').rows).toHaveLength(1);
  });
});

describe('أيام التغطية والراكد', () => {
  it('التغطية = الرصيد ÷ متوسط البيع اليومي', () => {
    const products = [prod({ id: 'p1', quantity: 100, branchStock: { [MAIN_BRANCH_ID]: 100 } })];
    const sales = new Map([['p1', { productId: 'p1', name: '', unit: '', category: '', qty: 50, revenue: 0, knownProfit: 0, unknownRevenue: 0, lastSaleDate: '', invoiceCount: 1 }]]);
    const [row] = coverage(products, sales as any, MAIN_BRANCH_ID, 30);
    expect(row.avgPerDay).toBeCloseTo(50 / 30, 5);
    expect(Math.round(row.coverageDays!)).toBe(60);
  });

  it('بلا مبيعات ⇒ تغطية لا نهائية (null) لا قسمة على صفر', () => {
    const products = [prod({ id: 'p1', quantity: 100, branchStock: { [MAIN_BRANCH_ID]: 100 } })];
    const [row] = coverage(products, new Map() as any, MAIN_BRANCH_ID, 30);
    expect(row.coverageDays).toBeNull();
  });

  it('الراكد: رصيد موجب وصفر مبيعات — ورأس المال المجمّد بسعر الشراء', () => {
    const products = [
      prod({ id: 'p1', name: 'راكدة', quantity: 500, branchStock: { [MAIN_BRANCH_ID]: 500 } }),
      prod({ id: 'p2', name: 'متحرّكة', quantity: 10, branchStock: { [MAIN_BRANCH_ID]: 10 } }),
    ];
    const sales = new Map([['p2', { productId: 'p2', name: '', unit: '', category: '', qty: 5, revenue: 0, knownProfit: 0, unknownRevenue: 0, lastSaleDate: '', invoiceCount: 1 }]]);
    const rows = deadStock(products, sales as any, (p) => (p.id === 'p1' ? 200 : 100), MAIN_BRANCH_ID, '2026-08-05');
    expect(rows).toHaveLength(1);
    expect(rows[0].product.id).toBe('p1');
    expect(rows[0].frozenCapital).toBe(500 * 200);
  });

  it('الراكد بلا سعر شراء: يُعرض لكن رأس ماله غير محتسب — لا تخمين', () => {
    const products = [prod({ id: 'p1', quantity: 10, branchStock: { [MAIN_BRANCH_ID]: 10 } })];
    const rows = deadStock(products, new Map() as any, () => undefined, MAIN_BRANCH_ID, '2026-08-05');
    expect(rows[0].costKnown).toBe(false);
    expect(rows[0].frozenCapital).toBe(0);
  });
});

describe('تصنيف العملاء — «الأفضل» ليس الأكثر شراءً', () => {
  const cust = (o: Partial<Customer>): Customer => ({
    id: 'c', name: 'زبون', phone: '', address: '', notes: '', balance: 0, dueDate: '', createdAt: '', ...o,
  });

  it('يحسب المشتريات والمحصَّل ونسبة السداد', () => {
    const customers = [cust({ id: 'c1', name: 'أحمد' })];
    const invoices = [
      inv({ customerId: 'c1', customerName: 'أحمد', finalAmount: 100000, paidAmount: 60000 }),
      inv({ customerId: 'c1', customerName: 'أحمد', finalAmount: 50000, paidAmount: 50000 }),
    ];
    const [row] = topCustomers(customers, invoices, [], () => undefined, () => undefined, '2026-08-05');
    expect(row.purchases).toBe(150000);
    expect(row.collected).toBe(110000);
    expect(row.payRatio).toBeCloseTo(110000 / 150000, 5);
  });

  it('🔴 زبون بدين وسداد ضعيف = خطر ائتماني لا زبون مميّز', () => {
    const customers = [cust({ id: 'c1', name: 'خطر', balance: 500000 })];
    const invoices = [inv({ customerId: 'c1', customerName: 'خطر', finalAmount: 1000000, paidAmount: 100000 })];
    const [row] = topCustomers(customers, invoices, [], () => undefined, () => undefined, '2026-08-05');
    expect(customerBadge(row)).toBe('خطر ائتماني');
  });

  it('سداد كامل مع ربح = ذهبي', () => {
    const products = [prod({ id: 'p1', name: 'مادة', sellPrice: 1000 })];
    const customers = [cust({ id: 'c1', name: 'ذهبي' })];
    const invoices = [inv({
      customerId: 'c1', customerName: 'ذهبي', finalAmount: 10000, paidAmount: 10000,
      items: [{ itemId: 'a', name: 'مادة', productId: 'p1', quantity: 10, price: 1000, total: 10000 }],
    })];
    const [row] = topCustomers(customers, invoices, products, () => 700, () => 700, '2026-08-05');
    expect(row.profit).toBe(3000);
    expect(customerBadge(row)).toBe('ذهبي');
  });

  it('لم يشترِ منذ ٩٠ يوماً = مفقود', () => {
    const customers = [cust({ id: 'c1', name: 'مفقود' })];
    const invoices = [inv({ customerId: 'c1', customerName: 'مفقود', date: '2026-01-01', finalAmount: 1000, paidAmount: 1000 })];
    const [row] = topCustomers(customers, invoices, [], () => undefined, () => undefined, '2026-08-05');
    expect(customerBadge(row)).toBe('مفقود');
  });
});

describe('خطة التقسيط', () => {
  it('يوزّع المبلغ ويضع الباقي في القسط الأخير — لا يضيع دينار', () => {
    const sched = generateSchedule(100000, 3, 'monthly', '2026-08-05');
    expect(sched).toHaveLength(3);
    expect(sched.reduce((s, d) => s + d.amount, 0)).toBe(100000);
    expect(sched[2].amount).toBeGreaterThanOrEqual(sched[0].amount);
  });

  it('الحالة تُشتقّ من الفاتورة لا من دفتر ثانٍ', () => {
    const plan: any = { schedule: generateSchedule(90000, 3, 'monthly', '2026-01-01'), totalAmount: 90000, downPayment: 0 };
    const inv = (remaining: number) => ({ finalAmount: 90000, remainingAmount: remaining, paidAmount: 90000 - remaining });
    expect(planStatus(plan, inv(0)).isCompleted).toBe(true);   // الفاتورة سُدّدت ⇒ الخطة مكتملة
    expect(planStatus(plan, inv(90000)).isCompleted).toBe(false);
    expect(planStatus(plan, inv(30000)).remaining).toBe(30000);
  });
});
