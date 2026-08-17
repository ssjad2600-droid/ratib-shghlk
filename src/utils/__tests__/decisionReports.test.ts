import { describe, it, expect } from 'vitest';
import {
  aggregateSales, deadStock, lastSaleMap, daysBetween, inventoryValue,
  inventoryByCategory, coverage, topCustomers, customerBadge, abcAnalysis,
  CustomerRow,
} from '../decisionReports';
import { Invoice, Product, Customer } from '../../types';

/**
 * محرّك تقارير القرار — كان ٣٧١ سطراً من الحساب الخالص **بلا اختبار واحد**، وهو أنسب
 * ملفات المشروع للاختبار (دوالّ نقيّة بلا واجهة ولا Firestore).
 *
 * وعلل هذا الملف من صنفٍ خاص: ليست كتابةً خاطئة ولا فرعاً منسيّاً، بل **حدودٌ تنقلب عند
 * الأطراف** — وهي أخطر ما يكون في شاشة مخرجاتها **أوصاف** يبني عليها التاجر تصرّفاً:
 * يهمل مادة، أو يمنع الآجل عن زبون وفيّ.
 */

const prod = (id: string, over: Partial<Product> = {}): Product => ({
  id, name: id, barcode: '', category: 'عام', unit: 'قطعة',
  sellPrice: 10_000, quantity: 0, lowStockThreshold: 1,
  createdAt: '2026-01-01', hasWholesale: false, ...over,
} as Product);

const inv = (over: Partial<Invoice> = {}): Invoice => ({
  id: 'i1', invoiceNumber: '1', customerName: 'نقدي', totalAmount: 0, discount: 0, tax: 0,
  finalAmount: 0, date: '2026-08-01', type: 'retail', items: [],
  ...over,
} as Invoice);

const line = (productId: string, quantity: number, price: number, unitConversionQty?: number) =>
  ({ itemId: productId, productId, name: productId, quantity, price, unitConversionQty } as Invoice['items'][number]);

const costs = (m: Record<string, number>) => (p: Product) => m[p.id];
const noCost = () => undefined;

/* ═══════════════════════════ تجميع المبيعات ═══════════════════════════ */

describe('تجميع المبيعات', () => {
  const products = [prod('حليب')];

  it('يجمع الكمية والقيمة والربح', () => {
    const m = aggregateSales(
      [inv({ totalAmount: 100_000, finalAmount: 100_000, items: [line('حليب', 10, 10_000)] })],
      products, costs({ حليب: 6_000 }), noCost,
    );
    const a = m.get('حليب')!;
    expect(a.qty).toBe(10);
    expect(a.revenue).toBe(100_000);
    expect(a.knownProfit).toBe(40_000);
    expect(a.unknownRevenue).toBe(0);
  });

  it('🔴 التكلفة المجهولة تُبوَّب ولا تُخمَّن', () => {
    const m = aggregateSales(
      [inv({ totalAmount: 100_000, finalAmount: 100_000, items: [line('حليب', 10, 10_000)] })],
      products, noCost, noCost,
    );
    const a = m.get('حليب')!;
    expect(a.knownProfit, 'صفرٌ للتكلفة يجعل كل البيع ربحاً').toBe(0);
    expect(a.unknownRevenue).toBe(100_000);
  });

  it('الخصم يُوزَّع تناسبياً على الربح والقيمة', () => {
    const m = aggregateSales(
      [inv({ totalAmount: 100_000, discount: 10_000, finalAmount: 90_000, items: [line('حليب', 10, 10_000)] })],
      products, costs({ حليب: 6_000 }), noCost,
    );
    const a = m.get('حليب')!;
    expect(a.revenue).toBe(90_000);
    expect(a.knownProfit).toBe(36_000);
  });

  it('سطر الجملة: الكمية بوحدة الأساس والتكلفة تكلفة الجملة', () => {
    const m = aggregateSales(
      [inv({ totalAmount: 750_000, finalAmount: 750_000, items: [line('حليب', 3, 250_000, 30)] })],
      products, costs({ حليب: 6_000 }), costs({ حليب: 200_000 }),
    );
    const a = m.get('حليب')!;
    expect(a.qty, '٣ كراتين × ٣٠ = ٩٠ قطعة').toBe(90);
    expect(a.knownProfit).toBe(150_000);
  });

  it('🟠 عدّاد الفواتير يعدّ فواتير لا أسطر', () => {
    const m = aggregateSales(
      [inv({ totalAmount: 200_000, finalAmount: 200_000, items: [line('حليب', 10, 10_000), line('حليب', 10, 10_000)] })],
      products, costs({ حليب: 6_000 }), noCost,
    );
    expect(
      m.get('حليب')!.invoiceCount,
      'مادة تظهر سطرين في فاتورة واحدة كانت تُحسب فاتورتين — الاسم يَعِد بشيء والقيمة شيء آخر',
    ).toBe(1);
  });

  it('البند الحرّ بلا منتج مسجَّل لا يدخل تقارير المنتجات', () => {
    const m = aggregateSales(
      [inv({ items: [line('شبح', 5, 1_000)] })],
      products, costs({}), noCost,
    );
    expect(m.size).toBe(0);
  });
});

