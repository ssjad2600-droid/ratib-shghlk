import { useMemo, useState } from 'react';
import {
  Target, Snowflake, Gem, Package, Timer, Crown, Layers,
  AlertTriangle, HelpCircle, Info, FileDown, TrendingDown, Wallet,
} from 'lucide-react';
import { useCollection } from '../hooks/useCollection';
import { useProductCosts } from '../hooks/useProductCosts';
import { useBranches } from '../hooks/useBranches';
import { Invoice, Product, Customer } from '../types';
import { toArabicDigits, formatCurrency } from '../utils/arabicFormatters';
import { todayISO } from '../utils/dateLocal';
import { windowConstraints, daysAgoKey, WINDOW } from '../utils/dateWindow';
import { exportAsWord, exportAsPdf, ExportSpec } from '../utils/exportDoc';
import {
  aggregateSales, deadStock, lastSaleMap, daysBetween, inventoryValue,
  inventoryByCategory, coverage, topCustomers, customerBadge, abcAnalysis,
} from '../utils/decisionReports';

interface Props { currency: 'IQD' | 'USD'; exchangeRate: number; storeName?: string }

type Tab = 'dead' | 'profit' | 'value' | 'coverage' | 'customers' | 'abc';

const TABS: Array<{ id: Tab; label: string; icon: typeof Target }> = [
  { id: 'dead', label: 'الأصناف الراكدة', icon: Snowflake },
  { id: 'profit', label: 'الأكثر ربحاً', icon: Gem },
  { id: 'value', label: 'قيمة المخزون', icon: Package },
  { id: 'coverage', label: 'أيام التغطية', icon: Timer },
  { id: 'customers', label: 'أفضل العملاء', icon: Crown },
  { id: 'abc', label: 'تحليل أ ب ج', icon: Layers },
];

const WINDOWS = [30, 60, 90, 180];

