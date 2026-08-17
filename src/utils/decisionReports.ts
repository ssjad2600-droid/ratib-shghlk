import { Invoice, Product, Customer } from '../types';
import { stockOf } from './branchStock';

/**
 * محرّك «تقارير القرار» — طبقة حساب واحدة تغذّي كل التقارير.
 *
 * مبادئ ثابتة (نفس انضباط بقية البرنامج):
 *  ١. كل رقم **مشتقّ** من الفواتير والمنتجات الحيّة — لا جداول ملخّصات ولا عدّادات تنحرف.
 *  ٢. التكلفة غير المعروفة **لا تُخمَّن أبداً**؛ تُبوَّب في `unknownRevenue` وتُعرض منفصلة.
 *  ٣. المرتجعات محسوبة تلقائياً: عملية الإرجاع تُعيد كتابة بنود الفاتورة بالكميات المتبقّية،
 *     فأي تجميع من `invoice.items` صافٍ من المرتجع بلا أي معالجة إضافية.
 *  ٤. قراءة محضة — لا كتابة، فتعمل أوفلاين وبلا أي خطر على البيانات.
 */

// ---------------------------------------------------------------- تجميع المبيعات

export interface SalesAgg {
  productId: string;
  name: string;
  unit: string;
  category: string;
  qty: number;             // عدد الوحدات المباعة (بوحدة الأساس)
  revenue: number;         // قيمة المبيعات
  knownProfit: number;     // ربح البنود ذات التكلفة المعروفة
  unknownRevenue: number;  // مبيعات بلا تكلفة معروفة — لا تُخمَّن
  lastSaleDate: string;    // آخر يوم بِيعت فيه (فارغ = لم تُبَع في المدى)
  invoiceCount: number;
}

type CostFn = (p: Product) => number | undefined;

/** مطابقة بند فاتورة بمنتج — نفس منطق بقية الشاشات (معرّف ثم اسم). */
const findProduct = (products: Product[], item: Invoice['items'][number]): Product | undefined =>
  products.find(p => p.id === (item.productId || item.itemId) || p.name === item.name);

/**
 * يجمّع مبيعات كل منتج خلال الفواتير الممرَّرة (بعد فلترتها بالفرع/الفترة من المستدعي).
 * الخصم يُوزَّع تناسبياً على ربح الفاتورة — كما في شاشة التقارير تماماً.
 */
export function aggregateSales(
  invoices: Invoice[],
  products: Product[],
  buyPriceOf: CostFn,
  wholesaleBuyPriceOf: CostFn,
): Map<string, SalesAgg> {
  const map = new Map<string, SalesAgg>();

  for (const inv of invoices) {
    const discRatio = inv.totalAmount > 0 && inv.discount > 0 ? inv.discount / inv.totalAmount : 0;
    const countedInThisInvoice = new Set<string>();   // كل مادة تُعدّ مرّةً لكل فاتورة

    for (const item of inv.items || []) {
      const product = findProduct(products, item);
      if (!product) continue; // بند حرّ بلا منتج مسجَّل — لا يدخل تقارير المنتجات
      const key = product.id;

      let agg = map.get(key);
      if (!agg) {
        agg = {
          productId: product.id, name: product.name, unit: product.unit || 'قطعة',
          category: product.category || 'بلا فئة',
          qty: 0, revenue: 0, knownProfit: 0, unknownRevenue: 0, lastSaleDate: '', invoiceCount: 0,
        };
        map.set(key, agg);
      }

      // سطر جملة يُوثَّق بـ unitConversionQty > 1 ⇒ الكمية بوحدة الأساس، والتكلفة تكلفة الجملة
      const conv = item.unitConversionQty ?? 1;
      const isWholesaleLine = conv > 1;
      const lineRevenue = item.price * item.quantity * (1 - discRatio);
      const cost = isWholesaleLine ? wholesaleBuyPriceOf(product) : buyPriceOf(product);

      agg.qty += item.quantity * conv;
      agg.revenue += lineRevenue;
      // 🟠 كان `+= 1` داخل حلقة **البنود**، فمادة تظهر سطرين في فاتورة واحدة تُحسب
      // فاتورتين. الاسم يَعِد بعدد فواتير والقيمة كانت عدد أسطر.
      if (!countedInThisInvoice.has(key)) {
        agg.invoiceCount += 1;
        countedInThisInvoice.add(key);
      }
      if (inv.date > agg.lastSaleDate) agg.lastSaleDate = inv.date;

      if (cost !== undefined && cost >= 0) {
        agg.knownProfit += (item.price - cost) * item.quantity * (1 - discRatio);
      } else {
        agg.unknownRevenue += lineRevenue;
      }
    }
  }

  return map;
}

