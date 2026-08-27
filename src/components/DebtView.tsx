import React, { useState, useMemo } from 'react';
import { writeBatch, doc, increment } from 'firebase/firestore';
import NumberInput from './NumberInput';
import { db, auth } from '../firebase';
import { useCollection } from '../hooks/useCollection';
import { useBranches } from '../hooks/useBranches';
import { useConfirm } from '../hooks/useConfirm';
import {
  Banknote, CheckCircle2, Clock, ChevronDown, ChevronUp,
  Trash2, Phone, User, AlertCircle, Save, X, History, FileText, MessageCircle, Download
} from 'lucide-react';
import { toArabicDigits, formatCurrency, parseAmount } from '../utils/arabicFormatters';
import { buildDebtReminderUrl, canWhatsapp } from '../utils/whatsapp';
import { exportAsWord, exportAsPdf, ExportSpec } from '../utils/exportDoc';
import { useActor } from '../hooks/useActor';
import { logAudit } from '../utils/auditLog';
import { allPaymentMethods, CASH_METHOD } from '../utils/paymentMethods';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { Customer, Invoice } from '../types';
import { allocatePayment, invoicePaymentUpdate } from '../utils/debtAllocation';
import { reportFirestoreError } from '../utils/writeGuard';
import { openExternal } from '../utils/openExternal';

interface DebtViewProps {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  storeName: string;
  customPaymentMethods?: string[];
}

interface DebtPayment {
  id: string;
  customerId: string;
  customerName: string;
  amount: number;
  date: string;
  notes: string;
  invoiceId?: string; // اختياري — للتوافق مع الدفعات القديمة
  branchId?: string;  // الفرع الذي وصل إليه النقد. غيابه = الرئيسي
  method?: string;    // طريقة الدفع — غيابها = كاش (توافق رجعي مع التسديدات السابقة)
}

const formatDateAr = (dateStr: string): string => {
  if (!dateStr) return '';
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
  return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('ar-IQ');
};

