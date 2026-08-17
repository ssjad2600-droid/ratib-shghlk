import React, { useMemo, useState } from 'react';
import { writeBatch, doc, increment } from 'firebase/firestore';
import { Banknote, CheckCircle2, Clock, FileText, History, Save, Truck, X } from 'lucide-react';
import { db } from '../firebase';
import { useCollection } from '../hooks/useCollection';
import { useSession } from '../context/SessionContext';
import { useActor } from '../hooks/useActor';
import { useConfirm } from '../hooks/useConfirm';
import { Supplier, SupplierPayment, PurchaseInvoice } from '../types';
import { formatCurrency, parseAmount, toArabicDigits } from '../utils/arabicFormatters';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { logAudit } from '../utils/auditLog';
import { allocatePayment, invoicePaymentUpdate, remainingOf, AllocatableInvoice } from '../utils/debtAllocation';
import { CASH_METHOD, allPaymentMethods, isCashMethod } from '../utils/paymentMethods';
import { canReverse, isReversed, isReversal, markReversedUpdate } from '../utils/reversal';
import { useBranches } from '../hooks/useBranches';

interface Props {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  customPaymentMethods?: string[];
}

const formatDate = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString('ar-IQ') : '—';

/**
 * جسر النوع: `debtAllocation` كُتبت لفواتير البيع حيث الإجمالي `finalAmount`، وفاتورة
 * الشراء تسمّيه `total`. المنطق واحد حرفياً (توزيع على الأقدم + كتابة بالفوارق)، فنعبر
 * بجسرٍ صغير بدل نسخ الملف كاملاً باسم حقلٍ آخر.
 */
const asAllocatable = (i: PurchaseInvoice): AllocatableInvoice => ({
  id: i.id, finalAmount: i.total, remainingAmount: i.remainingAmount,
  paidAmount: i.paidAmount, createdAt: i.createdAt,
});

