import { useMemo, useState } from 'react';
import NumberInput from './NumberInput';
import {
  CalendarX2, Plus, X, Save, AlertTriangle, Info, Trash2, Search, Wallet, PackageX, Clock, CheckCircle2, HelpCircle, } from 'lucide-react';
import { doc } from 'firebase/firestore';
import { newBatch, updateDoc } from '../utils/firestoreWrite';
import { db } from '../firebase';
import { useCollection } from '../hooks/useCollection';
import { useSession } from '../context/SessionContext';
import { useActor } from '../hooks/useActor';
import { useProductCosts } from '../hooks/useProductCosts';
import { useBranches } from '../hooks/useBranches';
import { useConfirm } from '../hooks/useConfirm';
import { Product, ExpiryBatch, StockAdjustment, SystemSettings } from '../types';
import { toArabicDigits, formatCurrency } from '../utils/arabicFormatters';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { logAudit } from '../utils/auditLog';
import { stockUpdate, stockOf } from '../utils/branchStock';
import { buildBatchRows, expirySummary, STAGE_LABEL, ExpiryStage, isStaleExpired } from '../utils/expiry';
import { readAmountOr } from '../utils/amountField';
import { reportFirestoreError } from '../utils/writeGuard';

interface Props {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  settings: SystemSettings;
}

