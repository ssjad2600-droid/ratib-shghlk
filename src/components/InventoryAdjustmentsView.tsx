import React, { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Boxes, ClipboardList, History, PackageSearch, Plus, Save, X, Barcode, Undo2 } from 'lucide-react';
import { doc, runTransaction, writeBatch, increment, getDocFromServer, deleteField } from 'firebase/firestore';
import { db } from '../firebase';
import { useCollection } from '../hooks/useCollection';
import { useSession } from '../context/SessionContext';
import { useActor } from '../hooks/useActor';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { Product, StockAdjustment, StockAdjustmentType, ExpiryBatch } from '../types';
import { toArabicDigits } from '../utils/arabicFormatters';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { logAudit } from '../utils/auditLog';
import { useBranches } from '../hooks/useBranches';
import { stockUpdate, stockUpdateSeeded, stockOf } from '../utils/branchStock';
import { readAmount } from '../utils/amountField';
import { canReverse, isReversed, isReversal, markReversedUpdate, reversalReason } from '../utils/reversal';
import { useConfirm } from '../hooks/useConfirm';
import { useProductCosts } from '../hooks/useProductCosts';
import { formatCurrency } from '../utils/arabicFormatters';
import { adjustmentStats } from '../utils/adjustmentStats';
import { reportFirestoreError } from '../utils/writeGuard';

const TYPE_OPTIONS: Array<{ value: StockAdjustmentType; label: string; direction: 'out' | 'recount' | 'both' }> = [
  { value: 'damage', label: 'تلف / كسر', direction: 'out' },
  { value: 'expiry', label: 'انتهاء صلاحية', direction: 'out' },
  { value: 'theft', label: 'سرقة أو فقدان', direction: 'out' },
  { value: 'gift', label: 'هدية أو عينة', direction: 'out' },
  { value: 'return_to_supplier', label: 'مرتجع إلى المورد', direction: 'out' },
  { value: 'recount', label: 'جرد فعلي', direction: 'recount' },
  { value: 'other', label: 'سبب آخر', direction: 'both' },
];

const typeLabel = (type: StockAdjustmentType) => TYPE_OPTIONS.find(item => item.value === type)?.label ?? 'سبب آخر';

interface Props { currency: 'IQD' | 'USD'; exchangeRate: number; }

