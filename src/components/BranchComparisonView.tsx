import { useMemo, useState } from 'react';
import {
  Building2, TrendingUp, Trophy, Store, Warehouse, Package,
  Banknote, CreditCard, FileText, Info, HelpCircle,
} from 'lucide-react';
import { useCollection } from '../hooks/useCollection';
import { useProductCosts } from '../hooks/useProductCosts';
import { useBranches, branchOf, isWarehouse } from '../hooks/useBranches';
import { useSession } from '../context/SessionContext';
import { Invoice, Product, Branch } from '../types';
import { toArabicDigits, formatCurrency } from '../utils/arabicFormatters';
import { cashPortion, electronicPortion } from '../utils/paymentMethods';
import { netProfitOf, costLookup } from '../utils/profit';
import { periodRange, isInRange, rangeText, PeriodKey } from '../utils/reportPeriod';
import { inventoryValue } from '../utils/decisionReports';
import { windowConstraints, daysAgoKey, WINDOW } from '../utils/dateWindow';
import { exportAsWord, exportAsPdf, ExportSpec } from '../utils/exportDoc';

interface FinancialTx { id: string; amount: number; type: 'revenue' | 'expense'; date: string; branchId?: string }

type Period = PeriodKey;

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: 'daily', label: 'اليوم' },
  { id: 'weekly', label: 'آخر ٧ أيام' },
  { id: 'monthly', label: 'آخر ٣٠ يوم' },
  { id: 'yearly', label: 'آخر سنة' },
  { id: 'all', label: 'الكل' },
];

interface Props { currency: 'IQD' | 'USD'; exchangeRate: number }

/** صفّ نتائج موقع واحد — كل رقم مُشتقّ من البيانات الحيّة لا من عدّاد منفصل. */
interface BranchRow {
  branch: Branch;
  sales: number;          // حجم المبيعات (أساس استحقاق)
  collected: number;      // المحصَّل فعلاً
  cash: number;           // منه نقداً في الدرج
  electronic: number;     // منه بطاقة/محفظة/تحويل
  invoiceCount: number;
  debtIssued: number;     // ديون نشأت من فواتير هذا الموقع
  expenses: number;
  profit: number;         // ربح إجمالي من التكاليف المعروفة
  unknownCostSales: number;
  net: number;            // الربح بعد مصاريف الموقع
  stockUnits: number;
  stockValue: number;     // بسعر البيع
  stockCost: number;      // بسعر الشراء — رأس المال النائم في الموقع
  unknownCostUnits: number; // وحدات بلا سعر شراء: قيمتها الشرائية غير محتسبة
  /** صفّ السجلات اليتيمة (فرع محذوف) — يُعرض ولا يُخلط بفرع قائم */
  orphan?: boolean;
}