/* ═══════════════════════════ الراكد وقيمة المخزون ═══════════════════════════ */

describe('الأصناف الراكدة', () => {
  it('ما له رصيد ولم يُبَع في المدّة = راكد، ورأس ماله بسعر الشراء', () => {
    const products = [prod('راكد', { quantity: 10 }), prod('نشط', { quantity: 5 })];
    const sales = aggregateSales(
      [inv({ items: [line('نشط', 2, 10_000)] })], products, costs({}), noCost,
    );
    const rows = deadStock(products, sales, costs({ راكد: 7_000 }), undefined, '2026-08-17');
    expect(rows.map(r => r.product.id)).toEqual(['راكد']);
    expect(rows[0].frozenCapital, 'بسعر الشراء لا البيع — هو المال الذي دفعتَه ونام').toBe(70_000);
  });

  it('ما لا رصيد له ليس راكداً (لا مال مجمّد فيه)', () => {
    const products = [prod('نافد', { quantity: 0 })];
    expect(deadStock(products, new Map(), costs({}), undefined, '2026-08-17')).toEqual([]);
  });

  it('التكلفة المجهولة تُعلَن ولا تُحتسب رأس مال', () => {
    const products = [prod('مجهول', { quantity: 10 })];
    const rows = deadStock(products, new Map(), noCost, undefined, '2026-08-17');
    expect(rows[0].frozenCapital).toBe(0);
    expect(rows[0].costKnown, 'الصفر هنا يجب أن يُقرأ «غير معروف» لا «بلا قيمة»').toBe(false);
  });
});

describe('قيمة المخزون', () => {
  const products = [prod('معروف', { quantity: 10, sellPrice: 10_000 }), prod('مجهول', { quantity: 5, sellPrice: 20_000 })];
  const buyPriceOf = costs({ معروف: 6_000 });

  it('🔴 الربح الكامن على معروفة التكلفة فقط', () => {
    const v = inventoryValue(products, buyPriceOf, undefined);
    expect(v.costValue).toBe(60_000);
    expect(v.sellValue).toBe(200_000);
    expect(v.unknownCostSellValue).toBe(100_000);
    expect(v.latentProfit, 'لولا الاستثناء لظهر ربح وهمي بقيمة المجهول كاملة').toBe(40_000);
  });

  it('🔴 التجميع حسب الفئة يُعلن المجهول ولا يبتلعه صفراً', () => {
    const rows = inventoryByCategory(products, buyPriceOf, undefined);
    const row = rows[0];
    expect(row.costValue).toBe(60_000);
    expect(
      row.unknownCostCount,
      'فئة بلا أسعار شراء كانت تُعرض برأس مال صفر — كأنها لا تحوي مالاً، ولا عدّاد ينبّه',
    ).toBe(1);
    expect(row.unknownCostUnits).toBe(5);
  });
});

/* ═══════════════════════════ التغطية ═══════════════════════════ */

