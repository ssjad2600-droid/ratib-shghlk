/**
 * حساب الربح — **مصدر حقيقة واحد** لكل شاشة تعرض رقم ربح.
 *
 * 🔴🔴 العلّة التي وُلد منها هذا الملف: شاشة «المصاريف والأرباح» كانت تحسب
 *
 *     الربح الصافي = المبيعات − المصاريف
 *
 * **بلا تكلفة البضاعة المباعة إطلاقاً**. قِسْتُها على بيانات معلومة النتيجة: مادة تكلفتها
 * ٨٬٠٠٠ تُباع بـ١٠٬٠٠٠، بيع ١٠٠ قطعة، ومصروف ١٠٠ ألف. الحقيقة ربحٌ صافٍ ١٠٠٬٠٠٠،
 * والشاشة تعرض **٩٠٠٬٠٠٠** — تسعة أضعاف. وبهامش ربح واقعي (٢٠٪) يصير المعروض خمسة
 * أضعاف الحقيقي دائماً.
 *
 * وشاشة التقارير كانت تحسبها **صحيحةً** في الملف المجاور. فكان في البرنامج رقما ربحٍ
 * متناقضان، الفارق بينهما تكلفة البضاعة كلها — والتاجر يبني على المتضخّم منهما: يوسّع،
 * يستدين، يسحب لنفسه، على ربحٍ لا وجود له.
 *
 * ⚖️ القواعد الثلاث التي يحكم بها هذا الملف (منقولة عن حساب التقارير الصحيح):
 *
 *  ١) **التكلفة المجهولة تُستثنى ولا تُخمَّن.** مادة بلا سعر شراء: مبيعاتها تُبوَّب
 *     «غير محتسبة» ولا تدخل الربح. لأن اعتبار تكلفتها صفراً يعني «بضاعة مجانية» فيصير
 *     كل بيعها ربحاً — وهو أخطر من الجهل بها. (نفس القاعدة في قيمة المخزون والخسائر.)
 *
 *  ٢) **سطر الجملة يُحاسَب بتكلفة الجملة.** خصم المورد يجعل تكلفة الكرتون ≠ تكلفة القطعة.
 *     وغياب `wholesaleBuyPrice` يجعل السطر غير محتسب ولو كانت تكلفة المفرد معروفة.
 *
 *  ٣) **الخصم يُوزَّع بالنسبة** على الربح المعروف، فلا يُطرح كاملاً من ربحٍ جزئي.
 */

export interface ProfitLine {
  productId?: string;
  itemId?: string;
  name?: string;
  quantity: number;
  price: number;
  /** > ١ يعني سطر بيع بالجملة (الاسم والسعر والكمية كلها بوحدة الجملة) */
  unitConversionQty?: number;
}

export interface ProfitInvoice {
  id: string;
  finalAmount?: number;
  totalAmount?: number;
  discount?: number;
  paidAmount?: number;
  items?: ProfitLine[];
}

/** تُرجع تكلفة الوحدة، أو `undefined` إن كانت مجهولة. لا تُرجع صفراً للمجهول أبداً. */
export type CostLookup = (line: ProfitLine) => number | undefined;

export interface ProfitResult {
  /** حجم المبيعات (أساس استحقاق) */
  sales: number;
  /** المحصَّل فعلاً (أساس نقدي) */
  collected: number;
  /** الربح الإجمالي على معروفة التكلفة فقط */
  grossProfit: number;
  /** تكلفة البضاعة المباعة — لمعروفة التكلفة فقط */
  cogs: number;
  /** مبيعات مواد بلا سعر شراء — مستثناة من الربح كي لا يتضخّم */
  unknownCostSales: number;
  /** عدد الفواتير المحسوبة */
  invoiceCount: number;
}

const EMPTY: ProfitResult = {
  sales: 0, collected: 0, grossProfit: 0, cogs: 0, unknownCostSales: 0, invoiceCount: 0,
};

