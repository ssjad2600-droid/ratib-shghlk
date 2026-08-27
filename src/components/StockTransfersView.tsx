import React, { useMemo, useRef, useState } from 'react';
import NumberInput from './NumberInput';
import {
  ArrowLeftRight, Plus, Save, X, Barcode, Trash, History, AlertTriangle,
  Store, Warehouse, PackageSearch, Wrench, Undo2,
} from 'lucide-react';
import { doc } from 'firebase/firestore';
import { newBatch } from '../utils/firestoreWrite';
import { db } from '../firebase';
import { useCollection } from '../hooks/useCollection';
import { useSession } from '../context/SessionContext';
import { useActor } from '../hooks/useActor';
import { useBranches, isWarehouse } from '../hooks/useBranches';
import { Product, StockTransfer, StockTransferItem, MAIN_BRANCH_ID } from '../types';
import { toArabicDigits } from '../utils/arabicFormatters';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { logAudit } from '../utils/auditLog';
import { transferUpdate, atBranch } from '../utils/stockTransfer';
import { readAmountOr } from '../utils/amountField';
import { mergeTransferLines, duplicateCount, shortagesOf } from '../utils/stockTransferLines';
import { allocateTransferNumber, duplicateTransferNumbers } from '../utils/transferNumber';
import { getDeviceTag } from '../utils/invoiceNumber';
import { canReverse, isReversed, isReversal, markReversedUpdate } from '../utils/reversal';
import { useConfirm } from '../hooks/useConfirm';
import { reportFirestoreError } from '../utils/writeGuard';

interface Line { key: string; productId: string; quantity: string }

const newLine = (): Line => ({ key: genId(), productId: '', quantity: '' });

/** أقصى ما يُعرض من نتائج دفعةً واحدة — القائمة الطويلة تُبطئ ولا تُفيد. */
const PICKER_LIMIT = 40;

/**
 * اختيار المادة بالبحث لا بالتمرير.
 *
 * 🟠 القائمة المنسدلة كانت تسرد **كل** المنتجات. صاحب المحل الصغير لا يلاحظ، وصاحب
 * الألفَي مادة لا يستطيع استعمال الشاشة أصلاً: يبحث بعينه في قائمة لا تُبحث. والباركود
 * يحلّ نصف المشكلة فقط — ومن لا قارئ عنده يبقى بلا حيلة.
 */
