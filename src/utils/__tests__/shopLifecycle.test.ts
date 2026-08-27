import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  initializeTestEnvironment, RulesTestEnvironment, RulesTestContext,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, collection, getDocs, writeBatch, increment,
} from 'firebase/firestore';
import { stockUpdate, stockOf } from '../branchStock';
import { purchaseTotals, allocatePurchaseNumber } from '../purchaseInvoice';
import { allocateOwnerNumber } from '../invoiceNumber';
import { allocatePayment } from '../debtAllocation';
import { salesProfit, netProfitOf, costLookup } from '../profit';
import { cashPortion, electronicPortion, CASH_METHOD } from '../paymentMethods';
import { nextEmployeeCode } from '../employeeSync';
import { warrantyStatus, findSerial, serialSaleCounts, normalizeSerial } from '../warranty';
import { expiryStatus } from '../expiry';
import { generateSchedule, planStatus } from '../installments';
import { cancellationShortages, costAfterCancelling } from '../purchaseInvoice';
import { Invoice } from '../../types';
import { customerBalanceOps } from '../saleWrite';
import { MAIN_BRANCH_ID } from '../../types';

/**
 * 🏪 محلٌّ كامل من الصفر — على محاكي Firestore بقاعدة بيانات **فارغة ومصفَّرة**.
 *
 * لماذا هذا الملف؟ لأن المشروع يملك أكثر من ألف اختبارٍ لمنطقٍ نقيّ، وستّةً وستّين
 * لقواعد الأمان — وكلّها تفحص **قطعةً واحدة معزولة**. ولا شيء يفحص ما يفعله التاجر
 * فعلاً: يشتري من مورّد فيدخل المخزن، فيبيع منه نقداً وبالدين، فيُحصّل، فيصرف،
 * فيُقفل الصندوق، فيقرأ ربحه. كل خطوة تُغذّي التالية، والخلل في الوصلة بينها لا
 * يراه اختبارُ قطعةٍ مهما كان دقيقاً.
 *
 * 🔴 والتحقّق بدوالّ البرنامج نفسها لا بحسابٍ أُعيد كتابته هنا: لو أعدتُ الحساب
 * لاختبرتُ رياضياتي أنا، ومرّ خطأ البرنامج سالماً.
 *
 * ⚙️ يعمل تحت **قواعد الأمان مفعَّلة** بجلسة مالكٍ حقيقية — فيثبت أيضاً أن القواعد
 *    تسمح بيوم عملٍ كامل، لا أنها تمنع ما يجب أن تسمح به.
 *
 * التشغيل: `npm run test:rules` (يحتاج Java — وُجد JDK على هذا الجهاز).
 */

const PROJECT = 'ratib-shop-lifecycle'; // مشروع خاصّ — معزولٌ حتى عن اختبارات القواعد
const OWNER = 'shopOwner';
const BR = MAIN_BRANCH_ID;

let env: RulesTestEnvironment;
let ctx: RulesTestContext;
const db = () => ctx.firestore();

/** مسارات مختصرة داخل شجرة المالك. */
const P = {
  product: (id: string) => doc(db(), 'users', OWNER, 'products', id),
  cost: (id: string) => doc(db(), 'users', OWNER, 'product_costs', id),
  supplier: (id: string) => doc(db(), 'users', OWNER, 'suppliers', id),
  customer: (id: string) => doc(db(), 'users', OWNER, 'customers', id),
  invoice: (id: string) => doc(db(), 'users', OWNER, 'invoices', id),
  purchase: (id: string) => doc(db(), 'users', OWNER, 'purchase_invoices', id),
  expense: (id: string) => doc(db(), 'users', OWNER, 'financial_transactions', id),
  payment: (id: string) => doc(db(), 'users', OWNER, 'debt_payments', id),
  supPayment: (id: string) => doc(db(), 'users', OWNER, 'supplier_payments', id),
  closing: (id: string) => doc(db(), 'users', OWNER, 'cash_closings', id),
};

const readAll = async (name: string): Promise<Array<Record<string, unknown>>> => {
  const snap = await getDocs(collection(db(), 'users', OWNER, name));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};
const readOne = async (ref: ReturnType<typeof P.product>) => (await getDoc(ref)).data();

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: {
      rules: readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
  await env.clearFirestore();          // ← «كل شيء خالٍ ومصفَّر»
  ctx = env.authenticatedContext(OWNER);
});

afterAll(async () => { await env?.cleanup(); });

/** أسعار المحل — تُستعمل في كل خطوة فلا تنحرف الأرقام بين الاختبارات. */
/** دالّة التكلفة من وثائق product_costs — تحترم قاعدتَي الجهل والجملة. */
const costOfAll = (costs: Array<Record<string, unknown>>) => costLookup(
  (line) => costs.find(c => c.id === line.productId),
  (c) => (c as { buyPrice?: number }).buyPrice,
  (c) => (c as { wholesaleBuyPrice?: number }).wholesaleBuyPrice,
);

const RICE = { id: 'p_rice', name: 'رز عنبر', buy: 20_000, sell: 25_000 };
const OIL = { id: 'p_oil', name: 'زيت دوار الشمس', buy: 12_000, sell: 15_000 };
const SUGAR = { id: 'p_sugar', name: 'سكر', buy: 1_000, sell: 1_500 };

describe('🏪 يوم عمل كامل في محلٍّ جديد', () => {
  // ───────────────────────────── ١) الصفر
  describe('١ · المحل قبل أي عملية', () => {
    it('🔴 كل المجموعات فارغة فعلاً — نقطة البداية مُثبَتة لا مفترَضة', async () => {
      for (const name of ['products', 'invoices', 'customers', 'suppliers',
        'purchase_invoices', 'financial_transactions', 'debt_payments', 'cash_closings']) {
        expect(await readAll(name), name).toEqual([]);
      }
    });

    it('ولا وجود لوثيقة المحل بعد', async () => {
      expect((await getDoc(doc(db(), 'users', OWNER))).exists()).toBe(false);
    });
  });

  // ───────────────────────────── ٢) التأسيس
  describe('٢ · تأسيس المحل وإدخال الأصناف', () => {
    it('يُنشأ المحل وثلاثة أصناف بمخزون صفر', async () => {
      await setDoc(doc(db(), 'users', OWNER), {
        storeName: 'محل الاختبار', ownerName: 'صاحب المحل', createdAt: '2026-08-25',
      });
      const batch = writeBatch(db());
      for (const p of [RICE, OIL, SUGAR]) {
        batch.set(P.product(p.id), {
          id: p.id, name: p.name, barcode: '', sellPrice: p.sell,
          quantity: 0, branchStock: { [BR]: 0 }, lowStockThreshold: 5,
          category: 'مواد غذائية', unit: 'قطعة', createdAt: '2026-08-25', hasWholesale: false,
        });
        batch.set(P.cost(p.id), { id: p.id, buyPrice: p.buy });
      }
      await batch.commit();

      const products = await readAll('products');
      expect(products).toHaveLength(3);
      // 🔴 صفر مخزون: البضاعة لم تصل بعد. أي رقم آخر هنا يعني بضاعةً وهمية
      for (const p of products) expect(p.quantity, String(p.name)).toBe(0);
    });
  });

  // ───────────────────────────── ٣) الشراء من مورّد
  describe('٣ · شراء من مورّد — البضاعة تدخل المخزن والدَّين يُسجَّل', () => {
    const SUP = 'sup_jumla';
    const items = [
      { productId: RICE.id, productName: RICE.name, quantity: 10, buyPrice: RICE.buy },
      { productId: OIL.id, productName: OIL.name, quantity: 20, buyPrice: OIL.buy },
      { productId: SUGAR.id, productName: SUGAR.name, quantity: 100, buyPrice: SUGAR.buy },
    ];
    // ١٠×٢٠٠٠٠ + ٢٠×١٢٠٠٠ + ١٠٠×١٠٠٠ = ٥٤٠٬٠٠٠
    const TOTAL = 540_000;
    const PAID = 200_000;

    it('الإجمالي يُحسب بدالّة البرنامج لا بيدي', () => {
      const t = purchaseTotals(
        items.map(i => ({
          productId: i.productId, productName: i.productName,
          quantity: String(i.quantity), buyPrice: String(i.buyPrice),
          wholesaleUnitPrice: '', unitName: 'قطعة',
        })),
        '0', '0', String(PAID),
      );
      expect(t.finalTotal).toBe(TOTAL);
      expect(t.remaining).toBe(TOTAL - PAID);
    });

    it('🔴 المخزون يزيد بالكميات المشتراة بالضبط', async () => {
      const number = allocatePurchaseNumber([], '');
      const batch = writeBatch(db());
      batch.set(P.supplier(SUP), { id: SUP, name: 'مورّد الجملة', phone: '07701112233', balance: 0 });
      batch.set(P.purchase('pur1'), {
        id: 'pur1', invoiceNumber: number, supplierId: SUP, supplierName: 'مورّد الجملة',
        date: '2026-08-25', items, finalTotal: TOTAL, paidAmount: PAID,
        status: 'received', branchId: BR, createdAt: Date.now(),
      });
      for (const it of items) {
        batch.update(P.product(it.productId), stockUpdate(it.quantity, BR));
      }
      batch.update(P.supplier(SUP), { balance: increment(TOTAL - PAID) });
      await batch.commit();

      expect((await readOne(P.product(RICE.id)))?.quantity).toBe(10);
      expect((await readOne(P.product(OIL.id)))?.quantity).toBe(20);
      expect((await readOne(P.product(SUGAR.id)))?.quantity).toBe(100);
    });

    it('ومخزون الفرع يطابق الإجمالي — لا كمية بلا موقع', async () => {
      for (const p of [RICE, OIL, SUGAR]) {
        const d = await readOne(P.product(p.id)) as { quantity: number; branchStock: Record<string, number> };
        expect(stockOf(d as never, BR), p.name).toBe(d.quantity);
      }
    });

    it('🔴 ودَين المورّد = الإجمالي ناقص المدفوع', async () => {
      expect((await readOne(P.supplier(SUP)))?.balance).toBe(340_000);
    });

    it('دفعةٌ للمورّد تُنقص دَينه', async () => {
      const batch = writeBatch(db());
      batch.set(P.supPayment('sp1'), {
        id: 'sp1', supplierId: SUP, amount: 140_000, method: CASH_METHOD, date: '2026-08-25',
      });
      batch.update(P.supplier(SUP), { balance: increment(-140_000) });
      await batch.commit();
      expect((await readOne(P.supplier(SUP)))?.balance).toBe(200_000);
    });
  });

  // ───────────────────────────── ٤) البيع النقدي
  describe('٤ · بيع نقدي', () => {
    // ٢ رز + ٥ سكر = ٥٠٬٠٠٠ + ٧٬٥٠٠
    const LINES = [
      { productId: RICE.id, name: RICE.name, quantity: 2, price: RICE.sell },
      { productId: SUGAR.id, name: SUGAR.name, quantity: 5, price: SUGAR.sell },
    ];
    const TOTAL = 57_500;

    it('الفاتورة تأخذ أول رقم في المحل الجديد', async () => {
      const number = allocateOwnerNumber([], '');
      expect(number).toBe('١٠٠٢'); // FIRST_SEQ = ١٠٠١ ⟶ أول فاتورة بعدها

      const batch = writeBatch(db());
      batch.set(P.invoice('inv1'), {
        id: 'inv1', invoiceNumber: number, customerName: 'زبون نقدي',
        totalAmount: TOTAL, discount: 0, tax: 0, finalAmount: TOTAL,
        paidAmount: TOTAL, remainingAmount: 0,
        payments: [{ method: CASH_METHOD, amount: TOTAL }],
        date: '2026-08-25', type: 'general', items: LINES, branchId: BR, createdAt: Date.now(),
      });
      for (const l of LINES) batch.update(P.product(l.productId), stockUpdate(-l.quantity, BR));
      await batch.commit();
    });

    it('🔴 المخزون ينقص بالمباع لا أكثر', async () => {
      expect((await readOne(P.product(RICE.id)))?.quantity).toBe(8);   // ١٠ − ٢
      expect((await readOne(P.product(SUGAR.id)))?.quantity).toBe(95); // ١٠٠ − ٥
      expect((await readOne(P.product(OIL.id)))?.quantity).toBe(20);   // لم يُبَع منه شيء
    });

    it('🔴 والربح يُحسب بدالّة البرنامج على تكلفة الشراء الحقيقية', async () => {
      const invoices = await readAll('invoices');
      const costs = await readAll('product_costs');
      const costOf = costLookup(
        (line) => costs.find(c => c.id === line.productId),
        (c) => (c as { buyPrice?: number }).buyPrice,
        (c) => (c as { wholesaleBuyPrice?: number }).wholesaleBuyPrice,
      );
      const r = salesProfit(invoices as never, costOf);
      expect(r.sales).toBe(TOTAL);
      // (٢٥٠٠٠−٢٠٠٠٠)×٢ + (١٥٠٠−١٠٠٠)×٥ = ١٠٬٠٠٠ + ٢٬٥٠٠
      expect(r.grossProfit).toBe(12_500);
      expect(r.cogs).toBe(45_000);
      expect(r.unknownCostSales, 'كل المواد لها تكلفة معروفة').toBe(0);
    });
  });
});

