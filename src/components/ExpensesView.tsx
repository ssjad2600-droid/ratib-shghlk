import React, { useState, useEffect, useMemo } from 'react';
import DesktopOnly from './DesktopOnly';
import { useCollection } from '../hooks/useCollection';
import NumberInput from './NumberInput';
import { useBranches } from '../hooks/useBranches';
import { useConfirm } from '../hooks/useConfirm';
import {
  Wallet, ArrowUpRight, ArrowDownRight, TrendingUp,
  Plus, Trash2, Edit, Save, X, Search, AlertCircle, Settings, ShoppingBag,
} from 'lucide-react';
import {
  toArabicDigits, formatCurrency, parseAmount,
  isValidExchangeRate, EXCHANGE_RATE_ERROR, EXCHANGE_RATE_MIN, EXCHANGE_RATE_MAX,
} from '../utils/arabicFormatters';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { CASH_METHOD, allPaymentMethods, isCashMethod } from '../utils/paymentMethods';
import { netProfitOf, costLookup } from '../utils/profit';
import { windowConstraints, daysAgoKey, WINDOW } from '../utils/dateWindow';
import { Invoice, Product } from '../types';
import { useProductCosts } from '../hooks/useProductCosts';
import { useActor } from '../hooks/useActor';
import { logAudit } from '../utils/auditLog';

type PeriodKey = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'all';

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'daily', label: 'اليوم' },
  { key: 'weekly', label: 'الأسبوع' },
  { key: 'monthly', label: 'الشهر' },
  { key: 'yearly', label: 'السنة' },
  { key: 'all', label: 'الكل' },
];

/** هل يقع هذا التاريخ ضمن الفترة؟ (نفس منطق شاشة التقارير كي لا يختلف الرقمان) */
const isInPeriod = (dateStr: string, period: PeriodKey): boolean => {
  if (period === 'all') return true;
  if (!dateStr) return false;
  const iso = toISO(dateStr);
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'daily') return d >= startOfToday && d < new Date(startOfToday.getTime() + 86400000);
  const start = new Date(startOfToday);
  if (period === 'weekly') start.setDate(startOfToday.getDate() - 7);
  else if (period === 'monthly') start.setDate(startOfToday.getDate() - 30);
  else start.setFullYear(startOfToday.getFullYear() - 1);
  return d >= start && d <= new Date(startOfToday.getTime() + 86400000);
};

interface ExpensesViewProps {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  updateSettings: (settings: { exchangeRate: number; currency?: 'IQD' | 'USD' }) => void;
}

interface FinancialTransaction {
  id: string;
  title: string;
  amount: number;
  type: 'revenue' | 'expense';
  category: string;
  date: string;
  notes: string;
  /** الموقع الذي خرج/دخل منه المال — غيابه = الفرع الرئيسي (كل حركاتك السابقة) */
  branchId?: string;
  /**
   * 🔴 طريقة الدفع — كانت غائبة، وتقفيل الصندوق يخصم **كل** مصروف من الدرج.
   * فإيجارٌ يُدفع بتحويل مصرفي يُخصم من نقدٍ لم يمسّه ⟵ فائضٌ وهمي بقيمته كل ليلة.
   * وهي العلّة نفسها التي عولجت في تسديدات الزبائن ثم الموردين؛ هذه الجبهة الثالثة.
   * غيابها في البيانات القديمة = كاش، وهو الصحيح تاريخياً.
   */
  method?: string;
}

const formatDateAr = (dateStr: string): string => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (!isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return d.toLocaleDateString('ar-IQ');
  }
  return toArabicDigits(dateStr);
};

const toISO = (dateStr: string): string => {
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.split('T')[0];
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? todayISO() : d.toISOString().split('T')[0];
};