export default function DebtView({ currency, exchangeRate, storeName, customPaymentMethods }: DebtViewProps) {
  const actor = useActor(); // لسجل التدقيق — توثيق تحصيل الديون

  // فتح رسالة واتساب جاهزة بتذكير الدين — المالك يضغط إرسال بنفسه (لا إرسال تلقائي)
  const handleWhatsappReminder = (customer: Customer) => {
    const url = buildDebtReminderUrl({
      customerName: customer.name,
      phone: customer.phone,
      balance: customer.balance,
      storeName,
      currency,
      exchangeRate,
      dueDate: customer.dueDate,
    });
    if (!url) {
      triggerAlert('رقم هاتف الزبون غير صالح لإرسال رسالة واتساب', 'danger');
      return;
    }
    // النظام يفتح تطبيق واتساب نفسه على الهاتف؛ وتبويباً جديداً على الكمبيوتر
    void openExternal(url);
  };

  // ---- FIRESTORE ----
  const { items: customers } = useCollection<Customer>('customers');
  const { items: payments, save: savePayment, remove: deletePayment } =
    useCollection<DebtPayment>('debt_payments');
  const { items: allInvoices } = useCollection<Invoice>('invoices');

  // ---- TABS ----
  const [tab, setTab] = useState<'active' | 'settled'>('active');

  const { requestConfirm, confirmDialog } = useConfirm();
  const { isMultiBranch, stampBranchId } = useBranches();

  // ---- ALERT ----
  const [alert, setAlert] = useState<{ text: string; type: 'success' | 'danger' } | null>(null);
  const triggerAlert = (text: string, type: 'success' | 'danger' = 'success') => {
    setAlert({ text, type });
    setTimeout(() => setAlert(null), 5000);
  };

  // ---- DERIVED LISTS ----
  const activeDebtors = useMemo(
    () => [...customers.filter(c => c.balance > 0)].sort((a, b) => b.balance - a.balance),
    [customers]
  );

  const paymentsByCustomer = useMemo(() => {
    const map: Record<string, DebtPayment[]> = {};
    for (const p of payments) {
      if (!map[p.customerId]) map[p.customerId] = [];
      map[p.customerId].push(p);
    }
    for (const id in map) {
      map[id].sort((a, b) => b.date.localeCompare(a.date));
    }
    return map;
  }, [payments]);

  const settledDebtorIds = useMemo(
    () => new Set(payments.map(p => p.customerId)),
    [payments]
  );

  const settledDebtors = useMemo(
    () => customers.filter(c => c.balance === 0 && settledDebtorIds.has(c.id)),
    [customers, settledDebtorIds]
  );

  /**
   * 🔴 الزبون الذي **له** أمانة عندك (رصيد سالب) كان يختفي من الشاشة كلها: ليس في
   * «الديون النشطة» (شرطها موجب)، ولا في «الأرشيف» (شرطه صفر). فالتاجر لا يرى في أي
   * مكان أنه مدينٌ لزبونه — وهو التزام عليه لا له، والزبون يتذكّره جيداً.
   *
   * لا نضعه في تبويب الديون كي لا يختلط الدائن بالمدين، بل ننبّه إليه فوق القائمة.
   */
  const creditors = useMemo(
    () => customers.filter(c => c.balance < 0).sort((a, b) => a.balance - b.balance),
    [customers]
  );
  const totalCredit = useMemo(
    () => creditors.reduce((s, c) => s + Math.abs(c.balance), 0),
    [creditors]
  );

  const totalActiveDebt = useMemo(
    () => activeDebtors.reduce((s, c) => s + c.balance, 0),
    [activeDebtors]
  );

  // ---- EXPANDED ROW ----
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggleExpand = (id: string) => setExpandedId(prev => prev === id ? null : id);

  // ---- PAYMENT MODAL ----
  const [paymentCustomer, setPaymentCustomer] = useState<Customer | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [payDate, setPayDate] = useState(todayISO());
  const [payMethod, setPayMethod] = useState<string>(CASH_METHOD);
  const [selectedPayInvoiceId, setSelectedPayInvoiceId] = useState<string>('none');
  const [isPaying, setIsPaying] = useState(false);

  const openPaymentModal = (customer: Customer) => {
    setPaymentCustomer(customer);
    setPayAmount('');
    setPayNotes('');
    setPayDate(todayISO());

    // اختيار تلقائي إذا للزبون فاتورة واحدة غير مسددة فقط
    const unpaidInvoices = allInvoices.filter(
      inv => inv.customerId === customer.id && (inv.remainingAmount ?? 0) > 0
    );
    setSelectedPayInvoiceId(unpaidInvoices.length === 1 ? unpaidInvoices[0].id : 'none');
  };

  const handlePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isPaying) return; // حماية من الضغط المزدوج — يمنع تسديداً مكرراً
    if (!paymentCustomer) return;
    const amount = parseAmount(payAmount);
    if (isNaN(amount) || amount <= 0) {
      triggerAlert('يرجى إدخال مبلغ صحيح', 'danger');
      return;
    }
    if (amount > paymentCustomer.balance) {
      triggerAlert('المبلغ المدخل أكبر من الدين الحالي! ✋', 'danger');
      return;
    }
    // حارس على المنطق لا على الواجهة وحدها (خانة التاريخ قد تُملأ بلصق أو من جهاز قديم)
    if (payDate > todayISO()) {
      triggerAlert('لا يمكن تسجيل تسديد بتاريخ مستقبلي — سيُحتسب في تقفيل يوم لم يأتِ بعد', 'danger');
      return;
    }

    setIsPaying(true);
    try {
    const uid = auth.currentUser?.uid;
    const newBalance = Math.max(0, paymentCustomer.balance - amount);
    const isFullyPaid = newBalance === 0;
    const paymentId = `pay_${genId()}`; // (fix 10) لاحقة عشوائية تمنع تصادم دفعتين في نفس الملّي ثانية

    /**
     * التوزيع: الفاتورة المختارة أولاً، ثم الباقي من الأقدم للأحدث.
     *
     * 🔴 كان مساران منفصلان: «فاتورة محدَّدة» يكتب عليها المبلغ كاملاً بلا سقف — فيتجاوز
     * `paidAmount` إجماليَّها ويتبخّر الفائض؛ و«توزيع عام» يكتب قيماً مطلقة تُمحى عند
     * التحصيل المتزامن. صارا مساراً واحداً بسقفٍ لكل فاتورة وبالفوارق وحدها.
     */
    const customerInvoices = allInvoices.filter(inv => inv.customerId === paymentCustomer.id);
    const { allocations, unallocated } = allocatePayment(
      customerInvoices, amount,
      selectedPayInvoiceId !== 'none' ? selectedPayInvoiceId : undefined,
    );
    const linkedInvoice = allocations.length === 1
      ? customerInvoices.find(inv => inv.id === allocations[0].invoiceId)
      : null;

    await savePayment({
      id: paymentId,
      customerId: paymentCustomer.id,
      customerName: paymentCustomer.name,
      amount,
      date: payDate,
      notes: payNotes.trim(),
      method: payMethod, // يُفصل في تقفيل الصندوق: التحويل/البطاقة لا يدخل الدرج
      // 🔴 الفرع: بدونه يُحتسب تحصيل المحل في صندوق المخزن أيضاً — كانت الوحيدة
      // من مصادر النقد بلا فرع إطلاقاً (بخلاف method التي تحملها منذ زمن).
      branchId: stampBranchId,
      ...(linkedInvoice ? { invoiceId: linkedInvoice.id } : {}),
    });

    // (fix 7) خصم الرصيد بـ increment(-amount) لا كتابة مطلقة من لقطة محلية — لئلا يمسح دلتا
    //   طيّ ديون الموظف المتزامنة (increment) فيضيع دين. آمن أوفلاين وتبادلي.
    //   والفواتير الآن بالفوارق كذلك، فلا ينحرف الدفتران عن بعضهما.
    if (uid) {
      const batch = writeBatch(db);
      for (const a of allocations) {
        const inv = customerInvoices.find(i => i.id === a.invoiceId)!;
        batch.update(doc(db, 'users', uid, 'invoices', a.invoiceId), invoicePaymentUpdate(inv, a.amount));
      }
      batch.update(doc(db, 'users', uid, 'customers', paymentCustomer.id), { balance: increment(-amount) });
      // fire-and-forget: يُطبَّق محلياً فوراً ويتزامن عند عودة الاتصال
      batch.commit().catch(err => reportFirestoreError('debt_payments', 'batch', err, '[Firestore] debt payment'));
    }

    // سجل التدقيق — تحصيل نقد من زبون: عملية مالية تستحق التوثيق (مَن حصّل ومتى وكم).
    // المعرّف هو معرّف الدفعة نفسه — كان `pay_${Date.now()}` فلا يُفضي إلى أي دفعة موجودة.
    void logAudit({
      action: 'create', entity: 'debt_payment', entityId: paymentId,
      summary: `تسديد دين من «${paymentCustomer.name}»: ${formatCurrency(amount, currency, exchangeRate)}`
        + ` (${payMethod})`
        + `${isFullyPaid ? ' — سُدِّد الدين كاملاً' : ` — المتبقي ${formatCurrency(newBalance, currency, exchangeRate)}`}`
        + `${allocations.length > 1 ? ` — وُزِّع على ${toArabicDigits(allocations.length)} فواتير` : ''}`
        + `${unallocated > 0 ? ` — ${formatCurrency(unallocated, currency, exchangeRate)} على دين قديم بلا فاتورة` : ''}`,
      before: { balance: paymentCustomer.balance },
      after: { balance: newBalance, paidNow: amount },
      actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
      relatedEntity: 'customer', relatedEntityId: paymentCustomer.id,
    });

    triggerAlert(
      isFullyPaid
        ? `تم تسديد دين ${paymentCustomer.name} كاملاً ✅ — انتقل للأرشيف`
        : `تم تسجيل الدفعة ✅ — المتبقي: ${newBalance.toLocaleString()} د.ع`
    );
    setPaymentCustomer(null);
    } finally {
      setIsPaying(false);
    }
  };

  /**
   * 🔴 حذف الأرشيف ليس «تنظيف عرض» — إنه يمحو وثائق `debt_payments`، وشاشة **تقفيل
   * الصندوق تقرأ هذه المجموعة نفسها** لتحسب النقد المحصَّل في كل يوم. فحذف أرشيف زبون
   * اليوم يغيّر رقم تقفيل يومٍ مضى وأُقفل وسُلّم.
   *
   * كان النص يقول «فقط سجل الدفعات» — صحيح حرفياً ومضلّل عملياً. صار يقول الأثر صراحةً،
   * ويعرض المبلغ وعدد الدفعات ليعرف التاجر حجم ما يمحوه، ويُوثَّق في سجل التدقيق.
   */
  const handleDeleteFromArchive = async (customer: Customer) => {
    const customerPayments = paymentsByCustomer[customer.id] || [];
    if (customerPayments.length === 0) return;
    const total = customerPayments.reduce((s, p) => s + p.amount, 0);
    const dates = customerPayments.map(p => p.date).sort();
    const span = dates.length > 1 ? `${formatDateAr(dates[0])} — ${formatDateAr(dates[dates.length - 1])}` : formatDateAr(dates[0]);

    const ok = await requestConfirm(
      `حذف سجل تسديدات «${customer.name}»؟\n\n`
      + `${toArabicDigits(customerPayments.length)} دفعة بمجموع ${formatCurrency(total, currency, exchangeRate)} (${span}).\n\n`
      + `⚠️ تنبيه: هذه الدفعات جزء من حساب النقد في «تقفيل الصندوق».\n`
      + `حذفها سيغيّر أرقام تقفيل أيام سابقة أقفلتَها من قبل.\n`
      + `الزبون ورصيده لا يتأثران.`
    );
    if (!ok) return;

    for (const p of customerPayments) {
      await deletePayment(p.id);
    }
    void logAudit({
      action: 'delete', entity: 'debt_payment', entityId: `archive_${customer.id}`,
      summary: `حذف أرشيف تسديدات «${customer.name}» — ${toArabicDigits(customerPayments.length)} دفعة بمجموع ${formatCurrency(total, currency, exchangeRate)}`,
      before: { payments: customerPayments } as unknown as Record<string, unknown>,
      actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
      relatedEntity: 'customer', relatedEntityId: customer.id,
    });
    triggerAlert(`تم حذف أرشيف «${customer.name}»`, 'danger');
  };

  // ---- RENDER HELPERS ----
  const renderPaymentHistory = (customerId: string) => {
    const history = paymentsByCustomer[customerId] || [];
    if (history.length === 0) {
      return (
        <div className="px-4 pb-3 pt-1 text-center text-xs text-slate-500 font-bold">
          لا توجد دفعات مسجّلة بعد
        </div>
      );
    }
    return (
      <div className="px-4 pb-4 pt-1 space-y-1.5">
        {history.map(p => (
          <div key={p.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 text-xs">
            <div className="flex items-center gap-2 text-slate-500 font-bold min-w-0">
              <Clock className="w-3 h-3 flex-shrink-0" />
              <span className="flex-shrink-0">{formatDateAr(p.date)}</span>
              {/* طريقة الدفع كانت تُحفظ ولا تُعرض — وهي أول ما يُسأل عنه عند جرد الدرج.
                  غيابها في الدفعات القديمة يعني كاشاً (توافق رجعي). */}
              <span className={`text-[10px] font-extrabold px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
                (p.method ?? CASH_METHOD) === CASH_METHOD
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-indigo-50 text-indigo-700 border-indigo-200'
              }`}>
                {p.method ?? CASH_METHOD}
              </span>
              {p.notes && <span className="text-slate-500 truncate">— {p.notes}</span>}
            </div>
            <span className="font-extrabold text-emerald-700 font-sans">
              +{formatCurrency(p.amount, currency, exchangeRate)}
            </span>
          </div>
        ))}
      </div>
    );
  };

  // تصدير سجل الديون والتسديدات إلى Word/PDF (قراءة فقط — لا يمسّ البيانات)
  const handleExportDebts = (format: 'word' | 'pdf') => {
    if (activeDebtors.length === 0) { triggerAlert('لا توجد ديون نشطة للتصدير', 'danger'); return; }
    const money = (n: number) => formatCurrency(n, currency, exchangeRate);
    const spec: ExportSpec = {
      title: storeName || 'رتب شغلك',
      subtitle: `سجل الديون والتسديدات — ${toArabicDigits(activeDebtors.length)} زبون مدين`,
      columns: [
        { header: '#', align: 'center' },
        { header: 'الزبون' },
        { header: 'الهاتف', align: 'center' },
        { header: 'الدين المتبقي', align: 'center' },
        { header: 'مجموع المسدّد', align: 'center' },
        { header: 'عدد الدفعات', align: 'center' },
        { header: 'تاريخ الاستحقاق', align: 'center' },
      ],
      rows: activeDebtors.map((c, i) => {
        const pays = paymentsByCustomer[c.id] || [];
        const paid = pays.reduce((s, p) => s + p.amount, 0);
        return [
          toArabicDigits(i + 1),
          c.name,
          c.phone ? toArabicDigits(c.phone) : '—',
          money(c.balance),
          paid > 0 ? money(paid) : '—',
          toArabicDigits(pays.length),
          c.dueDate ? toArabicDigits(c.dueDate) : '—',
        ];
      }),
      note: `إجمالي الديون النشطة: ${money(totalActiveDebt)}`,
    };
    const filename = `ديون_${(storeName || 'المتجر').replace(/\s+/g, '_')}`;
    if (format === 'word') { exportAsWord(spec, filename); triggerAlert('تم تصدير ملف Word للديون 📄'); }
    else exportAsPdf(spec, (m) => triggerAlert(m, 'danger'));
  };

  // ---- JSX ----
  return (
    <div className="space-y-6 font-tajawal">
      {confirmDialog}

      {/* HEADER */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
        <div>
          <h2 className="text-xl font-extrabold font-cairo text-[#0B1F4D] flex items-center gap-2">
            <Banknote className="w-6 h-6 text-amber-700" />
            <span>إدارة الديون</span>
          </h2>
          <p className="text-xs text-[#5B6B86] mt-1">
            تابع ديون زبائنك وسجّل التسديدات — الأرقام مرتبطة بسجل الزبائن مباشرة
          </p>
          {/* توضيح مقصود: دين الزبون على المحل كله لا على فرع. تقسيمه بالفروع يخلق دفترين
              متعارضين ويربك الزبون الذي يشتري من فرع ويسدّد في آخر. */}
          {isMultiBranch && (
            <p className="text-[10px] text-indigo-700 font-bold mt-1.5 bg-indigo-50 border border-indigo-200 rounded-lg px-2.5 py-1.5 leading-relaxed">
              🏢 دين الزبون <b>موحَّد على محلك كله</b> لا على فرع بعينه — فالزبون يشتري من فرع ويسدّد في آخر، وهذا هو الصحيح.
              لمعرفة الديون التي نشأت من كل فرع، افتح شاشة «أداء الفروع».
            </p>
          )}
        </div>
        {/* تصدير الديون Word / PDF */}
        <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl px-1.5 py-1 shadow-sm">
          <span className="text-[10px] text-slate-600 font-bold px-1 select-none">تصدير:</span>
          <button onClick={() => handleExportDebts('word')} title="تصدير Word"
            className="px-2.5 py-2 rounded-lg text-[11px] font-extrabold text-blue-700 hover:bg-blue-50 flex items-center gap-1 cursor-pointer transition">
            <FileText className="w-3.5 h-3.5" /> Word
          </button>
          <button onClick={() => handleExportDebts('pdf')} title="تصدير PDF"
            className="px-2.5 py-2 rounded-lg text-[11px] font-extrabold text-rose-700 hover:bg-rose-50 flex items-center gap-1 cursor-pointer transition">
            <Download className="w-3.5 h-3.5" /> PDF
          </button>
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

      {/* KPI CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

        {/* Total active debt */}
        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-xs font-bold text-[#5B6B86] block select-none">إجمالي الديون النشطة</span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-bold">مجموع ما عليه الزبائن</span>
            </div>
            <span className="p-2.5 bg-rose-50 rounded-xl text-rose-700">
              <Banknote className="w-5 h-5" />
            </span>
          </div>
          <h3 className="text-2xl font-black text-rose-700 mt-3 font-sans leading-none">
            {formatCurrency(totalActiveDebt, currency, exchangeRate)}
          </h3>
          <div className="absolute left-0 top-0 h-full w-1 bg-rose-500"></div>
        </div>

        {/* Active debtors count */}
        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-xs font-bold text-[#5B6B86] block select-none">زبائن عليهم دين</span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-bold">ديون نشطة تحتاج متابعة</span>
            </div>
            <span className="p-2.5 bg-amber-50 rounded-xl text-amber-700">
              <User className="w-5 h-5" />
            </span>
          </div>
          <h3 className="text-2xl font-black text-amber-700 mt-3 font-sans leading-none">
            {toArabicDigits(activeDebtors.length)}
            <span className="text-sm font-bold text-slate-500 mr-1">زبون</span>
          </h3>
          <div className="absolute left-0 top-0 h-full w-1 bg-amber-500"></div>
        </div>

        {/* Settled count */}
        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-xs font-bold text-[#5B6B86] block select-none">سدّدوا ديونهم</span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-bold">محفوظين في الأرشيف</span>
            </div>
            <span className="p-2.5 bg-emerald-50 rounded-xl text-emerald-700">
              <CheckCircle2 className="w-5 h-5" />
            </span>
          </div>
          <h3 className="text-2xl font-black text-emerald-700 mt-3 font-sans leading-none">
            {toArabicDigits(settledDebtors.length)}
            <span className="text-sm font-bold text-slate-500 mr-1">زبون</span>
          </h3>
          <div className="absolute left-0 top-0 h-full w-1 bg-emerald-500"></div>
        </div>

      </div>

      {/* زبائن لهم أمانة عندك — التزام عليك، وكانوا يختفون من الشاشة كلها */}
      {creditors.length > 0 && (
        <div className="p-3.5 rounded-xl border-2 border-emerald-200 bg-emerald-50/70 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-extrabold text-emerald-900 flex items-center gap-1.5">
              <User className="w-4 h-4" />
              زبائن لهم أمانة عندك ({toArabicDigits(creditors.length)})
            </span>
            <span className="text-xs font-black text-emerald-800 font-sans">
              {formatCurrency(totalCredit, currency, exchangeRate)}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {creditors.slice(0, 12).map(c => (
              <span key={c.id} className="text-[11px] font-bold bg-white border border-emerald-200 text-emerald-800 rounded-lg px-2 py-1">
                {c.name} — {formatCurrency(Math.abs(c.balance), currency, exchangeRate)}
              </span>
            ))}
            {creditors.length > 12 && (
              <span className="text-[11px] font-bold text-emerald-700 px-2 py-1">
                و{toArabicDigits(creditors.length - 12)} غيرهم
              </span>
            )}
          </div>
          <p className="text-[10px] text-emerald-700 font-bold">
            هذه مبالغ مستحقة <b>عليك</b> لهم — تُصفَّى بتسليمهم المبلغ أو بخصمها من مشترياتهم القادمة.
          </p>
        </div>
      )}

      {/* TABS */}
      <div className="flex gap-1.5 bg-white border border-[#E4EAF3] p-1 rounded-xl w-fit select-none shadow-sm">
        <button
          onClick={() => setTab('active')}
          className={`px-4 py-2 rounded-lg text-xs font-extrabold transition cursor-pointer flex items-center gap-1.5 ${
            tab === 'active' ? 'bg-[#0B1F4D] text-white' : 'text-slate-500 hover:bg-slate-100'
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          <span>ديون نشطة</span>
          {activeDebtors.length > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-extrabold ${
              tab === 'active' ? 'bg-white/20 text-white' : 'bg-rose-100 text-rose-700'
            }`}>
              {toArabicDigits(activeDebtors.length)}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('settled')}
          className={`px-4 py-2 rounded-lg text-xs font-extrabold transition cursor-pointer flex items-center gap-1.5 ${
            tab === 'settled' ? 'bg-emerald-700 text-white' : 'text-slate-500 hover:bg-slate-100'
          }`}
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>مسدّدة — أرشيف</span>
          {settledDebtors.length > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-extrabold ${
              tab === 'settled' ? 'bg-white/20 text-white' : 'bg-emerald-100 text-emerald-700'
            }`}>
              {toArabicDigits(settledDebtors.length)}
            </span>
          )}
        </button>
      </div>

      {/* ACTIVE DEBTS */}
      {tab === 'active' && (
        <div>
          {activeDebtors.length === 0 ? (
            <div className="bg-white rounded-2xl border border-[#E4EAF3] py-20 text-center shadow-sm">
              <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
              <h3 className="font-extrabold text-sm text-[#0B1F4D] font-cairo">لا توجد ديون نشطة 🎉</h3>
              <p className="text-xs text-slate-500 mt-1 font-bold">
                كل الزبائن مسوّون حساباتهم — ممتاز!
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {activeDebtors.map(customer => {
                const isExpanded = expandedId === customer.id;
                const historyCount = paymentsByCustomer[customer.id]?.length ?? 0;
                return (
                  <div
                    key={customer.id}
                    className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden"
                  >
                    {/* Main row */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between px-4 py-4 gap-3">

                      {/* Avatar + info */}
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 rounded-full bg-amber-50 border-2 border-amber-200 flex items-center justify-center flex-shrink-0">
                          <span className="text-sm font-extrabold text-amber-800 select-none">
                            {customer.name.slice(0, 2)}
                          </span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <span title={customer.name} className="font-extrabold text-sm text-[#0B1F4D] block truncate font-cairo">
                            {customer.name}
                          </span>
                          {customer.phone ? (
                            <span className="text-[11px] text-slate-500 font-bold flex items-center gap-1 mt-0.5 dir-ltr">
                              <Phone className="w-3 h-3 inline" />
                              <span dir="ltr">{customer.phone}</span>
                            </span>
                          ) : (
                            <span className="text-[11px] text-slate-500 font-bold">بدون رقم هاتف</span>
                          )}
                        </div>
                      </div>

                      {/* Amount + actions */}
                      <div className="flex items-center gap-2 flex-shrink-0 w-full sm:w-auto justify-end">
                        <div className="text-left">
                          <span className="block font-extrabold text-rose-700 font-sans text-sm leading-none">
                            {formatCurrency(customer.balance, currency, exchangeRate)}
                          </span>
                          <span className="block text-[10px] text-slate-600 font-bold mt-0.5 text-left">دين متبقي</span>
                        </div>

                        {/* History toggle */}
                        <button
                          onClick={() => toggleExpand(customer.id)}
                          className="flex items-center gap-1 px-2.5 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-800 text-[10px] font-extrabold transition cursor-pointer"
                          title="سجل الدفعات"
                        >
                          <History className="w-3.5 h-3.5" />
                          {historyCount > 0 && <span>{toArabicDigits(historyCount)}</span>}
                          {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        </button>

                        {/* WhatsApp reminder — يظهر فقط لزبون له رقم صالح */}
                        {canWhatsapp(customer.phone) && (
                          <button
                            onClick={() => handleWhatsappReminder(customer)}
                            className="flex items-center justify-center w-9 h-9 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 hover:text-emerald-700 transition cursor-pointer active:scale-95 flex-shrink-0"
                            title="تذكير بالدين عبر واتساب"
                          >
                            <MessageCircle className="w-4 h-4" />
                          </button>
                        )}

                        {/* Pay button */}
                        <button
                          onClick={() => openPaymentModal(customer)}
                          className="px-3.5 py-2 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold text-xs rounded-xl transition cursor-pointer active:scale-95 whitespace-nowrap"
                        >
                          تسديد 💵
                        </button>
                      </div>
                    </div>

                    {/* Payment history (expanded) */}
                    {isExpanded && (
                      <div className="border-t border-slate-100">
                        <div className="px-4 py-2 bg-slate-50/80 flex items-center gap-1.5">
                          <History className="w-3 h-3 text-slate-500" />
                          <span className="text-[11px] font-extrabold text-slate-500">سجل الدفعات السابقة</span>
                        </div>
                        {renderPaymentHistory(customer.id)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* SETTLED ARCHIVE */}
      {tab === 'settled' && (
        <div>
          {settledDebtors.length === 0 ? (
            <div className="bg-white rounded-2xl border border-[#E4EAF3] py-20 text-center shadow-sm">
              <History className="w-12 h-12 text-slate-400 mx-auto mb-3" />
              <h3 className="font-extrabold text-sm text-[#0B1F4D] font-cairo">الأرشيف فارغ</h3>
              <p className="text-xs text-slate-500 mt-1 font-bold">
                عند تسديد دين زبون كاملاً سيظهر هنا
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {settledDebtors.map(customer => {
                const isExpanded = expandedId === customer.id;
                const history = paymentsByCustomer[customer.id] || [];
                const totalPaid = history.reduce((s, p) => s + p.amount, 0);
                return (
                  <div
                    key={customer.id}
                    className="bg-white rounded-2xl border border-emerald-100 shadow-sm overflow-hidden"
                  >
                    {/* Main row */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between px-4 py-4 gap-3">

                      {/* Avatar + info */}
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 rounded-full bg-emerald-50 border-2 border-emerald-200 flex items-center justify-center flex-shrink-0">
                          <span className="text-sm font-extrabold text-emerald-800 select-none">
                            {customer.name.slice(0, 2)}
                          </span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <span title={customer.name} className="font-extrabold text-sm text-[#0B1F4D] block truncate font-cairo">
                            {customer.name}
                          </span>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-extrabold flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" />
                              مسدّد
                            </span>
                            {customer.phone && (
                              <span className="text-[11px] text-slate-500 font-bold" dir="ltr">{customer.phone}</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Total paid + actions */}
                      <div className="flex items-center gap-2 flex-shrink-0 w-full sm:w-auto justify-end">
                        <div className="text-left">
                          <span className="block font-extrabold text-emerald-700 font-sans text-sm leading-none">
                            {formatCurrency(totalPaid, currency, exchangeRate)}
                          </span>
                          <span className="block text-[10px] text-slate-600 font-bold mt-0.5 text-left">
                            {toArabicDigits(history.length)} دفعة
                          </span>
                        </div>

                        {/* History toggle */}
                        <button
                          onClick={() => toggleExpand(customer.id)}
                          className="flex items-center gap-1 px-2.5 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-800 text-[10px] font-extrabold transition cursor-pointer"
                        >
                          <History className="w-3.5 h-3.5" />
                          {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        </button>

                        {/* Delete from archive */}
                        <button
                          onClick={() => handleDeleteFromArchive(customer)}
                          className="px-3 py-2 bg-slate-100 hover:bg-rose-100 text-slate-500 hover:text-rose-700 font-bold text-xs rounded-xl transition cursor-pointer flex items-center gap-1"
                          title="حذف من الأرشيف"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">حذف السجل</span>
                        </button>
                      </div>
                    </div>

                    {/* Payment history (expanded) */}
                    {isExpanded && (
                      <div className="border-t border-slate-100">
                        <div className="px-4 py-2 bg-slate-50/80 flex items-center gap-1.5">
                          <History className="w-3 h-3 text-slate-500" />
                          <span className="text-[11px] font-extrabold text-slate-500">تفاصيل الدفعات</span>
                        </div>
                        {renderPaymentHistory(customer.id)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* PAYMENT MODAL */}
      {paymentCustomer && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-slate-100 overflow-hidden">

            {/* Modal header */}
            <div className="bg-[#0B1F4D] p-5 text-white flex justify-between items-center">
              <div>
                <h3 className="font-extrabold text-sm font-cairo">تسجيل تسديد</h3>
                <p className="text-[11px] text-slate-300 mt-0.5">
                  الزبون: <span className="text-white font-bold">{paymentCustomer.name}</span>
                </p>
              </div>
              <button
                onClick={() => setPaymentCustomer(null)}
                className="p-1.5 hover:bg-white/10 rounded-lg cursor-pointer transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handlePayment} className="p-5 space-y-4">

              {/* Current debt badge */}
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 text-center">
                <span className="text-xs text-rose-700 font-bold">الدين الحالي</span>
                <p className="font-extrabold text-xl text-rose-700 font-sans mt-0.5">
                  {formatCurrency(paymentCustomer.balance, currency, exchangeRate)}
                </p>
              </div>

              {/* Amount */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">
                  المبلغ المسدّد (دينار عراقي)
                </label>
                <NumberInput inputMode="decimal"
                  value={payAmount}
                  onValueChange={(v) => setPayAmount(v)}
                  placeholder={`أقصى مبلغ: ${paymentCustomer.balance.toLocaleString()}`}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-center"
                  min={1}
                  max={paymentCustomer.balance}
                  autoFocus
                  required
                />
                {/* Remaining preview */}
                {payAmount && Number.isFinite(parseAmount(payAmount)) && parseAmount(payAmount) > 0 && (
                  <div className="mt-2 text-xs font-bold text-center">
                    {parseAmount(payAmount) >= paymentCustomer.balance ? (
                      <span className="text-emerald-700 bg-emerald-50 px-3 py-1 rounded-full">
                        سيُسدَّد الدين كاملاً ✅
                      </span>
                    ) : (
                      <span className="text-amber-700 bg-amber-50 px-3 py-1 rounded-full">
                        المتبقي بعد الدفع:{' '}
                        {formatCurrency(paymentCustomer.balance - parseAmount(payAmount), currency, exchangeRate)}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Invoice link dropdown — يظهر فقط إذا للزبون فواتير غير مسددة */}
              {(() => {
                const unpaid = allInvoices.filter(
                  inv => inv.customerId === paymentCustomer.id && (inv.remainingAmount ?? 0) > 0
                );
                if (unpaid.length === 0) return null;
                return (
                  <div>
                    <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-[#0B1F4D]" />
                      على أي فاتورة تريد تسجيل الدفعة؟
                      {unpaid.length === 1 && (
                        <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full text-[10px] font-bold">
                          تم الاختيار تلقائياً
                        </span>
                      )}
                    </label>
                    <select
                      value={selectedPayInvoiceId}
                      onChange={e => setSelectedPayInvoiceId(e.target.value)}
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-right"
                      disabled={unpaid.length === 1}
                    >
                      {unpaid.length > 1 && (
                        <option value="none">— بدون ربط بفاتورة محددة —</option>
                      )}
                      {unpaid.map(inv => (
                        <option key={inv.id} value={inv.id}>
                          فاتورة {inv.invoiceNumber} — متبقي {inv.remainingAmount?.toLocaleString()} د.ع — {inv.date}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })()}

              {/* Notes */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">
                  ملاحظة <span className="text-slate-500 font-normal">(اختياري)</span>
                </label>
                <input
                  type="text"
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  placeholder="مثال: دفعة نقدية، تحويل بنكي..."
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-right"
                />
              </div>

              {/* طريقة الدفع — تُفصل في تقفيل الصندوق */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">💳 طريقة الدفع</label>
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-right cursor-pointer outline-none"
                >
                  {allPaymentMethods(customPaymentMethods).map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>

              {/* Date */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">تاريخ التسديد</label>
                {/* تأخير التاريخ مشروع (تسجيل تحصيل الأمس)، أما تقديمه فلا: تقفيل الصندوق
                    يجمع الدفعات بتاريخها، فدفعة بتاريخ الغد تدخل نقد يومٍ لم يأتِ بعد.
                    ⚠️ الرفض بحارس عربي عند الحفظ لا بـ`max`: الأخير يجعل المتصفح يعترض
                    برسالته الإنكليزية «Value must be … or earlier» في برنامج عربي بالكامل. */}
                <input
                  type="date"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold font-mono"
                  required
                />
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={isPaying}
                className="w-full py-3 bg-emerald-700 hover:bg-emerald-800 text-white font-extrabold rounded-xl text-sm shadow transition cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-wait"
              >
                <Save className="w-4 h-4" />
                <span>{isPaying ? 'جارٍ التسديد...' : 'تأكيد التسديد'}</span>
              </button>

            </form>
          </div>
        </div>
      )}

    </div>
  );
}