// ───────────────────────────── ٥) البيع بالدين
describe('٥ · بيع بالدين — الرصيد يُسجَّل على الزبون', () => {
  const CUST = 'cust_ali';
  // ٣ زيت × ١٥٬٠٠٠ = ٤٥٬٠٠٠ ، واصل ١٥٬٠٠٠ ⟶ دَين ٣٠٬٠٠٠
  const TOTAL = 45_000, PAID = 15_000, DEBT = 30_000;

  it('تُنشأ الفاتورة ويُسجَّل الدَّين على الزبون', async () => {
    const invoices = await readAll('invoices');
    const number = allocateOwnerNumber(invoices as never, '');
    expect(number).toBe('١٠٠٣'); // الرقم التالي بعد ١٠٠٢

    const batch = writeBatch(db());
    batch.set(P.customer(CUST), {
      id: CUST, name: 'علي', phone: '07801112233', address: '', notes: '',
      balance: 0, dueDate: '', createdAt: '2026-08-25',
    });
    batch.set(P.invoice('inv2'), {
      id: 'inv2', invoiceNumber: number, customerName: 'علي', customerId: CUST,
      totalAmount: TOTAL, discount: 0, tax: 0, finalAmount: TOTAL,
      paidAmount: PAID, remainingAmount: DEBT,
      /**
       * 🔴 دفعٌ مقسوم: ١٠٬٠٠٠ نقداً و٥٬٠٠٠ بالبطاقة.
       *
       * أُضيف بعد أن كشف زرعُ العطل أن محلّي التجريبي كان **نقدياً بالكامل**، فمرّ
       * عطلٌ يحسب البطاقة نقداً في الدرج بلا أن يسقط اختبار. ومحلٌّ كل مبيعاته نقد
       * ليس محلاً واقعياً — والدرج يجب ألّا يرى قرشاً من البطاقة.
       */
      payments: [
        { method: CASH_METHOD, amount: 10_000 },
        { method: 'بطاقة', amount: 5_000 },
      ],
      date: '2026-08-25', type: 'general', branchId: BR, createdAt: Date.now(),
      items: [{ productId: OIL.id, name: OIL.name, quantity: 3, price: OIL.sell }],
    });
    batch.update(P.product(OIL.id), stockUpdate(-3, BR));
    batch.update(P.customer(CUST), { balance: increment(DEBT) });
    await batch.commit();

    expect((await readOne(P.customer(CUST)))?.balance).toBe(DEBT);
    expect((await readOne(P.product(OIL.id)))?.quantity).toBe(17); // ٢٠ − ٣
  });

  it('🔴 والمحصَّل ليس المبيعات — الفرق هو الدَّين', async () => {
    const invoices = await readAll('invoices');
    const costs = await readAll('product_costs');
    const costOf = costLookup(
      (line) => costs.find(c => c.id === line.productId),
      (c) => (c as { buyPrice?: number }).buyPrice,
      (c) => (c as { wholesaleBuyPrice?: number }).wholesaleBuyPrice,
    );
    const r = salesProfit(invoices as never, costOf);
    expect(r.sales).toBe(57_500 + TOTAL);        // ١٠٢٬٥٠٠ بيعت
    expect(r.collected).toBe(57_500 + PAID);     // ٧٢٬٥٠٠ وصلت الصندوق
    expect(r.sales - r.collected).toBe(DEBT);
  });
});

// ───────────────────────────── ٦) تحصيل الدَّين
describe('٦ · تسديد دين — يُوزَّع على الأقدم', () => {
  const CUST = 'cust_ali';

  it('التوزيع يمرّ بدالّة البرنامج ولا يتجاوز متبقّي الفاتورة', async () => {
    const invoices = (await readAll('invoices')) as unknown as Array<{
      id: string; finalAmount: number; remainingAmount?: number; createdAt?: number;
    }>;
    const res = allocatePayment(invoices, 20_000);
    expect(res.allocations).toEqual([{ invoiceId: 'inv2', amount: 20_000 }]);
    expect(res.unallocated, 'لا يبقى مبلغٌ معلَّق').toBe(0);

    const batch = writeBatch(db());
    batch.set(P.payment('pay1'), {
      id: 'pay1', customerId: CUST, amount: 20_000, method: CASH_METHOD,
      date: '2026-08-25', createdAt: Date.now(),
    });
    for (const a of res.allocations) {
      batch.update(P.invoice(a.invoiceId), {
        remainingAmount: increment(-a.amount), paidAmount: increment(a.amount),
      });
    }
    batch.update(P.customer(CUST), { balance: increment(-20_000) });
    await batch.commit();

    expect((await readOne(P.customer(CUST)))?.balance).toBe(10_000);
    const inv = await readOne(P.invoice('inv2'));
    expect(inv?.remainingAmount).toBe(10_000);
    expect(inv?.paidAmount).toBe(35_000);
  });

  it('🔴 ومجموع الفاتورة لا يتغيّر بالتسديد — المدفوع + المتبقّي = الإجمالي', async () => {
    const inv = await readOne(P.invoice('inv2')) as { paidAmount: number; remainingAmount: number; finalAmount: number };
    expect(inv.paidAmount + inv.remainingAmount).toBe(inv.finalAmount);
  });

  it('تسديدٌ أكبر من الدَّين لا يخلق رصيداً وهمياً على الفاتورة', async () => {
    const invoices = (await readAll('invoices')) as unknown as Array<{
      id: string; finalAmount: number; remainingAmount?: number;
    }>;
    const res = allocatePayment(invoices, 999_999);
    const total = res.allocations.reduce((s, a) => s + a.amount, 0);
    expect(total, 'لا يُوزَّع إلا بقدر الدَّين القائم').toBe(10_000);
    expect(res.unallocated).toBe(989_999);
  });
});

// ───────────────────────────── ٧) المصاريف والصندوق
describe('٧ · مصروف ثم تقفيل الصندوق', () => {
  it('يُسجَّل مصروف إيجار', async () => {
    await setDoc(P.expense('exp1'), {
      id: 'exp1', type: 'expense', amount: 25_000, category: 'إيجار',
      description: 'إيجار المحل', date: '2026-08-25', method: CASH_METHOD, branchId: BR,
    });
    expect(await readAll('financial_transactions')).toHaveLength(1);
  });

  it('🔴 النقد المتوقَّع في الدرج — بدالّة فصل النقد لا بجمعٍ أعمى', async () => {
    const invoices = (await readAll('invoices')) as Array<{ paidAmount: number; payments?: Array<{ method: string; amount: number }> }>;
    const payments = (await readAll('debt_payments')) as Array<{ amount: number; method: string }>;
    const expenses = (await readAll('financial_transactions')) as Array<{ amount: number; method: string }>;
    const supPays = (await readAll('supplier_payments')) as Array<{ amount: number; method: string }>;

    const salesCash = invoices.reduce((s, i) => s + cashPortion(i.paidAmount, i.payments), 0);
    const collected = payments.reduce((s, p) => s + cashPortion(p.amount, undefined), 0);
    const spentExp = expenses.reduce((s, e) => s + cashPortion(e.amount, undefined), 0);
    const spentSup = supPays.reduce((s, p) => s + cashPortion(p.amount, undefined), 0);

    // ٥٧٬٥٠٠ (نقدي) + ١٥٬٠٠٠ (واصل الدَّين) = ٧٢٬٥٠٠
    expect(salesCash, 'البطاقة لا تدخل الدرج — ٥٧٬٥٠٠ + ١٠٬٠٠٠ نقداً فقط').toBe(67_500);
    // 🔴 والتصريح بالجزء الإلكتروني: خمسة آلاف وصلت الحساب لا الدرج
    const card = invoices.reduce((s, i) => s + electronicPortion(i.paidAmount, i.payments), 0);
    expect(card).toBe(5_000);
    expect(salesCash + card, 'النقد + الإلكتروني = كل ما وصل').toBe(72_500);
    expect(collected).toBe(20_000);
    expect(spentExp).toBe(25_000);
    expect(spentSup).toBe(140_000);

    const drawer = salesCash + collected - spentExp - spentSup;
    expect(drawer, 'الدرج بالسالب: صُرف للمورّد أكثر ممّا دخل — حالةٌ واقعية في أول يوم').toBe(-77_500);

    await setDoc(P.closing('cc1'), {
      id: 'cc1', date: '2026-08-25', openingCash: 0,
      expectedCash: drawer, countedCash: drawer, difference: 0, branchId: BR,
    });
    const cc = await readOne(P.closing('cc1'));
    expect(cc?.difference, 'لا فرق ⟸ العدّ طابق المتوقَّع').toBe(0);
  });
});

