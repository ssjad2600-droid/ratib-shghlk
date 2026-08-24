import React, { useMemo, useState } from 'react';
import {
  BarChart3, TrendingUp, TrendingDown, DollarSign, Users, BarChart,
  AlertTriangle, CheckCircle, ArrowUpRight, ArrowDownRight,
  HelpCircle, Activity, ShoppingBag
} from 'lucide-react';
import { useCollection } from '../hooks/useCollection';
import { useProductCosts } from '../hooks/useProductCosts';
import { UserProfile, SystemSettings, Invoice, Customer, Product } from '../types';
import { toArabicDigits, formatCurrency, formatArabicNoun, ARABIC_NOUNS } from '../utils/arabicFormatters';
import { sumByMethod, isCashMethod } from '../utils/paymentMethods';
import { useBranches } from '../hooks/useBranches';
import { windowConstraints, daysAgoKey, WINDOW } from '../utils/dateWindow';
import { netProfitOf, costLookup } from '../utils/profit';
import { periodRange, isInRange, chartBuckets, parseDayLoose, rangeText, MAX_PERIOD_DAYS } from '../utils/reportPeriod';
import { exportAsWord, exportAsPdf, ExportSpec } from '../utils/exportDoc';
import { visibleStock } from '../utils/branchStock';

interface FinancialTransaction {
  id: string;
  title: string;
  amount: number;
  type: 'revenue' | 'expense';
  category: string;
  date: string;
  notes: string;
  branchId?: string; // غيابه = الفرع الرئيسي
}

interface ReportsViewProps {
  user: UserProfile;
  settings: SystemSettings;
}