describe('أيام التغطية', () => {
  const products = [prod('سريع', { quantity: 30 })];

  it('الرصيد ÷ متوسط البيع اليومي', () => {
    const sales = aggregateSales(
      [inv({ items: [line('سريع', 30, 1_000)] })], products, costs({}), noCost,
    );
    const r = coverage(products, sales, undefined, 30)[0];
    expect(r.avgPerDay).toBe(1);
    expect(r.coverageDays, 'تكفي ٣٠ يوماً').toBe(30);
  });

  it('بلا مبيعات ⇒ تغطية غير منتهية (راكد) لا صفر', () => {
    const r = coverage(products, new Map(), undefined, 30)[0];
    expect(r.coverageDays, 'صفرٌ هنا يعني «ينفد اليوم» — عكس الحقيقة تماماً').toBeNull();
  });

  it('🟠 الدوران محسوب على الرصيد الحالي ⇒ يُحرَس من القيم الشاذّة', () => {
    const almostOut = [prod('نادر', { quantity: 1 })];
    const sales = aggregateSales(
      [inv({ items: [line('نادر', 500, 1_000)] })], almostOut, costs({}), noCost,
    );
    const r = coverage(almostOut, sales, undefined, 30)[0];
    expect(r.turnover, 'رصيد ١ ومبيعات ٥٠٠ تُنتج ٥٠٠ فتتصدّر أي ترتيب وتُربك القراءة').toBeLessThanOrEqual(99);
  });
});

/* ═══════════════════════════ العملاء ═══════════════════════════ */

const cust = (id: string, name: string, balance = 0): Customer =>
  ({ id, name, phone: '', address: '', notes: '', balance, createdAt: '2026-01-01' } as Customer);

describe('أفضل العملاء', () => {
  it('يجمع المشتريات والمحصَّل ونسبة السداد', () => {
    const rows = topCustomers(
      [cust('c1', 'أحمد')],
      [inv({ customerId: 'c1', totalAmount: 100_000, finalAmount: 100_000, paidAmount: 80_000, items: [] })],
      [], costs({}), noCost, '2026-08-17',
    );
    expect(rows[0].purchases).toBe(100_000);
    expect(rows[0].collected).toBe(80_000);
    expect(rows[0].payRatio).toBeCloseTo(0.8);
  });

  it('🟠 زبونان بنفس الاسم لا يبتلع أحدهما فواتير الآخر', () => {
    const rows = topCustomers(
      [cust('c1', 'محمد علي'), cust('c2', 'محمد علي')],
      [inv({ customerId: 'c1', finalAmount: 100_000, paidAmount: 100_000 })],
      [], costs({}), noCost, '2026-08-17',
    );
    const c1 = rows.find(r => r.customer.id === 'c1')!;
    const c2 = rows.find(r => r.customer.id === 'c2')!;
    expect(c1.purchases, 'المطابقة بالاسم كانت تنسب فواتير الأول للثاني').toBe(100_000);
    expect(c2.purchases).toBe(0);
  });

  it('المطابقة بالاسم تبقى للفواتير القديمة بلا معرّف', () => {
    const rows = topCustomers(
      [cust('c1', 'أحمد')],
      [inv({ customerName: 'أحمد', finalAmount: 50_000, paidAmount: 50_000 })],
      [], costs({}), noCost, '2026-08-17',
    );
    expect(rows[0].purchases).toBe(50_000);
  });
});

describe('🔴 تصنيف الزبون', () => {
  const row = (over: Partial<CustomerRow>): CustomerRow => ({
    customer: cust('c1', 'أحمد'), purchases: 0, collected: 0, profit: 0, unknownProfitSales: 0,
    debt: 0, payRatio: null, invoiceCount: 0, lastPurchase: '', daysSincePurchase: null,
    ...over,
  } as CustomerRow);

  it('🔴 مدينٌ لم يشترِ خلال الفترة **ليس** خطراً ائتمانياً', () => {
    // نفس الزبون: بفترة ٩٠ يوماً «ذهبي»، وبـ٣٠ يوماً كان يصير «خطر ائتماني».
    // زرُّ فترةٍ لا يغيّر أخلاق الزبون — والوصف يُبنى عليه قرار منع الآجل.
    const quiet = row({ debt: 50_000, invoiceCount: 0 });
    expect(customerBadge(quiet)).not.toBe('خطر ائتماني');
  });

  it('الخطر الائتماني الحقيقي: دينٌ مع سدادٍ ضعيف مُثبَت', () => {
    expect(customerBadge(row({ debt: 50_000, invoiceCount: 3, payRatio: 0.2, daysSincePurchase: 5 })))
      .toBe('خطر ائتماني');
  });

  it('الوفيّ الرابح = ذهبي', () => {
    expect(customerBadge(row({ invoiceCount: 3, payRatio: 0.95, profit: 9_000, daysSincePurchase: 5 })))
      .toBe('ذهبي');
  });

  it('من انقطع طويلاً = مفقود', () => {
    expect(customerBadge(row({ invoiceCount: 2, payRatio: 1, daysSincePurchase: 120 }))).toBe('مفقود');
  });

  it('من لا فواتير له ولا دين = جديد', () => {
    expect(customerBadge(row({}))).toBe('جديد');
  });
});