// ───────────────────────────── ٨) الربح الصافي
describe('٨ · الربح الصافي بعد المصاريف', () => {
  it('🔴 يُحسب بدالّة البرنامج: الإجمالي − تكلفة المباع − المصاريف', async () => {
    const invoices = await readAll('invoices');
    const costs = await readAll('product_costs');
    const txns = (await readAll('financial_transactions')) as Array<{ type: 'revenue' | 'expense'; amount: number }>;
    const costOf = costLookup(
      (line) => costs.find(c => c.id === line.productId),
      (c) => (c as { buyPrice?: number }).buyPrice,
      (c) => (c as { wholesaleBuyPrice?: number }).wholesaleBuyPrice,
    );
    const r = netProfitOf(invoices as never, txns, costOf);

    // ربح النقدي ١٢٬٥٠٠ + ربح الدَّين (١٥٠٠٠−١٢٠٠٠)×٣ = ٩٬٠٠٠ ⟶ ٢١٬٥٠٠
    expect(r.grossProfit).toBe(21_500);
    expect(r.expenses).toBe(25_000);
    expect(r.netProfit, 'أول يومٍ بخسارة — والبرنامج يقولها لا يُجمّلها').toBe(-3_500);

    /**
     * 🔴 والمبيعات ≠ المحصَّل هنا أيضاً.
     *
     * أُضيف بعد أن كشف زرعُ العطل ثغرةً: كنتُ أفحص هذين الحقلين من `salesProfit`
     * وحدها، فمرّ عطلٌ يجعل `netProfitOf` تُعيد المحصَّل مكان المبيعات — أي يختفي
     * الدَّين من الدفاتر — بلا أن يسقط اختبار.
     */
    expect(r.sales, 'حجم البيع بأساس الاستحقاق').toBe(102_500);
    expect(r.collected, 'ما وصل فعلاً — أقلّ بمقدار الدَّين القائم').toBe(92_500);
    expect(r.sales - r.collected, 'الفرق = دَين الزبون بعد تسديده الجزئي').toBe(10_000);
  });
});


// ───────────────────────────── ٩) موظف يبيع
describe('٩ · موظف يبيع — ترقيمه مستقلّ وأرقامه خالصة', () => {
  const EMP = 'emp_kareem';

  it('يُنشأ الموظف برقمٍ قصير لا بمعرّف فايربيس', async () => {
    const code = nextEmployeeCode([]);
    expect(code).toBe(1);
    await setDoc(doc(db(), 'users', OWNER, 'employees', EMP), {
      id: EMP, name: 'كريم', email: 'k@shop.iq', code,
      addedAt: '2026-08-25', disabled: false, branchId: BR,
    });
    const saved = (await getDoc(doc(db(), 'users', OWNER, 'employees', EMP))).data();
    expect(saved?.code).toBe(1);
  });

  it('🔴 ورقم فاتورته «1-1» — خاناتٌ وشرطة، بلا حرفٍ لاتيني', async () => {
    const number = '1-1';
    expect(number).toMatch(/^\d+-\d+$/);

    const batch = writeBatch(db());
    batch.set(P.invoice('inv3'), {
      id: 'inv3', invoiceNumber: number, customerName: 'زبون الموظف',
      totalAmount: 3_000, discount: 0, tax: 0, finalAmount: 3_000,
      paidAmount: 3_000, remainingAmount: 0,
      payments: [{ method: CASH_METHOD, amount: 3_000 }],
      date: '2026-08-25', type: 'general', branchId: BR, createdAt: Date.now(),
      createdByUid: EMP, createdByName: 'كريم',
      items: [{ productId: SUGAR.id, name: SUGAR.name, quantity: 2, price: SUGAR.sell }],
    });
    batch.update(P.product(SUGAR.id), stockUpdate(-2, BR));
    await batch.commit();

    expect((await readOne(P.product(SUGAR.id)))?.quantity).toBe(93); // ٩٥ − ٢
  });

  it('والمالك يرى فاتورة موظفه ضمن فواتيره', async () => {
    const invoices = (await readAll('invoices')) as unknown as Array<{ createdByUid?: string }>;
    expect(invoices).toHaveLength(3);
    expect(invoices.filter(i => i.createdByUid === EMP)).toHaveLength(1);
  });
});

// ───────────────────────────── ١٠) المطابقة الختامية
describe('١٠ · المطابقة الختامية — الدفاتر تُقفل', () => {
  it('🔴 لكل مادة: المشترى − المباع = الموجود', async () => {
    const bought: Record<string, number> = { [RICE.id]: 10, [OIL.id]: 20, [SUGAR.id]: 100 };
    const sold: Record<string, number> = {};
    const invoices = (await readAll('invoices')) as unknown as Array<{
      items: Array<{ productId: string; quantity: number }>;
    }>;
    for (const inv of invoices) {
      for (const l of inv.items) sold[l.productId] = (sold[l.productId] ?? 0) + l.quantity;
    }
    for (const p of [RICE, OIL, SUGAR]) {
      const onHand = (await readOne(P.product(p.id)))?.quantity;
      expect(onHand, `${p.name}: ${bought[p.id]} مشترى − ${sold[p.id] ?? 0} مباع`)
        .toBe(bought[p.id] - (sold[p.id] ?? 0));
    }
  });

  it('🔴 ومجموع مخزون الفروع = الإجمالي — لا كمية بلا موقع', async () => {
    for (const p of [RICE, OIL, SUGAR]) {
      const d = (await readOne(P.product(p.id))) as unknown as {
        quantity: number; branchStock: Record<string, number>;
      };
      const sum = Object.values(d.branchStock).reduce((s, n) => s + n, 0);
      expect(sum, p.name).toBe(d.quantity);
    }
  });

  it('🔴 ودَين كل زبون في سجلّه = مجموع متبقّي فواتيره', async () => {
    const customers = (await readAll('customers')) as unknown as Array<{ id: string; balance: number }>;
    const invoices = (await readAll('invoices')) as unknown as Array<{
      customerId?: string; remainingAmount?: number;
    }>;
    expect(customers.length, 'زبون دَينٍ واحد في هذا اليوم').toBe(1);
    for (const c of customers) {
      const fromInvoices = invoices
        .filter(i => i.customerId === c.id)
        .reduce((s, i) => s + (i.remainingAmount ?? 0), 0);
      expect(c.balance, `رصيد ${c.id} يجب أن يساوي متبقّي فواتيره`).toBe(fromInvoices);
    }
  });

  it('ولا مادة بمخزون سالب — بيعٌ بلا رصيد', async () => {
    for (const p of (await readAll('products')) as unknown as Array<{ name: string; quantity: number }>) {
      expect(p.quantity, p.name).toBeGreaterThanOrEqual(0);
    }
  });
});

// ───────────────────────────── ١١) مادة بلا تكلفة معروفة
/**
 * 🔴 هذا الفصل أُضيف بعد أن كشف زرعُ العطل ثغرةً في «شموليّة» هذا الملف:
 * كل موادّ محلّي التجريبي كانت معروفة التكلفة، فمرّ عطلٌ يجعل تكلفة المجهول
 * **صفراً** بلا أن يسقط اختبار. وصفرٌ يعني «بضاعة مجانية» فيصير كل بيعها ربحاً.
 *
 * والحالة واقعية تماماً: بضاعةٌ دخلت المحل بجردٍ يدوي أو من قبل استعمال البرنامج،
 * فلا سعر شراء لها. والبرنامج يجب أن يقول «غير محتسبة» لا أن يخترع لها ربحاً.
 */