export default function ReportsView({ user, settings }: ReportsViewProps) {
  // ---- 1. UI STATE ----
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'yearly'>('monthly');
  /** العمود المفتوح باللمس. على الكمبيوتر يكفي المرور بالفأرة، أما على
   * الهاتف فلا hover — وكانت أرقام العمود **غير قابلة للوصول إطلاقاً**. */
  const [openBar, setOpenBar] = useState<number | null>(null);

  // ---- 2. LIVE FIRESTORE DATA ----
  // تقارير الموقع النشط ('' = كل الفروع ⇒ عرض مجمّع). السجلات القديمة بلا موقع = الرئيسي.
  const { activeBranchId, matchesActiveBranch, isMultiBranch, branchName, stampBranchId } = useBranches();
  // نافذة واحدة تغطّي أطول فترة (٣٦٥ يوماً) بهامش — للفواتير **وللحركات المالية** معاً.
  // كانت الحركات تُقرأ من أول يوم في عمر المحل لعرض فترةٍ أقصاها سنة.
  const invWindow = useMemo(() => windowConstraints(daysAgoKey(WINDOW.REPORTS)), []);
  const { items: allInvoices } = useCollection<Invoice>('invoices', invWindow);
  const { items: allTransactions } = useCollection<FinancialTransaction>('financial_transactions', invWindow);
  const invoices = allInvoices.filter(matchesActiveBranch);
  const transactions = allTransactions.filter(matchesActiveBranch);
  const { items: customers } = useCollection<Customer>('customers');
  const { items: products } = useCollection<Product>('products');
  // تكلفة المفرد (buyPriceOf مع fallback موروث) وتكلفة الجملة (wholesaleBuyPriceOf بلا تخمين)
  const { buyPriceOf, wholesaleBuyPriceOf } = useProductCosts();

  /**
   * ---- 3. النطاق الزمني — **مصدر واحد** للبطاقات والمخطط والتصدير ----
   *
   * 🔴 كان في هذا الملف محرّك تصفية محلّي (`isDateInPeriod`) يحسب مدى البطاقات، ومولّد
   * مخطط يرسم عدداً **ثابتاً** من الأعمدة بقاعدة أخرى — فافترق المقياسان، وتحتهما جملة
   * تقول «بيانات حقيقية للفترة المختارة». والسنة كانت أسوأها: بطاقات ٣٦٧ يوماً ومخطط ١٧١.
   * الآن كلاهما من `periodRange`، فيستحيل افتراقهما.
   */
  const range = useMemo(() => periodRange(period), [period]);

  // ---- 4. CALCULATED STATS ----
  const filteredInvoices = invoices.filter(inv => isInRange(inv.date, range));
  const filteredTransactions = transactions.filter(t => isInRange(t.date, range));

  // A. Total Sales (حجم المبيعات الكلي — أساس استحقاق)
  const totalSales = filteredInvoices.reduce((sum, inv) => sum + (inv.finalAmount || 0), 0);
  const invoiceCount = filteredInvoices.length;

  // A2. الإيراد الفعلي المحصّل (أساس نقدي — ما دخل الجيب فعلاً)
  const totalCollected = filteredInvoices.reduce((sum, inv) => sum + (inv.paidAmount ?? inv.finalAmount ?? 0), 0);

  // A3. تفصيل المحصَّل حسب طريقة الدفع — الفواتير القديمة (بلا payments) تُحسب كاش
  const collectedByMethod = sumByMethod(
    filteredInvoices.map(inv => ({ paidAmount: inv.paidAmount ?? inv.finalAmount ?? 0, payments: inv.payments })),
  );
  const methodRows = [...collectedByMethod.entries()].sort((a, b) => b[1] - a[1]);

  /**
   * B–E. الربح — من المحرّك المشترك `utils/profit.ts`.
   *
   * كان هذا الحساب صحيحاً هنا ومكتوباً في هذا الملف وحده، بينما شاشة «المصاريف والأرباح»
   * تحسب «المبيعات − المصاريف» بلا تكلفة بضاعة. فكان في البرنامج رقما ربحٍ متناقضان.
   * نقلنا هذا الحساب — لا ذاك — إلى مصدر واحد تستدعيه الشاشتان، فيستحيل التناقض.
   */
  const costOf = costLookup(
    (line) => products.find(p => p.id === (line.productId || line.itemId) || p.name === line.name),
    buyPriceOf,
    wholesaleBuyPriceOf,
  );
  const profit = netProfitOf(filteredInvoices, filteredTransactions, costOf);
  const totalProfit = profit.grossProfit;
  const unknownSalesTotal = profit.unknownCostSales;
  const hasUnknownProfit = unknownSalesTotal > 0;
  const totalRevenueTransactions = profit.manualRevenue;
  const totalExpenses = profit.expenses;
  const netEarnings = profit.netProfit;

  // E. Customer debts (all-time snapshot, not filtered by period)
  const totalOutstandingDebts = customers.reduce((sum, c) => sum + (c.balance > 0 ? c.balance : 0), 0);
  const debtorCount = customers.filter(c => c.balance > 0).length;

  // F. Inventory stats
  const lowStockProductsCount = products.filter(p => visibleStock(p, activeBranchId) <= p.lowStockThreshold).length;

  /**
   * ---- 5. المخطط — دلاؤه **مشتقّة من النطاق نفسه** ----
   * فمجموع الأعمدة يساوي أرقام البطاقات بالضبط، ولا يبقى يومٌ خارج الرسم.
   */
  const chartData = useMemo(() => {
    const inDay = (dateStr: string, from: Date, to: Date) => {
      const d = parseDayLoose(dateStr);
      return !!d && d >= from && d <= to;
    };
    return chartBuckets(period, range).map(b => ({
      name: b.name,
      outsidePeriod: b.outsidePeriod,
      sales: invoices.filter(i => inDay(i.date, b.from, b.to)).reduce((s, i) => s + i.finalAmount, 0),
      expenses: transactions.filter(t => t.type === 'expense' && inDay(t.date, b.from, b.to))
        .reduce((s, t) => s + t.amount, 0),
    }));
  }, [period, range, invoices, transactions]);
  const maxValInChart = Math.max(...chartData.map(d => Math.max(d.sales, d.expenses)), 1);

  /**
   * ---- ٦. التصدير ----
   * 🟡 كانت الشاشة بلا تصدير إطلاقاً، بينما شاشات أقلّ أهمية (الموردون، تقارير القرار،
   * فواتير الشراء) تُصدّر. والتاجر الذي يحتاج ورقةً لمحاسبه أو مصرفه لا يجدها هنا تحديداً.
   * والنطاق مطبوع في العنوان الفرعي — فالورقة تقول مداها بنفسها خارج البرنامج.
   */
  const money = (v: number) => formatCurrency(v, settings.currency, settings.exchangeRate);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const buildExport = (): ExportSpec => {
    const scope = isMultiBranch ? ` — ${activeBranchId ? branchName(stampBranchId) : 'كل الفروع'}` : '';
    return {
      title: user.storeName || 'رتب شغلك',
      subtitle: `تقرير ${range.label} (${rangeText(range)})${scope}`,
      columns: [{ header: 'البند' }, { header: 'القيمة', align: 'center' }],
      rows: [
        ['سجل مبيعات الفواتير', money(totalSales)],
        ['عدد الفواتير', toArabicDigits(invoiceCount)],
        ['الإيراد الفعلي المحصّل', money(totalCollected)],
        ['لم يُحصَّل بعد', money(Math.max(0, totalSales - totalCollected))],
        ['ربح البيع (بعد تكلفة البضاعة)', money(totalProfit)],
        ['إيرادات يدوية', money(totalRevenueTransactions)],
        ['المصاريف والمسحوبات', money(totalExpenses)],
        ['صافي الربح بعد المصاريف', money(netEarnings)],
        ...(hasUnknownProfit ? [['مبيعات بلا سعر شراء (ربحها غير محتسب)', money(unknownSalesTotal)]] : []),
        ...methodRows.map(([m, amt]) => [`محصَّل — ${m}`, money(amt)]),
        ['ديون الزبائن (رصيد حالي، خارج الفترة)', money(totalOutstandingDebts)],
      ],
      note: `المبيعات صافية من المرتجعات. الأرقام تخصّ ${range.label} ما لم يُذكر غير ذلك.`,
    };
  };
  const doExport = (format: 'word' | 'pdf') => {
    if (filteredInvoices.length === 0 && filteredTransactions.length === 0) {
      setExportMsg('لا توجد بيانات في هذه الفترة للتصدير');
      setTimeout(() => setExportMsg(null), 4000);
      return;
    }
    const name = `تقرير_${range.label.replace(/\s+/g, '_')}_${new Date().toLocaleDateString('ar-IQ').replace(/\//g, '-')}`;
    if (format === 'word') {
      exportAsWord(buildExport(), name);
      setExportMsg('تم تصدير ملف Word 📄');
    } else {
      exportAsPdf(buildExport(), (m) => setExportMsg(m));
    }
    setTimeout(() => setExportMsg(null), 4000);
  };

  // ---- 7. THEME ----
  const themeTheme = { iconColor: 'text-blue-500', bgLight: 'bg-blue-500/10', borderAccent: 'border-blue-200', badgeBg: 'bg-[#0B1F4D]' };

  return (
    <div className="space-y-6" id="reports_module_full_wrapper" dir="rtl">

      {/* Header + Period filter */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-[#0B1F4D] text-white p-6 rounded-2xl shadow-md border-b-4 border-amber-400">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-1 px-2.5 bg-amber-500 text-slate-950 font-black rounded-lg text-[10px] uppercase tracking-wider font-sans">
              وحدة التحليل والتقارير v١.٥
            </span>
            <div className="flex items-center gap-1 text-slate-300 text-xs font-bold font-cairo">
              <Activity className="w-3.5 h-3.5 text-emerald-500 animate-pulse" />
              <span>لوحة التقارير الذكية 📊</span>
            </div>
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2">
            <BarChart3 className="w-6.5 h-6.5 text-amber-400" />
            <span>لوحة التقارير وتحليل حسابات المتجر</span>
            {isMultiBranch && (
              <span className="text-[10px] font-extrabold px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-200 border border-amber-400/40">
                🏢 {activeBranchId ? branchName(stampBranchId) : 'كل الفروع (مجمّع)'}
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed font-medium">
            شاهد مبيعات الفواتير الفورية، وتجرد أرباحك الصافية، وتتبع تكاليف المصاريف مع ملخصات ذكية بلهجتك البغدادية
          </p>
        </div>

        <div className="bg-slate-900/60 p-2.5 rounded-xl border border-slate-700/80 flex gap-1 self-start md:self-center">
          {(['daily', 'weekly', 'monthly', 'yearly'] as const).map(p => (
            <button
              key={p}
              onClick={() => { setPeriod(p); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-extrabold transition cursor-pointer ${
                period === p ? 'bg-amber-500 text-slate-950 shadow' : 'text-slate-300 hover:text-white hover:bg-white/10'
              }`}
            >
              {p === 'daily' ? 'يومي' : p === 'weekly' ? 'أسبوعي' : p === 'monthly' ? 'شهري' : 'سنوي'}
            </button>
          ))}
        </div>
      </div>

      {/* شريط النطاق والتصدير — الشاشة تقول مداها بنفسها */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white rounded-2xl px-5 py-3 border border-[#E4EAF3] shadow-sm">
        <span className="text-[11px] font-bold text-[#5B6B86]">
          📅 كل الأرقام تخصّ <b className="text-[#0B1F4D]">{range.label}</b> — {rangeText(range)}
        </span>
        <div className="flex gap-2">
          <button onClick={() => doExport('word')}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-extrabold rounded-lg cursor-pointer">
            تصدير Word
          </button>
          <button onClick={() => doExport('pdf')}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-extrabold rounded-lg cursor-pointer">
            تصدير PDF
          </button>
        </div>
      </div>
      {exportMsg && (
        <div className="px-4 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold">
          {exportMsg}
        </div>
      )}

      {/* 5 Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">

        {/* Sales */}
        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <span className="text-xs font-extrabold text-[#5B6B86]">سجل مبيعات الفواتير</span>
            <span className="p-2.5 bg-emerald-50 rounded-xl text-emerald-700"><DollarSign className="w-5 h-5" /></span>
          </div>
          <div className="mt-4">
            <h4 className="text-xl md:text-2xl font-black font-cairo text-slate-900 leading-none">
              {formatCurrency(totalSales, settings.currency, settings.exchangeRate)}
            </h4>
            <div className="flex items-center gap-1.5 mt-2 text-emerald-700 font-bold text-[10px]">
              <ArrowUpRight className="w-3.5 h-3.5" />
              <span>شامل {toArabicDigits(invoiceCount)} فواتير مسلّمة</span>
            </div>
          </div>
        </div>

        {/* Collected Revenue — أساس نقدي */}
        <div className="bg-white rounded-2xl p-5 border border-emerald-200 shadow-sm flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <span className="text-xs font-extrabold text-[#5B6B86]">الإيراد الفعلي المحصّل</span>
            <span className="p-2.5 bg-teal-50 rounded-xl text-teal-600"><CheckCircle className="w-5 h-5" /></span>
          </div>
          <div className="mt-4">
            <h4 className="text-xl md:text-2xl font-black font-cairo text-teal-700 leading-none">
              {formatCurrency(totalCollected, settings.currency, settings.exchangeRate)}
            </h4>
            <div className="flex items-center gap-1 mt-2 text-teal-700 font-bold text-[10px]">
              <ArrowUpRight className="w-3.5 h-3.5" />
              <span>ما دخل الجيب فعلاً (نقدي)</span>
            </div>
            {totalCollected < totalSales && (
              <div className="flex items-center gap-1 mt-1 text-amber-700 font-bold text-[10px]">
                <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                <span>{formatCurrency(totalSales - totalCollected, settings.currency, settings.exchangeRate)} لم تُحصَّل بعد</span>
              </div>
            )}
          </div>
        </div>

        {/* Net Profit */}
        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <span className="text-xs font-extrabold text-[#5B6B86]">صافي الربح التقريبي</span>
            <span className="p-2.5 bg-blue-50 rounded-xl text-blue-600"><TrendingUp className="w-5 h-5" /></span>
          </div>
          <div className="mt-4">
            <h4 className={`text-xl md:text-2xl font-black font-cairo leading-none ${netEarnings >= 0 ? 'text-slate-900' : 'text-rose-700'}`}>
              {formatCurrency(Math.abs(netEarnings), settings.currency, settings.exchangeRate)}
            </h4>
            <div className={`flex items-center gap-1 mt-2 text-[10px] font-bold ${netEarnings >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {netEarnings >= 0 ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
              <span>{netEarnings >= 0 ? 'صافي ربح بعد المصاريف' : 'خسارة بعد المصاريف'}</span>
            </div>
            {hasUnknownProfit && (
              <div className="flex items-center gap-1 mt-1 text-[10px] font-bold text-amber-700">
                <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                <span>بعض المواد بدون سعر شراء (غير محتسبة)</span>
              </div>
            )}
          </div>
        </div>

        {/* Expenses */}
        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <span className="text-xs font-extrabold text-[#5B6B86]">المصاريف والمسحوبات</span>
            <span className="p-2.5 bg-rose-50 rounded-xl text-rose-700"><TrendingDown className="w-5 h-5" /></span>
          </div>
          <div className="mt-4">
            <h4 className="text-xl md:text-2xl font-black font-cairo text-slate-900 leading-none">
              {formatCurrency(totalExpenses, settings.currency, settings.exchangeRate)}
            </h4>
            <div className="flex items-center gap-1 mt-2 text-rose-700 font-bold text-[10px]">
              <ArrowDownRight className="w-3.5 h-3.5" />
              <span>
                {filteredTransactions.filter(t => t.type === 'expense').length > 0
                  ? `${toArabicDigits(filteredTransactions.filter(t => t.type === 'expense').length)} سجل مصروف بالفترة`
                  : 'لا مصاريف مسجلة بالفترة'}
              </span>
            </div>
          </div>
        </div>

        {/* Customer Debts */}
        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <span className="text-xs font-extrabold text-[#5B6B86]">المتبقي بديون الزبائن</span>
            <span className="p-2.5 bg-amber-50 rounded-xl text-amber-700"><Users className="w-5 h-5" /></span>
          </div>
          <div className="mt-4">
            <h4 className="text-xl md:text-2xl font-black font-cairo text-slate-900 leading-none">
              {formatCurrency(totalOutstandingDebts, settings.currency, settings.exchangeRate)}
            </h4>
            <div className="flex items-center gap-1 mt-2 text-amber-700 font-bold text-[10px]">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>على {toArabicDigits(debtorCount)} زبوناً — رصيد حالي خارج الفترة</span>
            </div>
          </div>
        </div>

      </div>

      {/* Chart + Segment Details */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* Bar chart */}
        <div className="lg:col-span-8 bg-white rounded-3xl p-6 border border-[#E4EAF3] shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
              <div>
                <h3 className="font-extrabold text-sm md:text-base font-cairo text-[#0B1F4D] flex items-center gap-2">
                  <BarChart className="w-5 h-5 text-indigo-500" />
                  <span>المخطط العام للواردات والمبيعات مقارنة بالمصاريف</span>
                </h3>
                <p className="text-xs text-[#5B6B86] mt-0.5">مجموع الأعمدة يساوي أرقام البطاقات أعلاه — {rangeText(range)}</p>
              </div>
              <div className="flex gap-4 text-[11px] font-bold">
                <span className="flex items-center gap-1.5 text-emerald-700">
                  <span className="w-3 h-3 bg-emerald-500 rounded-md" />مبيعات الفواتير
                </span>
                <span className="flex items-center gap-1.5 text-rose-700">
                  <span className="w-3 h-3 bg-rose-500 rounded-md" />أرقام المصاريف
                </span>
              </div>
            </div>

            {maxValInChart > 1 ? (
              <div className="h-64 flex items-end justify-between gap-3 pt-6 border-b border-slate-100">
                {chartData.map((data, idx) => {
                  const salesH = (data.sales / maxValInChart) * 100;
                  const expH = (data.expenses / maxValInChart) * 100;
                  return (
                    <div key={idx} onClick={() => setOpenBar(openBar === idx ? null : idx)}
                      className={`flex-1 flex flex-col items-center gap-2 group h-full justify-end relative ${data.outsidePeriod ? 'opacity-50' : ''}`}>
                      <div className={`${openBar === idx ? 'flex' : 'hidden'} md:group-hover:flex flex-col bg-slate-950 text-white text-[11px] p-2 rounded-xl absolute -top-8 z-30 shadow-lg text-center w-28`}>
                        <span className="font-extrabold">{data.name}</span>
                        {/* 🔴 عمود «البارحة» في عرض «اليوم» ليس من الفترة — يُقال صراحةً بدل أن يُوهم */}
                        {data.outsidePeriod && <span className="text-amber-300">للمقارنة فقط — خارج الفترة</span>}
                        <span className="text-emerald-300">مبيعات: {toArabicDigits(Math.round(data.sales).toLocaleString())}</span>
                        <span className="text-rose-300">مصاريف: {toArabicDigits(Math.round(data.expenses).toLocaleString())}</span>
                      </div>
                      <div className="w-full flex items-end justify-center gap-1 h-44">
                        <div className="w-3.5 bg-emerald-500 rounded-t-md hover:bg-emerald-600 cursor-pointer transition-all duration-300"
                          style={{ height: `${Math.max(salesH, 2)}%` }} />
                        <div className="w-3.5 bg-rose-500 rounded-t-md hover:bg-rose-600 cursor-pointer transition-all duration-300"
                          style={{ height: `${Math.max(expH, 2)}%` }} />
                      </div>
                      <span className="text-[10px] text-[#5B6B86] font-bold text-center truncate w-full mt-1.5 block">
                        {data.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="h-64 flex flex-col items-center justify-center p-6 border-b border-slate-100 text-slate-500">
                <BarChart3 className="w-12 h-12 text-slate-400 mb-2 animate-pulse" />
                <p className="text-xs font-bold">لا توجد فواتير أو مصاريف مسجلة بهذه الفترة</p>
                <p className="text-[10px] mt-0.5">سجّل فواتير أو مصاريف وستظهر البيانات مباشرة</p>
              </div>
            )}
          </div>
          <div className="text-[11px] text-slate-500 mt-4 leading-relaxed flex items-center gap-1 font-medium select-none">
            <HelpCircle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>المسْ أي عمود أو مرّر عليه لرؤية قيمته بدقّة.</span>
          </div>
        </div>

        {/* Segment-specific details */}
        <div className="lg:col-span-4 space-y-6">
          <div className="bg-white rounded-3xl p-6 border border-[#E4EAF3] shadow-sm space-y-5">
            <div className="flex items-center gap-2.5 pb-3 border-b border-slate-100">
              <span className={`p-2 rounded-xl ${themeTheme.bgLight} ${themeTheme.iconColor}`}>
                <ShoppingBag className="w-5.5 h-5.5" />
              </span>
              <div>
                <h4 className="font-extrabold text-[#0B1F4D] font-cairo text-sm">جرد المستودع</h4>
                <p className="text-xs text-[#5B6B86] mt-0.5">تفاصيل المخزون والزبائن</p>
              </div>
            </div>

            {/* تفصيل المحصَّل حسب طريقة الدفع — لمطابقة كشوف البنك والمحافظ */}
            {methodRows.length > 0 && (
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <div className="px-3.5 py-2.5 bg-slate-50 border-b border-slate-100">
                  <span className="text-xs font-extrabold text-[#0B1F4D]">💳 المحصَّل حسب طريقة الدفع</span>
                </div>
                <div className="divide-y divide-slate-50">
                  {methodRows.map(([method, amount]) => (
                    <div key={method} className="flex justify-between items-center px-3.5 py-2.5 text-xs">
                      <span className={`font-bold ${isCashMethod(method) ? 'text-emerald-700' : 'text-blue-700'}`}>
                        {isCashMethod(method) ? '💵' : '💳'} {method}
                      </span>
                      <span className="font-extrabold text-[#0B1F4D] font-sans">
                        {formatCurrency(amount, settings.currency, settings.exchangeRate)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-4">
              <div className="flex justify-between items-center p-3.5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-medium">
                <span className="text-slate-500">مجموع البضاعة المسجلة:</span>
                <span className="font-extrabold text-[#0B1F4D] bg-slate-100 px-2.5 py-1 rounded-lg">
                  {toArabicDigits(products.length)} مادة
                </span>
              </div>
              <div className="flex justify-between items-center p-3.5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-medium">
                <span className="text-slate-500">نقص حرج بالمخزن:</span>
                <span className="font-extrabold text-amber-700 bg-amber-50 px-2.5 py-1 rounded-lg">
                  {toArabicDigits(lowStockProductsCount)} مادة ⚠️
                </span>
              </div>
              <div className="flex justify-between items-center p-3.5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-medium">
                <span className="text-slate-500">إجمالي الزبائن:</span>
                <span className="font-extrabold text-[#1B3A7A] bg-blue-50 px-2.5 py-1 rounded-lg">
                  {toArabicDigits(customers.length)} سجل
                </span>
              </div>
              <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl text-[11px] text-amber-900 leading-relaxed font-semibold">
                📦 راجع النواقص قبل نزول المجهز لتفادي قطع أي مادة عن الزبائن.
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