// ---------------------------------------------------------------- ١. الأصناف الراكدة

export interface DeadStockRow {
  product: Product;
  stock: number;
  lastSaleDate: string;   // فارغ = لم تُبَع إطلاقاً ضمن المدى المفحوص
  daysIdle: number | null; // null = لم تُبَع إطلاقاً
  frozenCapital: number;   // بسعر الشراء — الرقم الذي يُحرّك التاجر
  costKnown: boolean;
}

/**
 * مادة راكدة = عندها رصيد في الموقع، ولم تُبَع منها قطعة خلال `days` يوماً.
 * رأس المال المجمّد يُحسب **بسعر الشراء** لا البيع — لأن هذا هو المال الذي دفعتَه فعلاً ونام.
 */
export function deadStock(
  products: Product[],
  salesInWindow: Map<string, SalesAgg>,
  buyPriceOf: CostFn,
  branchId: string | undefined,
  todayKey: string,
): DeadStockRow[] {
  const rows: DeadStockRow[] = [];
  for (const p of products) {
    const stock = branchId ? stockOf(p, branchId) : (p.quantity ?? 0);
    if (stock <= 0) continue;
    const agg = salesInWindow.get(p.id);
    if (agg && agg.qty > 0) continue; // بِيعت خلال المدة ⇒ ليست راكدة

    const cost = buyPriceOf(p);
    rows.push({
      product: p,
      stock,
      lastSaleDate: '',
      daysIdle: null,
      frozenCapital: cost !== undefined ? cost * stock : 0,
      costKnown: cost !== undefined,
    });
  }
  return rows.sort((a, b) => b.frozenCapital - a.frozenCapital || b.stock - a.stock);
}

/** آخر تاريخ بيع لكل منتج عبر **كل** التاريخ — لعرض «راكد منذ كم يوماً». */
export function lastSaleMap(invoices: Invoice[], products: Product[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const inv of invoices) {
    for (const item of inv.items || []) {
      const p = findProduct(products, item);
      if (!p) continue;
      const prev = m.get(p.id) ?? '';
      if (inv.date > prev) m.set(p.id, inv.date);
    }
  }
  return m;
}