describe('١١ · مادة دخلت بلا سعر شراء — الربح لا يتضخّم', () => {
  const PASTE = { id: 'p_paste', name: 'معجون طماطم', sell: 4_000 };

  it('تُدخَل المادة ويُضاف مخزونها بلا وثيقة تكلفة', async () => {
    await setDoc(P.product(PASTE.id), {
      id: PASTE.id, name: PASTE.name, barcode: '', sellPrice: PASTE.sell,
      quantity: 0, branchStock: { [BR]: 0 }, lowStockThreshold: 3,
      category: 'مواد غذائية', unit: 'قطعة', createdAt: '2026-08-25', hasWholesale: false,
    });
    await updateDoc(P.product(PASTE.id), stockUpdate(6, BR));

    expect((await readOne(P.product(PASTE.id)))?.quantity).toBe(6);
    const costs = (await readAll('product_costs')) as unknown as Array<{ id: string }>;
    expect(costs.find(c => c.id === PASTE.id), 'لا سعر شراء لها عمداً').toBeUndefined();
  });

  it('🔴 بيعها يُسجَّل «غير محتسب» ولا يُضاف إلى الربح', async () => {
    const costsBefore = await readAll('product_costs');
    const costOfFn = (costs: Array<Record<string, unknown>>) => costLookup(
      (line) => costs.find(c => c.id === line.productId),
      (c) => (c as { buyPrice?: number }).buyPrice,
      (c) => (c as { wholesaleBuyPrice?: number }).wholesaleBuyPrice,
    );
    const before = await readAll('invoices');
    /**
     * 🔴 نقيس **الفرق** لا رقماً مثبَّتاً.
     *
     * أول محاولةٍ ثبّتُّ فيها ٢١٬٥٠٠ فسقط الاختبار — وكان خطئي أنا: نسيتُ ربح
     * فاتورة الموظف (١٬٠٠٠) التي وقعت قبل هذا الفصل. والرقم المثبَّت يشيخ مع كل
     * خطوةٍ تُضاف للقصّة، أمّا «لم يتغيّر» فيبقى صادقاً مهما طالت.
     */
    const baseline = salesProfit(before as never, costOfFn(costsBefore));
    const number = allocateOwnerNumber(before as never, '');

    const batch = writeBatch(db());
    batch.set(P.invoice('inv4'), {
      id: 'inv4', invoiceNumber: number, customerName: 'زبون نقدي',
      totalAmount: 8_000, discount: 0, tax: 0, finalAmount: 8_000,
      paidAmount: 8_000, remainingAmount: 0,
      payments: [{ method: CASH_METHOD, amount: 8_000 }],
      date: '2026-08-25', type: 'general', branchId: BR, createdAt: Date.now(),
      items: [{ productId: PASTE.id, name: PASTE.name, quantity: 2, price: PASTE.sell }],
    });
    batch.update(P.product(PASTE.id), stockUpdate(-2, BR));
    await batch.commit();

    const after = salesProfit(
      (await readAll('invoices')) as never,
      costOfFn(await readAll('product_costs')),
    );

    // ٨٬٠٠٠ بيعت من مادةٍ مجهولة التكلفة — تُعزَل صراحةً
    expect(after.unknownCostSales - baseline.unknownCostSales).toBe(8_000);
    expect(after.sales - baseline.sales, 'وتدخل حجم المبيعات كأي بيع').toBe(8_000);
    // 🔴 القلب: الربح وتكلفة المباع لم يتحرّكا قيد أنملة
    expect(after.grossProfit, 'لا يُخترع ربحٌ من تكلفةٍ مجهولة').toBe(baseline.grossProfit);
    expect(after.cogs, 'وتكلفة المباع لا تشمل المجهول').toBe(baseline.cogs);
  });

  it('ومخزونها ينقص كأي مادة أخرى', async () => {
    expect((await readOne(P.product(PASTE.id)))?.quantity).toBe(4); // ٦ − ٢
  });
});

// ═══════════════════════════════════════════════════════════════════
//                   الفصل الثاني — أسبوع العمل
// ═══════════════════════════════════════════════════════════════════

/**
 * ثلاثة زبائن بحالاتٍ مختلفة، وفواتير متعدّدة لكل واحد.
 *
 * 🔴 لماذا أكثر من زبون؟ لأن زبوناً واحداً لا يكشف خلط الأرصدة. أخطر ما في
 * دفتر الديون أن يُخصم تسديدُ زيدٍ من دَين عمرو — ولا يظهر ذلك إلا بوجود
 * الاثنين معاً وأرقامٍ متقاربة تُغري بالخلط.
 */
describe('١٢ · ثلاثة زبائن وديونٌ متعدّدة', () => {
  const CUSTOMERS = [
    { id: 'c_ahmed', name: 'أحمد', phone: '07701111111' },
    { id: 'c_hasan', name: 'حسن', phone: '07702222222' },
    { id: 'c_zainab', name: 'زينب', phone: '07703333333' },
  ];

  it('يُضاف الثلاثة برصيد صفر', async () => {
    const batch = writeBatch(db());
    for (const c of CUSTOMERS) {
      batch.set(P.customer(c.id), {
        id: c.id, name: c.name, phone: c.phone, address: '', notes: '',
        balance: 0, dueDate: '', createdAt: '2026-08-26',
      });
    }
    await batch.commit();
    const all = (await readAll('customers')) as unknown as Array<{ balance: number }>;
    expect(all).toHaveLength(4); // علي من الفصل الأول + ثلاثة
    for (const c of CUSTOMERS) {
      expect((await readOne(P.customer(c.id)))?.balance, c.name).toBe(0);
    }
  });

  /**
   * أحمد يشتري ثلاث مرّات بالدين — والأرقام متقاربة عمداً.
   * الأولى ٢٥٬٠٠٠ · الثانية ١٥٬٠٠٠ · الثالثة ١٠٬٠٠٠ ⟶ الدَّين ٥٠٬٠٠٠
   */
  it('أحمد يشتري ثلاث مرّات بالدين — ورصيده مجموعها', async () => {
    const sales = [
      { id: 'inv_a1', line: { productId: RICE.id, name: RICE.name, quantity: 1, price: RICE.sell }, total: 25_000, at: 1 },
      { id: 'inv_a2', line: { productId: OIL.id, name: OIL.name, quantity: 1, price: OIL.sell }, total: 15_000, at: 2 },
      { id: 'inv_a3', line: { productId: SUGAR.id, name: SUGAR.name, quantity: 4, price: SUGAR.sell }, total: 6_000, at: 3 },
    ];
    for (const s of sales) {
      const invoices = await readAll('invoices');
      const batch = writeBatch(db());
      batch.set(P.invoice(s.id), {
        id: s.id, invoiceNumber: allocateOwnerNumber(invoices as never, ''),
        customerName: 'أحمد', customerId: 'c_ahmed',
        totalAmount: s.total, discount: 0, tax: 0, finalAmount: s.total,
        paidAmount: 0, remainingAmount: s.total,
        date: '2026-08-26', type: 'general', branchId: BR,
        createdAt: 1_700_000_000_000 + s.at, // ترتيبٌ صريح: الأقدم أولاً
        items: [s.line],
      });
      batch.update(P.product(s.line.productId), stockUpdate(-s.line.quantity, BR));
      batch.update(P.customer('c_ahmed'), { balance: increment(s.total) });
      await batch.commit();
    }
    expect((await readOne(P.customer('c_ahmed')))?.balance).toBe(46_000);
  });

  it('🔴 وتسديدٌ جزئي يُطفئ الأقدم أولاً لا الأحدث', async () => {
    const all = (await readAll('invoices')) as unknown as Array<{
      id: string; finalAmount: number; remainingAmount?: number; createdAt?: number; customerId?: string;
    }>;
    const his = all.filter(i => i.customerId === 'c_ahmed');
    // ٣٠٬٠٠٠ تكفي الأولى (٢٥٬٠٠٠) وتترك ٥٬٠٠٠ للثانية
    const res = allocatePayment(his, 30_000);
    expect(res.allocations).toEqual([
      { invoiceId: 'inv_a1', amount: 25_000 },
      { invoiceId: 'inv_a2', amount: 5_000 },
    ]);
    expect(res.unallocated).toBe(0);

    const batch = writeBatch(db());
    batch.set(P.payment('pay_a1'), {
      id: 'pay_a1', customerId: 'c_ahmed', amount: 30_000, method: CASH_METHOD,
      date: '2026-08-26', createdAt: Date.now(),
    });
    for (const a of res.allocations) {
      batch.update(P.invoice(a.invoiceId), {
        remainingAmount: increment(-a.amount), paidAmount: increment(a.amount),
      });
    }
    batch.update(P.customer('c_ahmed'), { balance: increment(-30_000) });
    await batch.commit();

    expect((await readOne(P.invoice('inv_a1')))?.remainingAmount, 'الأقدم سُدّدت كاملة').toBe(0);
    expect((await readOne(P.invoice('inv_a2')))?.remainingAmount, 'والثانية جزئياً').toBe(10_000);
    expect((await readOne(P.invoice('inv_a3')))?.remainingAmount, 'والأحدث لم تُمَسّ').toBe(6_000);
    expect((await readOne(P.customer('c_ahmed')))?.balance).toBe(16_000);
  });

  it('🔴 ولم يتأثّر رصيد أي زبونٍ آخر — لا خلط بين الدفاتر', async () => {
    expect((await readOne(P.customer('c_hasan')))?.balance).toBe(0);
    expect((await readOne(P.customer('c_zainab')))?.balance).toBe(0);
    expect((await readOne(P.customer('cust_ali')))?.balance, 'علي من الفصل الأول').toBe(10_000);
  });
});

/**
 * 🔴 الخصم — والقاعدة التي تُخطئ فيها أغلب البرامج.
 *
 * الخصم يُوزَّع **بالنسبة** على الربح المعروف، فلا يُطرح كاملاً من ربحٍ جزئي.
 * ولو طُرح كاملاً لظهرت فاتورةٌ خاسرة وهي رابحة، أو العكس.
 */
describe('١٣ · فاتورة بخصم — الربح يُوزَّع بالنسبة', () => {
  it('البيع بخصم ٥٬٠٠٠ يُنقص الربح بمقداره لا أكثر', async () => {
    const before = await readAll('invoices');
    const costs = await readAll('product_costs');
    const costOf = costLookup(
      (line) => costs.find(c => c.id === line.productId),
      (c) => (c as { buyPrice?: number }).buyPrice,
      (c) => (c as { wholesaleBuyPrice?: number }).wholesaleBuyPrice,
    );
    const baseline = salesProfit(before as never, costOf);

    // ٢ رز = ٥٠٬٠٠٠ ، خصم ٥٬٠٠٠ ⟶ ٤٥٬٠٠٠. الربح قبل الخصم ١٠٬٠٠٠ ⟶ بعده ٥٬٠٠٠
    const batch = writeBatch(db());
    batch.set(P.invoice('inv_disc'), {
      id: 'inv_disc', invoiceNumber: allocateOwnerNumber(before as never, ''),
      customerName: 'زبون نقدي',
      totalAmount: 50_000, discount: 5_000, tax: 0, finalAmount: 45_000,
      paidAmount: 45_000, remainingAmount: 0,
      payments: [{ method: CASH_METHOD, amount: 45_000 }],
      date: '2026-08-26', type: 'general', branchId: BR, createdAt: Date.now(),
      items: [{ productId: RICE.id, name: RICE.name, quantity: 2, price: RICE.sell }],
    });
    batch.update(P.product(RICE.id), stockUpdate(-2, BR));
    await batch.commit();

    const after = salesProfit((await readAll('invoices')) as never, costOf);
    expect(after.sales - baseline.sales, 'المبيعات بالصافي بعد الخصم').toBe(45_000);
    expect(after.cogs - baseline.cogs, 'تكلفة قطعتَي رز').toBe(40_000);
    /**
     * ✅ أُصلح: كان البرنامج يقول ٩٬٠٠٠ هنا.
     *
     * الصيغة القديمة `knownProfit *= 1 - discount/total` تُنقص الربح **بنسبة**
     * الخصم لا **بمقداره**، فيُبالَغ في الربح في كل فاتورةٍ بخصم. كُشف العطل من
     * هذا الفصل بالذات — أول فاتورة خصمٍ في قصّة المحل.
     */
    expect(
      after.grossProfit - baseline.grossProfit,
      '١٠٬٠٠٠ ربح − ٥٬٠٠٠ خصم = ٤٥٬٠٠٠ محصَّل − ٤٠٬٠٠٠ تكلفة',
    ).toBe(5_000);
  });
});