function ProductPicker({
  products, value, onChange,
}: {
  products: Product[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = products.find(p => p.id === value);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    const pool = q
      ? products.filter(p =>
          (p.name || '').toLowerCase().includes(q) || (p.barcode || '').includes(q))
      : products;
    return { shown: pool.slice(0, PICKER_LIMIT), total: pool.length };
  }, [products, q]);

  const pick = (id: string) => { onChange(id); setQuery(''); setOpen(false); };

  return (
    <div className="relative">
      <input
        type="text"
        value={open ? query : (selected?.name ?? '')}
        placeholder={selected ? selected.name : '— ابحث عن مادة —'}
        onFocus={() => { setQuery(''); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-right outline-none cursor-pointer focus:ring-2 focus:ring-[#0B1F4D]/20"
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg">
          {matches.shown.length === 0 ? (
            <div className="px-3 py-2.5 text-[10px] font-bold text-slate-500">لا مادة بهذا الاسم أو الباركود</div>
          ) : (
            <>
              {matches.shown.map(p => (
                <button key={p.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => pick(p.id)}
                  className={`w-full text-right px-3 py-2 text-[11px] font-bold hover:bg-slate-50 cursor-pointer border-b border-slate-50 last:border-0 ${p.id === value ? 'bg-slate-100 text-[#0B1F4D]' : 'text-slate-700'}`}>
                  {p.name}
                  {p.barcode ? <span className="text-[11px] font-mono text-slate-500 mr-2">{p.barcode}</span> : null}
                </button>
              ))}
              {matches.total > matches.shown.length && (
                <div className="px-3 py-2 text-[11px] font-bold text-slate-500 bg-slate-50">
                  يُعرض {toArabicDigits(matches.shown.length)} من {toArabicDigits(matches.total)} — تابع الكتابة لتضييق النتائج
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function StockTransfersView() {
  const { items: products } = useCollection<Product>('products');
  const { items: transfers, loading } = useCollection<StockTransfer>('stock_transfers');
  const { ownerUid, role } = useSession();
  const actor = useActor();
  const { branches, activeBranches, isMultiBranch, branchName, activeBranchId } = useBranches();
  /**
   * مواقع **المصدر**: الفعّالة + أي موقع معطَّل ما زال فيه رصيد.
   * فالتعطيل لا يحبس البضاعة، ولا يظهر المعطَّل الفارغ ليزحم القائمة.
   */
  const sourceBranches = useMemo(() => {
    const hasStock = (id: string) => products.some(p => (p.branchStock?.[id] ?? 0) !== 0);
    return branches.filter(b => b.active !== false || hasStock(b.id));
  }, [branches, products]);
  const { requestConfirm, confirmDialog } = useConfirm();

  const [showForm, setShowForm] = useState(false);
  const [fromBranch, setFromBranch] = useState(MAIN_BRANCH_ID);
  const [toBranch, setToBranch] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState<{ text: string; bad?: boolean } | null>(null);
  const notify = (text: string, bad = false) => { setAlert({ text, bad }); setTimeout(() => setAlert(null), 6000); };

  const productOf = (id: string) => products.find(p => p.id === id);

  // ---- قراءة الباركود لإضافة مادة بسرعة (نفس نمط بقية الشاشات) ----
  const [barcodeVal, setBarcodeVal] = useState('');
  const [barcodeError, setBarcodeError] = useState(false);
  const barcodeRef = useRef<HTMLInputElement | null>(null);
  const handleBarcodeScan = () => {
    const code = barcodeVal.trim();
    if (!code) return;
    const found = products.find(p => (p.barcode || '').trim() === code);
    if (!found) { setBarcodeError(true); setTimeout(() => setBarcodeError(false), 1500); setBarcodeVal(''); return; }
    setLines(prev => {
      const existing = prev.find(l => l.productId === found.id);
      if (existing) return prev.map(l => l.productId === found.id ? { ...l, quantity: String((readAmountOr(l.quantity, 0) ?? 0) + 1) } : l);
      const blank = prev.find(l => !l.productId);
      if (blank) return prev.map(l => l.key === blank.key ? { ...l, productId: found.id, quantity: '1' } : l);
      return [...prev, { key: genId(), productId: found.id, quantity: '1' }];
    });
    setBarcodeVal('');
    barcodeRef.current?.focus();
  };

  // ---- أرصدة سالبة: خلل حقيقي يحتاج تصحيحاً (بيع من موقع لم تُنقل إليه البضاعة) ----
  const negatives = useMemo(() => {
    const out: Array<{ product: Product; branchId: string; qty: number }> = [];
    for (const p of products) {
      for (const [bid, v] of Object.entries(p.branchStock ?? {})) {
        if ((v ?? 0) < 0) out.push({ product: p, branchId: bid, qty: v ?? 0 });
      }
    }
    return out;
  }, [products]);

  /** هل لهذه المادة فائضٌ في موقع آخر يمكن سحبه؟ (وإلا فالنقص كلّي لا توزيعي) */
  const surplusFor = (product: Product, exceptBranchId: string) =>
    Object.entries(product.branchStock ?? {})
      .filter(([bid, v]) => bid !== exceptBranchId && (v ?? 0) > 0)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];

  /**
   * يفتح النموذج مُعبّأً لتصحيح رصيد سالب: ننقل النقص من موقع فيه فائض.
   *
   * 🔴 وإن لم يكن للمادة فائضٌ في **أي** موقع، فالنقل يُفسد ولا يُصلح: يجعل الفرع الرئيسي
   * سالباً بدل هذا الفرع. لأن العجز حينها في **الكمية الكلية** لا في توزيعها، وعلاجه
   * تسوية مخزون لا نقلاً. فنقول ذلك بدل أن ننقل السالب من مكان إلى مكان.
   */
  const fixNegative = (product: Product, branchId: string, qty: number) => {
    const surplus = surplusFor(product, branchId);
    if (!surplus) {
      notify(
        `«${product.name}» ليس له رصيد موجب في أي موقع — النقص في الكمية الكلية لا في توزيعها. `
        + 'صحّحه من شاشة «تسوية المخزون» بجردٍ فعلي، فالنقل هنا ينقل السالب فقط.',
        true,
      );
      return;
    }
    setFromBranch(surplus[0]);
    setToBranch(branchId);
    setLines([{ key: genId(), productId: product.id, quantity: String(Math.abs(qty)) }]);
    setNotes(`تصحيح رصيد سالب في «${branchName(branchId)}»`);
    setShowForm(true);
  };

  const openCreate = () => {
    const first = activeBranches[0]?.id ?? MAIN_BRANCH_ID;
    const second = activeBranches.find(b => b.id !== first)?.id ?? '';
    setFromBranch(first); setToBranch(second);
    setLines([newLine()]); setNotes(''); setShowForm(true);
  };

  const totalQty = lines.reduce((s, l) => s + (readAmountOr(l.quantity, 0) ?? 0), 0);

  /**
   * مجموع المطلوب من كل مادة عبر كل الأسطر — كي يقيس التحذير ما يخرج فعلاً من المصدر.
   * سطران ٦٠ و٦٠ من رصيد ١٠٠ كانا يمرّان بلا تحذير لأن كلّاً منهما وحده كافٍ.
   */
  const requestedPerProduct = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) {
      if (!l.productId) continue;
      m.set(l.productId, (m.get(l.productId) ?? 0) + (readAmountOr(l.quantity, 0) ?? 0));
    }
    return m;
  }, [lines]);

  const dupProductIds = useMemo(() => {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const l of lines) {
      if (!l.productId) continue;
      if (seen.has(l.productId)) dups.add(l.productId);
      else seen.add(l.productId);
    }
    return dups;
  }, [lines]);

  const handleSave = async () => {
    if (saving || !ownerUid) return;
    if (!toBranch || fromBranch === toBranch) { notify('اختر موقعين مختلفين (من / إلى)', true); return; }
    // 🔴 الدمج **قبل** أي فحص أو كتابة. المادة المكرَّرة يدوياً كانت تمرّ من فحص الكفاية
    // (كل سطر يُقارن وحده بنفس الرصيد)، وتُسجَّل برصيدٍ سابقٍ واحد للسطرين، وتُنقل ناقصةً
    // للمنتج القديم بلا خريطة فروع. الدمج يُغلق الثلاثة معاً.
    const merged = mergeTransferLines(
      lines.map(l => ({ productId: l.productId, quantity: readAmountOr(l.quantity, 0) ?? 0 })),
    ).filter(l => productOf(l.productId));
    if (merged.length === 0) { notify('أضف مادة واحدة على الأقل بكمية أكبر من صفر', true); return; }
    const mergedCount = duplicateCount(
      lines.map(l => ({ productId: l.productId, quantity: readAmountOr(l.quantity, 0) ?? 0 }))
        .filter(l => l.quantity > 0 && productOf(l.productId)),
    );

    // تحذير غير مانع: النقل قد يجعل رصيد المصدر سالباً إن كان المخزون غير محدَّث.
    // لا نمنع — قد تكون البضاعة انتقلت فعلاً والبرنامج متأخّر عن الواقع.
    // الفحص على الكمية المدموجة — أي على ما يخرج فعلاً من المصدر، لا على كل سطر وحده.
    const shortages = shortagesOf(merged, id => {
      const p = productOf(id);
      return p ? atBranch(p, fromBranch) : null;
    }).map(s => {
      const name = productOf(s.productId)?.name ?? s.productId;
      return `«${name}»: مطلوب ${toArabicDigits(s.requested)} — متوفر ${toArabicDigits(s.available)}`;
    });

    setSaving(true);
    try {
      const items: StockTransferItem[] = merged.map(l => {
        const p = productOf(l.productId)!;
        return {
          productId: p.id, name: p.name, unit: p.unit || 'قطعة',
          quantity: l.quantity,
          fromBefore: atBranch(p, fromBranch),
          toBefore: atBranch(p, toBranch),
        };
      });

      const id = genId();
      const myTag = getDeviceTag(actor.uid);
      const rec: StockTransfer = {
        id,
        // 🔴 لا `transfers.length + 1`: طول القائمة المحلية يُصدر نفس الرقم من جهازين،
        // ويُعيد استعمال رقم المحذوف. التسلسل الآن من أعلى رقم مستعمل، موسوماً بالجهاز عند التعدّد.
        transferNumber: allocateTransferNumber(transfers, myTag),
        deviceTag: myTag,
        fromBranchId: fromBranch, fromBranchName: branchName(fromBranch),
        toBranchId: toBranch, toBranchName: branchName(toBranch),
        items,
        totalQuantity: items.reduce((s, it) => s + it.quantity, 0),
        date: todayISO(),
        createdAt: new Date().toISOString(),
        createdByUid: actor.uid, createdByName: actor.name,
        notes: notes.trim(),
      };

      // دفعة ذرّية واحدة: سجل النقل + تحديث خريطة كل منتج.
      // quantity لا يظهر في أي تحديث هنا — الإجمالي لا يتغيّر بالنقل الداخلي.
      const batch = newBatch();
      batch.set(doc(db, 'users', ownerUid, 'stock_transfers', id), rec);
      for (const it of items) {
        const p = productOf(it.productId)!;
        batch.update(doc(db, 'users', ownerUid, 'products', it.productId),
          transferUpdate(p, it.quantity, fromBranch, toBranch));
      }
      // Fire-and-forget: الكاش المحلي يطبّقها فوراً، والانتظار يُعلّق الشاشة أوفلاين
      batch.commit().catch(err => reportFirestoreError('stock_transfers', 'batch', err, '[Firestore] stock transfer'));

      void logAudit({
        action: 'create', entity: 'stock_transfer', entityId: id,
        summary: `نقل بضاعة من «${rec.fromBranchName}» إلى «${rec.toBranchName}» — ${toArabicDigits(rec.totalQuantity)} وحدة في ${toArabicDigits(items.length)} مادة`,
        after: rec as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
      });

      setShowForm(false);
      // الدمج لا يجري في صمت: التاجر كتب سطرين ورأى واحداً في السجل، فيُخبَر لماذا.
      const mergeNote = mergedCount > 0
        ? ` (دُمجت ${toArabicDigits(mergedCount)} مادة مكرَّرة في سطر واحد)`
        : '';
      notify(shortages.length > 0
        ? `تم النقل ⚠️ لكن الكمية تتجاوز رصيد المصدر: ${shortages.join(' | ')}${mergeNote}`
        : `تم نقل البضاعة ✅ الإجمالي لم يتغيّر — البضاعة تحرّكت بين موقعيك فقط${mergeNote}`,
        shortages.length > 0);
    } finally { setSaving(false); }
  };

  /**
   * السجل يتبع الموقع النشط: النقل له طرفان، فيظهر إن كان الموقع **أحدهما**.
   * ('' = كل المواقع ⇒ يظهر كل شيء، كما كان تماماً لصاحب الفرع الواحد.)
   */
  const branchTransfers = useMemo(
    () => activeBranchId
      ? transfers.filter(t => t.fromBranchId === activeBranchId || t.toBranchId === activeBranchId)
      : transfers,
    [transfers, activeBranchId],
  );

  const recent = useMemo(
    () => [...branchTransfers].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 30),
    [branchTransfers],
  );

  /** تكرار وقع قبل هذا الإصلاح: لا يُمنع بأثر رجعي، لكن السكوت عنه أسوأ من إظهاره. */
  const dupNumbers = useMemo(() => duplicateTransferNumbers(transfers), [transfers]);

  /**
   * 🔴 التراجع عن نقل — بنقلٍ معاكس مربوط، لا بحذف.
   *
   * التاجر ينقل ٥٠ إلى المخزن وهو يقصد ٥، فيجد نفسه أمام رصيدين خاطئين ولا سبيل إلا أن
   * يفهم اتجاه القيد ويعكسه بيده. ومن يخطئ في الاتجاه يُضاعف الخلل بدل إصلاحه.
   *
   * والحذف ليس حلّاً: النقل حدثٌ وقع، وإخفاؤه يُفسد التدقيق. فيبقى مختوماً «متراجَع عنه»
   * ويُولَد نقلٌ معاكسٌ مربوطٌ به — والمخزون يعود بـ`increment` على الطرفين، والإجمالي
   * لا يتغيّر لا في النقل ولا في عكسه.
   */
  const [reversingId, setReversingId] = useState('');
  const reverseTransfer = async (original: StockTransfer) => {
    if (!ownerUid || reversingId) return;

    const check = canReverse(original);
    if (!check.ok) return notify(check.reason, true);

    const missing = original.items.filter(it => !productOf(it.productId));
    if (missing.length > 0) {
      return notify(`مواد محذوفة لا يمكن إرجاعها: ${missing.map(m => `«${m.name}»`).join('، ')}`, true);
    }

    // العكس يسحب من الوجهة — فالنقص يُقاس هناك. تحذير غير مانع كما في النقل نفسه:
    // قد تكون البضاعة عادت فعلاً والبرنامج متأخّر عن الواقع.
    const shortages = original.items
      .map(it => {
        const p = productOf(it.productId)!;
        const have = atBranch(p, original.toBranchId);
        return it.quantity > have
          ? `«${p.name}»: مطلوب ${toArabicDigits(it.quantity)} — متوفر ${toArabicDigits(have)}`
          : null;
      })
      .filter(Boolean) as string[];

    const ok = await requestConfirm(
      `التراجع عن النقل ${original.transferNumber}؟\n\n`
      + `سيُسجَّل نقلٌ معاكس: من «${original.toBranchName}» إلى «${original.fromBranchName}»`
      + ` — ${toArabicDigits(original.totalQuantity)} وحدة في ${toArabicDigits(original.items.length)} مادة.\n\n`
      + `النقل الأصلي لا يُحذف: يبقى في السجل مختوماً «متراجَع عنه» ومربوطاً بالمعاكس.`
      + (shortages.length > 0
        ? `\n\n⚠️ الكمية تتجاوز رصيد ${original.toBranchName}: ${shortages.join(' | ')}`
        : ''),
    );
    if (!ok) return;

    setReversingId(original.id);
    try {
      const id = genId();
      const myTag = getDeviceTag(actor.uid);
      // الاتجاه معكوس، والأرصدة «قبل» تُلتقط الآن لا وقت النقل الأصلي
      const items: StockTransferItem[] = original.items.map(it => {
        const p = productOf(it.productId)!;
        return {
          productId: p.id, name: p.name, unit: p.unit || 'قطعة', quantity: it.quantity,
          fromBefore: atBranch(p, original.toBranchId),
          toBefore: atBranch(p, original.fromBranchId),
        };
      });

      const rec: StockTransfer = {
        id,
        transferNumber: allocateTransferNumber(transfers, myTag),
        deviceTag: myTag,
        fromBranchId: original.toBranchId, fromBranchName: original.toBranchName,
        toBranchId: original.fromBranchId, toBranchName: original.fromBranchName,
        items,
        totalQuantity: items.reduce((s, it) => s + it.quantity, 0),
        date: todayISO(),
        createdAt: new Date().toISOString(),
        createdByUid: actor.uid, createdByName: actor.name,
        notes: `تراجُع عن النقل ${original.transferNumber}${original.notes ? ` — ${original.notes}` : ''}`,
        reversalOfId: original.id,
      };

      const batch = newBatch();
      batch.set(doc(db, 'users', ownerUid, 'stock_transfers', id), rec);
      batch.update(doc(db, 'users', ownerUid, 'stock_transfers', original.id), markReversedUpdate(id));
      for (const it of items) {
        const p = productOf(it.productId)!;
        batch.update(doc(db, 'users', ownerUid, 'products', it.productId),
          transferUpdate(p, it.quantity, original.toBranchId, original.fromBranchId));
      }
      batch.commit().catch(err => reportFirestoreError('stock_transfers', 'batch', err, '[Firestore] transfer reversal'));

      void logAudit({
        action: 'cancel', entity: 'stock_transfer', entityId: original.id,
        summary: `تراجع عن نقل ${original.transferNumber}: أُعيدت ${toArabicDigits(original.totalQuantity)} وحدة من «${original.toBranchName}» إلى «${original.fromBranchName}»`,
        before: original as unknown as Record<string, unknown>,
        after: rec as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
      });

      notify(
        `تم التراجع ✅ أُعيدت ${toArabicDigits(rec.totalQuantity)} وحدة إلى «${original.fromBranchName}» بالنقل ${rec.transferNumber}`
        + (shortages.length > 0 ? ` ⚠️ لكن الكمية تجاوزت رصيد المصدر: ${shortages.join(' | ')}` : ''),
        shortages.length > 0,
      );
    } finally { setReversingId(''); }
  };

  const kindIcon = (id: string) =>
    isWarehouse(branches.find(b => b.id === id))
      ? <Warehouse className="w-3 h-3 text-indigo-600" />
      : <Store className="w-3 h-3 text-sky-600" />;

  if (role !== 'owner') return null;

  return (
    <div className="space-y-6 font-tajawal" dir="rtl">
      {/* رأس الشاشة */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-[#0B1F4D] text-white p-6 rounded-2xl border-b-4 border-amber-400">
        <div>
          <div className="flex items-center gap-2 text-slate-300 text-xs font-bold font-cairo">
            <ArrowLeftRight className="w-3.5 h-3.5 text-emerald-400" />
            <span>حركة البضاعة الداخلية</span>
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2">
            <ArrowLeftRight className="w-6 h-6 text-amber-400" />
            <span>نقل بضاعة بين المواقع 🔄</span>
          </h2>
          <p className="text-xs text-slate-300 mt-1 leading-relaxed">
            تسحب من مخزن وتضيف للمحل، أو بالعكس. <b>الإجمالي لا يتغيّر أبداً</b> —
            البضاعة لم تدخل ولم تخرج من ملكك، بل تحرّكت بين مواقعك. فأرباحك وتقاريرك لا تتأثّر.
          </p>
        </div>
        <button onClick={openCreate} disabled={!isMultiBranch}
          className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-extrabold rounded-xl text-xs shadow flex items-center gap-1.5 cursor-pointer active:scale-95 self-start">
          <Plus className="w-4 h-4" /> <span>نقل جديد</span>
        </button>
      </div>

      {alert && (
        <div className={`px-4 py-3 rounded-xl text-xs font-bold border ${alert.bad ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
          {alert.text}
        </div>
      )}

      {!isMultiBranch && (
        <div className="p-4 rounded-2xl border border-blue-200 bg-blue-50/70 flex items-start gap-2.5">
          <PackageSearch className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-blue-900 font-bold leading-relaxed">
            النقل يحتاج موقعين على الأقل. أضف <b>مخزناً</b> من شاشة «الفروع والمخازن»
            (مثل: مخزن الطابق الثاني)، ثم تعود هنا لتسحب منه إلى المحل.
          </p>
        </div>
      )}

      {/* أرقام نقلٍ مكرّرة وقعت قبل الإصلاح — تُعرض لتُراجَع لا لتُخفى */}
      {dupNumbers.length > 0 && (
        <div className="p-4 rounded-2xl border border-amber-200 bg-amber-50/70 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-700 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-900 font-bold leading-relaxed">
            أرقام نقلٍ متكرّرة في سجلك: {dupNumbers.map(d => `${d.number} (${toArabicDigits(d.count)} مرات)`).join(' · ')}.
            <br />
            حدثت حين كان الرقم يُحسب من عدد النقولات على كل جهاز. <b>لن تتكرّر بعد الآن</b> —
            النقولات الجديدة تأخذ تسلسلاً حرّاً موسوماً بالجهاز عند تعدّده. راجع الحركتين لتعرف أيّهما تقصد.
          </p>
        </div>
      )}

      {/* أرصدة سالبة — تصحيح بضغطة */}
      {negatives.length > 0 && (
        <div className="p-4 rounded-2xl border border-rose-200 bg-rose-50/70">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-rose-700" />
            <span className="text-xs font-extrabold text-rose-800">
              أرصدة سالبة ({toArabicDigits(negatives.length)}) — بِيعت من موقع لم تُنقل إليه البضاعة
            </span>
          </div>
          <div className="space-y-1.5">
            {negatives.map(n => (
              <div key={`${n.product.id}_${n.branchId}`} className="flex items-center justify-between gap-2 bg-white rounded-xl px-3 py-2 border border-rose-100">
                <span className="text-[11px] font-bold text-[#0B1F4D] truncate">
                  {n.product.name} — <span className="text-rose-700">{branchName(n.branchId)}: {toArabicDigits(n.qty)}</span>
                </span>
                <button onClick={() => fixNegative(n.product, n.branchId, n.qty)}
                  className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-extrabold rounded-lg cursor-pointer flex items-center gap-1 flex-shrink-0">
                  <Wrench className="w-3 h-3" /> تصحيح بنقل
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* سجل التحويلات */}
      <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-2">
          <History className="w-4 h-4 text-slate-500" />
          <span className="text-xs font-extrabold text-[#0B1F4D]">سجل التحويلات</span>
          {activeBranchId && (
            <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
              حركات {branchName(activeBranchId)} فقط
            </span>
          )}
          <span className="text-[10px] text-slate-600 font-bold mr-auto">آخر {toArabicDigits(recent.length)} عملية</span>
        </div>
        {loading ? (
          <div className="p-6 text-center text-xs text-slate-500 font-bold">جارٍ التحميل…</div>
        ) : recent.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500 font-bold flex flex-col items-center gap-2">
            <ArrowLeftRight className="w-6 h-6 text-slate-400" />
            <span>لا توجد تحويلات بعد</span>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {recent.map(t => {
              // الطرفان يظهران دائماً — التدقيق لا يُخفي حدثاً وقع
              const done = isReversed(t);
              const counter = isReversal(t);
              return (
              <div key={t.id} className={`px-5 py-3 ${done || counter ? 'bg-slate-50/70' : ''}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] font-mono font-extrabold text-slate-500 ${done ? 'line-through' : ''}`}>{t.transferNumber}</span>
                  {done && <span className="text-[11px] font-extrabold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">متراجَع عنه</span>}
                  {counter && <span className="text-[11px] font-extrabold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">نقل مضادّ</span>}
                  <span className="flex items-center gap-1 text-[11px] font-extrabold text-[#0B1F4D]">
                    {kindIcon(t.fromBranchId)} {t.fromBranchName}
                  </span>
                  <ArrowLeftRight className="w-3.5 h-3.5 text-amber-700" />
                  <span className="flex items-center gap-1 text-[11px] font-extrabold text-[#0B1F4D]">
                    {kindIcon(t.toBranchId)} {t.toBranchName}
                  </span>
                  <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 mr-auto">
                    {toArabicDigits(t.totalQuantity)} وحدة
                  </span>
                </div>
                <div className="mt-1.5 text-[10px] text-slate-600 font-bold leading-relaxed">
                  {t.items.map(it => `${it.name} (${toArabicDigits(it.quantity)} ${it.unit})`).join(' · ')}
                </div>
                <div className="mt-1 flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] text-slate-500 font-bold">
                    {toArabicDigits(t.date)} — بواسطة {t.createdByName || 'المالك'}
                    {t.notes ? ` — ${t.notes}` : ''}
                  </span>
                  {!done && !counter && (
                    <button type="button" onClick={() => reverseTransfer(t)} disabled={!!reversingId}
                      title="يُسجَّل نقل معاكس مربوط — والنقل الأصلي يبقى في السجل"
                      className="mr-auto px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-[#0B1F4D] hover:border-[#0B1F4D] disabled:opacity-40 text-[10px] font-extrabold cursor-pointer inline-flex items-center gap-1 flex-shrink-0">
                      <Undo2 className="w-3 h-3" /> تراجع
                    </button>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* نموذج النقل */}
      {showForm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4" onClick={() => !saving && setShowForm(false)}>
          <div onClick={e => e.stopPropagation()} className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl border border-slate-200 overflow-hidden max-h-[92vh] flex flex-col">
            <div className="p-5 bg-[#0B1F4D] text-white flex justify-between items-center flex-shrink-0">
              <h3 className="font-extrabold text-sm font-cairo flex items-center gap-1.5">
                <ArrowLeftRight className="w-5 h-5" /> نقل بضاعة بين المواقع
              </h3>
              <button onClick={() => setShowForm(false)} className="p-1.5 hover:bg-white/10 rounded-lg cursor-pointer"><X className="w-4 h-4" /></button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto">
              {/* من / إلى */}
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-2 items-end">
                <label className="block">
                  <span className="text-xs font-bold text-[#0B1F4D] block mb-1.5">من موقع</span>
                  <select value={fromBranch} onChange={e => setFromBranch(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:bg-white cursor-pointer">
                    {/* 🟠 المصدر يشمل المعطَّل: الشاشة تنصح بـ«تعطيل بدل الحذف»، وكان
                        التعطيل يُخفي الفرع من هذه القائمة فيسدّ الطريق الوحيد لإفراغه.
                        النقل **منه** مسموح؛ و**إليه** ممنوع (لا تدخل بضاعة موقعاً موقوفاً). */}
                    {sourceBranches.map(b => (
                      <option key={b.id} value={b.id}>
                        {isWarehouse(b) ? '🏬 ' : '🏪 '}{b.name}{b.active === false ? ' (معطّل)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex justify-center pb-2.5">
                  <button type="button" title="عكس الاتجاه"
                    onClick={() => { const f = fromBranch; setFromBranch(toBranch); setToBranch(f); }}
                    className="w-9 h-9 rounded-xl bg-amber-100 hover:bg-amber-200 text-amber-700 flex items-center justify-center cursor-pointer">
                    <ArrowLeftRight className="w-4 h-4" />
                  </button>
                </div>
                <label className="block">
                  <span className="text-xs font-bold text-[#0B1F4D] block mb-1.5">إلى موقع</span>
                  <select value={toBranch} onChange={e => setToBranch(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:bg-white cursor-pointer">
                    <option value="">— اختر —</option>
                    {activeBranches.filter(b => b.id !== fromBranch).map(b => (
                      <option key={b.id} value={b.id}>{isWarehouse(b) ? '🏬 ' : '🏪 '}{b.name}</option>
                    ))}
                  </select>
                </label>
              </div>

              {/* الباركود */}
              <div className={`p-3 rounded-2xl border-2 transition-colors ${barcodeError ? 'bg-rose-50 border-rose-400 animate-pulse' : 'bg-indigo-50/60 border-indigo-200'}`}>
                <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5 flex items-center gap-1.5">
                  <Barcode className="w-4 h-4 text-indigo-600" />
                  <span>قراءة الباركود 🔍</span>
                  <span className="text-[11px] font-bold text-slate-600 mr-auto">كل قراءة تضيف قطعة</span>
                </label>
                <input ref={barcodeRef} type="text" value={barcodeVal} dir="ltr" autoComplete="off"
                  onChange={e => setBarcodeVal(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleBarcodeScan(); } }}
                  placeholder="اقرأ باركود المادة لإضافتها..."
                  className={`w-full px-3 py-2.5 bg-white border rounded-xl text-sm text-center font-mono font-bold tracking-widest outline-none focus:ring-2 ${barcodeError ? 'border-rose-300 focus:ring-rose-400 text-rose-700' : 'border-indigo-200 focus:ring-indigo-400 text-[#0B1F4D]'}`} />
              </div>

              {/* المواد */}
              <div className="space-y-2">
                {lines.map(l => {
                  const p = productOf(l.productId);
                  const q = readAmountOr(l.quantity, 0) ?? 0;
                  const have = p ? atBranch(p, fromBranch) : 0;
                  // التحذير على مجموع المادة لا على السطر — وإلا مرّ سطران كلٌّ منهما كافٍ ومجموعهما لا.
                  const askedTotal = p ? (requestedPerProduct.get(p.id) ?? q) : q;
                  const isDup = !!p && dupProductIds.has(p.id);
                  const short = !!p && askedTotal > have;
                  return (
                    <div key={l.key} className={`p-3 rounded-xl border ${short ? 'border-amber-300 bg-amber-50/60' : 'border-slate-200 bg-slate-50'}`}>
                      <div className="flex gap-2 items-end">
                        <label className="flex-1 min-w-0">
                          <span className="text-[10px] font-bold text-slate-500 block mb-1">المادة</span>
                          <ProductPicker products={products} value={l.productId}
                            onChange={id => setLines(prev => prev.map(x => x.key === l.key ? { ...x, productId: id } : x))} />
                        </label>
                        <label className="w-28 flex-shrink-0">
                          <span className="text-[10px] font-bold text-slate-500 block mb-1">الكمية</span>
                          {/* لا min/step هنا: الحقل نصّي ليقبل الأرقام العربية، والسمتان لا أثر لهما
                              على type="text" فتوهمان بحمايةٍ غير موجودة. الحماية الحقيقية في فحص الحفظ. */}
                          <NumberInput inputMode="decimal" value={l.quantity}
                            onValueChange={v => setLines(prev => prev.map(x => x.key === l.key ? { ...x, quantity: v } : x))}
                            className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-center outline-none" />
                        </label>
                        <button type="button" onClick={() => setLines(prev => prev.length === 1 ? [newLine()] : prev.filter(x => x.key !== l.key))}
                          className="w-9 h-9 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-rose-600 hover:border-rose-200 flex items-center justify-center cursor-pointer flex-shrink-0">
                          <Trash className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {p && (
                        <div className="mt-2 text-[10px] font-bold flex items-center gap-2 flex-wrap">
                          <span className="text-slate-500">
                            في {branchName(fromBranch)}: <b className={have < 0 ? 'text-rose-700' : 'text-[#0B1F4D]'}>{toArabicDigits(have)}</b>
                          </span>
                          {toBranch && (
                            <span className="text-slate-500">
                              → في {branchName(toBranch)}: <b className="text-[#0B1F4D]">{toArabicDigits(atBranch(p, toBranch))}</b>
                            </span>
                          )}
                          {askedTotal > 0 && toBranch && (
                            <span className="text-emerald-700">
                              بعد النقل: {toArabicDigits(have - askedTotal)} ← {toArabicDigits(atBranch(p, toBranch) + askedTotal)}
                            </span>
                          )}
                          {isDup && (
                            <span className="text-indigo-700 flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" />
                              مكرَّرة — ستُدمج في سطر واحد بمجموع {toArabicDigits(askedTotal)}
                            </span>
                          )}
                          {short && (
                            <span className="text-amber-800 flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" /> الكمية تتجاوز رصيد المصدر
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                <button type="button" onClick={() => setLines(prev => [...prev, newLine()])}
                  className="w-full py-2 rounded-xl border-2 border-dashed border-slate-200 text-slate-500 hover:border-[#0B1F4D] hover:text-[#0B1F4D] text-xs font-extrabold cursor-pointer flex items-center justify-center gap-1.5">
                  <Plus className="w-3.5 h-3.5" /> إضافة مادة
                </button>
              </div>

              <label className="block">
                <span className="text-xs font-bold text-[#0B1F4D] block mb-1.5">ملاحظات</span>
                <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="مثال: تجهيز بضاعة المعرض"
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-right outline-none focus:bg-white" />
              </label>

              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-[10px] font-bold text-emerald-900 leading-relaxed">
                إجمالي مخزونك من كل مادة <b>لن يتغيّر</b> بهذه العملية — البضاعة تنتقل بين موقعيك فقط،
                فقيمة المخزون والأرباح والتقارير تبقى كما هي تماماً.
              </div>
            </div>

            <div className="p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={handleSave} disabled={saving || !toBranch}
                className="w-full py-3 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-sm shadow transition cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50">
                <Save className="w-4 h-4" />
                <span>{saving ? 'جارٍ الحفظ…' : `تنفيذ النقل (${toArabicDigits(totalQty)} وحدة)`}</span>
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