const STAGE_STYLE: Record<ExpiryStage, { chip: string; card: string; dot: string }> = {
  expired: { chip: 'bg-rose-600 text-white border-rose-600', card: 'border-rose-300 bg-rose-50/50', dot: 'bg-rose-600' },
  act: { chip: 'bg-amber-50 text-amber-800 border-amber-300', card: 'border-amber-200 bg-amber-50/40', dot: 'bg-amber-500' },
  watch: { chip: 'bg-yellow-50 text-yellow-800 border-yellow-200', card: 'border-slate-200 bg-white', dot: 'bg-yellow-400' },
  ok: { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', card: 'border-slate-200 bg-white', dot: 'bg-emerald-500' },
};

export default function ExpiryView({ currency, exchangeRate, settings }: Props) {
  const { ownerUid } = useSession();
  const actor = useActor();
  const { requestConfirm, confirmDialog } = useConfirm();
  const { items: products, save: saveProduct } = useCollection<Product>('products');
  const { items: batches, save: saveBatch, remove: removeBatch } = useCollection<ExpiryBatch>('expiry_batches');
  const { buyPriceOf } = useProductCosts();
  const { activeBranchId, stampBranchId, matchesActiveBranch, isMultiBranch, branchName } = useBranches();

  const [showForm, setShowForm] = useState(false);
  const [productId, setProductId] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [receivedDate, setReceivedDate] = useState(todayISO());
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<ExpiryStage | 'all'>('all');
  const [alert, setAlert] = useState<{ text: string; bad?: boolean } | null>(null);
  const notify = (text: string, bad = false) => { setAlert({ text, bad }); setTimeout(() => setAlert(null), 6000); };

  const money = (v: number) => formatCurrency(v, currency, exchangeRate);
  const today = todayISO();

  const branchBatches = useMemo(() => batches.filter(matchesActiveBranch), [batches, matchesActiveBranch]);

  // 🔴 نمرّر قارئ المخزون كي تُحسب الكمية الحيّة لكل شحنة — بدونه تُحسب بضاعة بِيعت خطراً
  const rows = useMemo(
    () => buildBatchRows(
      branchBatches, products, buyPriceOf, today, settings.categoryExpiryAlertDays,
      (productId, branchId) => {
        const prod = products.find(p => p.id === productId);
        return prod ? stockOf(prod, branchId || stampBranchId) : 0;
      },
    ),
    [branchBatches, products, buyPriceOf, today, settings.categoryExpiryAlertDays, stampBranchId],
  );
  const summary = useMemo(() => expirySummary(rows), [rows]);

  /**
   * الشحنات المنتهية منذ أكثر من شهرين تُطوى افتراضياً.
   * كانت تبقى في القائمة والعدّاد إلى الأبد، فينمو «منتهية» ولا ينقص حتى يفقد معناه.
   * لا تُحذف — زرّ واحد يُظهرها، فلا شيء يختفي بصمت.
   */
  const [showStale, setShowStale] = useState(false);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter(r => showStale || !isStaleExpired(r))
      .filter(r => stageFilter === 'all' || r.status.stage === stageFilter)
      .filter(r => !q || r.batch.productName.toLowerCase().includes(q));
  }, [rows, stageFilter, search, showStale]);

  const selectedProduct = products.find(p => p.id === productId);

  const resetForm = () => {
    setProductId(''); setExpiryDate(''); setReceivedDate(todayISO()); setQuantity(''); setNote('');
  };

  const handleSave = async () => {
    if (saving || !ownerUid) return;
    if (!selectedProduct) { notify('اختر المادة', true); return; }
    if (!expiryDate) { notify('تاريخ الانتهاء مطلوب', true); return; }
    if (receivedDate && expiryDate <= receivedDate) {
      notify('تاريخ الانتهاء يجب أن يكون بعد تاريخ الاستلام', true); return;
    }
    const qty = readAmountOr(quantity, 0) ?? 0;
    if (qty <= 0) { notify('الكمية يجب أن تكون أكبر من صفر', true); return; }

    // 🔴 شحنة أكبر من الرصيد تُضخّم «بضاعة على الخطر» بلا وجه حق — ننبّه ولا نمنع
    // (قد يسجّل التاجر شحنةً وصلت ولم يُدخلها المخزون بعد).
    const branchStockNow = stockOf(selectedProduct, stampBranchId);
    if (qty > branchStockNow) {
      const ok = await requestConfirm(
        `الكمية المسجَّلة (${toArabicDigits(qty)}) أكبر من رصيد «${selectedProduct.name}» `
        + `في ${branchName(stampBranchId)} (${toArabicDigits(branchStockNow)}).\n\n`
        + `إن لم تكن أدخلت هذه الشحنة للمخزون بعد فهذا طبيعي. وإلا فراجع الرقم — `
        + `الزائد لن يُحتسب في قيمة البضاعة المعرّضة للخطر.\n\nهل تريد المتابعة؟`,
      );
      if (!ok) return;
    }

    setSaving(true);
    try {
      const batch: ExpiryBatch = {
        id: `exp_${genId()}`,
        productId: selectedProduct.id,
        productName: selectedProduct.name,
        expiryDate,
        receivedDate,
        quantity: qty,
        note: note.trim(),
        branchId: stampBranchId,
        status: 'active',
        createdAt: Date.now(),
        createdByName: actor.name,
      };
      await saveBatch(batch);

      // 🔴 التعلّم: أول تاريخ يُدخله المستخدم لمادة يجعل البرنامج يسأله عنها في كل استلام
      // قادم تلقائياً. لا استجواب مسبق ولا مفتاح تشغيل — يتعلّم من الفعل.
      if (selectedProduct.tracksExpiry !== true && ownerUid) {
        // 🔴 حقل واحد بـ`updateDoc` — لا استبدال للوثيقة من لقطة محلية. الاستبدال كان
        // يُرجع أي بضاعة بيعت بين فتح الشاشة وتسجيل تاريخ الصلاحية.
        updateDoc(doc(db, 'users', ownerUid, 'products', selectedProduct.id), { tracksExpiry: true })
          .catch(err => reportFirestoreError('products', 'update', err, '[Firestore] tracksExpiry'));
      }

      void logAudit({
        action: 'create', entity: 'product', entityId: batch.id,
        summary: `تسجيل شحنة صلاحية: ${batch.productName} — ${toArabicDigits(qty)} تنتهي ${toArabicDigits(expiryDate)}`,
        after: batch as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
        relatedEntity: 'product', relatedEntityId: selectedProduct.id,
      });

      notify('سُجّلت الشحنة ✅' + (selectedProduct.tracksExpiry !== true ? ' — وسيسألك البرنامج عن تاريخها في كل استلام قادم' : ''));
      setShowForm(false);
      resetForm();
    } finally { setSaving(false); }
  };

  /**
   * شطب التالف — يمرّ عبر «تسوية المخزون» القائمة لا عبر طريق ثانٍ.
   * فينقص المخزون فعلياً، ويظهر في سجل التسويات والتقارير، ويُوثَّق في سجل التدقيق.
   * الشحنة تُغلق ولا تُحذف — أثرها يبقى مربوطاً بالتسوية.
   */
  const writeOff = async (rowIdx: number) => {
    const row = visible[rowIdx];
    if (!row || !ownerUid) return;
    const product = row.product;
    if (!product) { notify('المادة محذوفة — لا يمكن شطب مخزون غير موجود', true); return; }

    const branch = row.batch.branchId || stampBranchId;
    const before = stockOf(product, branch);
    const qty = Math.min(row.batch.quantity, before); // لا نُنقص أكثر ممّا في الرصيد فعلاً
    if (qty <= 0) {
      notify(`رصيد «${product.name}» في ${branchName(branch)} صفر — لا شيء لشطبه. أغلق الشحنة يدوياً إن أردت.`, true);
      return;
    }

    const ok = await requestConfirm(
      `شطب ${toArabicDigits(qty)} من «${product.name}» كتالف منتهي الصلاحية؟\n\n` +
      `سينقص مخزون ${branchName(branch)} من ${toArabicDigits(before)} إلى ${toArabicDigits(before - qty)}،` +
      ` وتُسجَّل تسوية مخزون بالسبب «منتهي الصلاحية» في السجل الدائم.` +
      (qty < row.batch.quantity ? `\n\nملاحظة: الشحنة ${toArabicDigits(row.batch.quantity)} لكن الرصيد ${toArabicDigits(before)} — سيُشطب المتوفّر فقط.` : ''),
    );
    if (!ok) return;

    const adjId = `adj_${genId()}`;
    const adjustment: StockAdjustment = {
      id: adjId,
      productId: product.id,
      productName: product.name,
      quantityDelta: -qty,
      quantityBefore: before,
      quantityAfter: before - qty,
      type: 'expiry',
      reason: `انتهاء صلاحية — شحنة تنتهي ${row.batch.expiryDate}${row.batch.note ? ` (${row.batch.note})` : ''}`,
      date: today,
      createdAt: Date.now(),
      createdByUid: actor.uid,
      createdByName: actor.name,
      branchId: branch,
    };

    // دفعة ذرّية: خصم المخزون + تسجيل التسوية + إغلاق الشحنة — لا تنفصل أبداً
    const wb = newBatch();
    wb.update(doc(db, 'users', ownerUid, 'products', product.id), stockUpdate(-qty, branch));
    wb.set(doc(db, 'users', ownerUid, 'stock_adjustments', adjId), adjustment);
    wb.update(doc(db, 'users', ownerUid, 'expiry_batches', row.batch.id), {
      status: 'written_off', writtenOffAdjustmentId: adjId,
    });
    wb.commit().catch(err => reportFirestoreError('expiry_batches', 'batch', err, '[Expiry] write-off'));

    void logAudit({
      action: 'create', entity: 'stock_adjustment', entityId: adjId,
      summary: `شطب تالف (صلاحية): ${product.name} — ${toArabicDigits(qty)} من ${branchName(branch)}`,
      after: adjustment as unknown as Record<string, unknown>,
      actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
      relatedEntity: 'product', relatedEntityId: product.id,
    });

    notify(`شُطبت ${toArabicDigits(qty)} من «${product.name}» ونقص المخزون ✅`);
  };

  const deleteBatch = async (id: string, name: string) => {
    const ok = await requestConfirm(`حذف شحنة «${name}»؟\n\nهذا حذف للسجل فقط — لا يغيّر المخزون إطلاقاً.`);
    if (!ok) return;
    const snapshot = batches.find(b => b.id === id); // لقطة قبل الاختفاء
    await removeBatch(id);
    // 🔴 التسجيل والشطب كانا يُوثَّقان والحذف لا — وهو بالضبط ما وُجد السجل لأجله:
    // مَن محا هذا القيد ومتى. والقيد المحذوف لا يُسترجَع إلا من هنا.
    void logAudit({
      action: 'delete', entity: 'product', entityId: id,
      summary: `حذف سجل شحنة صلاحية: ${name}`
        + (snapshot ? ` — ${toArabicDigits(snapshot.quantity)} تنتهي ${toArabicDigits(snapshot.expiryDate)}` : ''),
      before: snapshot as unknown as Record<string, unknown>,
      actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
      ...(snapshot ? { relatedEntity: 'product' as const, relatedEntityId: snapshot.productId } : {}),
    });
    notify('حُذفت الشحنة (المخزون لم يتغيّر)');
  };

  const Card = ({ label, value, hint, tone, icon: Icon }: {
    label: string; value: string; hint?: string; tone: string; icon: typeof CalendarX2;
  }) => (
    <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm p-4">
      <div className="flex items-center gap-1.5">
        <Icon className={`w-4 h-4 ${tone}`} />
        <span className="text-[10px] text-slate-600 font-bold">{label}</span>
      </div>
      <span className={`text-base font-extrabold block mt-1.5 ${tone}`}>{value}</span>
      {hint && <span className="text-[11px] text-slate-500 font-bold block mt-0.5 leading-relaxed">{hint}</span>}
    </div>
  );

  return (
    <div className="space-y-5 font-tajawal" dir="rtl">
      {confirmDialog}

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-[#0B1F4D] text-white p-6 rounded-2xl border-b-4 border-amber-400">
        <div>
          <div className="flex items-center gap-2 text-slate-300 text-xs font-bold font-cairo">
            <CalendarX2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>بضاعة يفسدها الوقت</span>
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2 flex-wrap">
            <CalendarX2 className="w-6 h-6 text-amber-400" />
            <span>الصلاحية ⏳</span>
            {isMultiBranch && (
              <span className="text-[10px] font-extrabold px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-200 border border-amber-400/40">
                🏢 {activeBranchId ? branchName(activeBranchId) : 'كل الفروع'}
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-300 mt-1 leading-relaxed max-w-3xl">
            البرنامج يحسب متى ينبّهك من <b>عمر المادة نفسها</b>: الخبز قبل يومين، والحليب قبل ١٣ يوماً،
            والدواء قبل ستة أشهر — بلا أن تضبط شيئاً.
          </p>
        </div>
        <button onClick={() => { resetForm(); setShowForm(true); }}
          className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-extrabold rounded-xl text-xs shadow flex items-center gap-1.5 cursor-pointer active:scale-95 self-start">
          <Plus className="w-4 h-4" /> <span>تسجيل شحنة</span>
        </button>
      </div>

      {alert && (
        <div className={`px-4 py-3 rounded-xl text-xs font-bold border ${alert.bad ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
          {alert.text}
        </div>
      )}

      {/* رقم الخطر بالدينار — هو ما يُحرّك التاجر لا عدد المواد */}
      {summary.atRiskCount > 0 && (
        <div className="p-5 rounded-2xl bg-gradient-to-l from-rose-50 to-white border-2 border-rose-200">
          <div className="flex items-center gap-1.5">
            <Wallet className="w-4 h-4 text-rose-700" />
            <span className="text-[11px] text-rose-800 font-extrabold">بضاعة على وشك أن تُرمى</span>
          </div>
          <span className="text-2xl font-extrabold text-rose-700 block mt-1.5">{money(summary.atRiskValue)}</span>
          <span className="text-[10px] text-slate-600 font-bold block mt-1 leading-relaxed">
            في {toArabicDigits(summary.atRiskCount)} شحنة — منتهية أو يجب تصريفها الآن.
            {summary.unknownCostCount > 0 && ` (${toArabicDigits(summary.unknownCostCount)} منها بلا سعر شراء مسجَّل فقيمتها غير محتسبة)`}
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card icon={PackageX} tone="text-rose-700" label="منتهية" value={toArabicDigits(summary.expiredCount)} hint="ارفعها من الرف اليوم" />
        <Card icon={AlertTriangle} tone="text-amber-700" label="صرّفها الآن" value={toArabicDigits(summary.actCount)} hint="نزّل السعر أو أعِدها للمورّد" />
        <Card icon={Clock} tone="text-yellow-700" label="راقبها" value={toArabicDigits(summary.watchCount)} hint="ضعها في مقدّمة الرف" />
        {/* 🔴 من `summary` كأخواتها — كانت تُحسب من `rows` الخام فتعدّ شحنات نفد رصيدها
            ومنتهية متقادمة. ثلاث بطاقات مصفّاة ورابعة لا ⇒ أرقام لا تجمع. */}
        <Card icon={CheckCircle2} tone="text-emerald-700" label="سليمة" value={toArabicDigits(summary.okCount)} />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute right-2.5 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ابحث عن مادة…"
            className="w-full pr-8 pl-2 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold outline-none" />
        </div>
        {(['all', 'expired', 'act', 'watch', 'ok'] as const).map(s => (
          <button key={s} onClick={() => setStageFilter(s)}
            className={`px-3 py-2 rounded-xl text-[11px] font-extrabold cursor-pointer border ${
              stageFilter === s ? 'bg-[#0B1F4D] text-white border-[#0B1F4D]' : 'bg-white text-slate-600 border-slate-200'
            }`}>
            {s === 'all' ? 'الكل' : STAGE_LABEL[s]}
          </button>
        ))}
        {/* لا شيء يختفي بصمت: القديمة مطويّة وزرّها يقول عددها */}
        {summary.staleCount > 0 && (
          <button onClick={() => setShowStale(v => !v)}
            className={`px-3 py-2 rounded-xl text-[11px] font-extrabold cursor-pointer border ${
              showStale ? 'bg-slate-700 text-white border-slate-700' : 'bg-white text-slate-500 border-slate-200'
            }`}>
            {showStale ? 'إخفاء' : 'إظهار'} المنتهية منذ زمن ({toArabicDigits(summary.staleCount)})
          </button>
        )}
      </div>

      <div className="space-y-2">
        {visible.length === 0 ? (
          <div className="p-10 text-center bg-white rounded-2xl border border-[#E4EAF3]">
            <Info className="w-6 h-6 text-slate-400 mx-auto mb-2" />
            <p className="text-xs font-bold text-slate-500">
              {rows.length === 0
                ? 'لا شحنات مسجّلة بعد — سجّل أول شحنة لمادة لها صلاحية، وسيتذكّرها البرنامج في كل استلام قادم'
                : 'لا نتائج بهذا الفلتر'}
            </p>
          </div>
        ) : visible.map((r, i) => {
          const st = STAGE_STYLE[r.status.stage];
          const d = r.status.daysLeft;
          return (
            <div key={r.batch.id} className={`rounded-2xl border-2 p-4 ${st.card}`}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`w-2 h-2 rounded-full ${st.dot}`} />
                    <span className="text-xs font-extrabold text-[#0B1F4D]">{r.batch.productName}</span>
                    <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${st.chip}`}>
                      {STAGE_LABEL[r.status.stage]}
                    </span>
                    {!r.product && (
                      <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">
                        المادة محذوفة
                      </span>
                    )}
                  </div>

                  <div className="mt-1.5 text-[11px] font-bold text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>تنتهي: <span className="font-mono">{toArabicDigits(r.batch.expiryDate)}</span></span>
                    <span className={d < 0 ? 'text-rose-700' : ''}>
                      {d < 0 ? `منتهية منذ ${toArabicDigits(Math.abs(d))} يوماً` : `بقي ${toArabicDigits(d)} يوماً`}
                      {r.status.lifeDays !== null && d >= 0 && (
                        <span className="text-slate-500"> من أصل {toArabicDigits(r.status.lifeDays)}</span>
                      )}
                    </span>
                    {/* الكمية الحيّة لا المسجَّلة — ونُظهر الأصل حين اختلفا كي لا يبدو نقصاً غامضاً */}
                    <span className={r.liveQuantity <= 0 ? 'text-slate-500' : ''}>
                      الكمية: {toArabicDigits(r.liveQuantity)}{r.product?.unit ? ` ${r.product.unit}` : ''}
                      {r.partiallySold && (
                        <span className="text-slate-500"> (سُجّلت {toArabicDigits(r.batch.quantity)} — بِيع الباقي)</span>
                      )}
                    </span>
                    {r.costKnown
                      ? <span className="text-rose-700">القيمة: {money(r.value)}</span>
                      : <span className="text-slate-500 flex items-center gap-1"><HelpCircle className="w-3 h-3" /> سعر الشراء غير مسجَّل</span>}
                  </div>

                  {/* شفافية القرار: لماذا نُبِّه الآن — فيفهم ولا يشكّ في البرنامج */}
                  <span className="text-[11px] text-slate-500 font-bold block mt-1">
                    حدّ التنبيه: {toArabicDigits(r.status.alert.days)} يوماً
                    {r.status.alert.origin === 'auto' && ' (محسوب تلقائياً من عمر المادة)'}
                    {r.status.alert.origin === 'category' && ' (ضبط الفئة)'}
                    {r.status.alert.origin === 'product' && ' (ضبط خاص بهذه المادة)'}
                    {r.status.alert.origin === 'default' && ' (بلا تاريخ استلام — افتراضي)'}
                    {r.batch.note ? ` · ${r.batch.note}` : ''}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {(r.status.stage === 'expired' || r.status.stage === 'act') && r.product && (
                    <button onClick={() => writeOff(i)}
                      className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-extrabold rounded-lg cursor-pointer flex items-center gap-1">
                      <PackageX className="w-3.5 h-3.5" /> شطب التالف
                    </button>
                  )}
                  <button onClick={() => deleteBatch(r.batch.id, r.batch.productName)} title="حذف السجل (لا يغيّر المخزون)"
                    className="p-2 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-rose-600 cursor-pointer">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-slate-600 font-bold leading-relaxed flex items-start gap-1.5">
        <Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
        <span>
          سجل الشحنات <b>لا يحسب مخزوناً</b> — يوثّق تاريخاً فقط، فلا يظهر لك رقمان متعارضان.
          و«شطب التالف» يمرّ عبر تسوية المخزون القائمة فينقص الرصيد فعلياً ويُسجَّل في سجل التدقيق.
          حذف السجل وحده لا يغيّر المخزون إطلاقاً.
        </span>
      </p>

      {/* نموذج تسجيل الشحنة */}
      {showForm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4" onClick={() => !saving && setShowForm(false)}>
          <div onClick={e => e.stopPropagation()} className="bg-white rounded-2xl w-full max-w-lg shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-5 bg-[#0B1F4D] text-white flex justify-between items-center">
              <h3 className="font-extrabold text-sm font-cairo flex items-center gap-1.5">
                <CalendarX2 className="w-5 h-5" /> تسجيل شحنة لها تاريخ انتهاء
              </h3>
              <button onClick={() => setShowForm(false)} className="p-1.5 hover:bg-white/10 rounded-lg cursor-pointer"><X className="w-4 h-4" /></button>
            </div>

            <div className="p-5 space-y-3">
              <label className="block">
                <span className="text-xs font-bold text-[#0B1F4D] block mb-1.5">المادة *</span>
                <select value={productId} onChange={e => setProductId(e.target.value)}
                  className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none cursor-pointer">
                  <option value="">— اختر مادة —</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>{p.name}{p.tracksExpiry ? ' ⏳' : ''}</option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-bold text-[#0B1F4D] block mb-1.5">تاريخ الاستلام</span>
                  <input type="date" value={receivedDate} onChange={e => setReceivedDate(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none" />
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-[#0B1F4D] block mb-1.5">تاريخ الانتهاء *</span>
                  <input type="date" value={expiryDate} onChange={e => setExpiryDate(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none" />
                </label>
              </div>

              <label className="block">
                <span className="text-xs font-bold text-[#0B1F4D] block mb-1.5">الكمية المستلمة *</span>
                <NumberInput inputMode="decimal" min="0" step="any" value={quantity} onValueChange={v => setQuantity(v)}
                  className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none" />
                <span className="text-[11px] text-slate-500 font-bold block mt-1">
                  لتقدير قيمة الخطر ولتجهيز كمية الشطب — <b>لا تُضاف إلى المخزون</b>
                </span>
              </label>

              <label className="block">
                <span className="text-xs font-bold text-[#0B1F4D] block mb-1.5">ملاحظة</span>
                <input type="text" value={note} onChange={e => setNote(e.target.value)}
                  placeholder="مثال: شحنة المورّد أبو أحمد"
                  className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-right outline-none" />
              </label>

              {selectedProduct && selectedProduct.tracksExpiry !== true && (
                <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-[10px] font-bold text-blue-900 leading-relaxed flex items-start gap-1.5">
                  <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>
                    أول تاريخ تُدخله لهذه المادة يجعل البرنامج يتذكّرها، فيسألك عن تاريخها
                    في كل استلام قادم تلقائياً. المواد التي لا يفسدها الوقت لا يسألك عنها أبداً.
                  </span>
                </div>
              )}

              <button onClick={handleSave} disabled={saving}
                className="w-full py-3 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-sm cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50">
                <Save className="w-4 h-4" /> {saving ? 'جارٍ الحفظ…' : 'حفظ الشحنة'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