/**
 * 🔴 إرجاع فاتورة — البضاعة تعود والدَّين ينقص.
 *
 * أخطر ما في الإرجاع أن يُعاد المخزون ولا يُعدَّل الدَّين (فيبقى على الزبون
 * دَينُ بضاعةٍ ردّها)، أو العكس (فتضيع البضاعة من الجرد).
 */
describe('١٤ · إرجاع جزئي — الجرد والدَّين يتحرّكان معاً', () => {
  it('حسن يشتري ٤ زيت بالدين', async () => {
    const before = await readAll('invoices');
    const batch = writeBatch(db());
    batch.set(P.invoice('inv_h1'), {
      id: 'inv_h1', invoiceNumber: allocateOwnerNumber(before as never, ''),
      customerName: 'حسن', customerId: 'c_hasan',
      totalAmount: 60_000, discount: 0, tax: 0, finalAmount: 60_000,
      paidAmount: 0, remainingAmount: 60_000,
      date: '2026-08-26', type: 'general', branchId: BR, createdAt: Date.now(),
      items: [{ productId: OIL.id, name: OIL.name, quantity: 4, price: OIL.sell }],
    });
    batch.update(P.product(OIL.id), stockUpdate(-4, BR));
    batch.update(P.customer('c_hasan'), { balance: increment(60_000) });
    await batch.commit();
    expect((await readOne(P.customer('c_hasan')))?.balance).toBe(60_000);
  });

  it('🔴 ثم يُرجع قطعتين — المخزون يعود والدَّين ينزل بنفس القيمة', async () => {
    const oilBefore = (await readOne(P.product(OIL.id)))?.quantity as number;
    const RETURN_VALUE = 2 * OIL.sell; // ٣٠٬٠٠٠

    const batch = writeBatch(db());
    batch.update(P.product(OIL.id), stockUpdate(2, BR));           // البضاعة تعود
    batch.update(P.invoice('inv_h1'), {
      finalAmount: increment(-RETURN_VALUE),
      totalAmount: increment(-RETURN_VALUE),
      remainingAmount: increment(-RETURN_VALUE),
    });
    batch.update(P.customer('c_hasan'), { balance: increment(-RETURN_VALUE) });
    await batch.commit();

    expect((await readOne(P.product(OIL.id)))?.quantity, 'قطعتان عادتا للرف').toBe(oilBefore + 2);
    const inv = (await readOne(P.invoice('inv_h1'))) as unknown as {
      finalAmount: number; paidAmount: number; remainingAmount: number;
    };
    expect(inv.finalAmount).toBe(30_000);
    expect(inv.remainingAmount).toBe(30_000);
    expect((await readOne(P.customer('c_hasan')))?.balance, 'الدَّين نزل بقيمة المُرجَع').toBe(30_000);
  });

  it('🔴 والمعادلة تبقى صحيحة: المدفوع + المتبقّي = الإجمالي', async () => {
    const inv = (await readOne(P.invoice('inv_h1'))) as unknown as {
      finalAmount: number; paidAmount: number; remainingAmount: number;
    };
    expect(inv.paidAmount + inv.remainingAmount).toBe(inv.finalAmount);
  });
});

// ═══════════════════════════════════════════════════════════════════
//              الفصل الثالث — الجرد والفروع وتصحيح الأخطاء
// ═══════════════════════════════════════════════════════════════════

/**
 * 🔴 تسوية المخزون — الشاشة التي تُصلح ما تكسره الحياة.
 *
 * تلفٌ أو سرقةٌ أو جردٌ يخالف الدفتر. والخطر أن تُخصم الكمية من الإجمالي بلا
 * أن تُخصم من الفرع — فيصير مجموع الفروع أكبر من الإجمالي، ويظهر في شاشة
 * الفروع مخزونٌ لا وجود له.
 */
describe('١٥ · تسوية مخزون — تلف خمس علب سكر', () => {
  it('الكمية تنقص من الإجمالي ومن الفرع معاً', async () => {
    const before = (await readOne(P.product(SUGAR.id))) as unknown as {
      quantity: number; branchStock: Record<string, number>;
    };

    const batch = writeBatch(db());
    batch.set(doc(db(), 'users', OWNER, 'stock_adjustments', 'adj1'), {
      id: 'adj1', productId: SUGAR.id, productName: SUGAR.name,
      type: 'damage', quantityBefore: before.quantity, quantityDelta: -5,
      quantityAfter: before.quantity - 5, reason: 'تلف أثناء النقل',
      date: '2026-08-26', branchId: BR, createdAt: Date.now(),
    });
    batch.update(P.product(SUGAR.id), stockUpdate(-5, BR));
    await batch.commit();

    const after = (await readOne(P.product(SUGAR.id))) as unknown as {
      quantity: number; branchStock: Record<string, number>;
    };
    expect(after.quantity).toBe(before.quantity - 5);
    expect(after.branchStock[BR], '🔴 الفرع نقص أيضاً — لا مخزونٌ بلا موقع').toBe(before.branchStock[BR] - 5);
    expect(Object.values(after.branchStock).reduce((s, n) => s + n, 0)).toBe(after.quantity);
  });

  it('والتسوية مسجَّلة بسببها — لا نقصٌ مجهول المصدر', async () => {
    const adjustments = (await readAll('stock_adjustments')) as unknown as Array<{ reason: string; quantityDelta: number }>;
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].reason).toBe('تلف أثناء النقل');
    expect(adjustments[0].quantityDelta).toBe(-5);
  });
});

/**
 * 🔴 تحويل بين فرعين — المجموع لا يتغيّر، التوزيع فقط.
 *
 * أخطر عطلٍ هنا أن يزيد الإجمالي مع التحويل (بضاعةٌ تتكاثر بالنقل)، أو أن
 * يخرج من فرعٍ ولا يدخل الآخر (بضاعةٌ تتبخّر في الطريق).
 */
describe('١٦ · تحويل بضاعة إلى فرعٍ ثانٍ', () => {
  const BR2 = 'branch_2';

  it('🔴 يخرج من الرئيسي ويدخل الثاني — والإجمالي ثابت', async () => {
    const before = (await readOne(P.product(RICE.id))) as unknown as {
      quantity: number; branchStock: Record<string, number>;
    };

    const batch = writeBatch(db());
    batch.set(doc(db(), 'users', OWNER, 'stock_transfers', 'tr1'), {
      id: 'tr1', transferNumber: 'TR-١', fromBranchId: BR, toBranchId: BR2,
      date: '2026-08-26', createdAt: Date.now(),
      lines: [{ productId: RICE.id, productName: RICE.name, quantity: 2 }],
    });
    // الخروج والدخول في **نفس الدفعة** — وإلا تبخّرت البضاعة بين الكتابتين
    batch.update(P.product(RICE.id), {
      [`branchStock.${BR}`]: increment(-2),
      [`branchStock.${BR2}`]: increment(2),
    });
    await batch.commit();

    const after = (await readOne(P.product(RICE.id))) as unknown as {
      quantity: number; branchStock: Record<string, number>;
    };
    expect(after.quantity, '🔴 الإجمالي لا يتغيّر بالنقل — البضاعة لا تتكاثر').toBe(before.quantity);
    expect(after.branchStock[BR]).toBe(before.branchStock[BR] - 2);
    expect(after.branchStock[BR2]).toBe(2);
    expect(Object.values(after.branchStock).reduce((s, n) => s + n, 0)).toBe(after.quantity);
  });

  it('و`stockOf` تقرأ كل فرعٍ على حدة', async () => {
    const d = (await readOne(P.product(RICE.id))) as never;
    expect(stockOf(d, BR2), 'الفرع الثاني').toBe(2);
    expect(stockOf(d, BR), 'الرئيسي').toBeGreaterThan(0);
  });
});

/**
 * 🔴 تبديل زبون الفاتورة — أخطر تعديلٍ في دفتر الديون.
 *
 * فاتورةٌ سُجّلت على «زينب» وهي في الحقيقة لـ«حسن». والخطأ الشائع أن يُضاف
 * الدَّين للجديد بلا أن يُعكس عن القديم — فيُطالَب بريءٌ بدَينٍ ليس عليه،
 * ويبقى المدين بلا دَين.
 */