/* ═══════════════════════════ أ ب ج ═══════════════════════════ */

describe('🔴 تحليل أ ب ج — الحدود', () => {
  const salesOf = (values: number[]) => {
    const products = values.map((_, i) => prod(`p${i}`));
    const invoices = values.map((v, i) => inv({
      id: `i${i}`, totalAmount: v, finalAmount: v, items: [line(`p${i}`, 1, v)],
    }));
    return aggregateSales(invoices, products, costs({}), noCost);
  };

  it('🔴 مادة واحدة تصنع كل المبيعات ⇒ «أ» لا «ج»', () => {
    const { rows } = abcAnalysis(salesOf([100]), 'revenue');
    expect(
      rows[0].grade,
      'التراكم يُحسب بعد الإضافة فتُحرَم المادة العابرة للحدّ — ومحلٌّ بمادة واحدة كان يرى مادته في أدنى فئة',
    ).toBe('أ');
  });

  it('🔴 مادتان ٩٠٪ و١٠٪ ⇒ الأولى «أ»', () => {
    const { rows, counts } = abcAnalysis(salesOf([90, 10]), 'revenue');
    expect(rows[0].grade).toBe('أ');
    expect(counts.أ, 'كان لا يُصنَّف شيء في «أ» إطلاقاً — والتقرير موجود ليقول «ركّز على هذه»').toBeGreaterThan(0);
  });

  it('التوزيع الطبيعي: العابرة للحدّ تنتمي لـ«أ»', () => {
    const { rows } = abcAnalysis(salesOf([50, 20, 15, 10, 5]), 'revenue');
    expect(rows.map(r => r.grade)).toEqual(['أ', 'أ', 'أ', 'ب', 'ج']);
  });

  it('النِّسَب والتراكم صحيحة', () => {
    const { rows, total } = abcAnalysis(salesOf([80, 20]), 'revenue');
    expect(total).toBe(100);
    expect(rows[0].share).toBeCloseTo(80);
    expect(rows[1].cumulative).toBeCloseTo(100);
  });

  it('بلا مبيعات ⇒ فراغ نظيف لا قسمة على صفر', () => {
    const { rows, total, counts } = abcAnalysis(new Map(), 'revenue');
    expect(rows).toEqual([]);
    expect(total).toBe(0);
    expect(counts).toEqual({ أ: 0, ب: 0, ج: 0 });
  });

  it('التحليل بالربح يستثني ما لا ربح معروف له', () => {
    const products = [prod('معروف'), prod('مجهول')];
    const sales = aggregateSales([
      inv({ totalAmount: 100_000, finalAmount: 100_000, items: [line('معروف', 10, 10_000)] }),
      inv({ id: 'i2', totalAmount: 50_000, finalAmount: 50_000, items: [line('مجهول', 5, 10_000)] }),
    ], products, costs({ معروف: 6_000 }), noCost);
    const { rows } = abcAnalysis(sales, 'profit');
    expect(rows.map(r => r.agg.productId)).toEqual(['معروف']);
  });
});

/* ═══════════════════════════ أدوات ═══════════════════════════ */

describe('أدوات مساعدة', () => {
  it('فرق الأيام', () => {
    expect(daysBetween('2026-08-01', '2026-08-17')).toBe(16);
    expect(daysBetween('تالف', '2026-08-17')).toBe(0);
  });

  it('آخر تاريخ بيع لكل مادة', () => {
    const products = [prod('حليب')];
    const m = lastSaleMap([
      inv({ date: '2026-07-01', items: [line('حليب', 1, 100)] }),
      inv({ id: 'i2', date: '2026-08-10', items: [line('حليب', 1, 100)] }),
    ], products);
    expect(m.get('حليب')).toBe('2026-08-10');
  });
});