export default function DecisionReportsView({ currency, exchangeRate, storeName }: Props) {
  // أطول فترة مختارة ١٨٠ يوماً، و«راكد منذ» يحتاج تاريخاً أبعد ⇒ ٤٠٠ يوم تغطّي الاثنين.
  // ما هو أقدم يُعرض كـ«لم تُبَع خلال آخر سنة» — أدقّ تجارياً من رقم غامض بلا نهاية.
  const invWindow = useMemo(() => windowConstraints(daysAgoKey(WINDOW.REPORTS)), []);
  const { items: invoices } = useCollection<Invoice>('invoices', invWindow);
  // المنتجات والعملاء بلا نافذة **عمداً**: التقارير تحتاج كل مادة (حتى ما لم يُبَع منذ
  // سنتين — وهو صلب تقرير «الراكد») وكل زبون (ليظهر «المفقود»). النافذة على الفواتير
  // وحدها، وهي الوحيدة التي تنمو بلا حدّ مع الزمن.
  const { items: products } = useCollection<Product>('products');
  const { items: customers } = useCollection<Customer>('customers');
  const { buyPriceOf, wholesaleBuyPriceOf } = useProductCosts();
  const { matchesActiveBranch, activeBranchId, isMultiBranch, branchName, stampBranchId } = useBranches(storeName);

  const [tab, setTab] = useState<Tab>('dead');
  const [windowDays, setWindowDays] = useState(90);
  const [abcBy, setAbcBy] = useState<'revenue' | 'profit'>('revenue');
  const [alert, setAlert] = useState<string | null>(null);

  const money = (v: number) => formatCurrency(v, currency, exchangeRate);
  const today = todayISO();

  // ---- الفواتير: الموقع النشط + نافذة الفترة ----
  const branchInvoices = useMemo(() => invoices.filter(matchesActiveBranch), [invoices, matchesActiveBranch]);

  const windowStart = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - windowDays + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, [windowDays]);

  const windowInvoices = useMemo(
    () => branchInvoices.filter(i => i.date >= windowStart && i.date <= today),
    [branchInvoices, windowStart, today],
  );

  // ---- طبقة الحساب المشتركة ----
  const salesWindow = useMemo(
    () => aggregateSales(windowInvoices, products, buyPriceOf, wholesaleBuyPriceOf),
    [windowInvoices, products, buyPriceOf, wholesaleBuyPriceOf],
  );
  const salesAll = useMemo(
    () => aggregateSales(branchInvoices, products, buyPriceOf, wholesaleBuyPriceOf),
    [branchInvoices, products, buyPriceOf, wholesaleBuyPriceOf],
  );
  const lastSales = useMemo(() => lastSaleMap(branchInvoices, products), [branchInvoices, products]);

  const branchForStock = activeBranchId || undefined; // '' = كل الفروع ⇒ الإجمالي

  // ---- ١. الراكد ----
  const dead = useMemo(() => {
    const rows = deadStock(products, salesWindow, buyPriceOf, branchForStock, today);
    return rows.map(r => {
      const last = lastSales.get(r.product.id) ?? '';
      return { ...r, lastSaleDate: last, daysIdle: last ? daysBetween(last, today) : null };
    });
  }, [products, salesWindow, buyPriceOf, branchForStock, lastSales, today]);

  const frozenTotal = dead.reduce((s, r) => s + r.frozenCapital, 0);
  const frozenUnknown = dead.filter(r => !r.costKnown).length;

  // ---- ٢. الربحية ----
  const profitRows = useMemo(
    () => [...salesWindow.values()].sort((a, b) => b.knownProfit - a.knownProfit),
    [salesWindow],
  );
  const needCost = useMemo(
    () => [...salesWindow.values()].filter(a => a.unknownRevenue > 0).sort((a, b) => b.unknownRevenue - a.unknownRevenue),
    [salesWindow],
  );

  // ---- ٣. قيمة المخزون ----
  const invValue = useMemo(() => inventoryValue(products, buyPriceOf, branchForStock), [products, buyPriceOf, branchForStock]);
  const byCategory = useMemo(() => inventoryByCategory(products, buyPriceOf, branchForStock), [products, buyPriceOf, branchForStock]);

  // ---- ٤. التغطية ----
  const coverageRows = useMemo(
    () => coverage(products, salesWindow, branchForStock, windowDays)
      .filter(r => r.stock > 0 || r.soldQty > 0)
      .sort((a, b) => {
        if (a.coverageDays === null) return 1;      // الراكد آخراً
        if (b.coverageDays === null) return -1;
        return a.coverageDays - b.coverageDays;      // الأقرب نفاداً أولاً
      }),
    [products, salesWindow, branchForStock, windowDays],
  );

  // ---- ٥. العملاء ----
  const customerRows = useMemo(
    () => topCustomers(customers, windowInvoices, products, buyPriceOf, wholesaleBuyPriceOf, today)
      .sort((a, b) => b.profit - a.profit || b.purchases - a.purchases),
    [customers, windowInvoices, products, buyPriceOf, wholesaleBuyPriceOf, today],
  );

  // ---- ٦. أ ب ج ----
  const abc = useMemo(() => abcAnalysis(salesWindow, abcBy), [salesWindow, abcBy]);

  // ---------------------------------------------------------------- التصدير
  const exportSpec = (): ExportSpec => {
    const scope = isMultiBranch ? ` — ${activeBranchId ? branchName(stampBranchId) : 'كل الفروع'}` : '';
    const range = `آخر ${toArabicDigits(windowDays)} يوم`;
    switch (tab) {
      case 'dead':
        return {
          title: storeName || 'رتب شغلك',
          subtitle: `الأصناف الراكدة (${range})${scope}`,
          columns: [{ header: '#' }, { header: 'المادة' }, { header: 'الفئة' }, { header: 'الرصيد' }, { header: 'آخر بيع' }, { header: 'راكد منذ' }, { header: 'رأس مال مجمّد' }],
          rows: dead.map((r, i) => [
            toArabicDigits(i + 1), r.product.name, r.product.category || '—',
            `${toArabicDigits(r.stock)} ${r.product.unit || 'قطعة'}`,
            r.lastSaleDate ? toArabicDigits(r.lastSaleDate) : 'لم تُبَع إطلاقاً',
            r.daysIdle !== null ? `${toArabicDigits(r.daysIdle)} يوم` : '—',
            r.costKnown ? money(r.frozenCapital) : 'سعر الشراء غير مسجَّل',
          ]),
          note: `إجمالي رأس المال المجمّد في الراكد: ${money(frozenTotal)}`,
        };
      case 'profit':
        return {
          title: storeName || 'رتب شغلك',
          subtitle: `المنتجات الأكثر ربحاً (${range})${scope}`,
          columns: [{ header: '#' }, { header: 'المادة' }, { header: 'الكمية المباعة' }, { header: 'المبيعات' }, { header: 'الربح' }, { header: 'هامش الربح' }],
          rows: profitRows.map((a, i) => [
            toArabicDigits(i + 1), a.name, toArabicDigits(a.qty), money(a.revenue), money(a.knownProfit),
            a.revenue > 0 ? `${toArabicDigits(Math.round((a.knownProfit / a.revenue) * 100))}٪` : '—',
          ]),
          note: needCost.length > 0 ? `${toArabicDigits(needCost.length)} مادة بلا سعر شراء مسجَّل — ربحها غير محتسب ولم يُخمَّن.` : undefined,
        };
      case 'value':
        return {
          title: storeName || 'رتب شغلك',
          subtitle: `قيمة المخزون حسب الفئة${scope}`,
          columns: [{ header: 'الفئة' }, { header: 'عدد المواد' }, { header: 'الوحدات' }, { header: 'بسعر الشراء' }, { header: 'بسعر البيع' }, { header: 'غير محتسب' }],
          rows: byCategory.map(c => [
            c.category, toArabicDigits(c.count), toArabicDigits(c.units), money(c.costValue), money(c.sellValue),
            // المجهول يُصرَّح في التصدير أيضاً — الورقة تُقرأ خارج البرنامج بلا سياقه
            c.unknownCostCount > 0 ? `${toArabicDigits(c.unknownCostCount)} بلا سعر شراء` : '—',
          ]),
          note: `رأس المال المجمّد: ${money(invValue.costValue)} · القيمة البيعية: ${money(invValue.sellValue)} · الربح الكامن: ${money(invValue.latentProfit)}`,
        };
      case 'coverage':
        return {
          title: storeName || 'رتب شغلك',
          subtitle: `أيام التغطية (بناءً على مبيعات ${range})${scope}`,
          columns: [{ header: '#' }, { header: 'المادة' }, { header: 'الرصيد' }, { header: 'بيع الفترة' }, { header: 'المعدل اليومي' }, { header: 'تكفي' }],
          rows: coverageRows.map((r, i) => [
            toArabicDigits(i + 1), r.product.name, toArabicDigits(r.stock), toArabicDigits(r.soldQty),
            toArabicDigits(r.avgPerDay.toFixed(2)),
            r.coverageDays === null ? 'لا مبيعات' : `${toArabicDigits(Math.round(r.coverageDays))} يوم`,
          ]),
        };
      case 'customers':
        return {
          title: storeName || 'رتب شغلك',
          subtitle: `أفضل العملاء (${range})${scope}`,
          columns: [{ header: '#' }, { header: 'الزبون' }, { header: 'التصنيف' }, { header: 'المشتريات' }, { header: 'الربح منه' }, { header: 'الدين الحالي' }, { header: 'نسبة السداد' }, { header: 'آخر شراء' }],
          rows: customerRows.map((r, i) => [
            toArabicDigits(i + 1), r.customer.name, customerBadge(r), money(r.purchases), money(r.profit), money(r.debt),
            r.payRatio !== null ? `${toArabicDigits(Math.round(r.payRatio * 100))}٪` : '—',
            r.lastPurchase ? toArabicDigits(r.lastPurchase) : 'لم يشترِ',
          ]),
        };
      case 'abc':
        return {
          title: storeName || 'رتب شغلك',
          subtitle: `تحليل أ ب ج حسب ${abcBy === 'revenue' ? 'المبيعات' : 'الربح'} (${range})${scope}`,
          columns: [{ header: '#' }, { header: 'المادة' }, { header: 'التصنيف' }, { header: 'القيمة' }, { header: 'النسبة' }, { header: 'التراكمي' }],
          rows: abc.rows.map((r, i) => [
            toArabicDigits(i + 1), r.agg.name, r.grade, money(r.value),
            `${toArabicDigits(r.share.toFixed(1))}٪`, `${toArabicDigits(r.cumulative.toFixed(1))}٪`,
          ]),
          note: `أ: ${toArabicDigits(abc.counts.أ)} مادة · ب: ${toArabicDigits(abc.counts.ب)} · ج: ${toArabicDigits(abc.counts.ج)}`,
        };
    }
  };

  const fileBase = () => `تقرير_${TABS.find(t => t.id === tab)?.label.replace(/\s+/g, '_')}_${(storeName || 'المتجر').replace(/\s+/g, '_')}`;
  const doExport = (kind: 'word' | 'pdf') => {
    const spec = exportSpec();
    if (spec.rows.length === 0) { setAlert('لا توجد بيانات في هذا التقرير لتصديرها'); setTimeout(() => setAlert(null), 4000); return; }
    if (kind === 'word') exportAsWord(spec, fileBase());
    else exportAsPdf(spec, m => { setAlert(m); setTimeout(() => setAlert(null), 5000); });
  };

  // ---------------------------------------------------------------- عناصر عرض
  const Empty = ({ text }: { text: string }) => (
    <div className="p-10 text-center text-xs text-slate-400 font-bold flex flex-col items-center gap-2">
      <Info className="w-6 h-6 text-slate-300" />
      <span>{text}</span>
    </div>
  );

  const Card = ({ label, value, hint, tone = 'text-[#0B1F4D]', icon: Icon }: {
    label: string; value: string; hint?: string; tone?: string; icon: typeof Target;
  }) => (
    <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm p-4">
      <div className="flex items-center gap-1.5">
        <Icon className={`w-4 h-4 ${tone}`} />
        <span className="text-[10px] text-slate-500 font-bold">{label}</span>
      </div>
      <span className={`text-base font-extrabold block mt-1.5 ${tone}`}>{value}</span>
      {hint && <span className="text-[9px] text-slate-400 font-bold block mt-0.5 leading-relaxed">{hint}</span>}
    </div>
  );

  return (
    <div className="space-y-5 font-tajawal" dir="rtl">
      {/* رأس الشاشة */}
      <div className="bg-[#0B1F4D] text-white p-6 rounded-2xl border-b-4 border-amber-400">
        <div className="flex items-center gap-2 text-slate-300 text-xs font-bold font-cairo">
          <Target className="w-3.5 h-3.5 text-emerald-400" />
          <span>أدوات صاحب القرار</span>
        </div>
        <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2 flex-wrap">
          <Target className="w-6 h-6 text-amber-400" />
          <span>تقارير القرار 🎯</span>
          {isMultiBranch && (
            <span className="text-[10px] font-extrabold px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-200 border border-amber-400/40">
              🏢 {activeBranchId ? branchName(stampBranchId) : 'كل الفروع (مجمّع)'}
            </span>
          )}
        </h2>
        <p className="text-xs text-slate-300 mt-1 leading-relaxed max-w-3xl">
          ليست تقارير محاسب، بل أجوبة قرارات: أي بضاعة تأكل رأس مالك؟ أي مادة تُطعمك؟ أي زبون يستحق تسهيلاً وأيّهم خطر؟
        </p>

        {/* الفترة */}
        <div className="flex flex-wrap items-center gap-1.5 mt-4">
          <span className="text-[10px] text-slate-400 font-bold ml-1">الفترة:</span>
          {WINDOWS.map(d => (
            <button key={d} onClick={() => setWindowDays(d)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-extrabold cursor-pointer transition ${
                windowDays === d ? 'bg-amber-500 text-slate-950' : 'bg-white/10 text-slate-200 hover:bg-white/20'
              }`}>
              آخر {toArabicDigits(d)} يوم
            </button>
          ))}
          <div className="flex items-center gap-1 bg-white/10 rounded-lg px-1.5 py-1 mr-auto">
            <span className="text-[10px] text-slate-300 font-bold px-1">تصدير:</span>
            <button onClick={() => doExport('word')} className="px-2 py-1 rounded text-[11px] font-extrabold text-blue-200 hover:bg-white/10 cursor-pointer flex items-center gap-1">
              <FileDown className="w-3 h-3" /> Word
            </button>
            <button onClick={() => doExport('pdf')} className="px-2 py-1 rounded text-[11px] font-extrabold text-rose-200 hover:bg-white/10 cursor-pointer flex items-center gap-1">
              <FileDown className="w-3 h-3" /> PDF
            </button>
          </div>
        </div>
      </div>

      {alert && (
        <div className="px-4 py-3 rounded-xl text-xs font-bold border bg-amber-50 text-amber-800 border-amber-200">{alert}</div>
      )}

      {/* التبويبات */}
      <div className="flex flex-wrap gap-1.5">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3.5 py-2 rounded-xl text-[11px] font-extrabold cursor-pointer transition flex items-center gap-1.5 border ${
              tab === t.id ? 'bg-[#0B1F4D] text-white border-[#0B1F4D]' : 'bg-white text-slate-600 border-slate-200 hover:border-[#0B1F4D]'
            }`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {/* ========================= ١. الراكد ========================= */}
      {tab === 'dead' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2 bg-gradient-to-l from-rose-50 to-white rounded-2xl border-2 border-rose-200 p-5">
              <div className="flex items-center gap-1.5">
                <Wallet className="w-4 h-4 text-rose-600" />
                <span className="text-[11px] text-rose-800 font-extrabold">رأس مالك النائم على الرف</span>
              </div>
              <span className="text-2xl font-extrabold text-rose-700 block mt-1.5">{money(frozenTotal)}</span>
              <span className="text-[10px] text-slate-500 font-bold block mt-1 leading-relaxed">
                موزّعة على {toArabicDigits(dead.length)} مادة لم تُبَع منها قطعة خلال آخر {toArabicDigits(windowDays)} يوم.
                {frozenUnknown > 0 && ` (${toArabicDigits(frozenUnknown)} منها بلا سعر شراء مسجَّل، فقيمتها غير محتسبة)`}
              </span>
            </div>
            <Card icon={Snowflake} tone="text-rose-600" label="مواد راكدة" value={toArabicDigits(dead.length)}
              hint={`من أصل ${toArabicDigits(products.length)} مادة`} />
          </div>

          <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
            {dead.length === 0 ? (
              <Empty text="لا توجد أصناف راكدة — كل بضاعتك تتحرّك 👏" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-right min-w-[640px]">
                  <thead className="bg-slate-50">
                    <tr className="text-[10px] font-extrabold text-slate-500">
                      <th className="px-4 py-2.5">المادة</th>
                      <th className="px-3 py-2.5">الرصيد</th>
                      <th className="px-3 py-2.5">آخر بيع</th>
                      <th className="px-3 py-2.5">راكد منذ</th>
                      <th className="px-3 py-2.5">رأس مال مجمّد</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dead.map(r => {
                      const sev = r.daysIdle === null || r.daysIdle >= 90 ? 'rose' : r.daysIdle >= 60 ? 'amber' : 'slate';
                      return (
                        <tr key={r.product.id} className="text-[11px] font-bold text-[#0B1F4D]">
                          <td className="px-4 py-3">
                            <span className="block">{r.product.name}</span>
                            <span className="text-[9px] text-slate-400">{r.product.category || 'بلا فئة'}</span>
                          </td>
                          <td className="px-3 py-3">{toArabicDigits(r.stock)} {r.product.unit || 'قطعة'}</td>
                          <td className="px-3 py-3 text-slate-500">
                            {r.lastSaleDate ? toArabicDigits(r.lastSaleDate) : <span className="text-rose-600">لم تُبَع إطلاقاً</span>}
                          </td>
                          <td className="px-3 py-3">
                            <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${
                              sev === 'rose' ? 'bg-rose-50 text-rose-700 border-rose-200'
                              : sev === 'amber' ? 'bg-amber-50 text-amber-800 border-amber-200'
                              : 'bg-slate-50 text-slate-600 border-slate-200'
                            }`}>
                              {r.daysIdle !== null ? `${toArabicDigits(r.daysIdle)} يوم` : 'أبداً'}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            {r.costKnown ? <span className="text-rose-700">{money(r.frozenCapital)}</span>
                              : <span className="text-[10px] text-slate-400 flex items-center gap-1"><HelpCircle className="w-3 h-3" /> سعر الشراء غير مسجَّل</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================= ٢. الأكثر ربحاً ========================= */}
      {tab === 'profit' && (
        <div className="space-y-4">
          <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-[10px] font-bold text-blue-900 leading-relaxed flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              <b>الأكثر مبيعاً ليس الأكثر ربحاً.</b> مادة تبيع منها ٥٠٠ قطعة بربح قليل قد تكون أقل نفعاً من مادة تبيع منها ١٠ بربح كبير.
              الترتيب هنا <b>بالربح الكلي</b>، وعمود الهامش يكشف أي مادة تستحق أن تدفعها للزبون.
            </span>
          </div>

          <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
            {profitRows.length === 0 ? <Empty text="لا مبيعات في هذه الفترة" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-right min-w-[620px]">
                  <thead className="bg-slate-50">
                    <tr className="text-[10px] font-extrabold text-slate-500">
                      <th className="px-4 py-2.5">المادة</th>
                      <th className="px-3 py-2.5">الكمية</th>
                      <th className="px-3 py-2.5">المبيعات</th>
                      <th className="px-3 py-2.5">الربح</th>
                      <th className="px-3 py-2.5">الهامش</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {profitRows.map((a, i) => {
                      const margin = a.revenue > 0 ? (a.knownProfit / a.revenue) * 100 : 0;
                      return (
                        <tr key={a.productId} className="text-[11px] font-bold text-[#0B1F4D]">
                          <td className="px-4 py-3">
                            <span className="flex items-center gap-1.5">
                              {i < 3 && <Gem className="w-3 h-3 text-amber-500" />}
                              {a.name}
                            </span>
                            <span className="text-[9px] text-slate-400">{a.category}</span>
                          </td>
                          <td className="px-3 py-3">{toArabicDigits(a.qty)} {a.unit}</td>
                          <td className="px-3 py-3">{money(a.revenue)}</td>
                          <td className={`px-3 py-3 font-extrabold ${a.knownProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                            {money(a.knownProfit)}
                            {a.unknownRevenue > 0 && (
                              <span className="block text-[9px] text-slate-400 font-bold">جزء بلا تكلفة معروفة</span>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${
                              margin >= 30 ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : margin >= 10 ? 'bg-sky-50 text-sky-700 border-sky-200'
                              : margin > 0 ? 'bg-amber-50 text-amber-800 border-amber-200'
                              : 'bg-rose-50 text-rose-700 border-rose-200'
                            }`}>
                              {toArabicDigits(Math.round(margin))}٪
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {needCost.length > 0 && (
            <div className="bg-white rounded-2xl border-2 border-amber-200 p-4">
              <div className="flex items-center gap-1.5 mb-2">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span className="text-xs font-extrabold text-amber-800">
                  {toArabicDigits(needCost.length)} مادة بلا سعر شراء مسجَّل — ربحها غير محتسب
                </span>
              </div>
              <p className="text-[10px] text-slate-500 font-bold mb-2 leading-relaxed">
                لم نُخمّن ربحها ولن نفعل. سجّل سعر الشراء من شاشة المنتجات ليدخل ربحها في كل التقارير.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {needCost.slice(0, 12).map(a => (
                  <span key={a.productId} className="text-[10px] font-bold px-2 py-1 rounded-lg bg-amber-50 text-amber-800 border border-amber-200">
                    {a.name} · {money(a.unknownRevenue)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================= ٣. قيمة المخزون ========================= */}
      {tab === 'value' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card icon={Wallet} tone="text-indigo-600" label="رأس المال المجمّد (بسعر الشراء)"
              value={money(invValue.costValue)} hint="المال الذي دفعتَه فعلاً وهو واقف بضاعة" />
            <Card icon={Package} tone="text-sky-600" label="القيمة البيعية (بسعر البيع)"
              value={money(invValue.sellValue)} hint="ما ستقبضه لو بِعت كل شيء" />
            <Card icon={Gem} tone="text-emerald-600" label="الربح الكامن"
              value={money(invValue.latentProfit)}
              hint={invValue.unknownCostSellValue > 0
                ? `ربحك المنتظر — بلا ${money(invValue.unknownCostSellValue)} لمواد سعر شراؤها غير مسجَّل`
                : 'ربحك المنتظر من المخزون الحالي'} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card icon={Layers} label="عدد المواد" value={toArabicDigits(invValue.productCount)} />
            <Card icon={Package} label="إجمالي الوحدات" value={toArabicDigits(invValue.units)} />
            <Card icon={HelpCircle} tone="text-amber-600" label="بلا سعر شراء" value={toArabicDigits(invValue.unknownCostCount)}
              hint={`${toArabicDigits(invValue.unknownCostUnits)} وحدة قيمتها الشرائية غير محتسبة`} />
            <Card icon={Snowflake} tone="text-rose-600" label="منه راكد" value={money(frozenTotal)}
              hint={`${toArabicDigits(dead.length)} مادة`} />
          </div>

          <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 text-xs font-extrabold text-[#0B1F4D]">أين يقف رأس مالك — حسب الفئة</div>
            {byCategory.length === 0 ? <Empty text="لا يوجد مخزون" /> : (
              <div className="divide-y divide-slate-100">
                {byCategory.map(c => {
                  const pct = invValue.costValue > 0 ? (c.costValue / invValue.costValue) * 100 : 0;
                  return (
                    <div key={c.category} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-extrabold text-[#0B1F4D]">{c.category}</span>
                        <span className="text-[11px] font-bold text-indigo-700">{money(c.costValue)}</span>
                      </div>
                      <div className="mt-1.5 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full bg-indigo-500" style={{ width: `${Math.round(pct)}%` }} />
                      </div>
                      <span className="text-[9px] text-slate-400 font-bold block mt-1">
                        {toArabicDigits(c.count)} مادة · {toArabicDigits(c.units)} وحدة · بيعياً {money(c.sellValue)}
                      </span>
                      {/* 🔴 المجهول يُعلَن: كانت الفئة بلا أسعار شراء تُعرض برأس مال صفر بلا أي تنبيه */}
                      {c.unknownCostCount > 0 && (
                        <span className="text-[9px] text-amber-700 font-bold block mt-0.5">
                          ⚠️ {toArabicDigits(c.unknownCostCount)} مادة ({toArabicDigits(c.unknownCostUnits)} وحدة) بلا سعر شراء — رأس مالها غير محتسب
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================= ٤. أيام التغطية ========================= */}
      {tab === 'coverage' && (
        <div className="space-y-4">
          <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-[10px] font-bold text-blue-900 leading-relaxed flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              <b>«تكفي كم يوماً»</b> = رصيدك ÷ متوسط بيعك اليومي خلال الفترة — رقم دقيق تماماً من بياناتك، ويقول لك متى تطلب.
              عمود <b>الدوران</b> بجانبه <b>تقريبي</b>: المعادلة المحاسبية تحتاج متوسط المخزون عبر الفترة، والبرنامج يحفظ الرصيد الحالي فقط — فلا نقدّمه كرقم دقيق.
            </span>
          </div>

          <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
            {coverageRows.length === 0 ? <Empty text="لا توجد بيانات كافية" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-right min-w-[640px]">
                  <thead className="bg-slate-50">
                    <tr className="text-[10px] font-extrabold text-slate-500">
                      <th className="px-4 py-2.5">المادة</th>
                      <th className="px-3 py-2.5">الرصيد</th>
                      <th className="px-3 py-2.5">بيع الفترة</th>
                      <th className="px-3 py-2.5">المعدل اليومي</th>
                      <th className="px-3 py-2.5">تكفي</th>
                      <th className="px-3 py-2.5">الدوران (تقريبي)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {coverageRows.map(r => {
                      const c = r.coverageDays;
                      const tone = c === null ? 'bg-slate-50 text-slate-500 border-slate-200'
                        : c <= 7 ? 'bg-rose-50 text-rose-700 border-rose-200'
                        : c <= 21 ? 'bg-amber-50 text-amber-800 border-amber-200'
                        : c <= 120 ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-indigo-50 text-indigo-700 border-indigo-200';
                      return (
                        <tr key={r.product.id} className="text-[11px] font-bold text-[#0B1F4D]">
                          <td className="px-4 py-3">{r.product.name}</td>
                          <td className="px-3 py-3">{toArabicDigits(r.stock)} {r.product.unit || 'قطعة'}</td>
                          <td className="px-3 py-3">{toArabicDigits(r.soldQty)}</td>
                          <td className="px-3 py-3 text-slate-500">{toArabicDigits(r.avgPerDay.toFixed(2))}</td>
                          <td className="px-3 py-3">
                            <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${tone}`}>
                              {c === null ? 'لا مبيعات' : `${toArabicDigits(Math.round(c))} يوم`}
                            </span>
                            {c !== null && c <= 7 && <span className="text-[9px] text-rose-600 font-extrabold block mt-0.5">اطلبها الآن</span>}
                            {c !== null && c > 180 && <span className="text-[9px] text-indigo-600 font-extrabold block mt-0.5">لا تشترِ منها</span>}
                          </td>
                          <td className="px-3 py-3 text-slate-500">
                            {r.turnover === null ? '—' : `${toArabicDigits(r.turnover.toFixed(2))}×`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================= ٥. أفضل العملاء ========================= */}
      {tab === 'customers' && (
        <div className="space-y-4">
          <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-[10px] font-bold text-blue-900 leading-relaxed flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              <b>«الأفضل» ليس الأكثر شراءً.</b> زبون يشتري كثيراً ديناً ولا يسدّد هو أسوأ زبون لا أفضلهم.
              لذلك الترتيب <b>بالربح المحقّق</b>، مع عمودَي الدين ونسبة السداد أمام عينك.
            </span>
          </div>

          <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
            {customerRows.length === 0 ? <Empty text="لا يوجد زبائن بعد" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-right min-w-[720px]">
                  <thead className="bg-slate-50">
                    <tr className="text-[10px] font-extrabold text-slate-500">
                      <th className="px-4 py-2.5">الزبون</th>
                      <th className="px-3 py-2.5">المشتريات</th>
                      <th className="px-3 py-2.5">الربح منه</th>
                      <th className="px-3 py-2.5">الدين الحالي</th>
                      <th className="px-3 py-2.5">نسبة السداد</th>
                      <th className="px-3 py-2.5">آخر شراء</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {customerRows.map(r => {
                      const badge = customerBadge(r);
                      const badgeTone =
                        badge === 'ذهبي' ? 'bg-amber-50 text-amber-800 border-amber-300'
                        : badge === 'خطر ائتماني' ? 'bg-rose-50 text-rose-700 border-rose-300'
                        : badge === 'مفقود' ? 'bg-slate-100 text-slate-600 border-slate-300'
                        : badge === 'جديد' ? 'bg-sky-50 text-sky-700 border-sky-200'
                        : 'bg-slate-50 text-slate-500 border-slate-200';
                      const pay = r.payRatio;
                      return (
                        <tr key={r.customer.id} className="text-[11px] font-bold text-[#0B1F4D]">
                          <td className="px-4 py-3">
                            <span className="flex items-center gap-1.5 flex-wrap">
                              {badge === 'ذهبي' && <Crown className="w-3 h-3 text-amber-500" />}
                              {r.customer.name}
                              <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded-full border ${badgeTone}`}>{badge}</span>
                            </span>
                            <span className="text-[9px] text-slate-400">{toArabicDigits(r.invoiceCount)} فاتورة</span>
                          </td>
                          <td className="px-3 py-3">{money(r.purchases)}</td>
                          <td className="px-3 py-3 text-emerald-700">
                            {money(r.profit)}
                            {r.unknownProfitSales > 0 && <span className="block text-[9px] text-slate-400">جزء بلا تكلفة معروفة</span>}
                          </td>
                          <td className={`px-3 py-3 ${r.debt > 0 ? 'text-amber-700' : 'text-slate-400'}`}>{money(r.debt)}</td>
                          <td className="px-3 py-3">
                            {pay === null ? <span className="text-slate-400">—</span> : (
                              <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${
                                pay >= 0.9 ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : pay >= 0.5 ? 'bg-amber-50 text-amber-800 border-amber-200'
                                : 'bg-rose-50 text-rose-700 border-rose-200'
                              }`}>{toArabicDigits(Math.round(pay * 100))}٪</span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-slate-500">
                            {r.lastPurchase ? (
                              <>
                                {toArabicDigits(r.lastPurchase)}
                                {r.daysSincePurchase !== null && r.daysSincePurchase >= 90 && (
                                  <span className="block text-[9px] text-rose-600 font-extrabold flex items-center gap-1">
                                    <TrendingDown className="w-2.5 h-2.5" /> منذ {toArabicDigits(r.daysSincePurchase)} يوم
                                  </span>
                                )}
                              </>
                            ) : <span className="text-slate-400">لم يشترِ في الفترة</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================= ٦. أ ب ج ========================= */}
      {tab === 'abc' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-bold text-slate-500">التحليل حسب:</span>
            {([['revenue', 'المبيعات'], ['profit', 'الربح']] as const).map(([id, label]) => (
              <button key={id} onClick={() => setAbcBy(id)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-extrabold cursor-pointer border ${
                  abcBy === id ? 'bg-[#0B1F4D] text-white border-[#0B1F4D]' : 'bg-white text-slate-600 border-slate-200'
                }`}>{label}</button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {([
              ['أ', abc.counts.أ, 'أول ٨٠٪ من القيمة — لا تدعها تنفد أبداً، راقبها يومياً', 'emerald'],
              ['ب', abc.counts.ب, 'الـ ١٥٪ التالية — متابعة عادية', 'sky'],
              ['ج', abc.counts.ج, 'آخر ٥٪ — قلّل شراءها وفكّر بتصفيتها', 'slate'],
            ] as const).map(([g, n, desc, tone]) => (
              <div key={g} className={`rounded-2xl border-2 p-4 ${
                tone === 'emerald' ? 'bg-emerald-50/60 border-emerald-200'
                : tone === 'sky' ? 'bg-sky-50/60 border-sky-200' : 'bg-slate-50 border-slate-200'
              }`}>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-extrabold text-[#0B1F4D]">{g}</span>
                  <span className="text-sm font-extrabold text-slate-600">{toArabicDigits(n)} مادة</span>
                </div>
                <span className="text-[10px] text-slate-500 font-bold block mt-1 leading-relaxed">{desc}</span>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
            {abc.rows.length === 0 ? <Empty text="لا توجد مبيعات في هذه الفترة لتحليلها" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-right min-w-[620px]">
                  <thead className="bg-slate-50">
                    <tr className="text-[10px] font-extrabold text-slate-500">
                      <th className="px-4 py-2.5">المادة</th>
                      <th className="px-3 py-2.5">التصنيف</th>
                      <th className="px-3 py-2.5">{abcBy === 'revenue' ? 'المبيعات' : 'الربح'}</th>
                      <th className="px-3 py-2.5">نسبته</th>
                      <th className="px-3 py-2.5">التراكمي</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {abc.rows.map(r => (
                      <tr key={r.agg.productId} className="text-[11px] font-bold text-[#0B1F4D]">
                        <td className="px-4 py-3">{r.agg.name}</td>
                        <td className="px-3 py-3">
                          <span className={`text-[11px] font-extrabold w-6 h-6 rounded-lg inline-flex items-center justify-center border ${
                            r.grade === 'أ' ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                            : r.grade === 'ب' ? 'bg-sky-50 text-sky-700 border-sky-300'
                            : 'bg-slate-50 text-slate-500 border-slate-300'
                          }`}>{r.grade}</span>
                        </td>
                        <td className="px-3 py-3">{money(r.value)}</td>
                        <td className="px-3 py-3 text-slate-500">{toArabicDigits(r.share.toFixed(1))}٪</td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5">
                            <div className="h-1.5 w-16 rounded-full bg-slate-100 overflow-hidden">
                              <div className="h-full bg-[#0B1F4D]" style={{ width: `${Math.round(r.cumulative)}%` }} />
                            </div>
                            <span className="text-[10px] text-slate-500">{toArabicDigits(r.cumulative.toFixed(0))}٪</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      <p className="text-[10px] text-slate-400 font-bold leading-relaxed flex items-start gap-1.5">
        <Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
        <span>
          كل الأرقام مشتقّة من فواتيرك ومنتجاتك الحيّة — لا جداول ملخّصات ولا عدّادات منفصلة.
          المرتجعات مخصومة تلقائياً. المواد بلا سعر شراء مسجَّل لا يُخمَّن ربحها أبداً وتُعرض منفصلة.
          التقارير قراءة فقط — لا تُعدّل أي بيان، وتعمل بلا إنترنت.
        </span>
      </p>
    </div>
  );
}