describe('١٧ · تصحيح خطأ: تبديل زبون الفاتورة', () => {
  const AMOUNT = 12_000;

  it('فاتورة دَين تُسجَّل على زينب بالخطأ', async () => {
    const before = await readAll('invoices');
    const batch = writeBatch(db());
    batch.set(P.invoice('inv_wrong'), {
      id: 'inv_wrong', invoiceNumber: allocateOwnerNumber(before as never, ''),
      customerName: 'زينب', customerId: 'c_zainab',
      totalAmount: AMOUNT, discount: 0, tax: 0, finalAmount: AMOUNT,
      paidAmount: 0, remainingAmount: AMOUNT,
      date: '2026-08-26', type: 'general', branchId: BR, createdAt: Date.now(),
      items: [{ productId: SUGAR.id, name: SUGAR.name, quantity: 8, price: SUGAR.sell }],
    });
    batch.update(P.product(SUGAR.id), stockUpdate(-8, BR));
    batch.update(P.customer('c_zainab'), { balance: increment(AMOUNT) });
    await batch.commit();
    expect((await readOne(P.customer('c_zainab')))?.balance).toBe(AMOUNT);
  });

  it('🔴 التبديل إلى حسن — بدالّة البرنامج: عكسٌ عن القديم وتطبيقٌ على الجديد', async () => {
    const ops = customerBalanceOps({
      isSameCustomer: false,
      newCustomerId: 'c_hasan',
      oldCustomerId: 'c_zainab',
      oldRemaining: AMOUNT,
      delta: AMOUNT,
      // فاتورة مالكٍ عادية. و`true` تعني «دَين فاتورة موظف لم يُطوَ بعد» فلا
      // يُمَسّ الرصيد — مرّرتُها خطأً أول مرّة فأرجعت الدالّة مصفوفةً فارغة،
      // وكانت مُحقّة: الطي يضيف الدَّين لاحقاً، ومسّه هنا يُضاعفه.
      foldDeferred: false,
    });
    // حركتان لا واحدة: −١٢٬٠٠٠ عن زينب و+١٢٬٠٠٠ على حسن
    expect(ops).toEqual([
      { customerId: 'c_zainab', delta: -AMOUNT },
      { customerId: 'c_hasan', delta: AMOUNT },
    ]);

    const hasanBefore = (await readOne(P.customer('c_hasan')))?.balance as number;
    const batch = writeBatch(db());
    batch.update(P.invoice('inv_wrong'), { customerId: 'c_hasan', customerName: 'حسن' });
    for (const op of ops) batch.update(P.customer(op.customerId), { balance: increment(op.delta) });
    await batch.commit();

    expect((await readOne(P.customer('c_zainab')))?.balance, '🔴 زينب بريئة — عاد رصيدها صفراً').toBe(0);
    expect((await readOne(P.customer('c_hasan')))?.balance).toBe(hasanBefore + AMOUNT);
  });
});

/**
 * المطابقة الكبرى — بعد كل ما جرى: شراء وبيع وتسديد وإرجاع وتلف وتحويل وتصحيح.
 */
describe('١٨ · المطابقة الكبرى — الدفاتر تُقفل بعد كل شيء', () => {
  it('🔴 رصيد كل زبون = مجموع متبقّي فواتيره — بلا استثناء', async () => {
    const customers = (await readAll('customers')) as unknown as Array<{ id: string; name: string; balance: number }>;
    const invoices = (await readAll('invoices')) as unknown as Array<{ customerId?: string; remainingAmount?: number }>;
    for (const c of customers) {
      const fromInvoices = invoices
        .filter(i => i.customerId === c.id)
        .reduce((s, i) => s + (i.remainingAmount ?? 0), 0);
      expect(c.balance, `${c.name}`).toBe(fromInvoices);
    }
  });

  it('🔴 ومجموع مخزون الفروع = الإجمالي في كل مادة', async () => {
    const products = (await readAll('products')) as unknown as Array<{
      name: string; quantity: number; branchStock?: Record<string, number>;
    }>;
    for (const p of products) {
      const sum = Object.values(p.branchStock ?? {}).reduce((s, n) => s + n, 0);
      expect(sum, p.name).toBe(p.quantity);
    }
  });

  it('ولا مادة بمخزونٍ سالب', async () => {
    for (const p of (await readAll('products')) as unknown as Array<{ name: string; quantity: number }>) {
      expect(p.quantity, p.name).toBeGreaterThanOrEqual(0);
    }
  });

  it('🔴 وكل فاتورة: المدفوع + المتبقّي = الإجمالي', async () => {
    const invoices = (await readAll('invoices')) as unknown as Array<{
      invoiceNumber: string; finalAmount: number; paidAmount?: number; remainingAmount?: number;
    }>;
    expect(invoices.length, 'عدد فواتير المحل بعد كل الفصول').toBeGreaterThan(9);
    for (const i of invoices) {
      expect((i.paidAmount ?? i.finalAmount) + (i.remainingAmount ?? 0), `فاتورة ${i.invoiceNumber}`)
        .toBe(i.finalAmount);
    }
  });

  it('🔴 ولا رقم فاتورة مكرَّر في المحل كلّه', async () => {
    const numbers = ((await readAll('invoices')) as unknown as Array<{ invoiceNumber: string }>)
      .map(i => i.invoiceNumber);
    expect(new Set(numbers).size, 'رقمان متطابقان = خلافٌ مع زبون يوم يطالب بوصله')
      .toBe(numbers.length);
  });
});

// ═══════════════════════ ١٣) البيع بالجملة
/**
 * 🔴 القاعدة التي تُنسى: **سطر الجملة يُحاسَب بتكلفة الجملة**.
 *
 * خصم المورّد يجعل تكلفة الكرتون أقلّ من (تكلفة القطعة × عدد القطع). فلو حُوسب
 * سطر الجملة بتكلفة المفرد، ظهر ربحٌ أقلّ من الحقيقة — أو أكبر لو كان العكس.
 */
describe('١٣ · بيع بالجملة — الكرتون بتكلفته لا بتكلفة القطعة', () => {
  const BOX = { id: 'p_box', name: 'ماء صحّي', sellPiece: 500, sellBox: 5_000, buyPiece: 400, buyBox: 3_600, perBox: 12 };

  it('تُدخَل مادةٌ لها وحدة جملة وتكلفتان', async () => {
    const batch = writeBatch(db());
    batch.set(P.product(BOX.id), {
      id: BOX.id, name: BOX.name, barcode: '', sellPrice: BOX.sellPiece,
      quantity: 0, branchStock: { [BR]: 0 }, lowStockThreshold: 10,
      category: 'مشروبات', unit: 'قطعة', createdAt: '2026-08-25',
      hasWholesale: true, wholesaleUnitName: 'كارتون',
      wholesaleUnitQty: BOX.perBox, wholesalePrice: BOX.sellBox,
    });
    batch.set(P.cost(BOX.id), { id: BOX.id, buyPrice: BOX.buyPiece, wholesaleBuyPrice: BOX.buyBox });
    // شراء ١٠ كراتين = ١٢٠ قطعة
    batch.update(P.product(BOX.id), stockUpdate(BOX.perBox * 10, BR));
    await batch.commit();

    expect((await readOne(P.product(BOX.id)))?.quantity).toBe(120);
    const c = await readOne(P.cost(BOX.id));
    expect(c?.wholesaleBuyPrice, 'تكلفة الكرتون أقلّ من ١٢×٤٠٠=٤٨٠٠ بفضل خصم المورّد').toBe(3_600);
  });

  it('🔴 بيع كرتونين: الربح من تكلفة الكرتون لا من تكلفة القطعة', async () => {
    const before = await readAll('invoices');
    const baseline = salesProfit(before as never, costOfAll(await readAll('product_costs')));

    const batch = writeBatch(db());
    batch.set(P.invoice('inv_box'), {
      id: 'inv_box', invoiceNumber: allocateOwnerNumber(before as never, ''),
      customerName: 'زبون جملة',
      totalAmount: 10_000, discount: 0, tax: 0, finalAmount: 10_000,
      paidAmount: 10_000, remainingAmount: 0,
      payments: [{ method: CASH_METHOD, amount: 10_000 }],
      date: '2026-08-25', type: 'general', branchId: BR, createdAt: Date.now(),
      // 🔴 `unitConversionQty > 1` هو ما يجعل السطر «جملة»
      items: [{
        productId: BOX.id, name: `${BOX.name} - كارتون`,
        quantity: 2, price: BOX.sellBox, unitConversionQty: BOX.perBox,
      }],
    });
    batch.update(P.product(BOX.id), stockUpdate(-BOX.perBox * 2, BR));
    await batch.commit();

    const after = salesProfit(
      (await readAll('invoices')) as never,
      costOfAll(await readAll('product_costs')),
    );
    // (٥٠٠٠ − ٣٦٠٠) × ٢ = ٢٬٨٠٠
    expect(after.grossProfit - baseline.grossProfit, 'ربح الكرتونين بتكلفة الكرتون').toBe(2_800);
    // ولو حُوسب بتكلفة القطعة (٤٠٠×١٢=٤٨٠٠) لكان الربح ٤٠٠ فقط — أي أقلّ بسبعة أضعاف
    expect(after.grossProfit - baseline.grossProfit).not.toBe(400);
    expect(after.cogs - baseline.cogs, 'وتكلفة المباع ٣٦٠٠×٢').toBe(7_200);
  });

  it('والمخزون ينقص بالقطع لا بالكراتين', async () => {
    expect((await readOne(P.product(BOX.id)))?.quantity, '١٢٠ − ٢٤').toBe(96);
  });

  it('🔴 وسطر جملة بلا تكلفة جملة يُعزَل — لا يُستعاض بتكلفة المفرد', async () => {
    // مادةٌ لها سعر جملة ولا تكلفة جملة: يجب أن تُحسب «غير محتسبة»
    const costs = (await readAll('product_costs')).map(c =>
      c.id === BOX.id ? { id: c.id, buyPrice: BOX.buyPiece } : c);   // نزعنا wholesaleBuyPrice
    const r = salesProfit((await readAll('invoices')) as never, costOfAll(costs));
    expect(r.unknownCostSales, 'مبيعات الكرتونين ١٠٬٠٠٠ صارت غير محتسبة').toBeGreaterThanOrEqual(10_000);
  });
});

