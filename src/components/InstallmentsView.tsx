import React, { useMemo, useState } from 'react';
import { doc, writeBatch, increment } from 'firebase/firestore';
import { db, auth } from '../firebase';
import {
  CalendarClock, AlertTriangle, CheckCircle2, Plus, X, Save, Search,
  CreditCard, MessageCircle, Wallet, TrendingUp, Clock,
} from 'lucide-react';
import { useCollection } from '../hooks/useCollection';
import { useBranches } from '../hooks/useBranches';
import { useActor } from '../hooks/useActor';
import { logAudit } from '../utils/auditLog';
import { Customer, Invoice, InstallmentPlan } from '../types';
import { toArabicDigits, formatCurrency, parseAmount } from '../utils/arabicFormatters';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { generateSchedule, planStatus, isDueWithin } from '../utils/installments';
import { buildDebtReminderUrl, canWhatsapp } from '../utils/whatsapp';
import { allocatePayment, invoicePaymentUpdate } from '../utils/debtAllocation';
import { allPaymentMethods, CASH_METHOD } from '../utils/paymentMethods';
import { reportFirestoreError } from '../utils/writeGuard';
import { openExternal } from '../utils/openExternal';

interface Props {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  storeName?: string;
  // طرق الدفع التي أضافها المالك — بدونها تُعرض الافتراضية وحدها هنا دون بقية الشاشات
  customPaymentMethods?: string[];
}

interface DebtPayment {
  id: string; customerId: string; customerName: string;
  amount: number; date: string; notes: string; invoiceId?: string;
  method?: string; // طريقة الدفع — يفصلها تقفيل الصندوق (غيابها = كاش، توافق رجعي)
}

const fmtDate = (d: string) => {
  if (!d) return '—';
  const dt = new Date(`${d}T00:00:00`);
  return isNaN(dt.getTime()) ? toArabicDigits(d) : dt.toLocaleDateString('ar-IQ');
};