export default function BranchComparisonView({ currency, exchangeRate }: Props) {
  const { role } = useSession();
  const { branches, isMultiBranch } = useBranches();
  /**
   * 🟠 نافذة تحميل: كانت المجموعات الثلاث تُقرأ **كاملةً** — تاريخ المحل كلّه لعرض
   * ثلاثين يوماً (الافتراضي). النافذة تغطّي أطول فترة مؤرَّخة، و«الكل» يُعلَن سقفه
   * في الحاشية بدل أن يوهم بشمولٍ لا يملكه.
   */
  const dataWindow = useMemo(() => windowConstraints(daysAgoKey(WINDOW.REPORTS)), []);
  const { items: invoices } = useCollection<Invoice>('invoices', dataWindow);
  const { items: transactions } = useCollection<FinancialTx>('financial_transactions', dataWindow);
  const { items: products } = useCollection<Product>('products');
  const { buyPriceOf, wholesaleBuyPriceOf } = useProductCosts();
  const [period, setPeriod] = useState<Period>('monthly');

  const money = (v: number) => formatCurrency(v, currency, exchangeRate);

  /**
   * 🟠 النطاق من `reportPeriod` — المصدر نفسه الذي تستعمله شاشة التقارير.
   *
   * كان هنا تعريفٌ محلّي يجعل «السنة» ٣٦٦ يوماً بينما هي ٣٦٥ هناك، ويصفّي بمقارنة
   * **نصوص** (`dateStr >= startKey`) تعمل فقط مع `YYYY-MM-DD` لاتينية — فأي تاريخ
   * بأرقام عربية أو بصيغة `١٧-٠٨-٢٠٢٦` يسقط خارج كل فترة بصمت.
   */
  const range = useMemo(() => periodRange(period), [period]);

  const costOf = useMemo(
    () => costLookup(
      (line) => products.find(x => x.id === (line.productId || line.itemId) || x.name === line.name),
      buyPriceOf,
      wholesaleBuyPriceOf,
    ),
    [products, buyPriceOf, wholesaleBuyPriceOf],
  );

  const rows = useMemo<BranchRow[]>(() => {
    const base = new Map<string, BranchRow>();
    const blank = (branch: Branch): BranchRow => ({
      branch, sales: 0, collected: 0, cash: 0, electronic: 0, invoiceCount: 0,
      debtIssued: 0, expenses: 0, profit: 0, unknownCostSales: 0, net: 0,
      stockUnits: 0, stockValue: 0, stockCost: 0, unknownCostUnits: 0, orphan: false,
    });
    for (const b of branches) base.set(b.id, blank(b));

    /**
     * 🔴 السجل اليتيم يُعلَن ولا يُسنَد لغيره.
     *
     * كان: `base.get(id) ?? base.get(branches[0]?.id)` — فسجلّ فرعٍ **محذوف** يسقط على
     * أوّل فرع في ترتيب المجموعة (لا الرئيسي ولا اختيار مقصود). وهذه شاشة كل غرضها
     * المقارنة العادلة: مبيعات فرعٍ أُغلق كانت تُضاف لمنافسه بصمت فيتصدّر «الأعلى ربحاً»
     * بأرقام ليست له. الآن تُجمع في صفٍّ صريح باسمه، فيراها التاجر ويقرّر.
     */
    const ORPHAN_ID = '__orphan__';
    const rowFor = (id: string): BranchRow => {
      const found = base.get(id);
      if (found) return found;
      let orphan = base.get(ORPHAN_ID);
      if (!orphan) {
        orphan = blank({ id: ORPHAN_ID, name: 'سجلات بلا فرع (فرع محذوف)' } as Branch);
        orphan.orphan = true;
        base.set(ORPHAN_ID, orphan);
      }
      return orphan;
    };

    // ---- الفواتير: التجميع بالفرع ثم الربح من المحرّك المشترك ----
    const invByBranch = new Map<string, Invoice[]>();
    for (const inv of invoices) {
      if (!isInRange(inv.date, range)) continue;
      const r = rowFor(branchOf(inv));
      const paid = inv.paidAmount ?? inv.finalAmount ?? 0;
      r.collected += paid;
      r.cash += cashPortion(paid, inv.payments);
      r.electronic += electronicPortion(paid, inv.payments);
      r.debtIssued += Math.max(0, (inv.finalAmount || 0) - paid);
      const list = invByBranch.get(r.branch.id);
      if (list) list.push(inv); else invByBranch.set(r.branch.id, [inv]);
    }

    // ---- المصاريف والإيرادات اليدوية ----
    const txByBranch = new Map<string, FinancialTx[]>();
    for (const t of transactions) {
      if (!isInRange(t.date, range)) continue;
      const r = rowFor(branchOf(t));
      const list = txByBranch.get(r.branch.id);
      if (list) list.push(t); else txByBranch.set(r.branch.id, [t]);
    }

    /**
     * 🟠 الربح من `netProfitOf` لا من نسخةٍ رابعة مكتوبة هنا.
     *
     * وقد **افترقت النسخة فعلاً**: الفاتورة بلا بنود (بيانات مستوردة أو قديمة) كانت
     * تُنتج «غير محتسب = ٠» هنا و«= كامل قيمتها» في شاشة التقارير — فيبدو الفرع أنظف
     * ممّا هو. المصدر الواحد يُغلق الفارق ويمنع انحرافاً جديداً.
     */
    for (const r of base.values()) {
      const p = netProfitOf(invByBranch.get(r.branch.id) ?? [], txByBranch.get(r.branch.id) ?? [], costOf);
      r.sales = p.sales;
      r.invoiceCount = p.invoiceCount;
      r.unknownCostSales = p.unknownCostSales;
      r.expenses = p.expenses;
      r.profit = p.grossProfit + p.manualRevenue;   // الواصل اليدوي يُضاف كما في التقارير
      r.net = p.netProfit;
    }

    // ---- المخزون الحالي (لقطة، لا يتأثّر بالفترة) ----
    // 🟠 بسعر الشراء **وبسعر البيع** معاً: رأس المال هو الأدلّ على مقارنة الفروع
    // (أيّ فرع نائمٌ فيه مالك أكثر)، والمجهول يُعلَن ولا يُحتسب صفراً.
    for (const b of branches) {
      const r = base.get(b.id);
      if (!r) continue;
      const v = inventoryValue(products, buyPriceOf, b.id);
      r.stockUnits = v.units;
      r.stockValue = v.sellValue;
      r.stockCost = v.costValue;
      r.unknownCostUnits = v.unknownCostUnits;
    }

    return [...base.values()];
  }, [branches, invoices, transactions, products, range, costOf, buyPriceOf]);

  const orphanRow = rows.find(r => r.orphan) ?? null;
  const shops = rows.filter(r => !r.orphan && !isWarehouse(r.branch));
  const warehouses = rows.filter(r => !r.orphan && isWarehouse(r.branch));
  const totals = rows.reduce(
    (a, r) => ({
      sales: a.sales + r.sales, collected: a.collected + r.collected, net: a.net + r.net,
      debtIssued: a.debtIssued + r.debtIssued, stockValue: a.stockValue + r.stockValue, stockCost: a.stockCost + r.stockCost,
      invoiceCount: a.invoiceCount + r.invoiceCount,
    }),
    { sales: 0, collected: 0, net: 0, debtIssued: 0, stockValue: 0, stockCost: 0, invoiceCount: 0 },
  );
  const best = shops.length > 0 ? [...shops].sort((a, b) => b.net - a.net)[0] : null;
  const maxSales = Math.max(1, ...shops.map(r => r.sales));

  // ---- التصدير: أوّل ما يُطلب طباعته لاجتماع أو لمحاسب ----
  const buildExport = (): ExportSpec => ({
    title: 'رتب شغلك',
    subtitle: `أداء الفروع — ${range.label} (${rangeText(range)})`,
    columns: [
      { header: 'الموقع' }, { header: 'النوع', align: 'center' }, { header: 'المبيعات', align: 'center' },
      { header: 'المحصَّل', align: 'center' }, { header: 'نقداً', align: 'center' },
      { header: 'إلكترونياً', align: 'center' }, { header: 'ديون نشأت', align: 'center' },
      { header: 'المصاريف', align: 'center' }, { header: 'صافي الربح', align: 'center' },
      { header: 'مخزون (شراء)', align: 'center' }, { header: 'مخزون (بيع)', align: 'center' },
    ],
    rows: [...shops, ...warehouses, ...(orphanRow ? [orphanRow] : [])].map(r => [
      r.branch.name,
      r.orphan ? 'يتيم' : isWarehouse(r.branch) ? 'مخزن' : 'محل',
      money(r.sales), money(r.collected), money(r.cash), money(r.electronic),
      money(r.debtIssued), money(r.expenses), money(r.net),
      money(r.stockCost), money(r.stockValue),
    ]),
    note: `صافي الربح = ربح المبيعات معروفة التكلفة + الواصل اليدوي − مصاريف الموقع. `
      + `قيمة المخزون لقطة حالية لا تتأثّر بالفترة. البيانات ضمن آخر ${toArabicDigits(WINDOW.REPORTS)} يوم.`,
  });
  const [msg, setMsg] = useState<string | null>(null);
  const doExport = (format: 'word' | 'pdf') => {
    if (rows.length === 0) { setMsg('لا توجد مواقع للتصدير'); setTimeout(() => setMsg(null), 4000); return; }
    const name = `أداء_الفروع_${new Date().toLocaleDateString('ar-IQ').replace(/\//g, '-')}`;
    if (format === 'word') { exportAsWord(buildExport(), name); setMsg('تم تصدير ملف Word 📄'); }
    else exportAsPdf(buildExport(), m => setMsg(m));
    setTimeout(() => setMsg(null), 4000);
  };

  if (role !== 'owner') return null;

  return (
    <div className="space-y-6 font-tajawal" dir="rtl">
      {/* رأس الشاشة */}
      <div className="bg-[#0B1F4D] text-white p-6 rounded-2xl border-b-4 border-amber-400">
        <div className="flex items-center gap-2 text-slate-300 text-xs font-bold font-cairo">
          <Building2 className="w-3.5 h-3.5 text-emerald-400" />
          <span>مقارنة المواقع</span>
        </div>
        <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2">
          <Trophy className="w-6 h-6 text-amber-400" />
          <span>أداء الفروع 📊</span>
        </h2>
        <p className="text-xs text-slate-300 mt-1 leading-relaxed max-w-3xl">
          أي فرع يبيع أكثر؟ وأيّهم يربح أكثر بعد مصاريفه؟ كل رقم هنا مُشتقّ من فواتيرك ومصاريفك الفعلية
          — لا عدّادات منفصلة يمكن أن تنحرف.
        </p>
        <div className="flex flex-wrap items-center gap-1.5 mt-4">
          {PERIODS.map(p => (
            <button key={p.id} onClick={() => setPeriod(p.id)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-extrabold cursor-pointer transition ${
                period === p.id ? 'bg-amber-500 text-slate-950' : 'bg-white/10 text-slate-200 hover:bg-white/20'
              }`}>
              {p.label}
            </button>
          ))}
          <span className="text-[10px] text-slate-300 font-bold mr-2">📅 {rangeText(range)}</span>
          <div className="flex gap-1.5 mr-auto">
            <button onClick={() => doExport('word')}
              className="px-3 py-1.5 rounded-lg text-[11px] font-extrabold bg-white/10 text-slate-200 hover:bg-white/20 cursor-pointer">
              تصدير Word
            </button>
            <button onClick={() => doExport('pdf')}
              className="px-3 py-1.5 rounded-lg text-[11px] font-extrabold bg-white/10 text-slate-200 hover:bg-white/20 cursor-pointer">
              تصدير PDF
            </button>
          </div>
        </div>
      </div>

      {msg && (
        <div className="px-4 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold">
          {msg}
        </div>
      )}

      {/* 🔴 السجلات اليتيمة — تُعلَن ولا تُسنَد لفرعٍ قائم */}
      {orphanRow && (orphanRow.sales > 0 || orphanRow.expenses > 0) && (
        <div className="p-4 rounded-2xl border border-amber-200 bg-amber-50/70 flex items-start gap-2.5">
          <HelpCircle className="w-4 h-4 text-amber-700 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-900 font-bold leading-relaxed">
            توجد سجلات تخصّ فرعاً <b>محذوفاً</b>: مبيعات {money(orphanRow.sales)} ومصاريف {money(orphanRow.expenses)}
            {' '}({toArabicDigits(orphanRow.invoiceCount)} فاتورة).
            <br />
            <b>لم تُضَف إلى أي فرع قائم</b> — كانت تُسنَد سابقاً لأوّل فرع في القائمة فتُفسد المقارنة.
            إن أردت نسبتها لفرع فعدّل فرع تلك الفواتير، وإلا فاتركها هنا للعلم.
          </p>
        </div>
      )}

      {!isMultiBranch && (
        <div className="p-4 rounded-2xl border border-blue-200 bg-blue-50/70 flex items-start gap-2.5">
          <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-blue-900 font-bold leading-relaxed">
            لديك موقع واحد، فلا شيء لتقارنه بعد. أضف فرعاً أو مخزناً من شاشة «الفروع والمخازن»
            وستظهر هنا مقارنة كاملة بين مواقعك.
          </p>
        </div>
      )}

      {/* الملخّص العام */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'مبيعات كل المواقع', value: money(totals.sales), icon: TrendingUp, tone: 'text-emerald-700' },
          { label: 'المحصَّل فعلاً', value: money(totals.collected), icon: Banknote, tone: 'text-sky-600' },
          { label: 'صافي الربح بعد المصاريف', value: money(totals.net), icon: Trophy, tone: totals.net >= 0 ? 'text-emerald-700' : 'text-rose-700' },
          { label: 'رأس المال في المخزون', value: money(totals.stockCost), icon: Package, tone: 'text-indigo-600' },
        ].map(c => (
          <div key={c.label} className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm p-4">
            <div className="flex items-center gap-1.5">
              <c.icon className={`w-4 h-4 ${c.tone}`} />
              <span className="text-[10px] text-slate-600 font-bold">{c.label}</span>
            </div>
            <span className={`text-base font-extrabold block mt-1.5 ${c.tone}`}>{c.value}</span>
          </div>
        ))}
      </div>

      {/* الفرع الأفضل */}
      {best && shops.length > 1 && best.net !== 0 && (
        <div className="p-4 rounded-2xl bg-gradient-to-l from-amber-50 to-white border border-amber-200 flex items-center gap-3">
          <Trophy className="w-7 h-7 text-amber-700 flex-shrink-0" />
          <div>
            <span className="text-xs font-extrabold text-[#0B1F4D] block">
              الأعلى ربحاً: {best.branch.name}
            </span>
            <span className="text-[11px] text-slate-600 font-bold">
              صافي {money(best.net)} من مبيعات {money(best.sales)} — بعد مصاريف {money(best.expenses)}
            </span>
          </div>
        </div>
      )}

      {/* جدول المحلات */}
      <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-2">
          <Store className="w-4 h-4 text-sky-600" />
          <span className="text-xs font-extrabold text-[#0B1F4D]">المحلات (تبيع)</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right min-w-[720px]">
            <thead className="bg-slate-50">
              <tr className="text-[10px] font-extrabold text-slate-500">
                <th className="px-4 py-2.5">الموقع</th>
                <th className="px-3 py-2.5">المبيعات</th>
                <th className="px-3 py-2.5">المحصَّل</th>
                <th className="px-3 py-2.5">نقد / إلكتروني</th>
                <th className="px-3 py-2.5">ديون نشأت</th>
                <th className="px-3 py-2.5">المصاريف</th>
                <th className="px-3 py-2.5">صافي الربح</th>
                <th className="px-3 py-2.5">المخزون (شراء)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shops.map(r => (
                <tr key={r.branch.id} className="text-[11px] font-bold text-[#0B1F4D]">
                  <td className="px-4 py-3">
                    <span className="block">{r.branch.name}</span>
                    <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden w-24">
                      <div className="h-full bg-emerald-500" style={{ width: `${Math.round((r.sales / maxSales) * 100)}%` }} />
                    </div>
                    <span className="text-[11px] text-slate-500 font-bold flex items-center gap-1 mt-1">
                      <FileText className="w-2.5 h-2.5" /> {toArabicDigits(r.invoiceCount)} فاتورة
                    </span>
                  </td>
                  <td className="px-3 py-3 text-emerald-700">{money(r.sales)}</td>
                  <td className="px-3 py-3">{money(r.collected)}</td>
                  <td className="px-3 py-3">
                    <span className="flex items-center gap-1 text-emerald-700">
                      <Banknote className="w-3 h-3" /> {money(r.cash)}
                    </span>
                    <span className="flex items-center gap-1 text-sky-700 mt-0.5">
                      <CreditCard className="w-3 h-3" /> {money(r.electronic)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-amber-700">{money(r.debtIssued)}</td>
                  <td className="px-3 py-3 text-rose-700">{money(r.expenses)}</td>
                  <td className={`px-3 py-3 font-extrabold ${r.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {money(r.net)}
                    {r.unknownCostSales > 0 && (
                      <span className="block text-[11px] text-slate-500 font-bold flex items-center gap-1 mt-0.5">
                        <HelpCircle className="w-2.5 h-2.5" /> {money(r.unknownCostSales)} بلا تكلفة معروفة
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {/* رأس المال أوّلاً: هو الأدلّ على مقارنة الفروع — أيّ فرع نائمٌ فيه مالك أكثر */}
                    <span className="block text-indigo-700">{money(r.stockCost)}</span>
                    <span className="text-[11px] text-slate-500 font-bold block">
                      بيعياً {money(r.stockValue)} · {toArabicDigits(r.stockUnits)} وحدة
                    </span>
                    {r.unknownCostUnits > 0 && (
                      <span className="text-[11px] text-amber-700 font-bold block mt-0.5">
                        ⚠️ {toArabicDigits(r.unknownCostUnits)} وحدة بلا سعر شراء
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* المخازن — لا مبيعات لها، فقط بضاعة */}
      {warehouses.length > 0 && (
        <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-2">
            <Warehouse className="w-4 h-4 text-indigo-600" />
            <span className="text-xs font-extrabold text-[#0B1F4D]">المخازن (بضاعة فقط)</span>
          </div>
          <div className="divide-y divide-slate-100">
            {warehouses.map(r => (
              <div key={r.branch.id} className="px-5 py-3 flex items-center justify-between gap-2">
                <span className="text-[11px] font-extrabold text-[#0B1F4D]">{r.branch.name}</span>
                <span className="text-[11px] font-bold text-indigo-700">
                  {money(r.stockValue)}
                  <span className="text-[11px] text-slate-500 mr-1.5">({toArabicDigits(r.stockUnits)} وحدة)</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[10px] text-slate-600 font-bold leading-relaxed flex items-start gap-1.5">
        <Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
        <span>
          الفواتير والمصاريف المسجَّلة قبل إضافة الفروع تُنسب للفرع الرئيسي تلقائياً.
          «صافي الربح» = ربح المبيعات ذات التكلفة المعروفة + الواصل اليدوي − مصاريف الموقع.
          مبيعات بلا تكلفة معروفة تُعرض منفصلة ولا تُخمَّن أبداً. قيمة المخزون لقطة حالية لا تتأثّر بالفترة المختارة.
        </span>
      </p>
    </div>
  );
}
