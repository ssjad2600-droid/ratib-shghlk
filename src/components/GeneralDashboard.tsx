import { useMemo } from 'react';
import { ShoppingCart, Package, AlertTriangle, Coins } from 'lucide-react';
import { toArabicDigits, formatArabicNoun, ARABIC_NOUNS, formatCurrency } from '../utils/arabicFormatters';
import { Customer, Product, Invoice } from '../types';
import { useCollection } from '../hooks/useCollection';
import { localDateKey } from '../utils/dateLocal';
import { windowConstraints, daysAgoKey, WINDOW } from '../utils/dateWindow';
import { useBranches } from '../hooks/useBranches';
import { visibleStock } from '../utils/branchStock';

interface FinancialTx {
  id: string;
  amount: number;
  type: 'revenue' | 'expense';
  date: string;
  /** الموقع الذي خرج منه المال — غيابه = الفرع الرئيسي (كل الحركات السابقة) */
  branchId?: string;
}

const ARABIC_DAY = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
// مفتاح اليوم المحلي (لا UTC) — يطابق تواريخ الفواتير المخزّنة محلياً
const isoDate = (d: Date) => localDateKey(d);

/**
 * عرض تاريخ الفاتورة.
 * ⚠️ `new Date('2026-08-05')` يُفسَّر **بتوقيت UTC** فيزحف يوماً في المناطق ذات الإزاحة
 * السالبة. نبني التاريخ من مكوّناته المحلية كما في بقية البرنامج.
 */
const formatInvDate = (dateStr: string) => {
  if (!dateStr) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(dateStr);
  return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('ar-IQ');
};

/** أقصى عدد نواقص تُرسم في اللوحة — الباقي يُفتح من شاشة المنتجات (تفادي رسم مئات الصفوف) */
const LOW_STOCK_PREVIEW = 15;

interface GeneralDashboardProps {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  /** الانتقال لشاشة أخرى — يجعل بطاقات اللوحة مداخل لا أرقاماً صامتة */
  onGo?: (tab: string) => void;
}