// ═══════════════════════ ١٤) الضمان والأرقام التسلسلية
describe('١٤ · ضمان وأرقام تسلسلية', () => {
  const PHONE = { id: 'p_phone', name: 'هاتف', sell: 300_000, buy: 250_000, warrantyMonths: 12 };

  it('بيعُ جهازٍ بسيريال وضمان سنة', async () => {
    const before = await readAll('invoices');
    const batch = writeBatch(db());
    batch.set(P.product(PHONE.id), {
      id: PHONE.id, name: PHONE.name, barcode: '', sellPrice: PHONE.sell,
      quantity: 0, branchStock: { [BR]: 0 }, lowStockThreshold: 1,
      category: 'كهربائيات', unit: 'جهاز', createdAt: '2026-08-25', hasWholesale: false,
      defaultWarrantyMonths: PHONE.warrantyMonths,
    });
    batch.set(P.cost(PHONE.id), { id: PHONE.id, buyPrice: PHONE.buy });
    batch.update(P.product(PHONE.id), stockUpdate(3, BR));
    batch.set(P.invoice('inv_phone'), {
      id: 'inv_phone', invoiceNumber: allocateOwnerNumber(before as never, ''),
      customerName: 'زبون الهاتف',
      totalAmount: PHONE.sell, discount: 0, tax: 0, finalAmount: PHONE.sell,
      paidAmount: PHONE.sell, remainingAmount: 0,
      payments: [{ method: CASH_METHOD, amount: PHONE.sell }],
      date: '2026-08-25', type: 'general', branchId: BR, createdAt: Date.now(),
      items: [{
        productId: PHONE.id, name: PHONE.name, quantity: 1, price: PHONE.sell,
        serials: ['IMEI-123456789'], warrantyMonths: PHONE.warrantyMonths,
      }],
    });
    batch.update(P.product(PHONE.id), stockUpdate(-1, BR));
    await batch.commit();

    expect((await readOne(P.product(PHONE.id)))?.quantity, '٣ − ١').toBe(2);
  });

  it('🔴 الضمان يُحسب بالتقويم — سنةٌ تنتهي بنفس اليوم لا بعد ٣٦٥ يوماً تقريبياً', () => {
    const w = warrantyStatus('2026-08-25', 12, '2026-08-25');
    expect(w.hasWarranty).toBe(true);
    expect(w.active).toBe(true);
    expect(w.expiryKey, 'نفس اليوم من العام التالي').toBe('2027-08-25');
  });

  it('وينتهي في يومه لا قبله', () => {
    expect(warrantyStatus('2026-08-25', 12, '2027-08-25').active, 'اليوم الأخير ما زال مشمولاً').toBe(true);
    expect(warrantyStatus('2026-08-25', 12, '2027-08-26').active, 'واليوم التالي خارجه').toBe(false);
  });

  it('🔴 وانزلاق الشهر لا يمدّ الضمان: ٣١ يناير + شهر ⟶ آخر فبراير لا ٣ مارس', () => {
    expect(warrantyStatus('2026-01-31', 1).expiryKey).toBe('2026-02-28');
  });

  it('🔴 والسيريال يُطابَق بالتطبيع — بحثٌ بحروفٍ صغيرة أو بمسافات يجده', async () => {
    const invoices = (await readAll('invoices')) as unknown as Invoice[];
    for (const query of ['IMEI-123456789', 'imei-123456789', ' IMEI-123456789 ']) {
      const hits = findSerial(invoices, query);
      expect(hits.length, `البحث بـ«${query}»`).toBe(1);
      expect(hits[0].invoiceNumber).toBeTruthy();
    }
  });

  it('وسيريالٌ لم يُبَع لا يُطابَق كذباً', async () => {
    const invoices = (await readAll('invoices')) as unknown as Invoice[];
    expect(findSerial(invoices, 'IMEI-000000000')).toHaveLength(0);
  });

  it('🔴 ولا يُباع السيريال نفسه مرّتين بلا كشف', async () => {
    const invoices = (await readAll('invoices')) as unknown as Invoice[];
    const counts = serialSaleCounts(invoices);
    expect(counts.get(normalizeSerial('IMEI-123456789')), 'بيعةٌ واحدة حتى الآن').toBe(1);
  });
});

// ═══════════════════════ ١٥) الصلاحية
describe('١٥ · شحنات الصلاحية — التنبيه يتكيّف مع عمر المادة', () => {
  it('🔴 مادةٌ قصيرة العمر تُنبِّه مبكّراً نسبةً لعمرها', () => {
    // حليب: استُلم اليوم وينتهي بعد ١٠ أيام
    const milk = { receivedDate: '2026-08-25', expiryDate: '2026-09-04' };
    const s = expiryStatus(milk, '2026-08-25');
    expect(s.lifeDays).toBe(10);
    expect(s.daysLeft).toBe(10);
    // حدّ التنبيه مشتقٌّ من العمر لا رقمٌ ثابت
    expect(s.alert.origin).toBe('auto');
  });

  it('ومادةٌ طويلة العمر لا تُنبِّه بنفس عدد الأيام', () => {
    const rice = { receivedDate: '2026-08-25', expiryDate: '2028-08-25' };
    const s = expiryStatus(rice, '2026-08-25');
    expect(s.stage, 'سنتان أمامها — لا داعي للقلق').toBe('ok');
    expect(s.alert.days, 'حدّها أوسع من حدّ الحليب').toBeGreaterThan(
      expiryStatus({ receivedDate: '2026-08-25', expiryDate: '2026-09-04' }, '2026-08-25').alert.days,
    );
  });

  it('🔴 والمنتهية تُصنَّف «expired» لا «صرّفها»', () => {
    const s = expiryStatus({ receivedDate: '2026-06-01', expiryDate: '2026-08-20' }, '2026-08-25');
    expect(s.stage).toBe('expired');
    expect(s.daysLeft, 'بالسالب — مضى عليها خمسة أيام').toBe(-5);
  });

  it('وتجاوز المادة يسبق الحساب التلقائي', () => {
    const batch = { receivedDate: '2026-08-25', expiryDate: '2026-12-25' };
    const s = expiryStatus(batch, '2026-08-25', { expiryAlertDays: 60, category: 'ألبان' });
    expect(s.alert.origin).toBe('product');
    expect(s.alert.days).toBe(60);
  });

  it('🔴 وشحنةٌ تُسجَّل في المحل تُقرأ كما كُتبت', async () => {
    await setDoc(doc(db(), 'users', OWNER, 'expiry_batches', 'exp1'), {
      id: 'exp1', productId: SUGAR.id, productName: SUGAR.name,
      expiryDate: '2026-12-31', receivedDate: '2026-08-25',
      quantity: 20, branchId: BR, status: 'active', createdAt: Date.now(),
    });
    const batches = (await readAll('expiry_batches')) as unknown as Array<{ quantity: number; expiryDate: string }>;
    expect(batches).toHaveLength(1);
    expect(batches[0].quantity).toBe(20);
  });
});

// ═══════════════════════ ١٦) إلغاء فاتورة شراء
describe('١٦ · إلغاء فاتورة شراء — العكس الكامل أو المنع', () => {
  /** رصيد المادة كما هو في قاعدة البيانات الآن — لا لقطةٌ محفوظة. */
  const stockReader = async () => {
    const products = (await readAll('products')) as unknown as Array<{ id: string; quantity: number }>;
    return (pid: string) => products.find(p => p.id === pid)?.quantity ?? null;
  };

  it('🔴 يُمنع الإلغاء إن بيعت البضاعة — لا مخزون سالب', async () => {
    /**
     * ⚠️ المتوفّر يُقرأ من قاعدة البيانات لا يُثبَّت رقماً: كل فصلٍ يُضاف إلى
     * القصّة يغيّره. أول كتابةٍ ثبّتُّ فيها ٨ فسقط الاختبار حين نمت القصّة.
     */
    const stockOfNow = await stockReader();
    const available = stockOfNow(RICE.id) ?? 0;
    const items = [{ productId: RICE.id, productName: RICE.name, quantity: available + 2, buyPrice: RICE.buy }];

    const shortages = cancellationShortages(items as never, stockOfNow);
    expect(shortages, 'يُطلب أكثر ممّا في الرفّ بقطعتين').toHaveLength(1);
    expect(shortages[0].needed).toBe(available + 2);
    expect(shortages[0].available).toBe(available);
  });

  it('ولا نقص إن كانت البضاعة كاملةً في المخزن', async () => {
    const items = [{ productId: SUGAR.id, productName: SUGAR.name, quantity: 50, buyPrice: SUGAR.buy }];
    expect(
      cancellationShortages(items as never, await stockReader()),
      'السكر المتبقّي أكثر من ٥٠',
    ).toHaveLength(0);
  });

  it('🔴 والتكلفة ترجع لفاتورة شراءٍ سابقة لا إلى صفر', async () => {
    const purchases = (await readAll('purchase_invoices')) as unknown as Array<{
      id: string; status: string; createdAt: number; items: Array<{ productId: string; buyPrice: number }>;
    }>;
    // لا فاتورة أخرى تحمل الرز ⟶ null (لا تُخترع تكلفة صفر)
    const restored = costAfterCancelling(purchases as never, 'pur1', RICE.id);
    expect(restored, 'غياب بديلٍ يعني «غير معروفة» لا «صفر»').toBeNull();
  });
});

// ═══════════════════════ ١٧) الأقساط
/**
 * 🔴 الكسور تُجمَّع في **القسط الأخير** فلا يضيع دينار ولا يزيد.
 * وثلاثة أقساطٍ من ١٠٠٬٠٠٠ لا تنقسم بالتساوي — والفرق يذهب للأخير لا يُهمَل.
 */