export default function ExpensesView({ currency, exchangeRate, updateSettings }: ExpensesViewProps) {

  const { requestConfirm, confirmDialog } = useConfirm();
  const actor = useActor();

  // ---- FIRESTORE ----
  // المصروف يخصّ موقعاً: إيجار فرع البصرة ليس مصروف الرئيسي. القديم بلا موقع = الرئيسي.
  const { stampBranchId, matchesActiveBranch, isMultiBranch, branchName } = useBranches();
  const { items: allTransactions, save: saveTransaction, remove: deleteTransaction } =
    useCollection<FinancialTransaction>('financial_transactions');
  // 🟡 نافذة زمنية: كانت الفواتير تُقرأ كاملةً (كل تاريخ المحل) لعرض ثلاث بطاقات
  const invWindow = useMemo(() => windowConstraints(daysAgoKey(WINDOW.REPORTS)), []);
  const { items: allInvoices } = useCollection<Invoice>('invoices', invWindow);
  const { items: products } = useCollection<Product>('products');
  const { buyPriceOf, wholesaleBuyPriceOf } = useProductCosts();

  /**
   * 🔴 الفرع: كانت `transactions` مصفّاةً و`invoices` **بلا أي تصفية**.
   * قِسْتُ الأثر: مبيعة ومصروف كلاهما على الفرع الرئيسي، وبتبديل الفرع النشط إلى المخزن
   * ظهرت المبيعة (١٬٠٠٠٬٠٠٠) واختفى مصروفها (٠) — والشاشة تحمل شارة «🏢 المخزن الاول»
   * وتقول «كل حركة تُسجَّل على الموقع المختار». فكانت تَعِد بنطاقٍ لا تطبّقه.
   */
  const branchTransactions = useMemo(() => allTransactions.filter(matchesActiveBranch), [allTransactions, matchesActiveBranch]);
  const branchInvoices = useMemo(() => allInvoices.filter(matchesActiveBranch), [allInvoices, matchesActiveBranch]);

  /**
   * 🔴 الفترة: لم تكن الشاشة تعرف زمناً — الأرقام **عمر المحل كلّه**. فبعد سنتين يصير
   * «الربح الصافي» رقماً بلا معنى إداري: لا يقول كيف كان الشهر ولا يتغيّر بعمل اليوم.
   * وشاشة التقارير فيها منتقي فترة، فكان التناقض مضاعفاً.
   */
  const [period, setPeriod] = useState<PeriodKey>('monthly');
  const transactions = useMemo(
    () => branchTransactions.filter(t => isInPeriod(t.date, period)),
    [branchTransactions, period],
  );
  const periodInvoices = useMemo(
    () => branchInvoices.filter(inv => isInPeriod(inv.date, period)),
    [branchInvoices, period],
  );

  // ---- KPI TOTALS ----
  /**
   * 🔴🔴 الربح الصافي — من المحرّك المشترك، بعد **تكلفة البضاعة المباعة**.
   *
   * كان: `netProfit = (المبيعات + الإيرادات) − المصاريف` بلا تكلفة بضاعة إطلاقاً.
   * قِسْتُها: مادة تكلفتها ٨٬٠٠٠ تُباع بـ١٠٬٠٠٠، بيع ١٠٠ قطعة، مصروف ١٠٠ ألف.
   * الحقيقة ١٠٠٬٠٠٠ — وكانت الشاشة تعرض **٩٠٠٬٠٠٠**. تسعة أضعاف.
   * وهو الرقم الذي يبني عليه التاجر قراره: يوسّع، يستدين، يسحب لنفسه.
   */
  const costOf = useMemo(
    () => costLookup(
      (line) => products.find(p => p.id === (line.productId || line.itemId) || p.name === line.name),
      buyPriceOf,
      wholesaleBuyPriceOf,
    ),
    [products, buyPriceOf, wholesaleBuyPriceOf],
  );
  const profit = useMemo(
    () => netProfitOf(periodInvoices, transactions, costOf),
    [periodInvoices, transactions, costOf],
  );
  const totalWasil = profit.sales + profit.manualRevenue;
  const totalMasroof = profit.expenses;
  const netProfit = profit.netProfit;

  // ---- ALERT ----
  const [alert, setAlert] = useState<{ text: string; type: 'success' | 'danger' } | null>(null);
  const triggerAlert = (text: string, type: 'success' | 'danger' = 'success') => {
    setAlert({ text, type });
    setTimeout(() => setAlert(null), 4000);
  };

  // ---- EXCHANGE RATE ----
  const [isEditingRate, setIsEditingRate] = useState(false);
  const [rateInput, setRateInput] = useState(String(exchangeRate));
  useEffect(() => { setRateInput(String(exchangeRate)); }, [exchangeRate]);

  const handleSaveRate = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseAmount(rateInput);
    if (!isValidExchangeRate(parsed)) {
      triggerAlert(EXCHANGE_RATE_ERROR, 'danger'); // الرسالة السابقة كانت تذكر مدى خاطئاً (١٠٠٠–٣٠٠٠)
      return;
    }
    updateSettings({ exchangeRate: parsed });
    setIsEditingRate(false);
    triggerAlert('تم حفظ سعر الصرف');
  };

  // ---- MODAL FORM ----
  const [showModal, setShowModal] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formType, setFormType] = useState<'revenue' | 'expense'>('expense');
  const [formTitle, setFormTitle] = useState('');
  const [formAmount, setFormAmount] = useState('');
  const [formDate, setFormDate] = useState(todayISO());
  const [formMethod, setFormMethod] = useState<string>(CASH_METHOD);

  const openCreateModal = () => {
    setIsEditing(false);
    setEditingId(null);
    setFormType('expense');
    setFormTitle('');
    setFormAmount('');
    setFormDate(todayISO());
    setFormMethod(CASH_METHOD);
    setShowModal(true);
  };

  const openEditModal = (item: FinancialTransaction) => {
    setIsEditing(true);
    setEditingId(item.id);
    setFormType(item.type);
    setFormTitle(item.title);
    setFormAmount(String(item.amount));
    setFormDate(toISO(item.date));
    setFormMethod(item.method || CASH_METHOD);
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseAmount(formAmount);
    if (!formTitle.trim() || isNaN(amount) || amount <= 0) {
      triggerAlert('يرجى كتابة الوصف والمبلغ بشكل صحيح', 'danger');
      return;
    }
    if (isEditing && editingId) {
      const existing = transactions.find(t => t.id === editingId);
      if (existing) {
        await saveTransaction({
          ...existing,
          title: formTitle.trim(),
          amount,
          type: formType,
          category: formType === 'revenue' ? 'واصل' : 'مصروف',
          date: formDate,
          method: formMethod,
        });
      }
      triggerAlert('تم تعديل الحركة بنجاح');
    } else {
      await saveTransaction({
        id: genId(), // (fix 10) لاحقة عشوائية تمنع تصادم معرّفَي حركة في نفس الملّي ثانية
        title: formTitle.trim(),
        amount,
        type: formType,
        category: formType === 'revenue' ? 'واصل' : 'مصروف',
        date: formDate,
        notes: '',
        branchId: stampBranchId,
        method: formMethod,
      });
      triggerAlert(formType === 'revenue' ? 'تم تسجيل الواصل ✅' : 'تم تسجيل المصروف ✅');
    }
    setShowModal(false);
  };

  const handleDelete = async (id: string, title: string) => {
    const snapshot = transactions.find(t => t.id === id);   // لقطة قبل الاختفاء
    if (!(await requestConfirm(`حذف "${title}"؟`))) return;
    await deleteTransaction(id);
    /**
     * 🟠 كان الحذف بلا سجل تدقيق: مصروفٌ يُحذف = مالٌ يختفي من الدفتر بلا أثرٍ لمن حذفه
     * ومتى. وهي العلّة نفسها التي عولجت في شاشة الصلاحية — والتعليق هناك يقول:
     * «التسجيل والشطب كانا يُوثَّقان والحذف لا، وهو بالضبط ما وُجد السجل لأجله».
     */
    if (snapshot) {
      void logAudit({
        action: 'delete', entity: 'expense', entityId: id,
        summary: `حذف ${snapshot.type === 'revenue' ? 'واصل' : 'مصروف'}: ${snapshot.title} — ${formatCurrency(snapshot.amount, currency, exchangeRate)}`,
        before: snapshot as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
      });
    }
    triggerAlert('تم الحذف', 'danger');
  };

  // ---- LIST FILTER ----
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'revenue' | 'expense'>('all');

  const filteredList = [...transactions]
    .filter(t => {
      /**
       * 🔴 كان `t.title.toLowerCase()` فيسقط على سجلٍّ بلا عنوان — **وتموت
       * الشاشة كلها**، لا السطر وحده. رأيتُها بعيني: «حدث خلل في هذه الشاشة».
       *
       * وحقلٌ ناقص ليس فرضاً نظرياً: استعادةُ نسخةٍ قديمة، أو استيرادٌ من صيغةٍ
       * سابقة، أو كتابةٌ انقطعت في منتصفها — كلّها تُنتجه. والسطر الواحد التالف
       * يجب أن يُعرض ناقصاً لا أن يحجب مصاريف المحل كلها عن صاحبه.
       */
      const matchSearch = (t.title ?? '').toLowerCase().includes(search.toLowerCase());
      const matchType = filterType === 'all' || t.type === filterType;
      return matchSearch && matchType;
    })
    .sort((a, b) => toISO(b.date).localeCompare(toISO(a.date)));

  // ---- RENDER ----
  return (
    <div className="space-y-6 font-tajawal">
      {confirmDialog}

      {/* HEADER */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-extrabold font-cairo text-[#0B1F4D] flex items-center gap-2">
            <Wallet className="w-6 h-6 text-emerald-700" />
            <span>المصاريف والأرباح 💰</span>
            {isMultiBranch && (
              <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                🏢 {branchName(stampBranchId)}
              </span>
            )}
          </h2>
          <p className="text-xs text-[#5B6B86] mt-1">
            سجل واصل ومصروف محلك وتابع الربح الصافي بسهولة
            {isMultiBranch && ' — كل حركة تُسجَّل على الموقع المختار أعلاه'}
          </p>
        </div>

        {/* Exchange rate widget */}
        <div className="bg-white border border-[#E4EAF3] rounded-xl px-4 py-2.5 text-xs shadow-sm">
          {isEditingRate ? (
            <form onSubmit={handleSaveRate} className="flex items-center gap-2">
              <NumberInput inputMode="decimal"
                value={rateInput}
                onValueChange={(v) => setRateInput(v)}
                className="w-24 px-2 py-1.5 border border-slate-200 rounded-lg text-center font-bold text-xs"
                placeholder="١٥٠٠"
                autoFocus
              />
              <span className="text-slate-500 font-bold">د.ع / $</span>
              <button type="submit" className="px-3 py-1.5 bg-[#0B1F4D] text-white rounded-lg font-bold cursor-pointer">
                حفظ
              </button>
              <button type="button" onClick={() => setIsEditingRate(false)} className="px-2 py-1.5 text-slate-500 hover:text-slate-700 cursor-pointer">
                <X className="w-3.5 h-3.5" />
              </button>
            </form>
          ) : (
            <div className="flex items-center gap-2.5">
              <span className="text-slate-500 font-bold">سعر الدولار:</span>
              <span className="font-extrabold text-[#0B1F4D]">{toArabicDigits(exchangeRate)} د.ع</span>
              <button
                onClick={() => setIsEditingRate(true)}
                className="p-1 text-slate-500 hover:text-[#0B1F4D] transition cursor-pointer"
                title="تعديل سعر الصرف"
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ALERT */}
      {alert && (
        <div className={`p-3 rounded-xl border text-xs font-bold flex items-center gap-2 ${
          alert.type === 'success'
            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : 'bg-rose-50 border-rose-200 text-rose-800'
        }`}>
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{alert.text}</span>
        </div>
      )}

      {/* 🔴 منتقي الفترة — كانت الأرقام «عمر المحل» بلا زمن */}
      <div className="flex items-center gap-1.5 bg-white border border-[#E4EAF3] p-1 rounded-xl select-none w-fit">
        {PERIODS.map(p => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            className={`px-3.5 py-1.5 rounded-lg text-[11px] font-extrabold transition cursor-pointer ${
              period === p.key ? 'bg-[#0B1F4D] text-white' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* 4 KPI CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">

        {/* الواصل */}
        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-xs font-bold text-[#5B6B86] block select-none">الواصل</span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-bold">الفلوس الداخلة (مبيعات + إيرادات)</span>
            </div>
            <span className="p-2.5 bg-emerald-50 rounded-xl text-emerald-700">
              <ArrowUpRight className="w-5 h-5" />
            </span>
          </div>
          <h3 className="text-2xl font-black text-emerald-700 mt-3 font-sans leading-none">
            {formatCurrency(totalWasil, currency, exchangeRate)}
          </h3>
          <div className="mt-3 pt-2 border-t border-slate-50 text-[10px] text-slate-600 font-bold flex items-center justify-between">
            <span>مبيعات + إيرادات يدوية</span>
            {/* كان العدّاد يجمع حركات الفرع النشط مع **كل** فواتير المحل */}
            <span>{toArabicDigits(transactions.filter(t => t.type === 'revenue').length + profit.invoiceCount)} حركة</span>
          </div>
          <div className="absolute left-0 top-0 h-full w-1 bg-emerald-500"></div>
        </div>

        {/* 🔴🔴 تكلفة البضاعة المباعة — البند الغائب الذي كان يُضخّم «الربح» بمضاعفات */}
        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-xs font-bold text-[#5B6B86] block select-none">تكلفة البضاعة المباعة</span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-bold">ما دفعتَه لموردك ثمن ما بِعتَه</span>
            </div>
            <span className="p-2.5 bg-amber-50 rounded-xl text-amber-700">
              <ShoppingBag className="w-5 h-5" />
            </span>
          </div>
          <h3 className="text-2xl font-black text-amber-700 mt-3 font-sans leading-none">
            {formatCurrency(profit.cogs, currency, exchangeRate)}
          </h3>
          <div className="mt-3 pt-2 border-t border-slate-50 text-[10px] font-bold">
            {profit.unknownCostSales > 0 ? (
              <span className="text-amber-800 leading-relaxed block">
                ⚠️ {formatCurrency(profit.unknownCostSales, currency, exchangeRate)} مبيعات بلا سعر شراء —
                ربحها غير محتسب. سجّل تكلفتها لتظهر.
              </span>
            ) : (
              <span className="text-slate-500">كل المبيعات معروفة التكلفة ✓</span>
            )}
          </div>
          <div className="absolute left-0 top-0 h-full w-1 bg-amber-500"></div>
        </div>

        {/* المصروف */}
        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-xs font-bold text-[#5B6B86] block select-none">المصروف</span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-bold">الفلوس الطالعة (مصاريف وتكاليف)</span>
            </div>
            <span className="p-2.5 bg-rose-50 rounded-xl text-rose-700">
              <ArrowDownRight className="w-5 h-5" />
            </span>
          </div>
          <h3 className="text-2xl font-black text-rose-700 mt-3 font-sans leading-none">
            {formatCurrency(totalMasroof, currency, exchangeRate)}
          </h3>
          <div className="mt-3 pt-2 border-t border-slate-50 text-[10px] text-slate-600 font-bold flex items-center justify-between">
            <span>إيجار، كهرباء، بضاعة، رواتب...</span>
            <span>{toArabicDigits(transactions.filter(t => t.type === 'expense').length)} حركة</span>
          </div>
          <div className="absolute left-0 top-0 h-full w-1 bg-rose-500"></div>
        </div>

        {/* الربح الصافي */}
        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-xs font-bold text-[#5B6B86] block select-none">الربح الصافي</span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-bold">بعد تكلفة البضاعة والمصاريف</span>
            </div>
            <span className={`p-2.5 rounded-xl ${netProfit >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
              <TrendingUp className="w-5 h-5" />
            </span>
          </div>
          <h3 className={`text-2xl font-black mt-3 font-sans leading-none ${netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
            {netProfit >= 0 ? '+' : ''}{formatCurrency(netProfit, currency, exchangeRate)}
          </h3>
          <div className="mt-3 pt-2 border-t border-slate-50 text-[10px] font-bold space-y-1">
            {netProfit >= 0 ? (
              <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full inline-block">ربح وزيادة 🟢</span>
            ) : (
              <span className="text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full animate-pulse inline-block">خسارة تحتاج انتباه 🔴</span>
            )}
            <span className="text-slate-500 block leading-relaxed">
              ربح البيع {formatCurrency(profit.grossProfit, currency, exchangeRate)}
              {profit.manualRevenue > 0 ? ` + إيرادات ${formatCurrency(profit.manualRevenue, currency, exchangeRate)}` : ''}
              {' '}− مصاريف {formatCurrency(profit.expenses, currency, exchangeRate)}
            </span>
          </div>
          <div className={`absolute left-0 top-0 h-full w-1 ${netProfit >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}></div>
        </div>

      </div>

      {/* ADD BUTTON + SEARCH + FILTER */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">

        <DesktopOnly>
        <button
          onClick={openCreateModal}
          className="flex items-center gap-2 px-6 py-3 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-sm shadow transition cursor-pointer active:scale-95"
        >
          <Plus className="w-5 h-5" />
          <span>سجّل حركة</span>
        </button>
        </DesktopOnly>

        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          {/* Search */}
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث في الحركات..."
              className="w-full sm:w-52 pr-9 pl-3 py-2 bg-white border border-[#E4EAF3] rounded-xl text-xs text-right outline-none focus:ring-1 focus:ring-[#0B1F4D]"
            />
          </div>

          {/* Filter pills */}
          <div className="flex gap-1.5 bg-white border border-[#E4EAF3] p-1 rounded-xl select-none">
            {(['all', 'revenue', 'expense'] as const).map(type => (
              <button
                key={type}
                onClick={() => setFilterType(type)}
                className={`px-3 py-1 rounded-lg text-[11px] font-extrabold transition cursor-pointer ${
                  filterType === type ? 'bg-[#0B1F4D] text-white' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {type === 'all' ? 'الكل' : type === 'revenue' ? 'واصل 🟢' : 'مصروف 🔴'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* TRANSACTIONS LIST */}
      <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">

        <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center">
          <h4 className="font-extrabold text-sm text-[#0B1F4D] font-cairo">آخر الحركات</h4>
          <span className="text-[10px] bg-slate-100 text-slate-600 font-extrabold px-2.5 py-0.5 rounded-full">
            {toArabicDigits(filteredList.length)} حركة
          </span>
        </div>

        <div className="divide-y divide-slate-50">
          {filteredList.length === 0 ? (
            <div className="py-16 text-center text-slate-500 font-bold text-xs">
              {search ? 'لا توجد نتائج مطابقة' : 'لا توجد حركات بعد — انقر "سجّل حركة" للبدء'}
            </div>
          ) : (
            filteredList.map(item => {
              const isWasil = item.type === 'revenue';
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition group"
                >
                  {/* Left: type badge + title + date */}
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className={`flex-shrink-0 text-[10px] font-extrabold px-2.5 py-1 rounded-full ${
                      isWasil
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-rose-100 text-rose-800'
                    }`}>
                      {isWasil ? 'واصل' : 'مصروف'}
                    </span>
                    <div className="min-w-0">
                      <span title={item.title} className="text-xs font-bold text-[#0B1F4D] block truncate">{item.title}</span>
                      <span className="text-[10px] text-slate-600 font-bold block mt-0.5">
                        {formatDateAr(item.date)}
                      </span>
                    </div>
                  </div>

                  {/* Right: amount + actions */}
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className={`font-sans font-extrabold text-sm ${isWasil ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {isWasil ? '+' : '-'}{formatCurrency(item.amount, currency, exchangeRate)}
                    </span>
                    <DesktopOnly>
                    <div className="flex gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition">
                      <button
                        onClick={() => openEditModal(item)}
                        className="p-1.5 rounded-lg bg-slate-100 hover:bg-indigo-100 text-slate-500 hover:text-indigo-700 transition cursor-pointer"
                        title="تعديل"
                      >
                        <Edit className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(item.id, item.title)}
                        className="p-1.5 rounded-lg bg-slate-100 hover:bg-rose-100 text-slate-500 hover:text-rose-700 transition cursor-pointer"
                        title="حذف"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    </DesktopOnly>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* MODAL FORM */}
      {showModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-slate-100 overflow-hidden">

            {/* Modal header */}
            <div className={`p-5 text-white flex justify-between items-center ${
              formType === 'revenue' ? 'bg-emerald-700' : 'bg-[#0B1F4D]'
            }`}>
              <h3 className="font-extrabold text-sm font-cairo">
                {isEditing ? 'تعديل الحركة' : 'تسجيل حركة جديدة'}
              </h3>
              <button
                onClick={() => setShowModal(false)}
                className="p-1.5 hover:bg-white/10 rounded-lg cursor-pointer transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4">

              {/* Type toggle */}
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-2">نوع الحركة</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setFormType('revenue')}
                    className={`py-3 rounded-xl text-sm font-extrabold transition cursor-pointer border-2 ${
                      formType === 'revenue'
                        ? 'bg-emerald-50 border-emerald-400 text-emerald-800'
                        : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    🟢 واصل
                    <span className="block text-[10px] font-bold mt-0.5 opacity-70">فلوس داخلة</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormType('expense')}
                    className={`py-3 rounded-xl text-sm font-extrabold transition cursor-pointer border-2 ${
                      formType === 'expense'
                        ? 'bg-rose-50 border-rose-400 text-rose-800'
                        : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    🔴 مصروف
                    <span className="block text-[10px] font-bold mt-0.5 opacity-70">فلوس طالعة</span>
                  </button>
                </div>
              </div>

              {/* Amount */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">المبلغ (دينار عراقي)</label>
                <NumberInput inputMode="decimal"
                  value={formAmount}
                  onValueChange={(v) => setFormAmount(v)}
                  placeholder="مثال: 50000"
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-center"
                  min={1}
                  required
                  autoFocus={!isEditing}
                />
                {formAmount && !isNaN(Number(formAmount)) && Number(formAmount) > 0 && (
                  <p className="text-[10px] text-slate-600 mt-1 text-center font-bold">
                    = {formatCurrency(Number(formAmount), currency, exchangeRate)}
                  </p>
                )}
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">الوصف</label>
                <input
                  type="text"
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  placeholder={formType === 'expense'
                    ? 'مثال: إيجار المحل، كهرباء/مولدة، بضاعة، أجور عمال'
                    : 'مثال: مبيعات اليوم، دفعة زبون، إيراد خدمة'}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-right"
                  required
                />
              </div>

              {/* 🔴 طريقة الدفع — بدونها يخصم تقفيل الصندوق كل مصروف من الدرج */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">طريقة الدفع</label>
                <select
                  value={formMethod}
                  onChange={(e) => setFormMethod(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold cursor-pointer"
                >
                  {allPaymentMethods().map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                {!isCashMethod(formMethod) && (
                  <p className="text-[10px] font-bold text-blue-700 mt-1">
                    💳 {formType === 'revenue' ? 'لن يُحتسب داخلاً' : 'لن يُخصم'} من نقد الدرج في تقفيل الصندوق
                  </p>
                )}
              </div>

              {/* Date */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">التاريخ</label>
                <input
                  type="date"
                  value={formDate}
                  onChange={(e) => setFormDate(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold font-mono"
                  required
                />
              </div>

              {/* Save button */}
              <button
                type="submit"
                className={`w-full py-3 text-white font-extrabold rounded-xl text-sm shadow transition cursor-pointer flex items-center justify-center gap-2 ${
                  formType === 'revenue'
                    ? 'bg-emerald-600 hover:bg-emerald-700'
                    : 'bg-[#0B1F4D] hover:bg-[#13295E]'
                }`}
              >
                <Save className="w-4 h-4" />
                <span>{isEditing ? 'حفظ التعديل' : `حفظ ${formType === 'revenue' ? 'الواصل' : 'المصروف'}`}</span>
              </button>

            </form>
          </div>
        </div>
      )}

    </div>
  );
}