export default function GeneralDashboard({ currency, exchangeRate, onGo }: GeneralDashboardProps) {
  // 🔴 اللوحة كانت تحترم الفرع في المخزون فقط، وتعرض مبيعات **كل** الفروع مهما بدّل المالك.
  // فيرى مبيعات الفرعين وهو يظنّها مبيعات الفرع المختار — رقم يبني عليه قراراً.
  const { activeBranchId, matchesActiveBranch, isMultiBranch } = useBranches();
  const { items: products } = useCollection<Product>('products');
  const { items: customers } = useCollection<Customer>('customers');
  // اللوحة تعرض اليوم ورسم ٧ أيام وآخر الفواتير — لا معنى لتحميل فواتير من سنتين
  const invWindow = useMemo(() => windowConstraints(daysAgoKey(WINDOW.DASHBOARD)), []);
  const { items: allInvoices } = useCollection<Invoice>('invoices', invWindow);
  const { items: allTransactions } = useCollection<FinancialTx>('financial_transactions');

  const invoices = useMemo(() => allInvoices.filter(matchesActiveBranch), [allInvoices, matchesActiveBranch]);
  const transactions = useMemo(() => allTransactions.filter(matchesActiveBranch), [allTransactions, matchesActiveBranch]);

  const todayStr = isoDate(new Date());

  // Product stats

  const totalProductsCount = products.length;
  const categoriesCount = useMemo(
    () => new Set(products.map(p => p.category).filter(Boolean)).size,
    [products]
  );

  // Customer debt stats
  const debtCustomers = useMemo(() => customers.filter(c => c.balance > 0), [customers]);
  const outstandingDebtsTotal = debtCustomers.reduce((sum, c) => sum + c.balance, 0);
  const debtCustomerCount = debtCustomers.length;

  // Today's invoices
  const todayInvoices = useMemo(() => invoices.filter(inv => inv.date === todayStr), [invoices, todayStr]);
  const todaySalesTotal = todayInvoices.reduce((sum, inv) => sum + inv.finalAmount, 0);

  /**
   * آخر الفواتير — الترتيب بوقت الإنشاء لا باليوم وحده.
   * الترتيب بالتاريخ فقط يجعل كل فواتير اليوم متساوية، فيظهر ترتيب عشوائي والبائع
   * يبحث عن فاتورته الأخيرة فيرى فاتورة الصباح. `createdAt` موجود ومهمل.
   */
  const recentInvoices = useMemo(
    () => [...invoices]
      .sort((a, b) => {
        const t = (b.createdAt ?? 0) - (a.createdAt ?? 0);
        return t !== 0 ? t : b.date.localeCompare(a.date);
      })
      .slice(0, 3),
    [invoices]
  );

  // 7-day chart data from real invoices + expenses
  const chartDays = useMemo(() => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = isoDate(d);
      const dayName = i === 0 ? `${ARABIC_DAY[d.getDay()]} (اليوم)` : ARABIC_DAY[d.getDay()];
      const income = invoices
        .filter(inv => inv.date === dateStr)
        .reduce((sum, inv) => sum + inv.finalAmount, 0);
      const expense = transactions
        .filter(tx => tx.date === dateStr && tx.type === 'expense')
        .reduce((sum, tx) => sum + tx.amount, 0);
      days.push({ name: dayName, income, expense });
    }
    return days;
  }, [invoices, transactions]);

  const weeklyIncome = chartDays.reduce((sum, d) => sum + d.income, 0);
  const weeklyExpense = chartDays.reduce((sum, d) => sum + d.expense, 0);
  /** 🔴 الصافي = الوارد − المصاريف. كان يُعرض الوارد وحده تحت اسم «صافي» — تسمية مضلّلة على رقم مالي. */
  const weeklyNet = weeklyIncome - weeklyExpense;
  const maxChartValue = Math.max(...chartDays.map(d => Math.max(d.income, d.expense)), 1);

  // النواقص: تُحسب مرة وتُستعمل في البطاقة والقائمة معاً
  const lowStockProducts = useMemo(
    () => products.filter(p => visibleStock(p, activeBranchId) <= p.lowStockThreshold),
    [products, activeBranchId],
  );
  const lowStockCount = lowStockProducts.length;

  return (
    <div className="space-y-6">

      {/* 1. Four Stat Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" id="general_stat_grid">

        {/* Card 1: Today's sales (Green) */}
        <button type="button" onClick={() => onGo?.('invoices')} title="اضغط للانتقال" className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm relative overflow-hidden flex flex-col justify-between text-right w-full cursor-pointer hover:border-[#0B1F4D] hover:shadow-md transition active:scale-[0.98]">
          <div className="flex justify-between items-start">
            <span className="text-xs font-bold text-[#5B6B86]">أرباح ومبيعات اليوم</span>
            <span className="p-2.5 bg-[#E7F4EC] rounded-xl text-[#15803D]">
              <ShoppingCart className="w-5 h-5" />
            </span>
          </div>
          <div className="mt-4">
            <h4 className="text-2xl font-extrabold font-cairo text-[#0B1F4D]">
              {formatCurrency(todaySalesTotal, currency, exchangeRate)}
            </h4>
            <span className="text-[10px] text-[#15803D] font-bold block mt-1">
              {formatArabicNoun(todayInvoices.length, ARABIC_NOUNS.invoice)} مسجلة اليوم
            </span>
          </div>
        </button>

        {/* Card 2: Total Items count (Shared Blue) */}
        <button type="button" onClick={() => onGo?.('products')} title="اضغط للانتقال" className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm relative overflow-hidden flex flex-col justify-between text-right w-full cursor-pointer hover:border-[#0B1F4D] hover:shadow-md transition active:scale-[0.98]">
          <div className="flex justify-between items-start">
            <span className="text-xs font-bold text-[#5B6B86]">المواد الخاضعة للجرد</span>
            <span className="p-2.5 bg-[#EEF2F8] rounded-xl text-[#1B3A7A]">
              <Package className="w-5 h-5" />
            </span>
          </div>
          <div className="mt-4">
            <h4 className="text-2xl font-extrabold font-cairo text-[#0B1F4D]">
              {formatArabicNoun(totalProductsCount, ARABIC_NOUNS.product)}
            </h4>
            <span className="text-[10px] text-[#5B6B86] font-bold block mt-1">
              مصنفة تحت {formatArabicNoun(categoriesCount, ARABIC_NOUNS.category)}
            </span>
          </div>
        </button>

        {/* Card 3: Under-stock limit alerts (Amber) */}
        <button type="button" onClick={() => onGo?.('products')} title="اضغط للانتقال" className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm relative overflow-hidden flex flex-col justify-between text-right w-full cursor-pointer hover:border-[#0B1F4D] hover:shadow-md transition active:scale-[0.98]">
          <div className="flex justify-between items-start">
            <span className="text-xs font-bold text-[#5B6B86]">نواقص رفوف محلية</span>
            <span className="p-2.5 bg-[#FBF0DC] rounded-xl text-[#C77700]">
              <AlertTriangle className="w-5 h-5 animate-pulse" />
            </span>
          </div>
          <div className="mt-4">
            <h4 className="text-2xl font-extrabold font-cairo text-amber-600">
              {formatArabicNoun(lowStockCount, ARABIC_NOUNS.product)}
            </h4>
            <span className="text-[10px] text-[#C77700] font-bold block mt-1">
              أكياس وعلب دون حد الأمان
            </span>
          </div>
        </button>

        {/* Card 4: Outstanding debts to recover (Red) */}
        <button type="button" onClick={() => onGo?.('debts')} title="اضغط للانتقال" className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm relative overflow-hidden flex flex-col justify-between text-right w-full cursor-pointer hover:border-[#0B1F4D] hover:shadow-md transition active:scale-[0.98]">
          <div className="flex justify-between items-start">
            <span className="text-xs font-bold text-[#5B6B86]">إجمالي الديون المطلوبة</span>
            <span className="p-2.5 bg-[#FBEAEA] rounded-xl text-[#DC2626]">
              <Coins className="w-5 h-5" />
            </span>
          </div>
          <div className="mt-4">
            <h4 className="text-2xl font-extrabold font-cairo text-red-600">
              {formatCurrency(outstandingDebtsTotal, currency, exchangeRate)}
            </h4>
            <span className="text-[10px] text-[#DC2626] font-bold block mt-1">
              مستحقة لدى {formatArabicNoun(debtCustomerCount, ARABIC_NOUNS.customer)}
            </span>
          </div>
        </button>

      </div>

      {/* 2. Interactive Charts & List Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Left Side: Income vs Expense bar Chart */}
        <div className="lg:col-span-2 bg-white rounded-2xl p-6 border border-[#E4EAF3] shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="font-extrabold text-base font-cairo text-[#0B1F4D]">مقارنة الواردات والأرباح مع المصاريف</h3>
                <p className="text-xs text-[#5B6B86] mt-0.5">تقرير بياني عراقي لآخر سبعة أيام للمتجر</p>
              </div>
              <div className="flex gap-4 text-xs font-bold">
                <span className="flex items-center gap-1.5 text-[#15803D]">
                  <span className="w-3 h-3 bg-emerald-500 rounded-md" />
                  وارد مبيعات
                </span>
                <span className="flex items-center gap-1.5 text-[#DC2626]">
                  <span className="w-3 h-3 bg-rose-500 rounded-md" />
                  مصاريف النقدية
                </span>
              </div>
            </div>

            {/* Custom bar chart representation */}
            <div className="h-64 flex items-end justify-between gap-2.5 pt-6 border-b border-slate-100" id="bars_rendering_zone">
              {chartDays.map((day, idx) => {
                const incHeight = maxChartValue > 0 ? (day.income / maxChartValue) * 100 : 0;
                const expHeight = maxChartValue > 0 ? (day.expense / maxChartValue) * 100 : 0;
                return (
                  <div key={idx} className="flex-1 flex flex-col items-center gap-2 group h-full justify-end relative">

                    {/* Visual Tooltips on hover */}
                    <div className="hidden group-hover:flex flex-col bg-slate-900 text-white text-[9px] p-2 rounded absolute -mt-16 z-20 shadow text-center">
                      <span>وارد: {toArabicDigits(day.income.toLocaleString())}</span>
                      <span>صرف: {toArabicDigits(day.expense.toLocaleString())}</span>
                    </div>

                    <div className="w-full flex items-end justify-center gap-1.5 h-48">
                      {/* Income Bar */}
                      <div
                        className="w-3.5 bg-emerald-500 rounded-t-md hover:bg-emerald-600 transition-all duration-300"
                        style={{ height: `${incHeight}%` }}
                      />
                      {/* Expense Bar */}
                      <div
                        className="w-3.5 bg-rose-500 rounded-t-md hover:bg-rose-600 transition-all duration-300"
                        style={{ height: `${expHeight}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-bold text-slate-500 mt-1 select-none whitespace-nowrap">{day.name}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 🔴 كان يُعرض الوارد وحده تحت اسم «صافي». الرقمان منفصلان الآن، والصافي
              يطرح المصاريف فعلاً — الفرق بينهما هو المعلومة التي تهمّ التاجر. */}
          <div className="mt-4 pt-3 border-t border-slate-50 flex justify-between items-center gap-3 text-xs font-bold text-[#5B6B86] flex-wrap">
            <div className="flex items-center gap-4 flex-wrap">
              <span>وارد الأسبوع: <span className="text-emerald-700">{formatCurrency(weeklyIncome, currency, exchangeRate)}</span></span>
              <span>المصاريف: <span className="text-rose-700">{formatCurrency(weeklyExpense, currency, exchangeRate)}</span></span>
              <span className="font-extrabold text-[#0B1F4D]">
                الصافي: <span className={weeklyNet >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                  {formatCurrency(weeklyNet, currency, exchangeRate)}
                </span>
              </span>
            </div>
            {isMultiBranch && (
              <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-lg">
                🏢 أرقام الموقع المختار أعلى الشاشة
              </span>
            )}
          </div>
        </div>

        {/* Right Side: Simple Live List panel */}
        <div className="bg-white rounded-2xl p-6 border border-[#E4EAF3] shadow-sm flex flex-col justify-between">
          <div>
            <h3 className="font-extrabold text-base font-cairo text-[#0B1F4D] mb-1">المواد القريبة للنفاد (النواقص)</h3>
            <p className="text-xs text-[#5B6B86] mb-4">يُرجى إعداد طلبيات توريد مع المذخر أو التاجر المورد</p>

            <div className="space-y-4 max-h-76 overflow-y-auto pr-1">
              {lowStockProducts.slice(0, LOW_STOCK_PREVIEW).map(product => (
                <div key={product.id} className="p-3 bg-amber-50/50 hover:bg-amber-50 rounded-xl border border-amber-100 flex justify-between items-center transition">
                  <div className="flex items-center gap-3">
                    <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                    <div>
                      <h4 className="text-xs font-bold text-[#0B1F4D]">{product.name}</h4>
                      <p className="text-[10px] text-slate-400 font-medium mt-1">الرصيد: {formatArabicNoun(visibleStock(product, activeBranchId), ARABIC_NOUNS.box)}</p>
                    </div>
                  </div>
                  <span className="text-xs font-extrabold text-amber-700 bg-amber-100/60 px-2.5 py-1 rounded-full">
                    حد حرج: {toArabicDigits(product.lowStockThreshold)}
                  </span>
                </div>
              ))}
              {/* بقية النواقص لا تُرسم هنا — صندوق اللوحة ليس مكان مئات الصفوف */}
              {lowStockCount > LOW_STOCK_PREVIEW && (
                <button
                  type="button"
                  onClick={() => onGo?.('products')}
                  className="w-full py-2.5 rounded-xl border-2 border-dashed border-amber-200 text-amber-700 hover:border-amber-400 text-[11px] font-extrabold cursor-pointer transition"
                >
                  و{formatArabicNoun(lowStockCount - LOW_STOCK_PREVIEW, ARABIC_NOUNS.product)} أخرى — افتح المنتجات
                </button>
              )}
              {lowStockCount === 0 && (
                <p className="text-xs text-slate-400 text-center py-4">لا توجد نواقص في الوقت الحالي</p>
              )}
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4 mt-4">
            <h3 className="font-extrabold text-xs font-cairo text-[#0B1F4D] mb-3">آخر الفواتير المحفوظة</h3>
            <div className="space-y-2.5">
              {recentInvoices.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-2">لا توجد فواتير بعد</p>
              ) : recentInvoices.map((inv) => (
                <div key={inv.id} className="flex justify-between items-center text-xs">
                  <div>
                    <span className="font-bold text-[#0B1F4D]">{inv.customerName}</span>
                    <span className="text-[10px] text-slate-400 block mt-0.5">رقم {toArabicDigits(inv.invoiceNumber)} - {formatInvDate(inv.date)}</span>
                  </div>
                  <span className="font-extrabold text-slate-900">{formatCurrency(inv.finalAmount, currency, exchangeRate)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>

    </div>
  );
}