export default function InstallmentsView({ currency, exchangeRate, storeName, customPaymentMethods }: Props) {
  const actor = useActor();
  const { matchesActiveBranch, isMultiBranch, branchName, stampBranchId } = useBranches();
  const { items: plans, save: savePlan } = useCollection<InstallmentPlan>('installment_plans');
  const { items: invoices } = useCollection<Invoice>('invoices');
  const { items: customers } = useCollection<Customer>('customers');
  const { save: savePayment } = useCollection<DebtPayment>('debt_payments');

  const [alert, setAlert] = useState<{ text: string; bad?: boolean } | null>(null);
  const notify = (text: string, bad = false) => { setAlert({ text, bad }); setTimeout(() => setAlert(null), 5000); };

  const money = (n: number) => formatCurrency(n, currency, exchangeRate);

  // ---- دمج الخطط مع حالتها المشتقّة من الفواتير (مصدر الحقيقة الوحيد للمال) ----
  const rows = useMemo(() => {
    return plans
      .filter(p => p.status !== 'cancelled')
      // خطة القسط تتبع فرع فاتورتها المصدر (لا فرعاً مستقلاً — الفاتورة هي مصدر الحقيقة للمال).
      // خطة فُقدت فاتورتها تبقى ظاهرة في كل العروض حتى لا تختفي بصمت.
      .filter(p => { const inv = invoices.find(i => i.id === p.invoiceId); return !inv || matchesActiveBranch(inv); })
      .map(p => {
        const inv = invoices.find(i => i.id === p.invoiceId);
        const st = planStatus(p, inv ?? null);
        const customer = customers.find(c => c.id === p.customerId);
        return { plan: p, st, customer, invoiceExists: !!inv };
      })
      .sort((a, b) => {
        // الأولوية: المتأخرون أولاً (الأقدم تأخيراً)، ثم الأقرب استحقاقاً، ثم المكتملون آخراً
        if (a.st.isCompleted !== b.st.isCompleted) return a.st.isCompleted ? 1 : -1;
        if (a.st.overdueAmount !== b.st.overdueAmount) return b.st.overdueAmount - a.st.overdueAmount;
        return (a.st.nextDue?.dueDate ?? '9999').localeCompare(b.st.nextDue?.dueDate ?? '9999');
      });
  }, [plans, invoices, customers, matchesActiveBranch]);

  const kpis = useMemo(() => {
    const active = rows.filter(r => !r.st.isCompleted);
    const overdue = active.filter(r => r.st.overdueAmount > 0);
    const dueSoon = active.filter(r => !r.st.overdueAmount && r.st.nextDue && isDueWithin(r.st.nextDue.dueDate, 7));
    return {
      activeCount: active.length,
      overdueCount: overdue.length,
      overdueAmount: overdue.reduce((s, r) => s + r.st.overdueAmount, 0),
      dueSoonCount: dueSoon.length,
      // المسقوف بالمتبقي لا مبلغ الجدول الخام — بعد مرتجع يصير الجدول أكبر من الدَّين
      dueSoonAmount: dueSoon.reduce((s, r) => s + r.st.nextDueAmount, 0),
      outstanding: active.reduce((s, r) => s + r.st.remaining, 0),
    };
  }, [rows]);

  // ================= إنشاء خطة =================
  const [showCreate, setShowCreate] = useState(false);
  const [invSearch, setInvSearch] = useState('');
  const [pickedInvoiceId, setPickedInvoiceId] = useState('');
  const [count, setCount] = useState('3');
  const [freq, setFreq] = useState<'monthly' | 'weekly'>('monthly');
  const [startDate, setStartDate] = useState(todayISO());
  const [planNotes, setPlanNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // فواتير مؤهّلة: عليها دين، ولها زبون، وليست مقسّطة مسبقاً
  const eligibleInvoices = useMemo(() => {
    const planned = new Set(plans.filter(p => p.status !== 'cancelled').map(p => p.invoiceId));
    const q = invSearch.trim().toLowerCase();
    return invoices
      .filter(i => (i.remainingAmount ?? 0) > 0 && i.customerId && !planned.has(i.id))
      .filter(i => !q || String(i.invoiceNumber).toLowerCase().includes(q) || i.customerName.toLowerCase().includes(q))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, [invoices, plans, invSearch]);

  const pickedInvoice = invoices.find(i => i.id === pickedInvoiceId);
  const previewSchedule = useMemo(() => {
    if (!pickedInvoice) return [];
    const n = Math.max(1, Math.floor(parseAmount(count) || 1));
    return generateSchedule(pickedInvoice.remainingAmount ?? 0, n, freq, startDate);
  }, [pickedInvoice, count, freq, startDate]);

  const resetCreate = () => {
    setPickedInvoiceId(''); setCount('3'); setFreq('monthly');
    setStartDate(todayISO()); setPlanNotes(''); setInvSearch('');
  };

  const handleCreatePlan = async () => {
    if (saving) return;
    if (!pickedInvoice) { notify('اختر الفاتورة المراد تقسيطها', true); return; }
    const n = Math.floor(parseAmount(count) || 0);
    if (!n || n < 1) { notify('عدد الأقساط يجب أن يكون ١ فأكثر', true); return; }
    if (n > 60) { notify('عدد الأقساط كبير جداً (الحد ٦٠)', true); return; }

    setSaving(true);
    try {
      const total = pickedInvoice.remainingAmount ?? 0;
      const plan: InstallmentPlan = {
        id: `plan_${genId()}`,
        customerId: pickedInvoice.customerId!,
        customerName: pickedInvoice.customerName,
        invoiceId: pickedInvoice.id,
        invoiceNumber: pickedInvoice.invoiceNumber,
        productSummary: (pickedInvoice.items ?? []).map(i => i.name).slice(0, 3).join('، ') || 'بضاعة',
        totalAmount: total,
        // المقدَّم = المدفوع فعلاً لحظة الإنشاء. الفاتورة القديمة بلا paidAmount يُستنتج
        // مدفوعها من (الإجمالي − المتبقي)، وإلا صار المقدَّم صفراً واختلّ مرساة الخطة.
        downPayment: pickedInvoice.paidAmount ?? Math.max(0, pickedInvoice.finalAmount - (pickedInvoice.remainingAmount ?? 0)),
        frequency: freq,
        schedule: generateSchedule(total, n, freq, startDate),
        notes: planNotes.trim(),
        status: 'active',
        createdAt: Date.now(),
        createdByName: actor.name,
      };
      await savePlan(plan);
      void logAudit({
        action: 'create', entity: 'invoice', entityId: plan.id,
        summary: `إنشاء خطة تقسيط لـ«${plan.customerName}» — ${money(total)} على ${toArabicDigits(n)} أقساط (${freq === 'monthly' ? 'شهري' : 'أسبوعي'})`,
        after: plan as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
        relatedEntity: 'customer', relatedEntityId: plan.customerId,
      });
      notify('تم إنشاء خطة التقسيط ✅');
      setShowCreate(false);
      resetCreate();
    } finally { setSaving(false); }
  };

  // ================= تسجيل تسديد قسط =================
  const [payFor, setPayFor] = useState<typeof rows[number] | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(todayISO());
  const [payMethod, setPayMethod] = useState<string>(CASH_METHOD);
  const [paying, setPaying] = useState(false);

  const openPay = (row: typeof rows[number]) => {
    setPayFor(row);
    setPayAmount(String(row.st.overdueAmount > 0 ? row.st.overdueAmount : row.st.nextDueAmount));
    setPayDate(todayISO());
    setPayMethod(CASH_METHOD);
  };

  const handlePay = async () => {
    if (paying || !payFor) return;
    const amount = Math.round(parseAmount(payAmount) || 0);
    if (!amount || amount <= 0) { notify('أدخل مبلغاً صحيحاً', true); return; }
    if (amount > payFor.st.remaining) { notify('المبلغ أكبر من المتبقي على الخطة', true); return; }
    // تقفيل الصندوق يجمع الدفعات بتاريخها — فدفعة بتاريخ الغد تدخل نقد يومٍ لم يأتِ
    if (payDate > todayISO()) {
      notify('لا يمكن تسجيل تسديد بتاريخ مستقبلي — سيُحتسب في تقفيل يوم لم يأتِ بعد', true);
      return;
    }
    const inv = invoices.find(i => i.id === payFor.plan.invoiceId);
    const uid = auth.currentUser?.uid;
    if (!inv || !uid) { notify('تعذّر العثور على الفاتورة المرتبطة', true); return; }

    /**
     * 🔴 نفس مسار تسديد الديون حرفياً (`debtAllocation`) — لا مسار ثانٍ يتباعد عنه.
     *
     * كان هنا `saveInvoice({ ...inv, ... })`، و`save` هي `setDoc` أي **استبدال الوثيقة
     * بأكملها** من لقطة محلية. فأي تغيير حدث على الفاتورة بين تحميل الشاشة وضغط التسديد
     * كان يُمحى كلّه: تعديل الأصناف، تسديد سُجِّل من شاشة الديون، مرتجع أُرجع.
     *
     * وكان `inv.paidAmount ?? inv.finalAmount` يعامل الفاتورة القديمة كمدفوعة بالكامل ثم
     * يضيف القسط فوقها ⇒ مدفوع أكبر من الإجمالي. `invoicePaymentUpdate` يستنتجه صحيحاً.
     */
    const { allocations, unallocated } = allocatePayment([inv], amount, inv.id);
    if (unallocated > 0) {
      notify(
        `المبلغ أكبر من متبقّي الفاتورة المرتبطة (${money(inv.remainingAmount ?? 0)}) — `
        + `قد تكون سُدِّدت جزئياً من شاشة الديون`,
        true,
      );
      return;
    }

    setPaying(true);
    try {
      const paymentId = `pay_${genId()}`;
      // نفس آلية تسديد الديون القائمة تماماً — فيظهر النقد في تقفيل الصندوق والتقارير تلقائياً
      await savePayment({
        id: paymentId,
        customerId: payFor.plan.customerId,
        customerName: payFor.plan.customerName,
        amount,
        date: payDate,
        notes: `تسديد قسط — خطة ${payFor.plan.invoiceNumber}`,
        method: payMethod, // بدونه كان كل قسط يُحسب كاشاً في الدرج ولو سُدِّد ببطاقة
        invoiceId: inv.id,
      });

      // الفاتورة والرصيد بالفوارق في دفعة واحدة — آمن أوفلاين ومع التحصيل المتزامن
      const batch = writeBatch(db);
      for (const a of allocations) {
        batch.update(doc(db, 'users', uid, 'invoices', a.invoiceId), invoicePaymentUpdate(inv, a.amount));
      }
      batch.update(doc(db, 'users', uid, 'customers', payFor.plan.customerId), { balance: increment(-amount) });
      batch.commit().catch(err => reportFirestoreError('installment_plans', 'batch', err, '[Firestore] installment payment'));

      void logAudit({
        // معرّف الدفعة نفسه — كان `plan_pay_${Date.now()}` فلا يُفضي إلى أي دفعة موجودة
        action: 'create', entity: 'debt_payment', entityId: paymentId,
        summary: `تسديد قسط من «${payFor.plan.customerName}»: ${money(amount)} (${payMethod}) — المتبقي ${money(payFor.st.remaining - amount)}`,
        actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
        relatedEntity: 'customer', relatedEntityId: payFor.plan.customerId,
      });
      notify(`تم تسجيل القسط ✅ — المتبقي ${money(payFor.st.remaining - amount)}`);
      setPayFor(null);
    } finally { setPaying(false); }
  };

  const remind = (row: typeof rows[number]) => {
    const c = row.customer;
    if (!c || !canWhatsapp(c.phone)) { notify('لا يوجد رقم هاتف صالح لهذا الزبون', true); return; }
    const url = buildDebtReminderUrl({
      customerName: c.name, phone: c.phone,
      balance: row.st.overdueAmount > 0 ? row.st.overdueAmount : row.st.nextDueAmount,
      storeName: storeName || '', currency, exchangeRate,
      dueDate: row.st.nextDue ? fmtDate(row.st.nextDue.dueDate) : '',
    });
    if (url) void openExternal(url);
  };

  return (
    <div className="space-y-6 font-tajawal" dir="rtl">

      {/* HEADER */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-[#0B1F4D] text-white p-6 rounded-2xl border-b-4 border-amber-400">
        <div>
          <div className="flex items-center gap-2 text-slate-300 text-xs font-bold font-cairo">
            <CalendarClock className="w-3.5 h-3.5 text-emerald-400" />
            <span>البيع بالتقسيط ومتابعة التحصيل</span>
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2">
            <CreditCard className="w-6 h-6 text-amber-400" />
            <span>الأقساط والمتأخرات 📅</span>
            {isMultiBranch && (
              <span className="text-[10px] font-extrabold px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-200 border border-amber-400/40">
                🏢 {branchName(stampBranchId)}
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-300 mt-1 leading-relaxed">
            اعرف مَن تأخّر عليك، وكم بقي لكل زبون، وموعد القسط القادم — بدل مجرد رقم دين
          </p>
        </div>
        <button
          onClick={() => { resetCreate(); setShowCreate(true); }}
          className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-extrabold rounded-xl text-xs shadow flex items-center gap-1.5 cursor-pointer active:scale-95 self-start"
        >
          <Plus className="w-4 h-4" /> <span>خطة تقسيط جديدة</span>
        </button>
      </div>

      {alert && (
        <div className={`px-4 py-3 rounded-xl text-xs font-bold border ${alert.bad ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
          {alert.text}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <span className="text-[11px] font-bold text-[#5B6B86] block">متأخرات التحصيل</span>
          <h3 className="text-lg font-black text-rose-700 mt-1.5 font-sans">{money(kpis.overdueAmount)}</h3>
          <span className="text-[10px] text-rose-700 font-bold block mt-1.5">{toArabicDigits(kpis.overdueCount)} زبون متأخر ⚠️</span>
          <div className="absolute right-0 top-0 h-full w-1 bg-rose-500" />
        </div>
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <span className="text-[11px] font-bold text-[#5B6B86] block">مستحق خلال أسبوع</span>
          <h3 className="text-lg font-black text-amber-700 mt-1.5 font-sans">{money(kpis.dueSoonAmount)}</h3>
          <span className="text-[10px] text-slate-600 font-bold block mt-1.5">{toArabicDigits(kpis.dueSoonCount)} قسط قادم</span>
          <div className="absolute right-0 top-0 h-full w-1 bg-amber-500" />
        </div>
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <span className="text-[11px] font-bold text-[#5B6B86] block">إجمالي المتبقي</span>
          <h3 className="text-lg font-black text-[#0B1F4D] mt-1.5 font-sans">{money(kpis.outstanding)}</h3>
          <span className="text-[10px] text-slate-600 font-bold block mt-1.5">على كل الخطط النشطة</span>
          <div className="absolute right-0 top-0 h-full w-1 bg-[#0B1F4D]" />
        </div>
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <span className="text-[11px] font-bold text-[#5B6B86] block">خطط نشطة</span>
          <h3 className="text-lg font-black text-emerald-700 mt-1.5 font-sans">{toArabicDigits(kpis.activeCount)}</h3>
          <span className="text-[10px] text-slate-600 font-bold block mt-1.5">من أصل {toArabicDigits(rows.length)}</span>
          <div className="absolute right-0 top-0 h-full w-1 bg-emerald-500" />
        </div>
      </div>

      {/* PLANS LIST */}
      {rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#E4EAF3] p-12 text-center">
          <CreditCard className="w-12 h-12 text-slate-400 mx-auto mb-3" />
          <h3 className="font-extrabold text-sm text-[#0B1F4D]">لا توجد خطط تقسيط بعد</h3>
          <p className="text-xs text-slate-500 mt-2 font-bold leading-relaxed">
            أنشئ خطة من فاتورة دين قائمة — سيولّد البرنامج جدول الأقساط ومواعيدها تلقائياً.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(({ plan, st, customer, invoiceExists }) => {
            const tone = st.isCompleted
              ? { bar: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-800 border-emerald-200', label: 'مكتملة ✅' }
              : st.overdueAmount > 0
                ? { bar: 'bg-rose-500', chip: 'bg-rose-50 text-rose-800 border-rose-300', label: `متأخر ${toArabicDigits(st.daysLateOfOldest)} يوم ⚠️` }
                : { bar: 'bg-amber-500', chip: 'bg-amber-50 text-amber-800 border-amber-200', label: 'منتظم' };
            return (
              <div key={plan.id} className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden relative">
                <div className={`absolute right-0 top-0 h-full w-1.5 ${tone.bar}`} />
                <div className="p-4 pr-6">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-extrabold text-sm text-[#0B1F4D]">{plan.customerName}</span>
                        <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${tone.chip}`}>{tone.label}</span>
                        {!invoiceExists && (
                          <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">
                            الفاتورة محذوفة
                          </span>
                        )}
                        {invoiceExists && st.scheduleStale && (
                          <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-300">
                            {st.staleKind === 'grew' ? '⚠️ الفاتورة زادت بعد الخطة'
                              : st.staleKind === 'shrank' ? '⚠️ الفاتورة نقصت بعد الخطة'
                              : '⚠️ الجدول لا يطابق المبلغ'}
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-slate-500 font-bold block mt-1">
                        {plan.productSummary} · فاتورة {toArabicDigits(plan.invoiceNumber)} · {plan.frequency === 'monthly' ? 'شهري' : 'أسبوعي'}
                      </span>
                    </div>
                    <div className="text-left">
                      <span className="text-[10px] text-slate-600 font-bold block">المتبقي</span>
                      <span className="text-lg font-black text-[#0B1F4D] font-sans">{money(st.remaining)}</span>
                    </div>
                  </div>

                  {/* شريط التقدّم */}
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[10px] font-bold text-slate-500 mb-1">
                      {/* الإجمالي من الفاتورة الآن لا من لقطة الإنشاء — يصحّح نفسه عند أي تعديل */}
                      <span>مدفوع {money(st.paidTotal)} من {money(st.total)}</span>
                      <span>{toArabicDigits(st.progressPct)}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div className={`h-full ${tone.bar} transition-all`} style={{ width: `${st.progressPct}%` }} />
                    </div>
                    {/* الأرقام أعلاه صحيحة دائماً (مشتقّة من الفاتورة)، لكن **مواعيد الجدول
                        ومبالغه** بُنيت على المبلغ القديم — فنقول ذلك بدل أن نُخفيه. */}
                    {invoiceExists && st.scheduleStale && (
                      <p className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-2 leading-relaxed">
                        {st.staleKind === 'shrank'
                          ? 'نقص مبلغ الفاتورة بعد إنشاء الخطة (مرتجع أو خصم). المبالغ أعلاه صحيحة، لكن جدول الأقساط أدناه بُني على المبلغ القديم.'
                          : st.staleKind === 'grew'
                            ? 'زاد مبلغ الفاتورة بعد إنشاء الخطة. المبالغ أعلاه صحيحة، لكن جدول الأقساط أدناه لا يغطّي الزيادة.'
                            : 'مجموع الأقساط في الجدول لا يساوي المبلغ المتبقّي — راجع الجدول.'}
                        {' '}أنشئ خطة جديدة إن أردت جدولاً مطابقاً.
                      </p>
                    )}
                  </div>

                  {/* القسط القادم / المتأخرات */}
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                    <div className="bg-slate-50 rounded-xl p-2.5">
                      <span className="text-[10px] text-slate-600 font-bold block">القسط القادم</span>
                      <span className="font-extrabold text-[#0B1F4D]">
                        {st.nextDue ? `${money(st.nextDueAmount)} — ${fmtDate(st.nextDue.dueDate)}` : 'لا يوجد'}
                      </span>
                    </div>
                    <div className="bg-slate-50 rounded-xl p-2.5">
                      <span className="text-[10px] text-slate-600 font-bold block">المتأخر</span>
                      <span className={`font-extrabold ${st.overdueAmount > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                        {st.overdueAmount > 0 ? `${money(st.overdueAmount)} (${toArabicDigits(st.overdueRows.length)} قسط)` : 'لا شيء'}
                      </span>
                    </div>
                    <div className="bg-slate-50 rounded-xl p-2.5">
                      <span className="text-[10px] text-slate-600 font-bold block">الأقساط</span>
                      <span className="font-extrabold text-[#0B1F4D]">
                        {toArabicDigits(st.rows.filter(r => r.state === 'paid').length)} / {toArabicDigits(st.rows.length)} مسدَّد
                      </span>
                    </div>
                  </div>

                  {/* أزرار */}
                  {!st.isCompleted && (
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => openPay({ plan, st, customer, invoiceExists })}
                        disabled={!invoiceExists}
                        className="px-4 py-2 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold text-xs rounded-xl transition cursor-pointer active:scale-95 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Wallet className="w-3.5 h-3.5" /> تسجيل قسط
                      </button>
                      {customer && canWhatsapp(customer.phone) && (
                        <button
                          onClick={() => remind({ plan, st, customer, invoiceExists })}
                          className="px-3 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-extrabold text-xs rounded-xl transition cursor-pointer flex items-center gap-1.5"
                        >
                          <MessageCircle className="w-3.5 h-3.5" /> تذكير واتساب
                        </button>
                      )}
                    </div>
                  )}

                  {/* جدول الأقساط */}
                  <details className="mt-3">
                    <summary className="text-[11px] font-extrabold text-indigo-700 cursor-pointer">عرض جدول الأقساط</summary>
                    <div className="mt-2 space-y-1">
                      {st.rows.map(r => (
                        <div key={r.seq} className={`flex items-center justify-between text-[11px] px-3 py-1.5 rounded-lg ${
                          r.state === 'paid' ? 'bg-emerald-50' : r.isOverdue ? 'bg-rose-50' : 'bg-slate-50'
                        }`}>
                          <span className="font-bold text-slate-600">
                            قسط {toArabicDigits(r.seq)} — {fmtDate(r.dueDate)}
                          </span>
                          <span className="flex items-center gap-2">
                            <span className="font-extrabold font-sans text-[#0B1F4D]">{money(r.amount)}</span>
                            {r.state === 'paid'
                              ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />
                              : r.isOverdue
                                ? <AlertTriangle className="w-3.5 h-3.5 text-rose-700" />
                                : <Clock className="w-3.5 h-3.5 text-slate-500" />}
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ========== CREATE PLAN MODAL ========== */}
      {showCreate && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl border border-slate-200 flex flex-col max-h-[90vh]">
            <div className="p-5 bg-gradient-to-r from-amber-600 to-amber-500 text-white flex justify-between items-center flex-shrink-0">
              <h3 className="font-black text-sm md:text-base font-cairo flex items-center gap-1.5">
                <CreditCard className="w-5 h-5" /> <span>خطة تقسيط جديدة</span>
              </h3>
              <button onClick={() => setShowCreate(false)} className="p-1.5 hover:bg-white/10 rounded-lg font-black text-xs cursor-pointer">إغلاق ✕</button>
            </div>

            <div className="p-4 overflow-y-auto flex-1 space-y-4">
              {!pickedInvoice ? (
                <>
                  <div className="relative">
                    <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                      type="text" value={invSearch} onChange={e => setInvSearch(e.target.value)} autoFocus
                      placeholder="ابحث برقم الفاتورة أو اسم الزبون..."
                      className="w-full pr-9 pl-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-right outline-none focus:bg-white"
                    />
                  </div>
                  <p className="text-[11px] text-slate-500 font-bold">اختر فاتورة دين لتقسيطها:</p>
                  {eligibleInvoices.length === 0 ? (
                    <div className="py-10 text-center text-slate-500 font-bold text-xs">
                      لا توجد فواتير دين قابلة للتقسيط (يجب أن يكون عليها مبلغ متبقٍّ ومرتبطة بزبون).
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {eligibleInvoices.slice(0, 50).map(i => (
                        <button key={i.id} onClick={() => setPickedInvoiceId(i.id)}
                          className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-slate-200 hover:bg-amber-50 hover:border-amber-200 transition text-right cursor-pointer">
                          <div className="min-w-0">
                            <span className="text-xs font-extrabold text-[#0B1F4D] block">{i.customerName}</span>
                            <span className="text-[10px] text-slate-600 font-bold block mt-0.5">
                              فاتورة {toArabicDigits(i.invoiceNumber)} · {fmtDate(i.date)}
                            </span>
                          </div>
                          <span className="text-xs font-extrabold text-rose-700 font-sans flex-shrink-0">
                            دين {money(i.remainingAmount ?? 0)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <button onClick={() => setPickedInvoiceId('')} className="text-[11px] text-amber-700 font-bold hover:underline cursor-pointer">
                    ← اختيار فاتورة أخرى
                  </button>
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                    <span className="text-[11px] font-bold text-amber-900 block">
                      {pickedInvoice.customerName} — فاتورة {toArabicDigits(pickedInvoice.invoiceNumber)}
                    </span>
                    <span className="text-lg font-black text-amber-800 font-sans block mt-1">
                      المبلغ المقسَّط: {money(pickedInvoice.remainingAmount ?? 0)}
                    </span>
                    {!!pickedInvoice.paidAmount && (
                      <span className="text-[10px] text-amber-700 font-bold block mt-0.5">
                        (مقدَّم مدفوع مسبقاً: {money(pickedInvoice.paidAmount)})
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] font-extrabold text-[#0B1F4D] block mb-1">عدد الأقساط</label>
                      <input type="text" inputMode="decimal" min={1} max={60} value={count} onChange={e => setCount(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-bold text-center outline-none focus:border-amber-400" />
                    </div>
                    <div>
                      <label className="text-[11px] font-extrabold text-[#0B1F4D] block mb-1">الدورية</label>
                      <select value={freq} onChange={e => setFreq(e.target.value as 'monthly' | 'weekly')}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-bold bg-white cursor-pointer outline-none">
                        <option value="monthly">شهري</option>
                        <option value="weekly">أسبوعي</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] font-extrabold text-[#0B1F4D] block mb-1">تاريخ القسط الأول</label>
                    <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-bold font-mono outline-none focus:border-amber-400" />
                  </div>

                  <div>
                    <label className="text-[11px] font-extrabold text-[#0B1F4D] block mb-1">ملاحظة (اختياري)</label>
                    <input type="text" value={planNotes} onChange={e => setPlanNotes(e.target.value)}
                      placeholder="مثال: ثلاجة LG — كفيل: أبو علي"
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-bold text-right outline-none focus:border-amber-400" />
                  </div>

                  {/* معاينة الجدول */}
                  {previewSchedule.length > 0 && (
                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <div className="px-3 py-2 bg-slate-50 text-[11px] font-extrabold text-[#0B1F4D]">
                        معاينة الجدول ({toArabicDigits(previewSchedule.length)} أقساط)
                      </div>
                      <div className="max-h-48 overflow-y-auto divide-y divide-slate-50">
                        {previewSchedule.map(d => (
                          <div key={d.seq} className="flex items-center justify-between px-3 py-1.5 text-[11px]">
                            <span className="font-bold text-slate-600">قسط {toArabicDigits(d.seq)} — {fmtDate(d.dueDate)}</span>
                            <span className="font-extrabold text-[#0B1F4D] font-sans">{money(d.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {pickedInvoice && (
              <div className="p-4 bg-slate-50 border-t border-slate-100 flex-shrink-0">
                <button onClick={handleCreatePlan} disabled={saving}
                  className="w-full py-3 bg-amber-700 hover:bg-amber-800 text-white font-extrabold rounded-xl text-sm shadow transition cursor-pointer flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50">
                  <Save className="w-4 h-4" /> <span>{saving ? 'جارٍ الحفظ...' : 'إنشاء خطة التقسيط'}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========== PAY MODAL ========== */}
      {payFor && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-5 bg-[#0B1F4D] text-white flex justify-between items-center">
              <div>
                <h3 className="font-extrabold text-sm font-cairo">تسجيل تسديد قسط</h3>
                <p className="text-[11px] text-slate-300 mt-0.5">{payFor.plan.customerName}</p>
              </div>
              <button onClick={() => setPayFor(null)} className="p-1.5 hover:bg-white/10 rounded-lg cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 text-center">
                  <span className="text-[10px] text-rose-700 font-bold block">المتأخر</span>
                  <span className="font-black text-rose-700 font-sans">{money(payFor.st.overdueAmount)}</span>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                  <span className="text-[10px] text-slate-600 font-bold block">إجمالي المتبقي</span>
                  <span className="font-black text-[#0B1F4D] font-sans">{money(payFor.st.remaining)}</span>
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-[#0B1F4D] block mb-1.5">المبلغ المسدَّد (د.ع)</label>
                <input type="text" inputMode="decimal" min={1} value={payAmount} onChange={e => setPayAmount(e.target.value)} autoFocus
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-center outline-none focus:bg-white" />
                <p className="text-[10px] text-slate-600 font-bold mt-1 text-center">
                  اقتُرح تلقائياً: {payFor.st.overdueAmount > 0 ? 'مجموع المتأخر' : 'قيمة القسط القادم'}
                </p>
              </div>
              {/* طريقة الدفع — بدونها كان كل قسط يُحسب كاشاً في الدرج ولو سُدِّد ببطاقة،
                  فيظهر عجز عند عدّ النقد. تقفيل الصندوق يفصلها بهذا الحقل. */}
              <div>
                <label className="text-xs font-bold text-[#0B1F4D] block mb-1.5">💳 طريقة الدفع</label>
                <select value={payMethod} onChange={e => setPayMethod(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-right cursor-pointer outline-none">
                  {allPaymentMethods(customPaymentMethods).map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-bold text-[#0B1F4D] block mb-1.5">تاريخ التسديد</label>
                {/* الرفض بحارس عربي عند الحفظ لا بـ`max` — الأخير يعترض برسالة إنكليزية */}
                <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold font-mono outline-none" />
              </div>
              <button onClick={handlePay} disabled={paying}
                className="w-full py-3 bg-emerald-700 hover:bg-emerald-800 text-white font-extrabold rounded-xl text-sm shadow transition cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50">
                <TrendingUp className="w-4 h-4" /> <span>{paying ? 'جارٍ التسجيل...' : 'تأكيد التسديد'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