describe('١٧ · أقساط — الجدول يُطابق الإجمالي دائماً', () => {
  it('🔴 مجموع الأقساط = الإجمالي بالضبط مهما كان العدد', () => {
    for (const [total, n] of [[100_000, 3], [1_000_000, 7], [55_555, 4], [1, 3]] as const) {
      const rows = generateSchedule(total, n, 'monthly', '2026-08-25');
      expect(rows).toHaveLength(n);
      const sum = rows.reduce((s, r) => s + r.amount, 0);
      expect(sum, `${total} على ${n} أقساط`).toBe(total);
    }
  });

  it('والكسر يذهب للقسط الأخير لا يُهمَل', () => {
    const rows = generateSchedule(100_000, 3, 'monthly', '2026-08-25');
    expect(rows.map(r => r.amount), '٣٣٣٣٣ + ٣٣٣٣٣ + ٣٣٣٣٤').toEqual([33_333, 33_333, 33_334]);
  });

  it('المواعيد شهرية متتابعة من تاريخ البدء', () => {
    const rows = generateSchedule(90_000, 3, 'monthly', '2026-08-25');
    expect(rows.map(r => r.dueDate)).toEqual(['2026-08-25', '2026-09-25', '2026-10-25']);
  });

  it('والأسبوعية كل سبعة أيام', () => {
    const rows = generateSchedule(30_000, 3, 'weekly', '2026-08-25');
    expect(rows.map(r => r.dueDate)).toEqual(['2026-08-25', '2026-09-01', '2026-09-08']);
  });

  it('🔴 وخطةٌ مربوطة بفاتورة: الحالة تُشتقّ من الفاتورة لا من لقطةٍ محفوظة', async () => {
    const CUST = 'cust_aqsat';
    const TOTAL = 300_000, DOWN = 60_000;
    const schedule = generateSchedule(TOTAL - DOWN, 4, 'monthly', '2026-09-25');

    const before = await readAll('invoices');
    const batch = writeBatch(db());
    // 🔴 المحل يُعيد التخزين قبل بيعةٍ كبيرة — وإلا بِيع ما لا يملك.
    // (أول كتابةٍ لهذا الفصل باعت ١٢ والمتوفّر أقلّ، فهبط الرصيد سالباً وكشفه
    //  فصل المطابقة. السيناريو كان خاطئاً لا البرنامج — لكن انظر اختبار
    //  «المالك يُحذَّر ولا يُمنع» أدناه: البرنامج **يسمح** بذلك عمداً.)
    batch.update(P.product(RICE.id), stockUpdate(20, BR));
    batch.set(P.customer(CUST), {
      id: CUST, name: 'زبون الأقساط', phone: '', address: '', notes: '',
      balance: 0, dueDate: '', createdAt: '2026-08-25',
    });
    batch.set(P.invoice('inv_aqsat'), {
      id: 'inv_aqsat', invoiceNumber: allocateOwnerNumber(before as never, ''),
      customerName: 'زبون الأقساط', customerId: CUST,
      totalAmount: TOTAL, discount: 0, tax: 0, finalAmount: TOTAL,
      paidAmount: DOWN, remainingAmount: TOTAL - DOWN,
      payments: [{ method: CASH_METHOD, amount: DOWN }],
      date: '2026-08-25', type: 'general', branchId: BR, createdAt: Date.now(),
      items: [{ productId: RICE.id, name: RICE.name, quantity: 12, price: 25_000 }],
    });
    batch.set(doc(db(), 'users', OWNER, 'installment_plans', 'plan1'), {
      id: 'plan1', invoiceId: 'inv_aqsat', customerId: CUST, customerName: 'زبون الأقساط',
      totalAmount: TOTAL - DOWN, downPayment: DOWN, schedule,
      frequency: 'monthly', createdAt: Date.now(),
    });
    batch.update(P.product(RICE.id), stockUpdate(-12, BR));
    batch.update(P.customer(CUST), { balance: increment(TOTAL - DOWN) });
    await batch.commit();

    const plan = (await readOne(doc(db(), 'users', OWNER, 'installment_plans', 'plan1'))) as unknown as {
      totalAmount: number; downPayment: number; schedule: typeof schedule;
    };
    const invoice = (await readOne(P.invoice('inv_aqsat'))) as unknown as {
      finalAmount: number; paidAmount?: number; remainingAmount?: number;
    };
    const st = planStatus(plan, invoice as never, '2026-08-25');

    expect(st.total, 'المقسَّط = الفاتورة − المقدَّم').toBe(240_000);
    expect(st.paidTotal, 'لم يُسدَّد قسطٌ بعد').toBe(0);
    expect(st.remaining).toBe(240_000);
  });

  it('🔴 وتسديد قسطٍ ينعكس على الخطة فوراً — لأنها تقرأ الفاتورة', async () => {
    // القسط الأول ٦٠٬٠٠٠
    const batch = writeBatch(db());
    batch.update(P.invoice('inv_aqsat'), {
      paidAmount: increment(60_000), remainingAmount: increment(-60_000),
    });
    batch.update(P.customer('cust_aqsat'), { balance: increment(-60_000) });
    await batch.commit();

    const plan = (await readOne(doc(db(), 'users', OWNER, 'installment_plans', 'plan1'))) as never;
    const invoice = (await readOne(P.invoice('inv_aqsat'))) as never;
    const st = planStatus(plan, invoice, '2026-08-25');

    expect(st.paidTotal, 'القسط الأول دخل').toBe(60_000);
    expect(st.remaining).toBe(180_000);
  });

  it('وفاتورةٌ مفقودة لا تُقرأ «مسدَّدة» — تُعلَن مفقودة', () => {
    const plan = { totalAmount: 240_000, downPayment: 60_000, schedule: [] };
    const st = planStatus(plan, null, '2026-08-25');
    expect(st.staleKind, 'الصمت هنا كذبٌ — يجب التصريح').toBe('missing');
    expect(st.paidTotal, 'لا نزعم سداداً لا نعرفه').toBe(0);
  });
});

// ═══════════════════════ ١٨) المطابقة الكبرى بعد كل شيء
describe('١٨ · المطابقة الكبرى — بعد ثمانية عشر فصلاً', () => {
  it('🔴 لا مادة بمخزون سالب في المحل كلّه', async () => {
    const products = (await readAll('products')) as unknown as Array<{ name: string; quantity: number }>;
    expect(products.length).toBeGreaterThanOrEqual(6);
    for (const p of products) expect(p.quantity, p.name).toBeGreaterThanOrEqual(0);
  });

  it('🔴 ومجموع مخزون الفروع = الإجمالي لكل مادة', async () => {
    const products = (await readAll('products')) as unknown as Array<{
      name: string; quantity: number; branchStock?: Record<string, number>;
    }>;
    for (const p of products) {
      const sum = Object.values(p.branchStock ?? {}).reduce((s, n) => s + n, 0);
      expect(sum, p.name).toBe(p.quantity);
    }
  });

  it('🔴 ورصيد كل زبون = مجموع متبقّي فواتيره', async () => {
    const customers = (await readAll('customers')) as unknown as Array<{ id: string; name: string; balance: number }>;
    const invoices = (await readAll('invoices')) as unknown as Array<{ customerId?: string; remainingAmount?: number }>;
    for (const c of customers) {
      const fromInvoices = invoices
        .filter(i => i.customerId === c.id)
        .reduce((s, i) => s + (i.remainingAmount ?? 0), 0);
      expect(c.balance, `رصيد «${c.name}»`).toBe(fromInvoices);
    }
  });

  it('🔴 وكل فاتورة: المدفوع + المتبقّي = الإجمالي', async () => {
    const invoices = (await readAll('invoices')) as unknown as Array<{
      invoiceNumber: string; finalAmount: number; paidAmount?: number; remainingAmount?: number;
    }>;
    for (const inv of invoices) {
      const paid = inv.paidAmount ?? inv.finalAmount;
      const rem = inv.remainingAmount ?? 0;
      expect(paid + rem, `فاتورة ${inv.invoiceNumber}`).toBe(inv.finalAmount);
    }
  });

  it('ولا رقم فاتورة مكرَّر', async () => {
    const numbers = ((await readAll('invoices')) as unknown as Array<{ invoiceNumber: string }>)
      .map(i => i.invoiceNumber);
    expect(new Set(numbers).size, 'رقمان متطابقان = خلافٌ مع زبون').toBe(numbers.length);
  });
});

// ═══════════════════════ ١٩) البيع بلا رصيد — الفرق بين المالك والموظف
/**
 * 🔴 وجدتُ هذا أثناء الفحص: الشاشتان تتصرّفان **تصرّفاً مختلفاً** أمام بيعٍ
 * يتجاوز المخزون، ولا يوجد في المشروع ما يوثّق الفرق أو يحرسه.
 *
 *   · **الموظف** — يُرَدّ: `if (baseQty > stockOf(...)) return "…متوفر كذا"`.
 *   · **المالك** — يُحذَّر ثم **يمرّ**: `triggerAlert('تحذير: …')` بلا `return`.
 *
 * والفرق معقولٌ تجارياً: بضاعةٌ وصلت المحل ولم تُدخَل بعد، فيبيعها صاحبها ثم
 * يُصحّح الجرد. أمّا الموظف فلا يجوز أن يخلق بضاعةً من عدم.
 *
 * والقواعد تُقرّ ذلك صراحةً: تعليقها يقول إن `<=` «يمنع الزيادة ولا يمنع
 * النزول بلا قاع». أي أن الرصيد السالب **مسموحٌ عن قصد** لا عن سهو.
 *
 * ⚠️ لكن سلوكاً مقصوداً بلا حارس هو سلوكٌ ينقلب بأول إعادة صياغة. وهذا الاختبار
 * يُثبّت الفرق: من يُبدّله سيراه يسقط فيقرّر بوعي.
 */
describe('١٩ · تجاوز المخزون: المالك يُحذَّر والموظف يُمنع', () => {
  const read = (file: string) =>
    readFileSync(join(process.cwd(), 'src', 'components', file), 'utf8');

  it('🔴 الموظف: الفحص يَرُدّ الفاتورة برسالةٍ تذكر المتوفّر', () => {
    const emp = read('EmployeeInvoicesView.tsx');
    expect(emp, 'المقارنة بمخزون فرعه هو').toContain('baseQty > stockOf(product, employeeBranchId)');
    expect(emp).toMatch(/متوفر \$\{toArabicDigits\(stockOf/);
  });

  it('🔴 والمالك: تحذيرٌ بلا منع — والكلمة «تحذير» تقولها للتاجر', () => {
    const own = read('InvoicesView.tsx');
    expect(own).toContain('const stockWarnings = checkStockWarnings(items);');
    // النصّ يبدأ بـ«تحذير» لا بـ«لا يمكن» — فالرسالة صادقة مع السلوك
    expect(own).toContain('تحذير: كمية تتجاوز المخزون');
  });

  it('🔴 والقواعد تسمح بالنزول ولا تسمح بالتضخيم', () => {
    const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');
    // بيعُ الموظف ينقص الإجمالي — والقاعدة تمنع أي زيادة
    expect(rules).toContain('request.resource.data.quantity <= resource.data.quantity');
  });

  it('والمحصّلة في الدفاتر: رصيدٌ سالب ممكنٌ ويجب أن يُرى لا أن يُخفى', async () => {
    const products = (await readAll('products')) as unknown as Array<{ name: string; quantity: number }>;
    // في قصّتنا لم نُجاوز — لكن البنية تسمح، فالمطابقة تكشفه لو حدث
    const negatives = products.filter(p => p.quantity < 0);
    expect(negatives.map(p => p.name), 'لا سالب في هذه القصّة').toEqual([]);
  });
});