export default function SupplierAccountsView({ currency, exchangeRate, customPaymentMethods }: Props) {
  const { items: suppliers, loading } = useCollection<Supplier>('suppliers');
  const { items: invoices } = useCollection<PurchaseInvoice>('purchase_invoices');
  const { items: payments } = useCollection<SupplierPayment>('supplier_payments');
  const { ownerUid } = useSession();
  const actor = useActor();
  const { requestConfirm, confirmDialog } = useConfirm();
  const { stampBranchId, branchName, isMultiBranch } = useBranches();
  const [selected, setSelected] = useState<Supplier | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>(CASH_METHOD);
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState<{ text: string; bad?: boolean } | null>(null);

  const notify = (text: string, bad = false) => { setAlert({ text, bad }); setTimeout(() => setAlert(null), 6000); };
  const debtors = useMemo(() => [...suppliers.filter(s => s.balance > 0)].sort((a, b) => b.balance - a.balance), [suppliers]);
  const totalDebt = useMemo(() => debtors.reduce((sum, s) => sum + s.balance, 0), [debtors]);
  /**
   * 🟠 الموردون الذين **لنا** عندهم رصيد — دفعنا لهم زيادةً عن المستحق.
   * كانت الشاشة تُصفّي `balance > 0` وحدها، فالمال الذي لك عند مورّدك لا شاشة تعرضه.
   * وصار الرصيد السالب حالةً حقيقية بعد إصلاح الدفع الزائد في فواتير الشراء.
   */
  const creditors = useMemo(
    () => [...suppliers.filter(s => s.balance < 0)].sort((a, b) => a.balance - b.balance),
    [suppliers],
  );
  const totalCredit = useMemo(() => creditors.reduce((sum, s) => sum + Math.abs(s.balance), 0), [creditors]);

  const selectedInvoices = useMemo(() => !selected ? [] : invoices
    .filter(i => i.supplierId === selected.id && i.status === 'received' && remainingOf(asAllocatable(i)) > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt), [invoices, selected]);
  const selectedPayments = useMemo(() => !selected ? [] : payments
    .filter(p => p.supplierId === selected.id)
    .sort((a, b) => b.createdAt - a.createdAt), [payments, selected]);

  /** الرصيد الحيّ للمورد المفتوح نموذجه — لا لقطة التُقطت لحظة الفتح. */
  const liveSelected = selected ? suppliers.find(s => s.id === selected.id) ?? selected : null;

  const openPayment = (supplier: Supplier) => {
    setSelected(supplier); setAmount(''); setMethod(CASH_METHOD); setDate(todayISO()); setNotes('');
  };

  const submitPayment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !selected || !ownerUid) return;
    const supplier = liveSelected!;   // الرصيد الحيّ لا لقطة فتح النموذج
    const paid = parseAmount(amount);
    if (!Number.isFinite(paid) || paid <= 0) return notify('أدخل مبلغ تسديد صحيحاً.', true);
    if (paid > supplier.balance) {
      return notify(
        `المبلغ أكبر من المستحق للمورد (${formatCurrency(Math.max(0, supplier.balance), currency, exchangeRate)}).`
        + (supplier.balance !== selected.balance ? ' تغيّر الرصيد أثناء فتح النموذج.' : ''),
        true,
      );
    }

    /**
     * 🟠 التوزيع من `allocatePayment` المشتركة (نفس منطق ديون الزبائن) بدل حلقةٍ يدوية.
     *
     * والأهمّ: ما لا يجد فاتورةً يذهب إليها **لم يعد يمنع التسديد**. كان المنع تامّاً:
     * إن قال البرنامج «عليك مليون» ولم تُغطِّ الفواتيرُ المفتوحة المبلغَ كلَّه (بيانات
     * مستوردة، رصيد افتتاحي، فاتورة حُذفت) لم يكن التاجر يستطيع تسجيل التسديد إطلاقاً —
     * يرى ديناً ولا سبيل لإطفائه. الآن يُخصم الفائض من الرصيد وحده ويُخبَر التاجر بذلك.
     */
    const { allocations, unallocated } = allocatePayment(
      selectedInvoices.map(asAllocatable),
      paid,
    );

    setSaving(true);
    try {
      const payment: SupplierPayment = {
        id: `supplier_pay_${genId()}`,
        supplierId: supplier.id,
        supplierName: supplier.name,
        amount: paid,
        date,
        method,                 // 🔴 الفرق بين نقدٍ خرج من الدرج وتحويلٍ لم يمسّه
        branchId: stampBranchId,
        notes: notes.trim(),
        allocations,
        createdAt: Date.now(),
        createdByUid: actor.uid,
        createdByName: actor.name,
      };
      const batch = writeBatch(db);
      batch.set(doc(db, 'users', ownerUid, 'supplier_payments', payment.id), payment);
      for (const allocation of allocations) {
        const invoice = selectedInvoices.find(i => i.id === allocation.invoiceId);
        if (!invoice) continue;
        /**
         * 🔴 كانت الفاتورة تُكتب بقيم **مطلقة** من لقطة محلية بينما الرصيد بـ`increment`.
         * فجهازان يسدّدان لنفس المورد: الرصيد يجمع الحركتين والفاتورة تحتفظ بواحدة —
         * دفتران متعارضان، المورد يقول «سدّدتَ» والفاتورة تقول «باقٍ عليك».
         */
        batch.update(doc(db, 'users', ownerUid, 'purchase_invoices', invoice.id), {
          ...invoicePaymentUpdate(asAllocatable(invoice), allocation.amount),
          paymentType: remainingOf(asAllocatable(invoice)) - allocation.amount <= 0 ? 'cash' : 'partial',
        });
      }
      batch.update(doc(db, 'users', ownerUid, 'suppliers', supplier.id), { balance: increment(-paid) });
      // 🔴 لا `await`: الدفعة مع الذاكرة المحلية لا تعود أبداً بلا إنترنت، فيبقى الزرّ
      // «جارٍ الحفظ…» إلى الأبد. الكتابة تُطبَّق محلياً فوراً وتتزامن تلقائياً.
      batch.commit().catch(err => console.error('[Supplier payment] sync:', err));

      void logAudit({ action: 'create', entity: 'supplier_payment', entityId: payment.id, summary: `تسديد للمورد ${supplier.name} — ${formatCurrency(paid, currency, exchangeRate)} (${method})`, after: payment as unknown as Record<string, unknown>, actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name, relatedEntity: 'supplier', relatedEntityId: supplier.id });
      notify(
        `تم تسجيل تسديد ${formatCurrency(paid, currency, exchangeRate)} للمورد ${supplier.name} (${method}).`
        + (unallocated > 0
          ? ` — ${formatCurrency(unallocated, currency, exchangeRate)} منه لم يجد فاتورةً مفتوحة فخُصم من الرصيد مباشرةً.`
          : ''),
      );
      setSelected(null);
    } catch (error) {
      console.error('[Supplier payment]', error);
      notify(`لم يكتمل الحفظ: ${error instanceof Error ? error.message : 'خطأ غير متوقّع'}`, true);
    } finally { setSaving(false); }
  };

  /**
   * 🟠 التراجع عن تسديد — بقيدٍ مضادّ مربوط، لا بحذف.
   *
   * كان `batch.delete` يمحو وثيقة التسديد. والتسديد **حدثٌ وقع**: مَن دفع، ومتى، وبأي
   * طريقة، ولماذا تُراجع عنه. حذفه يمحو ذلك كله من الشاشة (وسجل التدقيق لا يفتحه تاجر).
   * وهو المبدأ نفسه المطبَّق في التسوية والصلاحية والنقل.
   */
  const undoPayment = async (payment: SupplierPayment) => {
    if (!ownerUid) return;
    const check = canReverse(payment);
    if (!check.ok) return notify(check.reason, true);

    const supplier = suppliers.find(s => s.id === payment.supplierId);
    if (!supplier) return notify('لا يمكن الإلغاء لأن المورد لم يعد موجوداً.', true);
    const allocations = payment.allocations || [];
    const hasChangedInvoice = allocations.some(allocation => {
      const invoice = invoices.find(i => i.id === allocation.invoiceId);
      return !invoice || invoice.status !== 'received';
    });
    if (hasChangedInvoice) return notify('لا يمكن إلغاء هذا التسديد لأن إحدى فواتيره أُلغيت أو حُذفت.', true);

    if (!(await requestConfirm(
      `التراجع عن تسديد ${formatCurrency(payment.amount, currency, exchangeRate)} للمورد ${payment.supplierName}؟\n\n`
      + 'سيعود الرصيد والفواتير كما كانت، ويُسجَّل قيدٌ مضادّ مربوط.\n\n'
      + 'التسديد الأصلي لا يُحذف — يبقى في السجل مختوماً «متراجَع عنه» لتبقى الحركة قابلة للمراجعة.'
    ))) return;

    const reversalId = `supplier_pay_${genId()}`;
    const reversal: SupplierPayment = {
      id: reversalId,
      supplierId: payment.supplierId,
      supplierName: payment.supplierName,
      amount: -payment.amount,          // قيدٌ مضادّ: المال عاد إلينا
      date: todayISO(),                 // تاريخ **التراجع** — حدثٌ وقع اليوم
      method: payment.method || CASH_METHOD,
      branchId: payment.branchId || stampBranchId,
      notes: `تراجُع عن تسديد ${formatCurrency(payment.amount, currency, exchangeRate)}${payment.notes ? ` — ${payment.notes}` : ''}`,
      allocations: allocations.map(a => ({ invoiceId: a.invoiceId, amount: -a.amount })),
      createdAt: Date.now(),
      createdByUid: actor.uid,
      createdByName: actor.name,
      reversalOfId: payment.id,
    };

    const batch = writeBatch(db);
    batch.set(doc(db, 'users', ownerUid, 'supplier_payments', reversalId), reversal);
    batch.update(doc(db, 'users', ownerUid, 'supplier_payments', payment.id), markReversedUpdate(reversalId));
    for (const allocation of allocations) {
      const invoice = invoices.find(i => i.id === allocation.invoiceId);
      if (!invoice || invoice.status !== 'received') continue;
      const restoredRemaining = remainingOf(asAllocatable(invoice)) + allocation.amount;
      batch.update(doc(db, 'users', ownerUid, 'purchase_invoices', invoice.id), {
        ...invoicePaymentUpdate(asAllocatable(invoice), -allocation.amount),
        // 🟡 كان يُكتب 'partial' دائماً ولو عاد المتبقّي إلى كامل الفاتورة
        paymentType: restoredRemaining >= (invoice.total ?? 0) ? 'credit' : 'partial',
      });
    }
    batch.update(doc(db, 'users', ownerUid, 'suppliers', payment.supplierId), { balance: increment(payment.amount) });
    batch.commit().catch(err => console.error('[Supplier payment undo] sync:', err));

    void logAudit({ action: 'cancel', entity: 'supplier_payment', entityId: payment.id, summary: `تراجع عن تسديد للمورد ${payment.supplierName} — ${formatCurrency(payment.amount, currency, exchangeRate)}`, before: payment as unknown as Record<string, unknown>, after: reversal as unknown as Record<string, unknown>, actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name, relatedEntity: 'supplier', relatedEntityId: payment.supplierId });
    notify('تم التراجع ✅ عادت الذمة والفواتير، والقيدان يبقيان في السجل.');
  };

  return <div className="space-y-5" dir="rtl">
    {confirmDialog}
    <div className="bg-[#0B1F4D] text-white p-6 rounded-2xl border-b-4 border-amber-400">
      <div className="flex items-center gap-2 text-amber-300 text-xs font-bold"><Truck className="w-4 h-4" /> قسم آجل الموردين</div>
      <h2 className="text-xl font-extrabold mt-2 flex items-center gap-2"><Banknote className="w-6 h-6 text-amber-400" /> الذمم والتسديدات للموردين</h2>
      <p className="text-xs text-slate-300 mt-2">سجّل كل تسديد واربطه تلقائياً بأقدم فواتير الشراء، مع سجل قابل للمراجعة والإلغاء.</p>
    </div>
    {alert && <div className={`rounded-xl px-4 py-3 text-xs font-bold ${alert.bad ? 'bg-rose-50 border border-rose-200 text-rose-700' : 'bg-emerald-50 border border-emerald-200 text-emerald-700'}`}>{alert.text}</div>}
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
      <div className="bg-white rounded-2xl p-4 border border-slate-200"><span className="text-xs text-slate-500 font-bold">إجمالي ما عليك لهم</span><p className="mt-2 text-xl text-rose-600 font-black">{formatCurrency(totalDebt, currency, exchangeRate)}</p></div>
      <div className="bg-white rounded-2xl p-4 border border-slate-200"><span className="text-xs text-slate-500 font-bold">موردون لهم ذمم</span><p className="mt-2 text-xl text-[#0B1F4D] font-black">{toArabicDigits(debtors.length)}</p></div>
      {/* 🟠 المال الذي لك عند مورّديك — لم تكن تعرضه أي شاشة */}
      <div className="bg-white rounded-2xl p-4 border border-slate-200"><span className="text-xs text-slate-500 font-bold">رصيدك عند الموردين</span><p className="mt-2 text-xl text-emerald-600 font-black">{formatCurrency(totalCredit, currency, exchangeRate)}</p></div>
      <div className="bg-white rounded-2xl p-4 border border-slate-200"><span className="text-xs text-slate-500 font-bold">تسديدات مسجلة</span><p className="mt-2 text-xl text-emerald-600 font-black">{toArabicDigits(payments.length)}</p></div>
    </div>
    {creditors.length > 0 && (
      <div className="bg-white rounded-2xl border border-emerald-200 overflow-hidden">
        <div className="p-4 border-b border-emerald-100 bg-emerald-50/50 flex items-center gap-2 font-extrabold text-emerald-800">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" /> لك عندهم — دفعتَ زيادةً عن المستحق
        </div>
        <div className="divide-y divide-slate-100">
          {creditors.map(s => (
            <div key={s.id} className="p-4 flex items-center justify-between gap-3">
              <div>
                <p className="font-extrabold text-[#0B1F4D]">{s.name}</p>
                <p className="text-xs text-slate-400 mt-1">{s.phone || 'بدون رقم هاتف'} — يُحسم من مشترياتك القادمة</p>
              </div>
              <span className="font-black text-emerald-600">{formatCurrency(Math.abs(s.balance), currency, exchangeRate)}</span>
            </div>
          ))}
        </div>
      </div>
    )}
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="p-4 border-b border-slate-100 flex items-center gap-2 font-extrabold text-[#0B1F4D]"><Clock className="w-4 h-4 text-amber-500" /> الذمم المفتوحة</div>
      {loading ? <p className="p-8 text-center text-sm text-slate-400">جارِ التحميل…</p> : debtors.length === 0 ? <p className="p-8 text-center text-sm text-slate-400">لا توجد ذمم مفتوحة للموردين.</p> : <div className="divide-y divide-slate-100">{debtors.map(s => <div key={s.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"><div><p className="font-extrabold text-[#0B1F4D]">{s.name}</p><p className="text-xs text-slate-400 mt-1">{s.phone || 'بدون رقم هاتف'}</p></div><div className="flex items-center gap-3"><span className="font-black text-rose-600">{formatCurrency(s.balance, currency, exchangeRate)}</span><button onClick={() => openPayment(s)} className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold">تسجيل تسديد</button></div></div>)}</div>}
    </div>
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden"><div className="p-4 border-b border-slate-100 flex items-center gap-2 font-extrabold text-[#0B1F4D]"><History className="w-4 h-4 text-emerald-600" /> آخر التسديدات</div>{payments.length === 0 ? <p className="p-6 text-center text-sm text-slate-400">لا توجد تسديدات مسجلة بعد.</p> : <div className="divide-y divide-slate-100">{payments.slice().sort((a,b) => b.createdAt-a.createdAt).slice(0,10).map(p => {
      // الطرفان يظهران دائماً — الإحصاء يستثني والتاريخ لا يُخفي
      const done = isReversed(p);
      const counter = isReversal(p);
      return <div key={p.id} className={`p-4 flex items-center justify-between gap-3 ${done || counter ? 'bg-slate-50/70' : ''}`}>
        <div>
          <p className={`font-bold text-[#0B1F4D] ${done ? 'line-through decoration-slate-400' : ''}`}>
            {p.supplierName}
            {done && <span className="mr-2 text-[9px] font-extrabold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 no-underline inline-block">متراجَع عنه</span>}
            {counter && <span className="mr-2 text-[9px] font-extrabold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 inline-block">قيد مضادّ</span>}
          </p>
          <p className="text-xs text-slate-400 mt-1">{formatDate(p.date)}{p.method ? ` — ${p.method}` : ''}{p.notes ? ` — ${p.notes}` : ''}</p>
        </div>
        <div className="flex gap-2 items-center">
          <span className={`font-black ${done || counter ? 'text-slate-400' : 'text-emerald-600'}`}>{formatCurrency(Math.abs(p.amount), currency, exchangeRate)}</span>
          {!done && !counter && p.amount > 0 && (
            <button onClick={() => undoPayment(p)} title="يُسجَّل قيد مضادّ — والتسديد يبقى في السجل"
              className="text-xs font-bold text-rose-600 hover:bg-rose-50 px-2 py-1 rounded cursor-pointer">تراجع</button>
          )}
        </div>
      </div>;
    })}</div>}</div>
    {selected && <div className="fixed inset-0 z-[9998] bg-slate-900/50 flex items-center justify-center p-4" onClick={() => !saving && setSelected(null)}><form onSubmit={submitPayment} onClick={e => e.stopPropagation()} className="bg-white rounded-2xl w-full max-w-lg p-5 space-y-4 shadow-2xl"><div className="flex justify-between items-center"><div><h3 className="font-extrabold text-[#0B1F4D]">تسديد للمورد: {selected.name}</h3><p className="text-xs text-rose-600 mt-1">المستحق: {formatCurrency(Math.max(0, liveSelected?.balance ?? 0), currency, exchangeRate)}</p></div><button type="button" onClick={() => setSelected(null)}><X className="w-5 h-5 text-slate-400" /></button></div><div className="bg-amber-50 rounded-xl p-3 text-xs text-amber-800"><FileText className="inline w-4 h-4 ml-1" /> سيُوزّع التسديد على أقدم الفواتير غير المسددة ({toArabicDigits(selectedInvoices.length)} فاتورة).</div>{/* لا min/max هنا: الحقل نصّي ليقبل الأرقام العربية، والسمتان بلا أثر عليه — الحماية في فحص الحفظ */}<label className="block text-xs font-bold text-[#0B1F4D]">مبلغ التسديد<input autoFocus type="text" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} className="mt-1.5 w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></label><label className="block text-xs font-bold text-[#0B1F4D]">طريقة الدفع<select value={method} onChange={e => setMethod(e.target.value)} className="mt-1.5 w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm bg-white cursor-pointer">{allPaymentMethods(customPaymentMethods).map(m => <option key={m} value={m}>{m}</option>)}</select>{!isCashMethod(method) && <span className="block mt-1 text-[10px] font-bold text-blue-700">💳 لن يُخصم من نقد الدرج في تقفيل الصندوق{isMultiBranch ? ` — يُسجَّل على ${branchName(stampBranchId)}` : ''}</span>}</label><label className="block text-xs font-bold text-[#0B1F4D]">التاريخ<input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1.5 w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></label><label className="block text-xs font-bold text-[#0B1F4D]">ملاحظة (اختياري)<input value={notes} onChange={e => setNotes(e.target.value)} className="mt-1.5 w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm" /></label><button disabled={saving} className="w-full py-3 bg-[#0B1F4D] disabled:opacity-50 text-white rounded-xl text-sm font-extrabold flex justify-center gap-2"><Save className="w-4 h-4" />{saving ? 'جارِ الحفظ…' : 'حفظ التسديد'}</button></form></div>}
  </div>;
}