/** ربح فاتورة واحدة. */
export function invoiceProfit(inv: ProfitInvoice, costOf: CostLookup): ProfitResult {
  const finalAmount = inv.finalAmount ?? 0;
  const collected = inv.paidAmount ?? finalAmount;

  // فاتورة بلا بنود (بيانات قديمة/مستوردة): لا نعرف ما بِيع فلا نعرف تكلفته
  if (!inv.items || inv.items.length === 0) {
    return { ...EMPTY, sales: finalAmount, collected, unknownCostSales: finalAmount, invoiceCount: 1 };
  }

  let knownProfit = 0;
  let cogs = 0;
  let unknownCostSales = 0;

  for (const line of inv.items) {
    const qty = Number(line.quantity) || 0;
    const price = Number(line.price) || 0;
    const cost = costOf(line);
    if (cost !== undefined && Number.isFinite(cost) && cost >= 0) {
      knownProfit += (price - cost) * qty;
      cogs += cost * qty;
    } else {
      unknownCostSales += price * qty;
    }
  }

  // الخصم يُوزَّع بالنسبة على الربح المعروف — لا يُطرح كاملاً من ربحٍ جزئي
  const total = inv.totalAmount ?? 0;
  const discount = inv.discount ?? 0;
  if (total > 0 && knownProfit > 0 && discount > 0) {
    knownProfit *= 1 - discount / total;
  }

  return { sales: finalAmount, collected, grossProfit: knownProfit, cogs, unknownCostSales, invoiceCount: 1 };
}

/** يجمع ربح مجموعة فواتير. */
export function salesProfit(invoices: ProfitInvoice[], costOf: CostLookup): ProfitResult {
  return invoices.reduce<ProfitResult>((acc, inv) => {
    const r = invoiceProfit(inv, costOf);
    return {
      sales: acc.sales + r.sales,
      collected: acc.collected + r.collected,
      grossProfit: acc.grossProfit + r.grossProfit,
      cogs: acc.cogs + r.cogs,
      unknownCostSales: acc.unknownCostSales + r.unknownCostSales,
      invoiceCount: acc.invoiceCount + r.invoiceCount,
    };
  }, { ...EMPTY });
}

export interface NetProfitResult extends ProfitResult {
  /** إيرادات يدوية (خارج الفواتير) */
  manualRevenue: number;
  /** مصاريف الفترة */
  expenses: number;
  /**
   * 🔴 الربح الصافي الحقيقي: **الربح الإجمالي** (بعد تكلفة البضاعة) + الإيرادات اليدوية
   * − المصاريف. لا «المبيعات − المصاريف».
   */
  netProfit: number;
}

/** الربح الصافي لفترة — الحساب الوحيد المعتمد في كل الشاشات. */
export function netProfitOf(
  invoices: ProfitInvoice[],
  transactions: Array<{ type: 'revenue' | 'expense'; amount: number }>,
  costOf: CostLookup,
): NetProfitResult {
  const base = salesProfit(invoices, costOf);
  const manualRevenue = transactions
    .filter(t => t.type === 'revenue')
    .reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const expenses = transactions
    .filter(t => t.type === 'expense')
    .reduce((s, t) => s + (Number(t.amount) || 0), 0);
  return {
    ...base,
    manualRevenue,
    expenses,
    netProfit: base.grossProfit + manualRevenue - expenses,
  };
}

/**
 * يبني دالة التكلفة من أسعار الشراء — تحترم القاعدتين ١ و٢.
 * @param findProduct كيف يُعثر على المنتج من سطر البيع (يختلف بين الشاشات)
 */
export function costLookup<P>(
  findProduct: (line: ProfitLine) => P | undefined,
  buyPriceOf: (p: P) => number | undefined,
  wholesaleBuyPriceOf: (p: P) => number | undefined,
): CostLookup {
  return (line) => {
    const product = findProduct(line);
    if (!product) return undefined;
    const isWholesaleLine = (line.unitConversionQty ?? 1) > 1;
    return isWholesaleLine ? wholesaleBuyPriceOf(product) : buyPriceOf(product);
  };
}