/** فرق الأيام بين تاريخين بصيغة YYYY-MM-DD (موجب = الأول أقدم). */
export function daysBetween(fromKey: string, toKey: string): number {
  const a = new Date(`${fromKey}T00:00:00`);
  const b = new Date(`${toKey}T00:00:00`);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// ---------------------------------------------------------------- ٢. قيمة المخزون

export interface InventoryValue {
  costValue: number;        // رأس المال المجمّد (بسعر الشراء) — للمواد معروفة التكلفة فقط
  sellValue: number;        // المتوقّع لو بِيع كل المخزون (سعر البيع معروف دائماً)
  latentProfit: number;     // الربح الكامن — يُحسب على معروفة التكلفة **فقط**
  units: number;
  productCount: number;
  unknownCostCount: number; // مواد بلا سعر شراء — قيمتها الشرائية غير محتسبة
  unknownCostUnits: number;
  unknownCostSellValue: number; // قيمتها البيعية — مستثناة من الربح الكامن لئلا يتضخّم
}

export function inventoryValue(
  products: Product[],
  buyPriceOf: CostFn,
  branchId: string | undefined,
): InventoryValue {
  const v: InventoryValue = {
    costValue: 0, sellValue: 0, latentProfit: 0, units: 0,
    productCount: 0, unknownCostCount: 0, unknownCostUnits: 0, unknownCostSellValue: 0,
  };
  for (const p of products) {
    const stock = branchId ? stockOf(p, branchId) : (p.quantity ?? 0);
    if (stock <= 0) continue;
    const lineSell = stock * (p.sellPrice || 0);
    v.productCount += 1;
    v.units += stock;
    v.sellValue += lineSell;
    const cost = buyPriceOf(p);
    if (cost !== undefined && cost >= 0) v.costValue += stock * cost;
    else { v.unknownCostCount += 1; v.unknownCostUnits += stock; v.unknownCostSellValue += lineSell; }
  }
  // 🔴 الربح الكامن على معروفة التكلفة **فقط**: لو طرحنا تكلفة معروفة من قيمة بيع تشمل
  // مواد مجهولة التكلفة، لظهر ربح وهمي بمقدار قيمة تلك المواد كاملة. لا نُخمّن ولا نُجمّل.
  v.latentProfit = (v.sellValue - v.unknownCostSellValue) - v.costValue;
  return v;
}

export interface CategoryValueRow {
  category: string;
  costValue: number;
  sellValue: number;
  units: number;
  count: number;
  /** مواد الفئة بلا سعر شراء — قيمتها الشرائية **غير محتسبة** في costValue */
  unknownCostCount: number;
  unknownCostUnits: number;
}

/**
 * قيمة المخزون مجمّعة حسب الفئة — لمعرفة أين يقف رأس مالك.
 *
 * 🔴 كان السطر `row.costValue += cost !== undefined ? cost * stock : 0;` — أي أن المادة
 * المجهولة التكلفة تُضاف بصفر، فتُعرض فئةٌ كاملة بلا أسعار شراء برأس مال **صفر** كأنها
 * لا تحوي مالاً، ولا عدّاد ينبّه. وهو النمط الذي يمنعه هذا المشروع صراحةً، ومُطبَّق
 * بصورته الصحيحة في `inventoryValue` أعلاه في هذا الملف نفسه — فتناقض الرقمان.
 * (وحارس `inventoryWorth` يمنع `?? 0`، والصيغة الثلاثية تسلّلت من تحته.)
 */
export function inventoryByCategory(
  products: Product[],
  buyPriceOf: CostFn,
  branchId: string | undefined,
): CategoryValueRow[] {
  const m = new Map<string, CategoryValueRow>();
  for (const p of products) {
    const stock = branchId ? stockOf(p, branchId) : (p.quantity ?? 0);
    if (stock <= 0) continue;
    const key = p.category?.trim() || 'بلا فئة';
    const row = m.get(key) ?? {
      category: key, costValue: 0, sellValue: 0, units: 0, count: 0,
      unknownCostCount: 0, unknownCostUnits: 0,
    };
    const cost = buyPriceOf(p);
    if (cost !== undefined && cost >= 0) row.costValue += cost * stock;
    else { row.unknownCostCount += 1; row.unknownCostUnits += stock; }
    row.sellValue += stock * (p.sellPrice || 0);
    row.units += stock;
    row.count += 1;
    m.set(key, row);
  }
  return [...m.values()].sort((a, b) => b.costValue - a.costValue);
}

// ---------------------------------------------------------------- ٣. أيام التغطية والدوران

export interface CoverageRow {
  product: Product;
  stock: number;
  soldQty: number;         // خلال الفترة
  avgPerDay: number;
  coverageDays: number | null; // null = لا مبيعات ⇒ تغطية لا نهائية (راكد)
  turnover: number | null;     // تقريبي — انظر التعليق أدناه
}

/**
 * «أيام التغطية» = الرصيد ÷ متوسط البيع اليومي. يُحسب **بدقّة تامة** من بياناتك،
 * ويقول لصاحب المحل مباشرة: «هذه المادة تكفي ٤ أيام — اطلبها الآن».
 *
 * أما «معدل الدوران» المحاسبي فيحتاج **متوسط** المخزون عبر الفترة، ونحن نخزّن الرصيد
 * الحالي فقط (لا لقطات تاريخية). فنقدّره تقديراً مبدئياً سليماً بدل القسمة على الرصيد الحالي:
 *
 *   متوسط المخزون ≈ (أول المدة + آخرها) ÷ ٢، وأول المدة ≈ الرصيد الحالي + المُباع
 *   ⟵ المتوسط ≈ الرصيد + (المُباع ÷ ٢)
 *
 * 🟠 ولماذا غيّرناه: `المُباع ÷ الرصيد الحالي` غير محدود من أعلى — مادة رصيدها ١ وبِيع
 * منها ٥٠٠ تعطي «٥٠٠×» فتتصدّر أي ترتيب وتُربك القراءة كلها. الصيغة الجديدة محدودة
 * ببنيتها (أقلّ من ٢ دائماً) وأقرب إلى المعنى المحاسبي، وتبقى **تقريبية** كما هي مُعلنة.
 */
export function coverage(
  products: Product[],
  sales: Map<string, SalesAgg>,
  branchId: string | undefined,
  periodDays: number,
): CoverageRow[] {
  const days = Math.max(1, periodDays);
  return products.map(p => {
    const stock = branchId ? stockOf(p, branchId) : (p.quantity ?? 0);
    const soldQty = sales.get(p.id)?.qty ?? 0;
    const avgPerDay = soldQty / days;
    const avgInventory = stock + soldQty / 2;   // تقدير متوسط المخزون عبر الفترة
    return {
      product: p,
      stock,
      soldQty,
      avgPerDay,
      coverageDays: avgPerDay > 0 ? stock / avgPerDay : null,
      turnover: avgInventory > 0 ? soldQty / avgInventory : null,
    };
  });
}

// ---------------------------------------------------------------- ٤. أفضل العملاء

export interface CustomerRow {
  customer: Customer;
  purchases: number;      // إجمالي قيمة فواتيره خلال الفترة
  collected: number;      // ما سدّده من تلك الفواتير
  profit: number;         // الربح المحقّق منه (تكاليف معروفة فقط)
  unknownProfitSales: number;
  debt: number;           // رصيده الحالي (لقطة، غير مقيَّد بالفترة)
  payRatio: number | null; // المحصَّل ÷ المفوتر — null إن لم يشترِ
  invoiceCount: number;
  lastPurchase: string;
  daysSincePurchase: number | null;
}

export function topCustomers(
  customers: Customer[],
  invoices: Invoice[],
  products: Product[],
  buyPriceOf: CostFn,
  wholesaleBuyPriceOf: CostFn,
  todayKey: string,
): CustomerRow[] {
  const byId = new Map<string, CustomerRow>();
  const keyOf = (c: Customer) => c.id;
  for (const c of customers) {
    byId.set(keyOf(c), {
      customer: c, purchases: 0, collected: 0, profit: 0, unknownProfitSales: 0,
      debt: c.balance > 0 ? c.balance : 0, payRatio: null, invoiceCount: 0,
      lastPurchase: '', daysSincePurchase: null,
    });
  }

  /**
   * مطابقة الفاتورة بالزبون: بالمعرّف أولاً، وإلا بالاسم (فواتير قديمة تحمل الاسم فقط).
   *
   * 🟠 والاسم المكرَّر **لا يُحسم بالتخمين**: كان `byName.set(...)` يجعل الأخير يبتلع
   * الأول، فتُنسب فواتير «محمد علي» الأول إلى الثاني — فيظهر أحدهما بمشتريات ليست له
   * والآخر بلا شيء. وفي تقرير يُرتّب الزبائن، **النسبة الخاطئة أسوأ من الإغفال**:
   * فنُسقط الاسم الملتبس من المطابقة ونكتفي بالمعرّف.
   */
  const byName = new Map<string, CustomerRow | null>();   // null = اسم ملتبس
  for (const row of byId.values()) {
    const key = row.customer.name.trim().toLowerCase();
    byName.set(key, byName.has(key) ? null : row);
  }

  for (const inv of invoices) {
    const row = (inv.customerId && byId.get(inv.customerId))
      || byName.get((inv.customerName || '').trim().toLowerCase());
    if (!row) continue;

    row.purchases += inv.finalAmount || 0;
    row.collected += inv.paidAmount ?? inv.finalAmount ?? 0;
    row.invoiceCount += 1;
    if (inv.date > row.lastPurchase) row.lastPurchase = inv.date;

    const discRatio = inv.totalAmount > 0 && inv.discount > 0 ? inv.discount / inv.totalAmount : 0;
    for (const item of inv.items || []) {
      const p = findProduct(products, item);
      const conv = item.unitConversionQty ?? 1;
      const cost = p ? (conv > 1 ? wholesaleBuyPriceOf(p) : buyPriceOf(p)) : undefined;
      const lineRevenue = item.price * item.quantity * (1 - discRatio);
      if (cost !== undefined && cost >= 0) row.profit += (item.price - cost) * item.quantity * (1 - discRatio);
      else row.unknownProfitSales += lineRevenue;
    }
  }

  for (const row of byId.values()) {
    row.payRatio = row.purchases > 0 ? row.collected / row.purchases : null;
    row.daysSincePurchase = row.lastPurchase ? daysBetween(row.lastPurchase, todayKey) : null;
  }

  return [...byId.values()];
}

export type CustomerBadge = 'ذهبي' | 'خطر ائتماني' | 'مفقود' | 'جديد' | 'عادي';

/**
 * تصنيف الزبون بمقياس مركّب — لأن «الأكثر شراءً» ليس «الأفضل».
 * زبون يشتري بعشرة ملايين ولا يسدّد هو أسوأ زبون لا أفضله.
 */
export function customerBadge(r: CustomerRow, lostAfterDays = 90): CustomerBadge {
  /**
   * 🔴 لا حُكمَ ائتماني بلا دليل من الفترة نفسها.
   *
   * كان: `invoiceCount === 0 ⇒ debt > 0 ? 'خطر ائتماني' : 'جديد'`. و`invoiceCount` يُحسب
   * من فواتير **الفترة المختارة** بينما `debt` لقطةُ عمرٍ كامل — فأي مدينٍ لم يشترِ خلال
   * الفترة كان يُوصَم «خطر ائتماني». قِسْتُ نفس الزبون: بفترة ٩٠ يوماً «ذهبي» وبـ٣٠ يوماً
   * «خطر ائتماني». زرُّ فترةٍ لا يغيّر أخلاق الزبون.
   *
   * والوصف يُبنى عليه قرار: التاجر يقرأه فيمنع الآجل عن أفضل زبائنه. فحين لا تكون في
   * الفترة أي فاتورة، لا دليل على السداد أصلاً ⟵ لا نحكم. والدَّين يظهر في عموده وحده.
   */
  if (r.invoiceCount === 0) return r.debt > 0 ? 'عادي' : 'جديد';
  // خطر: دين قائم مع سدادٍ ضعيف **مُثبَت** بفواتير الفترة
  if (r.debt > 0 && (r.payRatio ?? 1) < 0.5) return 'خطر ائتماني';
  if (r.daysSincePurchase !== null && r.daysSincePurchase >= lostAfterDays) return 'مفقود';
  if ((r.payRatio ?? 0) >= 0.9 && r.profit > 0) return 'ذهبي';
  return 'عادي';
}

// ---------------------------------------------------------------- ٥. تحليل ABC

export interface AbcRow {
  agg: SalesAgg;
  value: number;        // المقياس المختار (مبيعات أو ربح)
  share: number;        // نسبته من الإجمالي
  cumulative: number;   // النسبة التراكمية
  grade: 'أ' | 'ب' | 'ج';
}

/**
 * قاعدة ٨٠/٢٠: «أ» = المواد التي تصنع أول ٨٠٪ من القيمة، «ب» الـ ١٥٪ التالية، «ج» الباقي.
 * التحليل بالربح أدقّ لصاحب القرار، وبالمبيعات أسهل فهماً — كلاهما متاح.
 */
export function abcAnalysis(
  sales: Map<string, SalesAgg>,
  by: 'revenue' | 'profit',
): { rows: AbcRow[]; total: number; counts: { أ: number; ب: number; ج: number } } {
  const list = [...sales.values()]
    .map(agg => ({ agg, value: by === 'revenue' ? agg.revenue : agg.knownProfit }))
    .filter(x => x.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = list.reduce((s, x) => s + x.value, 0);
  const counts = { أ: 0, ب: 0, ج: 0 };
  let running = 0;

  const rows: AbcRow[] = list.map(x => {
    /**
     * 🔴 التصنيف بالتراكم **قبل** المادة لا بعدها.
     *
     * كان يُحسب بعد الإضافة، فالمادة العابرة لحدّ ٨٠٪ تُحرَم منه — وهي في الحقيقة جزءٌ
     * من الـ٨٠٪ لأنها ما زالت لازمة لبلوغها. قِسْتُ الأثر:
     *   · مادة واحدة تصنع ١٠٠٪ من المبيعات ⟵ كانت تُصنَّف **«ج»**، أدنى فئة.
     *   · مادتان ٩٠٪ و١٠٪ ⟵ «ب» و«ج»، و**لا مادة «أ» إطلاقاً**.
     * والتقرير موجود ليقول «ركّز على هذه المواد»، فكان يقول للتاجر إن لا شيء عنده يستحق.
     */
    const before = total > 0 ? (running / total) * 100 : 0;
    running += x.value;
    const cumulative = total > 0 ? (running / total) * 100 : 0;
    const grade: AbcRow['grade'] = before < 80 ? 'أ' : before < 95 ? 'ب' : 'ج';
    counts[grade] += 1;
    return { agg: x.agg, value: x.value, share: total > 0 ? (x.value / total) * 100 : 0, cumulative, grade };
  });

  return { rows, total, counts };
}