// كانت العملة تُستقبَل وتُهمَل تماماً — فشاشة الخسائر لا تعرض ديناراً واحداً
export default function InventoryAdjustmentsView({ currency, exchangeRate }: Props) {
  const { items: products } = useCollection<Product>('products');
  const { items: adjustments, loading } = useCollection<StockAdjustment>('stock_adjustments');
  // شحنات الصلاحية تُقرأ هنا لسببٍ واحد: شطبُ شحنةٍ منتهية يُنشئ تسويةً، فالتراجع عنها
  // يجب أن **يُعيد فتح الشحنة** أيضاً — وإلا عادت البضاعة للمخزون وشاشة الصلاحية تقول «مشطوبة».
  const { items: expiryBatches } = useCollection<ExpiryBatch>('expiry_batches');
  const { ownerUid } = useSession();
  const { requestConfirm, confirmDialog } = useConfirm();
  const actor = useActor();
  const { isOnline } = useNetworkStatus();
  const { activeBranchId, stampBranchId, isMultiBranch, branchName, matchesActiveBranch } = useBranches(); // التسوية تخصّ فرعاً محدّداً
  const { buyPriceOf } = useProductCosts();
  const money = (n: number) => formatCurrency(n, currency, exchangeRate);
  const [showForm, setShowForm] = useState(false);
  const [productId, setProductId] = useState('');
  const [type, setType] = useState<StockAdjustmentType>('recount');
  const [quantity, setQuantity] = useState('');
  const [direction, setDirection] = useState<'add' | 'subtract'>('subtract');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayISO());
  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState<{ text: string; bad?: boolean } | null>(null);

  const selectedProduct = products.find(product => product.id === productId);
  const selectedType = TYPE_OPTIONS.find(item => item.value === type)!;

  /**
   * 🔴 السجل والإحصاءات تتبع الفرع النشط.
   *
   * كانت تقرأ **كل** التسويات بلا تصفية، فمبدّل الفروع أعلى الشاشة بلا أثر هنا: تختار
   * «المخزن» فترى خسائر المحل معه. و`matchesActiveBranch` يطبّق قاعدة النوع نفسها
   * (غياب الفرع = الرئيسي)، فالسجلات القديمة تُنسب للرئيسي ولا تختفي.
   */
  const branchAdjustments = useMemo(
    () => adjustments.filter(matchesActiveBranch),
    [adjustments, matchesActiveBranch],
  );
  const recent = useMemo(
    () => [...branchAdjustments].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30),
    [branchAdjustments],
  );
  // الخسارة بالوحدات **وبالدينار** — والتكلفة المجهولة تُستثنى لا تُحتسب صفراً
  const stats = useMemo(
    () => adjustmentStats(branchAdjustments, products, buyPriceOf),
    [branchAdjustments, products, buyPriceOf],
  );

  const notify = (text: string, bad = false) => { setAlert({ text, bad }); setTimeout(() => setAlert(null), 5000); };

  /**
   * 🔴 التراجع عن تسوية — بقيدٍ مضادّ مربوط، لا بحذف.
   *
   * لماذا هذا بندٌ يمسّ المال: من كتب «تلف ١٠٠» وهو يقصد ١٠ كان يصحّحها بـ«إضافة ٩٠»،
   * فتُسجَّل خسارة ١٠٠ وإضافة ٩٠، وبطاقة «قيمة الخسارة» تعرض ثمن ١٠٠ قطعة إلى الأبد
   * (والإضافة لا تُخصم من الخسارة عمداً — فالإضافة الحقيقية حدثٌ مستقلّ). الآن يُختم
   * القيدان معاً فيسقطان من الحساب، ويبقيان ظاهرَين في السجل للمراجعة.
   *
   * والمخزون يعود **بفارق** عبر increment لا بقيمة مطلقة — فيبقى صحيحاً ولو باع موظف
   * من نفس المادة في اللحظة نفسها، ويعمل أوفلاين.
   */
  const [reversingId, setReversingId] = useState('');
  const reverseAdjustment = async (original: StockAdjustment) => {
    if (!ownerUid || reversingId) return;

    const check = canReverse(original);
    if (!check.ok) return notify(check.reason, true);

    const product = products.find(p => p.id === original.productId);
    if (!product) {
      return notify(`«${original.productName}» لم يعد موجوداً — لا يمكن إعادة مخزونٍ لمادة محذوفة.`, true);
    }

    const branch = original.branchId || stampBranchId;
    const delta = -(original.quantityDelta ?? 0);   // القيد المضادّ: عكس الفارق تماماً
    if (delta === 0) return notify('هذا القيد بلا فارق — لا شيء للتراجع عنه.', true);

    const before = stockOf(product, branch);
    const after = before + delta;
    if (after < 0) {
      return notify(
        `التراجع سيخصم ${toArabicDigits(Math.abs(delta))} من «${product.name}» في ${branchName(branch)}،`
        + ` والمتوفّر ${toArabicDigits(before)} فقط — سيصير الرصيد سالباً. بِيعت البضاعة بعد التسوية غالباً،`
        + ' فصحّح الرصيد بجردٍ فعلي بدل التراجع.',
        true,
      );
    }

    // شحنة صلاحية شُطبت بهذه التسوية؟ تُعاد إلى «سارية» مع عودة بضاعتها.
    const linkedBatch = expiryBatches.find(b => b.writtenOffAdjustmentId === original.id);

    const ok = await requestConfirm(
      `التراجع عن هذه التسوية؟\n\n`
      + `«${original.productName}» — ${typeLabel(original.type)}: ${original.quantityDelta > 0 ? '+' : ''}${toArabicDigits(original.quantityDelta)}\n`
      + `سيُسجَّل قيدٌ مضادّ (${delta > 0 ? '+' : ''}${toArabicDigits(delta)}) فيعود رصيد ${branchName(branch)}`
      + ` من ${toArabicDigits(before)} إلى ${toArabicDigits(after)}.\n\n`
      + `القيد الأصلي لا يُحذف — يبقى في السجل مختوماً «متراجَع عنه»، ويسقط الاثنان من حساب الخسائر.`
      + (linkedBatch ? `\n\nوستعود شحنة الصلاحية المرتبطة إلى «سارية».` : ''),
    );
    if (!ok) return;

    setReversingId(original.id);
    try {
      const reversalId = `adjust_${genId()}`;
      const reversal: StockAdjustment = {
        id: reversalId,
        productId: product.id,
        productName: product.name,
        quantityDelta: delta,
        quantityBefore: before,
        quantityAfter: after,
        type: original.type,          // نوع الحدث الأصلي يبقى — التراجع لا يخترع سبباً جديداً
        reason: reversalReason(original.reason),
        date: todayISO(),             // تاريخ **التراجع** لا تاريخ الأصل: هذا حدثٌ وقع اليوم
        createdAt: Date.now(),
        createdByUid: actor.uid,
        createdByName: actor.name,
        branchId: branch,
        reversalOfId: original.id,
      };

      const batch = writeBatch(db);
      batch.update(doc(db, 'users', ownerUid, 'products', product.id), stockUpdateSeeded(product, delta, branch));
      batch.set(doc(db, 'users', ownerUid, 'stock_adjustments', reversalId), reversal);
      batch.update(doc(db, 'users', ownerUid, 'stock_adjustments', original.id), markReversedUpdate(reversalId));
      if (linkedBatch) {
        batch.update(doc(db, 'users', ownerUid, 'expiry_batches', linkedBatch.id), {
          status: 'active', writtenOffAdjustmentId: deleteField(),
        });
      }
      batch.commit().catch(err => reportFirestoreError('stock_adjustments', 'batch', err, '[Stock adjustment] reversal'));

      void logAudit({
        action: 'cancel', entity: 'stock_adjustment', entityId: original.id,
        summary: `تراجع عن تسوية: ${original.productName} (${original.quantityDelta > 0 ? '+' : ''}${original.quantityDelta}) — ${typeLabel(original.type)}`,
        before: original as unknown as Record<string, unknown>,
        after: reversal as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
        relatedEntity: 'product', relatedEntityId: product.id,
      });

      notify(
        `تم التراجع ✅ رصيد «${product.name}» في ${branchName(branch)}: ${toArabicDigits(before)} ← ${toArabicDigits(after)}`
        + `. القيدان يبقيان في السجل وقد سقطا من حساب الخسائر.`
        + (linkedBatch ? ' وأُعيدت شحنة الصلاحية إلى «سارية».' : ''),
      );
    } finally { setReversingId(''); }
  };

  // ---- قراءة الباركود لاختيار المادة (بدل التنقّل في قائمة طويلة) ----
  const [barcodeVal, setBarcodeVal] = useState('');
  const [barcodeError, setBarcodeError] = useState(false);
  const barcodeRef = useRef<HTMLInputElement | null>(null);
  const handleBarcodeScan = () => {
    const code = barcodeVal.trim();
    if (!code) return;
    const found = products.find(p => p.barcode === code);
    if (!found) {
      setBarcodeError(true);
      setTimeout(() => setBarcodeError(false), 700);
      notify(`لا يوجد منتج بهذا الباركود [${toArabicDigits(code)}]`, true);
      setBarcodeVal('');
      barcodeRef.current?.focus();
      return;
    }
    setProductId(found.id);
    setBarcodeVal('');
    barcodeRef.current?.focus();
  };

  const resetForm = () => { setProductId(''); setType('recount'); setQuantity(''); setDirection('subtract'); setReason(''); setDate(todayISO()); setBarcodeVal(''); };
  const openForm = () => { resetForm(); setShowForm(true); setTimeout(() => barcodeRef.current?.focus(), 120); };

  const calculateDelta = () => {
    const read = readAmount(quantity);
    if (read.state !== 'ok' || read.value < 0) return null;
    const value = read.value;
    if (!selectedProduct) return null;
    if (selectedType.direction === 'recount') return value - stockOf(selectedProduct, stampBranchId);
    return direction === 'add' ? value : -value;
  };
  const previewDelta = calculateDelta();

  const saveAdjustment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !ownerUid || !selectedProduct) return notify('اختر المنتج أولاً.', true);
    if (!reason.trim()) return notify('اكتب سبب التسوية بوضوح ليبقى السجل قابلاً للمراجعة.', true);
    // 🔴 `Number('')` يساوي صفراً لا NaN — فكانت الخانة الفارغة تمرّ كأنها «صفر»، وفي
    // «الجرد الفعلي» معناها «رصيد المادة صفر» ⇒ يُمحى المخزون كله. الفراغ الآن يُرفض صراحةً.
    const readQty = readAmount(quantity);
    if (readQty.state !== 'ok' || readQty.value < 0) {
      return notify(readQty.state === 'empty' ? 'اكتب الكمية أولاً.' : 'أدخل كمية صحيحة.', true);
    }
    const inputQuantity = readQty.value;
    const adjustmentId = `adjust_${genId()}`;
    const isRecount = selectedType.direction === 'recount';

    // ---- المسار (أ): تسوية بكمية معروفة مسبقاً (تلف/سرقة/صلاحية/هدية/مرتجع/أخرى) ----
    // تعمل **أوفلاين**: نخصم/نضيف بالفارق عبر increment (تحويل ذرّي على الخادم) فيتراكم صحيحاً
    // حتى لو باع موظف من نفس المادة في اللحظة نفسها. لا تحتاج قراءة حيّة لأن الفارق معروف.
    if (!isRecount) {
      const delta = direction === 'add' ? inputQuantity : -inputQuantity;
      if (delta === 0) return notify('لا يوجد فرق لتسجيله في التسوية.', true);
      // حارس بأفضل جهد من النسخة المحلية (قد تكون أقدم من الخادم بلحظات عند العمل أوفلاين)
      // المقارنة بمخزون **الفرع النشط** لا بالإجمالي — التسوية تخصّ فرعاً محدّداً
      const before = stockOf(selectedProduct, stampBranchId);
      const after = before + delta;
      if (after < 0) return notify(`لا يمكن أن يصبح الرصيد سالباً. المتوفر حالياً: ${toArabicDigits(before)}.`, true);

      const adjustment: StockAdjustment = {
        id: adjustmentId,
        productId: selectedProduct.id,
        productName: selectedProduct.name,
        quantityDelta: delta,
        quantityBefore: before,   // لقطة متوقّعة وقت التسجيل (الفارق نفسه هو المصدر الموثوق)
        quantityAfter: after,
        type,
        reason: reason.trim(),
        date,
        createdAt: Date.now(),
        createdByUid: actor.uid,
        createdByName: actor.name,
        // 🔴 الفرع إلزامي هنا كما في مسار الجرد. كان غائباً، ونوع البيانات يقول
        // «غيابه = الرئيسي» — فكانت خسارة المخزن تُسجَّل على المحل: المخزون يخرج من
        // مكان والدفتر يقول مكاناً آخر. وهذه المسارات (تلف/سرقة/صلاحية) هي الغالبة.
        branchId: stampBranchId,
      };
      setSaving(true);
      try {
        const batch = writeBatch(db);
        batch.update(doc(db, 'users', ownerUid, 'products', selectedProduct.id), stockUpdate(delta, stampBranchId));
        batch.set(doc(db, 'users', ownerUid, 'stock_adjustments', adjustmentId), adjustment);
        // fire-and-forget: يُطبَّق محلياً فوراً ويتزامن تلقائياً عند عودة الاتصال
        batch.commit().catch(err => reportFirestoreError('stock_adjustments', 'batch', err, '[Stock adjustment] sync'));
        void logAudit({
          action: 'create', entity: 'stock_adjustment', entityId: adjustment.id,
          summary: `تسوية مخزون: ${adjustment.productName} (${adjustment.quantityDelta > 0 ? '+' : ''}${adjustment.quantityDelta}) — ${typeLabel(adjustment.type)}`,
          after: adjustment as unknown as Record<string, unknown>,
          actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
          relatedEntity: 'product', relatedEntityId: adjustment.productId,
        });
        notify(isOnline
          ? 'تم حفظ تسوية المخزون وتحديث الرصيد مع سجل مراجعة كامل.'
          : 'تم حفظ التسوية محلياً وتحديث الرصيد — ستُرسل تلقائياً عند عودة الإنترنت.');
        setShowForm(false);
      } finally { setSaving(false); }
      return;
    }

    /**
     * ---- المسار (ب): الجرد الفعلي — يتطلّب رصيداً من **الخادم** بالضرورة ----
     *
     * حساب الفارق يعتمد على الرصيد الحقيقي لحظتها. لو نُفّذ على رقم قديم في الذاكرة
     * (بينما باع موظف قطعاً لم تصل بعد) لأفسد المخزون بدل إصلاحه.
     *
     * 🔴 والحارس القديم `if (!isOnline)` كان يُخدَع، وأثبتُّه بالقياس لا بالظنّ:
     *   · `navigator.onLine` يبقى `true` مع راوتر يعمل واشتراك مقطوع
     *   · و`runTransaction` **لا يفشل** عندها — بل يقرأ من الذاكرة المحلية ويُكمل
     *     (جرّبتُها: قرأت ٥٠ وكتبت بنجاح والشبكة مقطوعة)
     *   · و`syncState` يبقى `'synced'` لأن لا حدث `offline` يقع أصلاً
     *   · و`snapshot.metadata.fromCache` تعود `false` في الحالتين — لا تصلح إشارةً
     *
     * الإشارة الصادقة الوحيدة: قراءة تفرض الخادم. `getDocFromServer` ترمي
     * `[code=unavailable]` حين لا نفاذ حقيقي مهما قال المتصفح — فنمنع عندها بوضوح.
     */
    setSaving(true);
    try {
      const productRef = doc(db, 'users', ownerUid, 'products', selectedProduct.id);
      let serverSnap;
      try {
        serverSnap = await getDocFromServer(productRef);
      } catch {
        setSaving(false);
        return notify(
          isOnline
            ? 'تعذّر الوصول إلى الخادم رغم أن الجهاز يبدو متصلاً (شبكة بلا إنترنت غالباً). '
              + 'الجرد الفعلي يحتاج قراءة الرصيد الحقيقي — تحقّق من الاتصال ثم أعد المحاولة. '
              + 'باقي أنواع التسوية (تلف/سرقة/صلاحية...) تعمل بدون إنترنت.'
            : 'الجرد الفعلي يحتاج اتصالاً بالإنترنت ليقرأ الرصيد الحقيقي ويحسب الفرق بدقّة. '
              + 'باقي أنواع التسوية (تلف/سرقة/صلاحية...) تعمل بدون إنترنت.',
          true,
        );
      }
      if (!serverSnap.exists()) {
        setSaving(false);
        return notify('المنتج لم يعد موجوداً. حدّث الشاشة ثم حاول مجدداً.', true);
      }

      const saved = await runTransaction(db, async transaction => {
        const current = await transaction.get(productRef);
        if (!current.exists()) throw new Error('المنتج لم يعد موجوداً. حدّث الشاشة ثم حاول مجدداً.');
        const currentProduct = { ...current.data(), id: current.id } as Product;
        // الجرد يقارن بمخزون **الفرع النشط** الحقيقي (لا بالإجمالي عبر الفروع)
        const branchBefore = stockOf(currentProduct, stampBranchId);
        const delta = selectedType.direction === 'recount'
          ? inputQuantity - branchBefore
          : direction === 'add' ? inputQuantity : -inputQuantity;
        const after = branchBefore + delta;
        if (after < 0) throw new Error(`لا يمكن أن يصبح الرصيد سالباً. المتوفر حالياً: ${branchBefore}.`);
        if (delta === 0) throw new Error('لا يوجد فرق لتسجيله في التسوية.');
        const adjustment: StockAdjustment = {
          id: adjustmentId,
          productId: currentProduct.id,
          productName: currentProduct.name,
          quantityDelta: delta,
          quantityBefore: branchBefore,
          quantityAfter: after,
          type,
          reason: reason.trim(),
          date,
          createdAt: Date.now(),
          createdByUid: actor.uid,
          createdByName: actor.name,
          branchId: stampBranchId,
        };
        // الإجمالي وخريطة الفرع معاً — القراءة الحيّة تضمن الدقّة والذرّية تضمن الاتساق
        transaction.update(productRef, {
          quantity: (currentProduct.quantity ?? 0) + delta,
          [`branchStock.${stampBranchId}`]: after,
        });
        transaction.set(doc(db, 'users', ownerUid, 'stock_adjustments', adjustmentId), adjustment);
        return adjustment;
      });
      void logAudit({ action: 'create', entity: 'stock_adjustment', entityId: saved.id, summary: `تسوية مخزون: ${saved.productName} (${saved.quantityDelta > 0 ? '+' : ''}${saved.quantityDelta}) — ${typeLabel(saved.type)}`, after: saved as unknown as Record<string, unknown>, actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name, relatedEntity: 'product', relatedEntityId: saved.productId });
      /**
       * 🔴 نذكر الفارق **المطبَّق فعلاً** لا المعروض في المعاينة.
       *
       * المعاينة تحسب من النسخة المحلية، والمعاملة من القراءة الحيّة. فلو بيعت قطع بين
       * فتح النموذج والحفظ اختلف الرقمان — وكانت الرسالة تقول «تم» بلا رقم، فيخرج التاجر
       * ظاناً أنه سجّل ما رآه.
       */
      const drifted = previewDelta !== null && previewDelta !== saved.quantityDelta;
      notify(
        `تم حفظ التسوية: ${saved.quantityDelta > 0 ? '+' : ''}${toArabicDigits(saved.quantityDelta)}`
        + ` — الرصيد ${toArabicDigits(saved.quantityBefore)} ← ${toArabicDigits(saved.quantityAfter)}`
        + (drifted ? ` (تغيّر المخزون أثناء التسجيل، فالفارق حُسب على الرصيد الحقيقي)` : ''),
        drifted,
      );
      setShowForm(false);
    } catch (error) {
      console.error('[Stock adjustment]', error);
      notify(error instanceof Error ? error.message : 'تعذر حفظ التسوية. تحقق من الاتصال ثم حاول مجدداً.', true);
    } finally { setSaving(false); }
  };

  return <div className="space-y-5" dir="rtl">
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-[#0B1F4D] text-white p-6 rounded-2xl border-b-4 border-amber-400">
      <div><div className="text-xs text-amber-300 font-bold flex items-center gap-2"><ClipboardList className="w-4 h-4" /> سجل دقيق لحركة الجرد</div><h2 className="text-xl font-extrabold mt-2 flex gap-2 items-center"><Boxes className="w-6 h-6 text-amber-400" /> تسوية المخزون</h2><p className="text-xs text-slate-300 mt-2">لا تعدّل الرصيد مباشرة: وثّق التلف والجرد والسرقة والهدية وكل فرق في الكمية.</p></div>
      <button onClick={openForm} className="px-4 py-2.5 bg-amber-500 hover:bg-amber-400 rounded-xl text-slate-950 text-xs font-extrabold flex gap-1.5 items-center self-start md:self-center"><Plus className="w-4 h-4" /> تسوية جديدة</button>
    </div>
    {alert && <div className={`px-4 py-3 rounded-xl text-xs font-bold ${alert.bad ? 'bg-rose-50 text-rose-700 border border-rose-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}>{alert.text}</div>}
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div className="bg-white p-4 rounded-2xl border border-slate-200"><span className="text-xs text-slate-500 font-bold">التسويات المسجلة{isMultiBranch ? ` — ${activeBranchId ? branchName(activeBranchId) : 'كل الفروع'}` : ''}</span><p className="text-xl text-[#0B1F4D] font-black mt-2">{toArabicDigits(stats.count)}</p></div>
      <div className="bg-white p-4 rounded-2xl border border-slate-200">
        <span className="text-xs text-slate-500 font-bold">قيمة الخسارة (بسعر الشراء)</span>
        <p className="text-xl text-rose-600 font-black mt-2">{money(stats.lostValue)}</p>
        <p className="text-[10px] text-slate-500 font-bold mt-1">{toArabicDigits(stats.lostUnits)} وحدة مخصومة{stats.addedUnits > 0 ? ` · ${toArabicDigits(stats.addedUnits)} مضافة` : ''}</p>
        {stats.unknownCostCount > 0 && <p className="text-[10px] text-amber-700 font-bold mt-1 leading-relaxed">⚠️ {toArabicDigits(stats.unknownCostUnits)} وحدة بلا سعر شراء — قيمتها غير محتسبة</p>}
        {stats.reversedCount > 0 && <p className="text-[10px] text-slate-500 font-bold mt-1 leading-relaxed">{toArabicDigits(stats.reversedCount)} قيد متراجَع عنه — مستثنى من الحساب وظاهر في السجل</p>}
      </div>
      <div className="bg-white p-4 rounded-2xl border border-slate-200"><span className="text-xs text-slate-500 font-bold">أصناف متاحة للتسوية</span><p className="text-xl text-emerald-600 font-black mt-2">{toArabicDigits(products.length)}</p></div>
    </div>
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden"><div className="p-4 border-b border-slate-100 font-extrabold text-[#0B1F4D] flex items-center gap-2"><History className="w-4 h-4 text-amber-700" /> سجل التسويات</div>{loading ? <p className="p-8 text-center text-sm text-slate-500">جارِ التحميل…</p> : recent.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">لا توجد تسويات مسجلة. استخدم «تسوية جديدة» عند وجود فرق في المخزون.</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-[#0B1F4D]"><tr><th className="p-3 text-right">التاريخ</th><th className="p-3 text-right">المنتج</th><th className="p-3 text-right">السبب</th><th className="p-3 text-center">قبل</th><th className="p-3 text-center">التغيير</th><th className="p-3 text-center">بعد</th><th className="p-3 text-right">ملاحظة</th><th className="p-3 text-center">تراجع</th></tr></thead><tbody>{recent.map(item => {
      // القيد المتراجَع عنه وقيدُه المضادّ **يظهران** — الإحصاء يستثني والتاريخ لا يُخفي
      const done = isReversed(item);
      const counter = isReversal(item);
      return <tr key={item.id} className={`border-t border-slate-100 ${done || counter ? 'bg-slate-50/70' : ''}`}><td className="p-3 text-xs text-slate-500">{new Date(`${item.date}T00:00:00`).toLocaleDateString('ar-IQ')}</td><td className={`p-3 font-bold text-[#0B1F4D] ${done ? 'line-through decoration-slate-400' : ''}`}>{item.productName}</td><td className="p-3"><span className="bg-amber-50 text-amber-800 rounded px-2 py-1 text-xs font-bold">{typeLabel(item.type)}</span>{done && <span className="block mt-1 text-[11px] font-extrabold text-slate-500">متراجَع عنه</span>}{counter && <span className="block mt-1 text-[11px] font-extrabold text-indigo-600">قيد مضادّ</span>}</td><td className="p-3 text-center">{toArabicDigits(item.quantityBefore)}</td><td className={`p-3 text-center font-black ${done || counter ? 'text-slate-500' : item.quantityDelta < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{item.quantityDelta > 0 ? '+' : ''}{toArabicDigits(item.quantityDelta)}</td><td className="p-3 text-center font-bold">{toArabicDigits(item.quantityAfter)}</td><td className="p-3 text-xs text-slate-500">{item.reason}</td><td className="p-3 text-center">{done || counter ? <span className="text-[11px] font-bold text-slate-500">—</span> : <button type="button" onClick={() => reverseAdjustment(item)} disabled={!!reversingId} title="يُسجَّل قيد مضادّ ويعود المخزون — والقيد يبقى في السجل" className="px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-[#0B1F4D] hover:border-[#0B1F4D] disabled:opacity-40 text-[10px] font-extrabold cursor-pointer inline-flex items-center gap-1"><Undo2 className="w-3 h-3" /> تراجع</button>}</td></tr>;
    })}</tbody></table></div>}</div>
    {showForm && <div className="fixed inset-0 z-[9998] bg-slate-900/50 flex items-center justify-center p-4" onClick={() => !saving && setShowForm(false)}><form onSubmit={saveAdjustment} onClick={event => event.stopPropagation()} className="bg-white w-full max-w-xl rounded-2xl p-5 space-y-4 shadow-2xl"><div className="flex items-center justify-between"><div><h3 className="font-extrabold text-[#0B1F4D]">تسجيل تسوية مخزون</h3><p className="text-xs text-slate-400 mt-1">سيحفظ الرصيد قبل وبعد التعديل تلقائياً.</p></div><button type="button" onClick={() => setShowForm(false)}><X className="w-5 h-5 text-slate-400" /></button></div><div className={`p-3 rounded-2xl border-2 transition-colors ${barcodeError ? 'bg-rose-50 border-rose-400 animate-pulse' : 'bg-indigo-50/60 border-indigo-200'}`}><label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5 flex items-center gap-1.5"><Barcode className="w-4 h-4 text-indigo-600" /><span>قراءة الباركود 🔍</span><span className="text-[11px] font-bold text-slate-400 mr-auto">جهاز القارئ أو كتابة يدوية + Enter</span></label><input ref={barcodeRef} type="text" value={barcodeVal} onChange={e => setBarcodeVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleBarcodeScan(); } }} placeholder="اقرأ باركود المادة لاختيارها..." dir="ltr" autoComplete="off" className={`w-full px-3 py-2.5 bg-white border rounded-xl text-sm text-center font-mono font-bold tracking-widest outline-none focus:ring-2 ${barcodeError ? 'border-rose-300 focus:ring-rose-400 text-rose-700' : 'border-indigo-200 focus:ring-indigo-400 text-[#0B1F4D]'}`} /></div><label className="block text-xs font-bold text-[#0B1F4D]">المنتج<select value={productId} onChange={event => setProductId(event.target.value)} required className="mt-1.5 w-full p-2.5 border border-slate-200 rounded-xl bg-white"><option value="">— اختر منتجاً —</option>{products.map(product => <option key={product.id} value={product.id}>{product.name} (المتوفر: {stockOf(product, stampBranchId)})</option>)}</select></label>{selectedProduct && <div className="bg-slate-50 rounded-xl p-3 text-xs text-slate-600"><PackageSearch className="inline w-4 h-4 ml-1 text-emerald-600" /> الرصيد الحالي: <b>{toArabicDigits(stockOf(selectedProduct, stampBranchId))} {selectedProduct.unit || 'وحدة'}</b></div>}<label className="block text-xs font-bold text-[#0B1F4D]">نوع التسوية<select value={type} onChange={event => { const value = event.target.value as StockAdjustmentType; setType(value); if (value !== 'other') setDirection('subtract'); setQuantity(''); }} className="mt-1.5 w-full p-2.5 border border-slate-200 rounded-xl bg-white">{TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>{selectedType.direction === 'both' && <div className="flex gap-2"><button type="button" onClick={() => setDirection('subtract')} className={`flex-1 py-2 rounded-xl text-xs font-bold ${direction === 'subtract' ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-600'}`}>خصم من المخزون</button><button type="button" onClick={() => setDirection('add')} className={`flex-1 py-2 rounded-xl text-xs font-bold ${direction === 'add' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}>إضافة إلى المخزون</button></div>}<label className="block text-xs font-bold text-[#0B1F4D]">{selectedType.direction === 'recount' ? 'الكمية الفعلية بعد الجرد' : 'الكمية'}<input type="text" inputMode="decimal" min="0" step="any" value={quantity} onChange={event => setQuantity(event.target.value)} required className="mt-1.5 w-full p-2.5 border border-slate-200 rounded-xl" /></label>{previewDelta !== null && selectedProduct && <div className={`rounded-xl p-3 text-xs font-bold ${previewDelta < 0 ? 'bg-rose-50 text-rose-700' : previewDelta > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-500'}`}>التغيير الذي سيُسجل: {previewDelta > 0 ? '+' : ''}{toArabicDigits(previewDelta)} — الرصيد المتوقع: {toArabicDigits(stockOf(selectedProduct, stampBranchId) + previewDelta)}</div>}<label className="block text-xs font-bold text-[#0B1F4D]">السبب والتفاصيل<textarea value={reason} onChange={event => setReason(event.target.value)} required rows={2} placeholder="مثال: كسر 5 قطع أثناء النقل" className="mt-1.5 w-full p-2.5 border border-slate-200 rounded-xl resize-none" /></label><label className="block text-xs font-bold text-[#0B1F4D]">التاريخ<input type="date" value={date} onChange={event => setDate(event.target.value)} className="mt-1.5 w-full p-2.5 border border-slate-200 rounded-xl" /></label>{!isOnline && selectedType.direction === 'recount' && <div className="bg-rose-50 text-rose-700 border border-rose-200 text-xs rounded-xl p-3 font-bold"><AlertTriangle className="inline w-4 h-4 ml-1" /> أنت غير متصل بالإنترنت. «الجرد الفعلي» يحتاج اتصالاً ليقرأ الرصيد الحقيقي ويحسب الفرق بدقّة — اختر نوعاً آخر (تلف/سرقة/صلاحية...) فهي تعمل بدون إنترنت.</div>}{!isOnline && selectedType.direction !== 'recount' && <div className="bg-blue-50 text-blue-800 border border-blue-200 text-xs rounded-xl p-3 font-bold"><AlertTriangle className="inline w-4 h-4 ml-1" /> غير متصل — ستُحفظ التسوية على جهازك ويُحدَّث الرصيد فوراً، وتُرسل تلقائياً عند عودة الإنترنت.</div>}<div className="bg-amber-50 text-amber-800 text-xs rounded-xl p-3"><AlertTriangle className="inline w-4 h-4 ml-1" /> لا يمكن أن تجعل التسوية رصيد المنتج سالباً، وتُسجل العملية مع اسم المنفذ للمراجعة.</div><button disabled={saving} className="w-full py-3 rounded-xl bg-[#0B1F4D] text-white disabled:opacity-50 font-extrabold text-sm flex items-center justify-center gap-2"><Save className="w-4 h-4" />{saving ? 'جارِ الحفظ…' : 'حفظ التسوية'}</button></form></div>}
    {confirmDialog}
  </div>;
}
