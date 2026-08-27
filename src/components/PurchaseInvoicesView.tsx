import React, { useState, useMemo, useRef, useEffect } from 'react';
import NumberInput from './NumberInput';
import {
  PackageSearch, Plus, Search, X, Trash2, Check, Printer, FileText, Download,
  Eye, RotateCcw, AlertCircle, CheckCircle2, Calendar, ChevronDown,
  Truck, Banknote, CreditCard, Wallet, StickyNote, Tag, Box, Barcode,
} from 'lucide-react';
import { useBranches, branchOf } from '../hooks/useBranches';
import { stockOf, stockUpdate } from '../utils/branchStock';
import { ExpiryBatch } from '../types';
import { doc, setDoc, increment, collection, query, where, getDocs } from 'firebase/firestore';
import { newBatch } from '../utils/firestoreWrite';
import { db } from '../firebase';
import { useCollection } from '../hooks/useCollection';
import { useConfirm } from '../hooks/useConfirm';
import { useProductCosts } from '../hooks/useProductCosts';
import { useActor } from '../hooks/useActor';
import { logAudit } from '../utils/auditLog';
import { Supplier, PurchaseInvoice, PurchaseInvoiceItem, Product, ProductCost } from '../types';
import { toArabicDigits, formatCurrency } from '../utils/arabicFormatters';
import {
  PurchaseFormItem, blankFormItem, lineTotal, validFormItems, buildInvoiceItem,
  purchaseTotals, paymentTypeOf, allocatePurchaseNumber, duplicatePurchaseNumbers,
  costAfterCancelling, cancellationShortages, amountOf,
  findProductByName, buildNewProductFromPurchase, unlinkedItems,
} from '../utils/purchaseInvoice';
import { getDeviceTag } from '../utils/invoiceNumber';
import { useSession } from '../context/SessionContext';
import { exportAsWord, exportAsPdf, ExportSpec } from '../utils/exportDoc';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { reportFirestoreError } from '../utils/writeGuard';
import { readAmountOr } from '../utils/amountField';

interface Props {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  /** تمرير supplierId من شاشة الموردين لفتح النموذج مباشرة لمورد محدد */
  initialSupplierId?: string | null;
  onConsumedInitialSupplier?: () => void;
}

type StatusFilter = 'all' | 'received' | 'cancelled' | 'draft';

/**
 * 🔴 المبالغ والكميات **نصوص خام** في حالة النموذج.
 *
 * كانت أرقاماً تُقرأ بـ`parseFloat` عند كل ضغطة مفتاح، و`parseAmount` مستورَدة في الملف
 * ولا تُستدعى. قِسْتُ الأثر على سطرٍ كميته ١٠:
 *   · `5000`  ⟵ ١٠٬٠٠٠ د.ع ✔
 *   · `٥٠٠٠`  ⟵ الحقل يبقى فارغاً والإجمالي **صفر**
 *   · `5٠٠٠`  ⟵ يُقرأ **٥** فالإجمالي ١٠ د.ع — أقلّ بألف مرّة و**بصمت**
 * والحالة المختلطة هي القاتلة: من يكتب بلوحة عربية ثم يصحّح رقماً بلوحة إنجليزية.
 * وهذا **سعر الشراء**: يُكتب في `product_costs` فيصير أساس حساب ربح كل بيعة قادمة.
 *
 * والنصّ الخام ضروري لا تجميلي: تحويل ما يُكتب إلى رقم فوراً يمنع كتابة الكسور
 * («٥٫» تصير ٥ فيختفي الفاصل) ويقفز بمؤشّر الكتابة.
 */
interface FormState {
  id: string;
  invoiceNumber: string;      // نص للعرض (مثال: "P-١٠٠١")
  supplierId: string;
  date: string;
  items: PurchaseFormItem[];
  discount: string;
  tax: string;
  paidAmount: string;
  notes: string;
}

const newForm = (nextNumber: string): FormState => ({
  id: genId(),
  invoiceNumber: nextNumber,
  supplierId: '',
  date: todayISO(),
  items: [blankFormItem()],
  discount: '',
  tax: '',
  paidAmount: '',
  notes: '',
});

export default function PurchaseInvoicesView({ currency, exchangeRate, initialSupplierId, onConsumedInitialSupplier }: Props) {
  // ---- 1. FIRESTORE ----
  const { items: invoices, loading } = useCollection<PurchaseInvoice>('purchase_invoices');
  const { items: suppliers } = useCollection<Supplier>('suppliers');
  const { items: products } = useCollection<Product>('products');
  // شحنات الصلاحية: الحفظ يُنشئها والإلغاء يجب أن يُبطلها — وإلا بقيت تُنذر عن بضاعة
  // أُلغي استلامها أصلاً، وتعرض زرّ «شطب» لمخزونٍ غير موجود.
  const { items: expiryBatches } = useCollection<ExpiryBatch>('expiry_batches');
  const { costs } = useProductCosts();
  const { requestConfirm, confirmDialog } = useConfirm();
  const actor = useActor();
  const { ownerUid } = useSession();
  const { stampBranchId } = useBranches(); // الفرع المستلِم للبضاعة
  // 🟡 كل المسارات كانت `actor.uid`: مطابقٌ لـ ownerUid في جلسة المالك (وهذه شاشته)،
  // لكنه يكتب في شجرة الموظف يوم تُفتح لموظف. المصدر الصحيح واحد.
  const uid = ownerUid || actor.uid;

  // ---- 2. UI STATE ----
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(() => newForm(allocatePurchaseNumber([])));
  const [viewingInvoice, setViewingInvoice] = useState<PurchaseInvoice | null>(null);
  const [alertMsg, setAlertMsg] = useState<{ text: string; type: 'success' | 'danger' } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // autocomplete dropdown per item index
  const [activeAutocompleteIdx, setActiveAutocompleteIdx] = useState<number | null>(null);
  const autocompleteRef = useRef<HTMLDivElement | null>(null);

  // قراءة الباركود عند استلام البضاعة من المورّد
  const [purchaseBarcode, setPurchaseBarcode] = useState('');
  const [purchaseBarcodeError, setPurchaseBarcodeError] = useState(false);
  const purchaseBarcodeRef = useRef<HTMLInputElement | null>(null);

  // ---- 3. HELPERS ----
  const triggerAlert = (text: string, type: 'success' | 'danger' = 'success') => {
    setAlertMsg({ text, type });
    setTimeout(() => setAlertMsg(null), 5000);
  };

  /**
   * 🔴 الرقم التالي. الحساب القديم كان:
   *   `String(inv.invoiceNumber).replace(/[^\d]/g, '')`
   * والأرقام تُخزَّن عربيةً (`P-١٠٠١`)، و`\d` لا تطابق إلا `0-9` اللاتينية — فالتجريد
   * يُنتج نصّاً فارغاً، و`parseInt('')` تساوي `NaN`، فتصير صفراً، فيبقى الأقصى ١٠٠٠
   * و**كل فاتورة تأخذ الرقم `P-١٠٠١`**. قِسْتُها: فتحتُ النموذج مرّتين فأعطى الرقم نفسه.
   */
  const myDeviceTag = getDeviceTag(actor.uid);
  const nextInvoiceNumber = () => allocatePurchaseNumber(invoices, myDeviceTag);
  /** تكرار وقع قبل الإصلاح: يُكشف بدل أن يُسكت عنه (كل الفواتير القديمة `P-١٠٠١`). */
  const dupNumbers = useMemo(() => duplicatePurchaseNumbers(invoices), [invoices]);

  // إغلاق autocomplete عند النقر خارجها
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (autocompleteRef.current && !autocompleteRef.current.contains(e.target as Node)) {
        setActiveAutocompleteIdx(null);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // عند تمرير initialSupplierId من شاشة الموردين، افتح النموذج مباشرة مع تحديد المورد
  useEffect(() => {
    if (initialSupplierId) {
      const f = newForm(nextInvoiceNumber());
      f.supplierId = initialSupplierId;
      setForm(f);
      setShowForm(true);
      onConsumedInitialSupplier?.();
    }
  }, [initialSupplierId]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 4. COMPUTED TOTALS (للفورم) ----
  // نوع الدفع صار **مشتقّاً** لا محفوظاً في الحالة: كان `useEffect` يزامنه فيتأخّر خطوةً
  // عن المبالغ ويحتاج ثلاثة فروع لتصحيح نفسه. الاشتقاق لا يتأخّر ولا يتناقض.
  const totals = useMemo(
    () => purchaseTotals(form.items, form.discount, form.tax, form.paidAmount),
    [form.items, form.discount, form.tax, form.paidAmount],
  );
  const { subtotal, finalTotal, remaining, overpaid, supplierDelta } = totals;
  const paymentType = paymentTypeOf(finalTotal, amountOf(form.paidAmount));

  // ---- 5. FILTERS ----
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return invoices
      .filter(inv => statusFilter === 'all' || inv.status === statusFilter)
      .filter(inv => supplierFilter === 'all' || inv.supplierId === supplierFilter)
      .filter(inv => !q
        || String(inv.invoiceNumber).toLowerCase().includes(q)
        || inv.supplierName.toLowerCase().includes(q)
        || inv.notes.toLowerCase().includes(q)
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [invoices, search, statusFilter, supplierFilter]);

  const totalReceived = useMemo(
    () => invoices.filter(i => i.status === 'received').reduce((s, i) => s + i.total, 0),
    [invoices]
  );
  const totalOutstanding = useMemo(
    () => invoices.filter(i => i.status === 'received').reduce((s, i) => s + (i.remainingAmount || 0), 0),
    [invoices]
  );

  // ---- 6. FORM HANDLERS ----
  const handleOpenCreate = () => {
    setForm(newForm(nextInvoiceNumber()));
    setShowForm(true);
  };

  const updateItem = (idx: number, patch: Partial<PurchaseFormItem>) => {
    setForm(f => {
      const items = [...f.items];
      items[idx] = { ...items[idx], ...patch };
      return { ...f, items };
    });
  };

  const addItem = () => setForm(f => ({ ...f, items: [...f.items, blankFormItem()] }));

  const removeItem = (idx: number) => setForm(f => {
    if (f.items.length <= 1) return f;
    return { ...f, items: f.items.filter((_, i) => i !== idx) };
  });

  const selectProductForItem = (idx: number, product: Product) => {
    const costEntry = costs.find(c => c.id === product.id);
    updateItem(idx, {
      productId: product.id,
      productName: product.name,
      // نصوص خام — والمجهول يبقى فارغاً لا صفراً (صفرٌ يعني «مجانية» فيصير كل بيع ربحاً كاملاً)
      buyPrice: costEntry?.buyPrice !== undefined ? String(costEntry.buyPrice) : '',
      wholesaleUnitPrice: costEntry?.wholesaleBuyPrice !== undefined ? String(costEntry.wholesaleBuyPrice) : '',
      unitName: product.unit || 'قطعة',
    });
    setActiveAutocompleteIdx(null);
  };

  /**
   * إنشاء منتجٍ من بندٍ لا مقابل له في الجرد.
   *
   * 🔴 الفاتورة تعرف **سعر الشراء والكمية**، ولا تعرف **سعر البيع**. ومنتجٌ
   * بسعر بيعٍ صفر يُباع مجاناً — فلا يُنشأ حتى يُسأل عنه صراحةً.
   *
   * ⚠️ وقبل الإنشاء نبحث بالاسم: منتجان بنفس الاسم يشقّان المخزون شقّين،
   * فيُباع من أحدهما ويبقى الآخر ممتلئاً في التقارير.
   */
  const [newProd, setNewProd] = useState<
    { idx: number; name: string; sellPrice: string; unit: string; category: string } | null
  >(null);

  const openNewProduct = (idx: number, typedName: string) => {
    const name = typedName.trim();
    if (!name) return;
    const existing = findProductByName(products, name);
    if (existing) { selectProductForItem(idx, existing); return; }
    setNewProd({ idx, name, sellPrice: '', unit: 'قطعة', category: '' });
    setActiveAutocompleteIdx(null);
  };

  const confirmNewProduct = async () => {
    if (!newProd || !ownerUid) return;
    const sell = readAmountOr(newProd.sellPrice, NaN);
    if (sell === null || !Number.isFinite(sell) || sell <= 0) {
      triggerAlert('أدخل سعر بيع أكبر من صفر — المنتج بلا سعر يُباع مجاناً', 'danger');
      return;
    }
    // 🔴 حارس أخير: قد يكون المنتج أُنشئ في تبويبٍ آخر بين فتح النموذج وتأكيده
    const existing = findProductByName(products, newProd.name);
    if (existing) { selectProductForItem(newProd.idx, existing); setNewProd(null); return; }

    const id = `prod_${genId()}`;
    const docData = buildNewProductFromPurchase({
      name: newProd.name, sellPrice: sell, unit: newProd.unit,
      category: newProd.category, branchId: stampBranchId, createdAt: todayISO(),
    });
    try {
      await setDoc(doc(db, 'users', ownerUid, 'products', id), { id, ...docData });
    } catch (err) {
      reportFirestoreError('products', 'save', err, '[Firestore] product from purchase');
      triggerAlert('تعذّر إنشاء المنتج — تحقّق من الاتصال ثم أعد المحاولة', 'danger');
      return;
    }
    // الربط الآن: الكمية والتكلفة تدخلان مع حفظ الفاتورة كأي بندٍ مربوط
    updateItem(newProd.idx, {
      productId: id,
      productName: newProd.name,
      unitName: newProd.unit.trim() || 'قطعة',
    });
    triggerAlert(`أُضيف «${newProd.name}» للمخزن — كميته تدخل عند حفظ الفاتورة`);
    setNewProd(null);
  };

  // ---- قراءة الباركود عند استلام البضاعة ----
  // أسرع بكثير من البحث بالاسم عند إدخال عشرات الأصناف. تكرار الباركود يزيد الكمية بدل
  // إنشاء سطر جديد، ويُعاد استخدام أول سطر فارغ حتى لا تتراكم سطور فارغة.
  const handlePurchaseBarcode = () => {
    const code = purchaseBarcode.trim();
    if (!code) return;
    const found = products.find(p => p.barcode === code);
    if (!found) {
      setPurchaseBarcodeError(true);
      setTimeout(() => setPurchaseBarcodeError(false), 700);
      triggerAlert(`لا يوجد منتج بهذا الباركود [${toArabicDigits(code)}]`, 'danger');
      setPurchaseBarcode('');
      purchaseBarcodeRef.current?.focus();
      return;
    }
    setForm(f => {
      const existingIdx = f.items.findIndex(it => it.productId === found.id);
      if (existingIdx !== -1) {
        const items = [...f.items];
        items[existingIdx] = { ...items[existingIdx], quantity: String(amountOf(items[existingIdx].quantity) + 1) };
        return { ...f, items };
      }
      const costEntry = costs.find(c => c.id === found.id);
      const newLine: PurchaseFormItem = {
        ...blankFormItem(),
        productId: found.id,
        productName: found.name,
        quantity: '1',
        buyPrice: costEntry?.buyPrice !== undefined ? String(costEntry.buyPrice) : '',
        wholesaleUnitPrice: costEntry?.wholesaleBuyPrice !== undefined ? String(costEntry.wholesaleBuyPrice) : '',
        unitName: found.unit || 'قطعة',
      };
      const emptyIdx = f.items.findIndex(it => !it.productName.trim() && !it.productId);
      if (emptyIdx !== -1) {
        const items = [...f.items];
        items[emptyIdx] = newLine;
        return { ...f, items };
      }
      return { ...f, items: [...f.items, newLine] };
    });
    setPurchaseBarcode('');
    purchaseBarcodeRef.current?.focus();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!form.supplierId) { triggerAlert('اختر المورّد أولاً', 'danger'); return; }
    /**
     * 🔴 شبكة الأمان الأخيرة: بندٌ غير مربوط كان يُتخطّى عند الحفظ **بصمت** —
     * فيُسجَّل الدَّين على المورّد ولا تدخل البضاعة المخزن. الآن يُمنع الحفظ
     * ويُسمّى البند، فلا يمرّ الخلل بلا كلمة.
     */
    const orphans = unlinkedItems(form.items);
    if (orphans.length > 0) {
      const names = orphans.map(o => `«${o.productName.trim()}»`).join('، ');
      triggerAlert(
        `${names} غير مرتبط بمنتج ولن يدخل المخزن — اختره من القائمة أو اضغط «أضِفه منتجاً جديداً»`,
        'danger',
      );
      return;
    }
    const sup = suppliers.find(s => s.id === form.supplierId);
    if (!sup) { triggerAlert('المورّد المختار غير موجود', 'danger'); return; }

    // فلترة البنود الصالحة (السعر صفراً مسموح — هدية أو عيّنة من المورد)
    const formItems = validFormItems(form.items);
    if (formItems.length === 0) {
      triggerAlert('أضف بنداً واحداً على الأقل (اسم + كمية أكبر من صفر)', 'danger');
      return;
    }
    if (finalTotal <= 0) {
      triggerAlert('إجمالي الفاتورة صفر — راجع الكميات والأسعار', 'danger');
      return;
    }

    setSubmitting(true);
    try {
      // 🔴 البنود تُبنى بإسقاط المفاتيح غير المعروفة. `{ productId: undefined }` كان
      // يرمي `Unsupported field value: undefined` **متزامناً**، فيقفز فوق رسالة النجاح
      // وإغلاق النموذج معاً: التاجر يضغط «حفظ» فلا يحدث شيء ولا يعرف لماذا.
      const validItems: PurchaseInvoiceItem[] = formItems.map(buildInvoiceItem);

      const inv: PurchaseInvoice = {
        id: genId(),
        invoiceNumber: form.invoiceNumber,
        deviceTag: myDeviceTag,
        supplierId: sup.id,
        supplierName: sup.name,
        date: form.date,
        subtotal,
        discount: amountOf(form.discount),
        tax: amountOf(form.tax),
        total: finalTotal,
        paidAmount: amountOf(form.paidAmount),
        remainingAmount: remaining,
        paymentType,
        notes: form.notes.trim(),
        status: 'received',
        items: validItems,
        createdAt: Date.now(),
        createdByUid: actor.uid,
        createdByName: actor.name,
        branchId: stampBranchId, // الفرع الذي استلم البضاعة
      };

      const batch = newBatch();

      // 1) وثيقة فاتورة الشراء نفسها
      batch.set(doc(db, 'users', uid, 'purchase_invoices', inv.id), inv);

      // 2) لكل بند مرتبط بمنتج: +مخزون + تكلفة جديدة
      for (const it of validItems) {
        if (!it.productId) continue;
        // +مخزون بوحدة الأساس — يدخل مخزون الفرع المستلِم والإجمالي معاً
        batch.update(doc(db, 'users', uid, 'products', it.productId), stockUpdate(it.quantity, stampBranchId));
        // شحنة صلاحية: تُنشأ فقط إن أدخل المستخدم تاريخاً لهذا البند.
        // 🔴 لا تُضيف مخزوناً — المخزون زاد أعلاه بـ stockUpdate وحده. هذه توثّق تاريخاً.
        if (it.expiryDate) {
          const eb: ExpiryBatch = {
            id: `exp_${genId()}`,
            productId: it.productId,
            productName: it.productName,
            expiryDate: it.expiryDate,
            receivedDate: form.date,
            quantity: it.quantity,
            note: `من فاتورة شراء ${inv.invoiceNumber}`,
            branchId: stampBranchId,
            purchaseInvoiceId: inv.id,
            status: 'active',
            createdAt: Date.now(),
            createdByName: actor.name,
          };
          batch.set(doc(db, 'users', uid, 'expiry_batches', eb.id), eb);
          // التعلّم: هذه المادة صارت ذات صلاحية فيُسأل عنها في كل استلام قادم
          const prod = products.find(pr => pr.id === it.productId);
          if (prod && prod.tracksExpiry !== true) {
            batch.update(doc(db, 'users', uid, 'products', it.productId), { tracksExpiry: true });
          }
        }
        // تحديث/إنشاء وثيقة التكلفة — المفتاح غير المعروف يُسقَط لا يُكتب فارغاً
        const newCost: ProductCost = { id: it.productId, buyPrice: it.buyPrice };
        if (it.wholesaleUnitPrice !== undefined) newCost.wholesaleBuyPrice = it.wholesaleUnitPrice;
        batch.set(doc(db, 'users', uid, 'product_costs', it.productId), newCost, { merge: true });
      }

      /**
       * 3) رصيد المورد — بالإشارة، لا الباقي الآجل وحده.
       *
       * 🟠 كان `if (remaining > 0) increment(remaining)`، و`remaining` مُقيَّدة بـ`Math.max(0,…)`.
       * فمن دفع للمورد أكثر من قيمة الفاتورة **خسر الفرق من دفاتره**: لا يُسجَّل عليه دين
       * ولا يُسجَّل له رصيد. ونظام الموردين يعرف هذه الحالة تماماً (رصيد سالب = «لنا عنده»)
       * — فالمفهوم كان موجوداً والشاشة لا تغذّيه.
       */
      if (supplierDelta !== 0) {
        batch.update(doc(db, 'users', uid, 'suppliers', sup.id), {
          balance: increment(supplierDelta),
        });
      }

      // 4) تدقيق
      // السجل الفعلي يُكتب بعد commit (fire-and-forget) — لا نضيفه للـ batch لتجنّب فشل الفاتورة بسبب فشل السجل

      batch.commit().catch(err => reportFirestoreError('purchase_invoices', 'batch', err, '[Firestore] purchase invoice save'));

      logAudit({
        action: 'create',
        entity: 'purchase_invoice',
        entityId: inv.id,
        summary:
          `فاتورة شراء #${inv.invoiceNumber} من ${inv.supplierName} — ${formatCurrency(inv.total, currency, exchangeRate)}`,
        after: inv as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid,
        actorName: actor.name,
        relatedEntity: 'supplier',
        relatedEntityId: sup.id,
      });

      triggerAlert(
        `تم حفظ فاتورة الشراء #${inv.invoiceNumber} وإضافة المخزون ✅`
        + (overpaid > 0
          ? ` — دفعتَ ${formatCurrency(overpaid, currency, exchangeRate)} زيادةً عن قيمتها، وسُجّلت رصيداً لك عند «${sup.name}»`
          : ''),
      );
      setShowForm(false);
    } catch (error) {
      // 🔴 الفشل كان صامتاً تماماً: `batch.set` يرمي متزامناً فيقفز فوق رسالة النجاح،
      // ولا `catch` هنا، فالتاجر يضغط «حفظ» ولا يرى شيئاً — لا نجاحاً ولا خطأ.
      console.error('[Purchase invoice] save:', error);
      triggerAlert(
        `تعذّر حفظ الفاتورة: ${error instanceof Error ? error.message : 'خطأ غير متوقّع'}`,
        'danger',
      );
    } finally {
      setSubmitting(false);
    }
  };

  // ---- 7. CANCEL HANDLER (عكس كامل لتأثيرات الفاتورة) ----
  const handleCancel = async (inv: PurchaseInvoice) => {
    if (inv.status !== 'received') return;
    const invBranch = branchOf(inv);

    /**
     * 🔴 الإلغاء كان يخصم المخزون بلا أي فحص. فاتورة استُلمت وبِيعت بضاعتها ثم أُلغيت
     * ⟵ **رصيد سالب** — وهي الحالة التي تعتبرها شاشة النقل «خللاً يحتاج تصحيحاً».
     */
    const shortages = cancellationShortages(inv.items, productId => {
      const p = products.find(x => x.id === productId);
      return p ? stockOf(p, invBranch) : null;
    });
    if (shortages.length > 0) {
      triggerAlert(
        'لا يمكن الإلغاء: البضاعة بِيعت بعد الاستلام فسيصير الرصيد سالباً — '
        + shortages.map(s => `«${s.name}» يحتاج ${toArabicDigits(s.needed)} والمتوفّر ${toArabicDigits(s.available)}`).join(' | ')
        + '. سجّل مرتجعاً إلى المورد من «تسوية المخزون» بدل الإلغاء.',
        'danger',
      );
      return;
    }

    // أثر الفاتورة الحقيقي على رصيد المورد (يشمل الدفع الزائد بإشارته)
    const supplierEffect = inv.total - (inv.paidAmount || 0);
    // شحنات الصلاحية التي أنشأتها هذه الفاتورة — تُبطَل معها
    const linkedBatches = expiryBatches.filter(b => b.purchaseInvoiceId === inv.id && b.status === 'active');

    if (!(await requestConfirm(
      `هل أنت متأكد من إلغاء فاتورة الشراء #${inv.invoiceNumber} من ${inv.supplierName}؟\n` +
      `سيتم:\n` +
      `  • خصم الكميات من المخزون (${toArabicDigits(inv.items.reduce((s, i) => s + i.quantity, 0))} قطعة)\n` +
      (supplierEffect !== 0
        ? `  • ${supplierEffect > 0 ? 'تخفيض دينك للمورد' : 'إلغاء الرصيد الذي لك عنده'} بمقدار ${formatCurrency(Math.abs(supplierEffect), currency, exchangeRate)}\n`
        : '') +
      (linkedBatches.length > 0
        ? `  • إبطال ${toArabicDigits(linkedBatches.length)} شحنة صلاحية أنشأتها هذه الفاتورة\n`
        : '') +
      `  • إعادة تكلفة المواد إلى سعر أحدث فاتورة أخرى\n` +
      `  • تسجيل الإلغاء في السجل`
    ))) return;

    setSubmitting(true);
    try {
      const batch = newBatch();
      // علامة الإلغاء
      batch.update(doc(db, 'users', uid, 'purchase_invoices', inv.id), {
        status: 'cancelled',
        cancelledAt: Date.now(),
        cancelledByName: actor.name,
      });
      // عكس المخزون — من **فرع الفاتورة الأصلي** لا الفرع النشط
      for (const it of inv.items) {
        if (!it.productId) continue;
        batch.update(doc(db, 'users', uid, 'products', it.productId), stockUpdate(-it.quantity, invBranch));
        /**
         * 🟠 التكلفة كانت تبقى على سعر فاتورةٍ ملغاة — فيصير سعر شراء خاطئ أساساً
         * لحساب ربح كل بيعة قادمة. نُعيدها إلى أحدث فاتورة مستلَمة أخرى؛ فإن لم توجد
         * فلا نعرف التكلفة، ولا نخترعها صفراً (صفرٌ يجعل كل بيع ربحاً كاملاً).
         */
        const restored = costAfterCancelling(invoices, inv.id, it.productId);
        if (restored) {
          const cost: ProductCost = { id: it.productId, buyPrice: restored.buyPrice };
          if (restored.wholesaleBuyPrice !== undefined) cost.wholesaleBuyPrice = restored.wholesaleBuyPrice;
          batch.set(doc(db, 'users', uid, 'product_costs', it.productId), cost, { merge: true });
        }
      }
      /**
       * 🔴 شحنات الصلاحية كانت تبقى سارية بعد الإلغاء: شاشة الصلاحية تُنذر عن بضاعة
       * أُلغي استلامها، وتعرض زرّ «شطب» لمخزونٍ لم يعد موجوداً.
       */
      for (const b of linkedBatches) {
        batch.update(doc(db, 'users', uid, 'expiry_batches', b.id), { status: 'cancelled' });
      }
      // عكس أثر الفاتورة على رصيد المورد — بالإشارة، فيصحّ مع الدفع الزائد أيضاً
      if (supplierEffect !== 0) {
        batch.update(doc(db, 'users', uid, 'suppliers', inv.supplierId), {
          balance: increment(-supplierEffect),
        });
      }
      batch.commit().catch(err => reportFirestoreError('purchase_invoices', 'batch', err, '[Firestore] cancel purchase'));

      logAudit({
        action: 'cancel',
        entity: 'purchase_invoice',
        entityId: inv.id,
        summary: `إلغاء فاتورة شراء #${inv.invoiceNumber} من ${inv.supplierName} — عكس ${toArabicDigits(inv.items.length)} بند`,
        before: inv as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid,
        actorName: actor.name,
        relatedEntity: 'supplier',
        relatedEntityId: inv.supplierId,
      });

      triggerAlert(`تم إلغاء فاتورة الشراء #${inv.invoiceNumber} وعكس تأثيراتها`);
    } finally {
      setSubmitting(false);
    }
  };

  // ---- 8. EXPORT (Word/PDF) ----
  const handleExport = (format: 'word' | 'pdf') => {
    const list = filtered;
    if (list.length === 0) { triggerAlert('لا توجد فواتير للتصدير', 'danger'); return; }
    const money = (n: number) => formatCurrency(n, currency, exchangeRate);
    const spec: ExportSpec = {
      title: 'رتب شغلك',
      subtitle: `سجل فواتير الشراء — ${toArabicDigits(list.length)} فاتورة`,
      columns: [
        { header: '#', align: 'center' },
        { header: 'رقم الفاتورة', align: 'center' },
        { header: 'المورّد' },
        { header: 'التاريخ', align: 'center' },
        { header: 'الإجمالي', align: 'center' },
        { header: 'المدفوع', align: 'center' },
        { header: 'المتبقي', align: 'center' },
        { header: 'الحالة', align: 'center' },
      ],
      rows: list.map((inv, i) => [
        toArabicDigits(i + 1),
        String(inv.invoiceNumber),
        inv.supplierName,
        toArabicDigits(inv.date),
        money(inv.total),
        money(inv.paidAmount),
        money(inv.remainingAmount),
        inv.status === 'received' ? 'مستلمة' : inv.status === 'cancelled' ? 'ملغاة' : 'مسودة',
      ]),
      note:
        `إجمالي المستلم: ${money(list.filter(i => i.status === 'received').reduce((s, i) => s + i.total, 0))} — ` +
        `المتبقي على الموردين: ${money(list.filter(i => i.status === 'received').reduce((s, i) => s + i.remainingAmount, 0))}`,
    };
    const filename = `فواتير_شراء_${(new Date().toLocaleDateString('ar-IQ')).replace(/\//g, '-')}`;
    if (format === 'word') { exportAsWord(spec, filename); triggerAlert('تم تصدير ملف Word 📄'); }
    else exportAsPdf(spec, (m) => triggerAlert(m, 'danger'));
  };

  // ---- 9. RENDER ----
  return (
    <div className="space-y-5" dir="rtl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-[#0B1F4D] text-white p-6 rounded-2xl shadow-md border-b-4 border-emerald-400">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-1 px-2.5 bg-emerald-500 text-slate-950 font-black rounded-lg text-[10px] uppercase tracking-wider font-sans">
              وحدة المشتريات v١٫٠
            </span>
            <span className="text-xs text-emerald-300 font-bold">فواتير الشراء من الموردين 📦</span>
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2">
            <PackageSearch className="w-6.5 h-6.5 text-emerald-400" />
            <span>إدارة فواتير الشراء والاستلام</span>
          </h2>
          <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed font-medium">
            سجّل مشترياتك، حدّث المخزون والتكلفة تلقائياً، وتابع ديونك للموردين من مكان واحد
          </p>
        </div>
        <div className="flex gap-2 self-start md:self-center">
          <button
            onClick={() => handleExport('word')}
            className="px-3 py-2 bg-slate-900/60 hover:bg-slate-800 text-white text-xs font-bold rounded-xl border border-slate-700 flex items-center gap-1.5 cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5" /> Word
          </button>
          <button
            onClick={() => handleExport('pdf')}
            className="px-3 py-2 bg-slate-900/60 hover:bg-slate-800 text-white text-xs font-bold rounded-xl border border-slate-700 flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> PDF
          </button>
          <button
            onClick={handleOpenCreate}
            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-extrabold rounded-xl flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" /> فاتورة شراء جديدة
          </button>
        </div>
      </div>

      {/* 🔴 أرقام مكرَّرة وقعت قبل الإصلاح — تُعرض لتُراجَع لا لتُخفى */}
      {dupNumbers.length > 0 && (
        <div className="p-4 rounded-2xl border border-amber-200 bg-amber-50/70 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-amber-700 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-900 font-bold leading-relaxed">
            أرقام فواتير شراء متكرّرة: {dupNumbers.map(d => `${d.number} (${toArabicDigits(d.count)} مرات)`).join(' · ')}.
            <br />
            كان تجريد الأرقام يمحو الأرقام العربية فيبقى العدّاد ثابتاً عند نفس الرقم لكل فاتورة.
            <b> لن يتكرّر بعد الآن</b> — الترقيم الآن من أعلى رقم مستعمل، وموسوم بالجهاز عند تعدّده.
            راجع الفواتير المتشابهة بالتاريخ والمورد للتمييز بينها.
          </p>
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[#5B6B86]">إجمالي الفواتير</span>
            <span className="p-2 bg-emerald-50 rounded-lg text-emerald-700"><PackageSearch className="w-4 h-4" /></span>
          </div>
          <h4 className="text-xl font-black mt-2 text-slate-900 font-cairo">{toArabicDigits(invoices.length)}</h4>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[#5B6B86]">إجمالي المستلم</span>
            <span className="p-2 bg-emerald-50 rounded-lg text-emerald-700"><CheckCircle2 className="w-4 h-4" /></span>
          </div>
          <h4 className="text-lg font-black mt-2 text-emerald-700 font-cairo">{formatCurrency(totalReceived, currency, exchangeRate)}</h4>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[#5B6B86]">المتبقي للموردين</span>
            <span className="p-2 bg-rose-50 rounded-lg text-rose-700"><Banknote className="w-4 h-4" /></span>
          </div>
          <h4 className="text-lg font-black mt-2 text-rose-700 font-cairo">{formatCurrency(totalOutstanding, currency, exchangeRate)}</h4>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[#5B6B86]">عدد الموردين النشطين</span>
            <span className="p-2 bg-amber-50 rounded-lg text-amber-700"><Truck className="w-4 h-4" /></span>
          </div>
          <h4 className="text-xl font-black mt-2 text-slate-900 font-cairo">
            {toArabicDigits(new Set(invoices.filter(i => i.status === 'received').map(i => i.supplierId)).size)}
          </h4>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl p-3 border border-[#E4EAF3] shadow-sm flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ابحث برقم الفاتورة أو اسم المورد أو ملاحظات…"
            className="flex-1 bg-transparent border-0 outline-none text-sm font-bold text-[#0B1F4D] placeholder:text-slate-400"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-bold text-[#0B1F4D] cursor-pointer"
        >
          <option value="all">جميع الحالات</option>
          <option value="received">مستلمة</option>
          <option value="cancelled">ملغاة</option>
          <option value="draft">مسودة</option>
        </select>
        <select
          value={supplierFilter}
          onChange={(e) => setSupplierFilter(e.target.value)}
          className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-bold text-[#0B1F4D] cursor-pointer"
        >
          <option value="all">كل الموردين</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {/* List */}
      <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-slate-500 text-sm">جاري التحميل…</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-slate-500 text-sm">
            {search || statusFilter !== 'all' || supplierFilter !== 'all'
              ? 'لا نتائج تطابق الفلاتر'
              : 'لا توجد فواتير شراء بعد. اضغط "فاتورة شراء جديدة" للبدء.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-[#0B1F4D] text-xs font-extrabold border-b border-slate-200">
                  <th className="p-3.5 text-center">#</th>
                  <th className="p-3.5 text-right">رقم الفاتورة</th>
                  <th className="p-3.5 text-right">المورّد</th>
                  <th className="p-3.5 text-right">التاريخ</th>
                  <th className="p-3.5 text-center">عدد البنود</th>
                  <th className="p-3.5 text-center">الإجمالي</th>
                  <th className="p-3.5 text-center">المتبقي</th>
                  <th className="p-3.5 text-center">الحالة</th>
                  <th className="p-3.5 rounded-l-xl text-left">التحكم</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((inv, idx) => (
                  <tr key={inv.id} className="border-b border-slate-100 hover:bg-emerald-50/30 transition">
                    <td className="p-3.5 text-slate-500 font-mono text-xs text-center">{toArabicDigits(idx + 1)}</td>
                    <td className="p-3.5 font-extrabold text-[#0B1F4D] font-mono">{String(inv.invoiceNumber)}</td>
                    <td className="p-3.5 text-slate-700 font-bold">{inv.supplierName}</td>
                    <td className="p-3.5 text-slate-500 text-xs">{toArabicDigits(inv.date)}</td>
                    <td className="p-3.5 text-center">
                      <span className="inline-block bg-slate-100 text-slate-700 text-[10px] font-bold px-2 py-0.5 rounded">
                        {toArabicDigits(inv.items.length)}
                      </span>
                    </td>
                    <td className="p-3.5 text-center text-emerald-700 font-bold text-xs">
                      {formatCurrency(inv.total, currency, exchangeRate)}
                    </td>
                    <td className="p-3.5 text-center">
                      {inv.remainingAmount > 0 ? (
                        <span className="text-rose-700 font-black text-xs">{formatCurrency(inv.remainingAmount, currency, exchangeRate)}</span>
                      ) : (
                        <span className="text-slate-500 text-xs">مسددة</span>
                      )}
                    </td>
                    <td className="p-3.5 text-center">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                        inv.status === 'received' ? 'bg-emerald-50 text-emerald-700'
                        : inv.status === 'cancelled' ? 'bg-rose-50 text-rose-700'
                        : 'bg-slate-100 text-slate-700'
                      }`}>
                        {inv.status === 'received' ? 'مستلمة' : inv.status === 'cancelled' ? 'ملغاة' : 'مسودة'}
                      </span>
                    </td>
                    <td className="p-3.5">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => setViewingInvoice(inv)}
                          title="عرض التفاصيل"
                          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        {inv.status === 'received' && (
                          <button
                            onClick={() => handleCancel(inv)}
                            title="إلغاء الفاتورة وعكس تأثيراتها"
                            className="p-1.5 text-rose-700 hover:bg-rose-50 rounded-lg cursor-pointer"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ============ FORM MODAL ============ */}
      {showForm && (
        <div
          className="fixed inset-0 z-[9998] bg-slate-900/60 backdrop-blur-[2px] flex items-center justify-center p-4"
          onClick={() => !submitting && setShowForm(false)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleSubmit}
            className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl p-5 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between sticky top-0 bg-white pb-2 border-b border-slate-100">
              <h3 className="text-lg font-extrabold text-[#0B1F4D] font-cairo flex items-center gap-2">
                <PackageSearch className="w-5 h-5 text-emerald-700" />
                فاتورة شراء جديدة — رقم {String(form.invoiceNumber)}
              </h3>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                disabled={submitting}
                className="text-slate-500 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Top fields */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5">المورّد *</label>
                <select
                  value={form.supplierId}
                  onChange={(e) => setForm(f => ({ ...f, supplierId: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-[#0B1F4D]"
                >
                  <option value="">— اختر مورد —</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5 flex items-center gap-1">
                  <Calendar className="w-3 h-3" /> التاريخ
                </label>
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm(f => ({ ...f, date: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-[#0B1F4D]"
                />
              </div>
              <div>
                <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5">رقم الفاتورة</label>
                <input
                  type="text"
                  value={form.invoiceNumber}
                  onChange={(e) => setForm(f => ({ ...f, invoiceNumber: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-[#0B1F4D] font-mono"
                  dir="ltr"
                />
              </div>
            </div>

            {/* قراءة الباركود — تضيف البند تلقائياً أو تزيد كميته إن تكرّر */}
            <div className={`p-3 rounded-2xl border-2 transition-colors ${
              purchaseBarcodeError ? 'bg-rose-50 border-rose-400 animate-pulse' : 'bg-indigo-50/60 border-indigo-200'
            }`}>
              <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5 flex items-center gap-1.5">
                <Barcode className="w-4 h-4 text-indigo-600" />
                <span>قراءة الباركود 🔍</span>
                <span className="text-[11px] font-bold text-slate-600 mr-auto">اقرأ الأصناف المستلمة — التكرار يزيد الكمية</span>
              </label>
              <input
                ref={purchaseBarcodeRef}
                type="text"
                value={purchaseBarcode}
                onChange={(e) => setPurchaseBarcode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handlePurchaseBarcode(); } }}
                placeholder="ضع المؤشر هنا واقرأ باركود المادة المستلمة..."
                dir="ltr"
                autoComplete="off"
                className={`w-full px-3 py-2.5 bg-white border rounded-xl text-sm text-center font-mono font-bold tracking-widest outline-none focus:ring-2 ${
                  purchaseBarcodeError
                    ? 'border-rose-300 focus:ring-rose-400 text-rose-700'
                    : 'border-indigo-200 focus:ring-indigo-400 text-[#0B1F4D]'
                }`}
              />
            </div>

            {/* Items table */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-extrabold text-[#0B1F4D] flex items-center gap-1">
                  <Box className="w-3 h-3" /> بنود الفاتورة
                </label>
                <button
                  type="button"
                  onClick={addItem}
                  className="text-xs font-bold text-emerald-700 hover:text-emerald-700 flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" /> بند جديد
                </button>
              </div>
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-[#0B1F4D] font-extrabold">
                    <tr>
                      <th className="p-2 text-right w-10">#</th>
                      <th className="p-2 text-right">المنتج / المادة</th>
                      <th className="p-2 text-center w-20">الكمية</th>
                      <th className="p-2 text-center w-28">سعر الشراء</th>
                      <th className="p-2 text-center w-28">سعر كرتون</th>
                      <th className="p-2 text-center w-24">الإجمالي</th>
                      <th className="p-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.items.map((it, idx) => {
                      const productMatches = it.productName.trim()
                        ? products.filter(p =>
                            p.name.toLowerCase().includes(it.productName.toLowerCase())
                          ).slice(0, 5)
                        : [];
                      // الصلاحية: يظهر الحقل **فقط** للمواد التي تعلّم البرنامج أنها ذات صلاحية.
                      // بائع الصوند لا يُستجوَب عن تواريخ لا معنى لها — لا عمود جديد في الجدول أصلاً.
                      const linked = it.productId ? products.find(pr => pr.id === it.productId) : undefined;
                      const asksExpiry = linked?.tracksExpiry === true;
                      return (
                        <tr key={idx} className="border-t border-slate-100">
                          <td className="p-2 text-slate-500 text-center font-mono">{toArabicDigits(idx + 1)}</td>
                          <td className="p-2 relative">
                            <input
                              type="text"
                              value={it.productName}
                              onChange={(e) => {
                                updateItem(idx, { productName: e.target.value, productId: undefined });
                                setActiveAutocompleteIdx(idx);
                              }}
                              onFocus={() => setActiveAutocompleteIdx(idx)}
                              placeholder="اكتب اسم المنتج أو اختر من القائمة"
                              className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-[#0B1F4D]"
                            />
                            {asksExpiry && (
                              <label className="flex items-center gap-1.5 mt-1.5">
                                <span className="text-[11px] font-extrabold text-amber-700 whitespace-nowrap">⏳ تنتهي في</span>
                                <input
                                  type="date"
                                  value={it.expiryDate ?? ''}
                                  onChange={(e) => updateItem(idx, { expiryDate: e.target.value || undefined })}
                                  className="flex-1 min-w-0 px-1.5 py-1 bg-amber-50 border border-amber-200 rounded-lg text-[10px] font-bold text-[#0B1F4D]"
                                />
                              </label>
                            )}
                            {activeAutocompleteIdx === idx && it.productName.trim() && !it.productId && (
                              <div
                                ref={autocompleteRef}
                                className="absolute z-10 mt-1 right-0 left-0 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto"
                              >
                                {/* 🔴 كان الشرط `productMatches.length > 0`، فاسمٌ غير موجود
                                    لا يُظهر قائمةً أصلاً — ولا شيء يقول للتاجر إن بنده غير
                                    مربوط. فيحفظ الفاتورة، ويُسجَّل الدَّين، ولا تدخل البضاعة. */}
                                {productMatches.length === 0 && (
                                  <button
                                    type="button"
                                    onClick={() => openNewProduct(idx, it.productName)}
                                    className="w-full text-right px-3 py-2.5 bg-emerald-50 hover:bg-emerald-100 text-xs font-extrabold text-emerald-800 border-b border-emerald-200 cursor-pointer flex items-center gap-1.5"
                                  >
                                    <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                                    <span className="truncate">أضِف «{it.productName.trim()}» منتجاً جديداً</span>
                                  </button>
                                )}
                                {productMatches.map(p => (
                                  <button
                                    key={p.id}
                                    type="button"
                                    onClick={() => selectProductForItem(idx, p)}
                                    className="w-full text-right px-3 py-2 hover:bg-emerald-50 text-xs font-bold text-[#0B1F4D] border-b border-slate-100 last:border-0 cursor-pointer"
                                  >
                                    <div className="flex items-center justify-between">
                                      <span>{p.name}</span>
                                      <span className="text-slate-500 font-mono">المخزون: {toArabicDigits(stockOf(p, stampBranchId))}</span>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="p-2">
                            <NumberInput inputMode="decimal"
                              min="0"
                              step="any"
                              value={it.quantity}
                              onValueChange={(v) => updateItem(idx, { quantity: v })}
                              className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-center text-[#0B1F4D]"
                            />
                          </td>
                          <td className="p-2">
                            <NumberInput inputMode="decimal"
                              min="0"
                              step="any"
                              value={it.buyPrice}
                              onValueChange={(v) => updateItem(idx, { buyPrice: v })}
                              className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-center text-[#0B1F4D]"
                            />
                          </td>
                          <td className="p-2">
                            <NumberInput inputMode="decimal"
                              min="0"
                              step="any"
                              value={it.wholesaleUnitPrice}
                              onValueChange={(v) => updateItem(idx, { wholesaleUnitPrice: v })}
                              placeholder="اختياري"
                              className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-center text-[#0B1F4D] placeholder:text-slate-300"
                            />
                          </td>
                          <td className="p-2 text-center font-bold text-emerald-700">
                            {formatCurrency(lineTotal(it), currency, exchangeRate)}
                          </td>
                          <td className="p-2 text-center">
                            {form.items.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeItem(idx)}
                                className="text-rose-700 hover:text-rose-700 cursor-pointer"
                                title="حذف البند"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Totals + payment */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5 flex items-center gap-1">
                    <StickyNote className="w-3 h-3" /> ملاحظات
                  </label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                    rows={3}
                    placeholder="تفاصيل الاستلام، رقم فاتورة المورد، شروط الدفع…"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-[#0B1F4D] resize-none"
                  />
                </div>
              </div>
              <div className="space-y-2 bg-slate-50 rounded-xl p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 font-bold">المجموع الفرعي:</span>
                  <span className="font-extrabold text-[#0B1F4D]">{formatCurrency(subtotal, currency, exchangeRate)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-slate-500 font-bold">خصم:</span>
                  <NumberInput inputMode="decimal"
                    min="0"
                    value={form.discount}
                    onValueChange={(v) => setForm(f => ({ ...f, discount: v }))}
                    className="w-32 px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-bold text-center"
                  />
                </div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-slate-500 font-bold">ضريبة:</span>
                  <input
                    type="text" inputMode="decimal"
                    min="0"
                    value={form.tax}
                    onChange={(e) => setForm(f => ({ ...f, tax: e.target.value }))}
                    className="w-32 px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-bold text-center"
                  />
                </div>
                <div className="flex items-center justify-between text-sm border-t border-slate-200 pt-2">
                  <span className="font-extrabold text-[#0B1F4D]">الإجمالي:</span>
                  <span className="font-black text-emerald-700">{formatCurrency(finalTotal, currency, exchangeRate)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-slate-500 font-bold">المدفوع:</span>
                  <NumberInput inputMode="decimal"
                    min="0"
                    value={form.paidAmount}
                    onValueChange={(v) => setForm(f => ({ ...f, paidAmount: v }))}
                    className="w-32 px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-bold text-center"
                  />
                </div>
                <div className="flex items-center justify-between text-sm border-t border-slate-200 pt-2">
                  <span className="font-extrabold text-[#0B1F4D]">
                    {overpaid > 0 ? 'رصيد لك عند المورد:' : 'المتبقي عليك للمورد:'}
                  </span>
                  <span className={`font-black ${remaining > 0 ? 'text-rose-700' : overpaid > 0 ? 'text-emerald-700' : 'text-slate-500'}`}>
                    {formatCurrency(overpaid > 0 ? overpaid : remaining, currency, exchangeRate)}
                  </span>
                </div>
                {/* 🟠 الدفع الزائد كان يتبخّر بلا أثر — الآن يُسجَّل رصيداً على المورد */}
                {overpaid > 0 && (
                  <p className="text-[10px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-2 leading-relaxed">
                    دفعتَ أكثر من قيمة الفاتورة. الفرق يُسجَّل رصيداً لك عند المورد يُحسم من مشترياتك القادمة.
                  </p>
                )}
                <div className="text-[10px] text-slate-600 mt-1">
                  نوع الدفع: <span className="font-bold text-[#0B1F4D]">
                    {paymentType === 'cash' ? '💵 نقدي' : paymentType === 'credit' ? '📝 آجل' : '🔀 جزئي'}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-1 sticky bottom-0 bg-white">
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 py-2.5 bg-emerald-500 hover:bg-emerald-800 active:scale-95 disabled:opacity-50 text-white font-extrabold text-xs rounded-xl transition cursor-pointer flex items-center justify-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                {submitting ? 'جاري الحفظ…' : 'حفظ الفاتورة وإضافة المخزون'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                disabled={submitting}
                className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-xs rounded-xl transition cursor-pointer"
              >
                إلغاء
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ============ VIEW MODAL ============ */}
      {viewingInvoice && (
        <div
          className="fixed inset-0 z-[9998] bg-slate-900/50 backdrop-blur-[2px] flex items-center justify-center p-4"
          onClick={() => setViewingInvoice(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-5 space-y-3 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-extrabold text-[#0B1F4D] font-cairo flex items-center gap-2">
                <PackageSearch className="w-5 h-5 text-emerald-700" />
                فاتورة شراء #{String(viewingInvoice.invoiceNumber)}
              </h3>
              <button
                onClick={() => setViewingInvoice(null)}
                className="text-slate-500 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><span className="text-slate-500">المورّد:</span> <span className="font-bold text-[#0B1F4D]">{viewingInvoice.supplierName}</span></div>
              <div><span className="text-slate-500">التاريخ:</span> <span className="font-bold text-[#0B1F4D]">{toArabicDigits(viewingInvoice.date)}</span></div>
              <div><span className="text-slate-500">الحالة:</span> <span className="font-bold text-[#0B1F4D]">{viewingInvoice.status === 'received' ? 'مستلمة' : viewingInvoice.status === 'cancelled' ? 'ملغاة' : 'مسودة'}</span></div>
              <div><span className="text-slate-500">أنشأها:</span> <span className="font-bold text-[#0B1F4D]">{viewingInvoice.createdByName || '—'}</span></div>
            </div>
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-[#0B1F4D] font-extrabold">
                  <tr>
                    <th className="p-2 text-right">المنتج</th>
                    <th className="p-2 text-center">الكمية</th>
                    <th className="p-2 text-center">سعر الشراء</th>
                    <th className="p-2 text-center">الإجمالي</th>
                  </tr>
                </thead>
                <tbody>
                  {viewingInvoice.items.map((it, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="p-2 font-bold text-[#0B1F4D]">{it.productName}</td>
                      <td className="p-2 text-center">{toArabicDigits(it.quantity)}</td>
                      <td className="p-2 text-center">{formatCurrency(it.buyPrice, currency, exchangeRate)}</td>
                      <td className="p-2 text-center font-bold text-emerald-700">{formatCurrency(it.total, currency, exchangeRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bg-slate-50 rounded-xl p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-slate-500">المجموع الفرعي:</span><span className="font-bold">{formatCurrency(viewingInvoice.subtotal, currency, exchangeRate)}</span></div>
              {viewingInvoice.discount > 0 && <div className="flex justify-between"><span className="text-slate-500">الخصم:</span><span className="font-bold">- {formatCurrency(viewingInvoice.discount, currency, exchangeRate)}</span></div>}
              {viewingInvoice.tax > 0 && <div className="flex justify-between"><span className="text-slate-500">الضريبة:</span><span className="font-bold">+ {formatCurrency(viewingInvoice.tax, currency, exchangeRate)}</span></div>}
              <div className="flex justify-between border-t border-slate-200 pt-1 text-sm"><span className="font-extrabold text-[#0B1F4D]">الإجمالي:</span><span className="font-black text-emerald-700">{formatCurrency(viewingInvoice.total, currency, exchangeRate)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">المدفوع:</span><span className="font-bold">{formatCurrency(viewingInvoice.paidAmount, currency, exchangeRate)}</span></div>
              {viewingInvoice.remainingAmount > 0 && <div className="flex justify-between"><span className="text-slate-500">المتبقي على المورد:</span><span className="font-bold text-rose-700">{formatCurrency(viewingInvoice.remainingAmount, currency, exchangeRate)}</span></div>}
            </div>
            {viewingInvoice.notes && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs">
                <div className="font-extrabold text-amber-800 mb-1">ملاحظات:</div>
                <div className="text-amber-700 whitespace-pre-wrap">{viewingInvoice.notes}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Toast */}
      {alertMsg && (
        <div
          className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-[9999] px-5 py-3 rounded-xl shadow-2xl text-sm font-bold ${
            alertMsg.type === 'danger' ? 'bg-rose-600 text-white' : 'bg-emerald-700 text-white'
          }`}
        >
          {alertMsg.text}
        </div>
      )}

      {/* منتجٌ جديد من بند شراء — يُسأل عمّا لا تعرفه الفاتورة فقط */}
      {newProd && (
        <div
          className="fixed inset-0 z-[9998] bg-slate-900/50 flex items-center justify-center p-4"
          onClick={() => setNewProd(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white w-full max-w-md rounded-2xl p-5 space-y-4 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-extrabold text-sm text-[#0B1F4D] font-cairo">إضافة منتج جديد للمخزن</h3>
                <p className="text-[11px] text-slate-600 font-bold mt-1 truncate" title={newProd.name}>
                  «{newProd.name}»
                </p>
              </div>
              <button type="button" onClick={() => setNewProd(null)} className="cursor-pointer flex-shrink-0">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>

            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-[11px] font-bold text-emerald-800 leading-relaxed">
              سعر الشراء والكمية يؤخذان من الفاتورة. المطلوب هنا ما لا تعرفه: <b>سعر البيع</b>.
            </div>

            <label className="block">
              <span className="text-xs font-extrabold text-[#0B1F4D] block mb-1.5">
                سعر البيع <span className="text-rose-700">*</span>
              </span>
              <NumberInput
                autoFocus
                inputMode="decimal"
                value={newProd.sellPrice}
                onValueChange={(v) => setNewProd({ ...newProd, sellPrice: v })}
                placeholder="مثال: ١٢٥٠٠"
                className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-bold text-center font-mono outline-none focus:border-[#0B1F4D]"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-extrabold text-[#0B1F4D] block mb-1.5">الوحدة</span>
                <input
                  type="text"
                  value={newProd.unit}
                  onChange={(e) => setNewProd({ ...newProd, unit: e.target.value })}
                  placeholder="قطعة"
                  className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs font-bold outline-none focus:border-[#0B1F4D]"
                />
              </label>
              <label className="block">
                <span className="text-xs font-extrabold text-[#0B1F4D] block mb-1.5">
                  التصنيف <span className="text-slate-500 font-normal">(اختياري)</span>
                </span>
                <input
                  type="text"
                  value={newProd.category}
                  onChange={(e) => setNewProd({ ...newProd, category: e.target.value })}
                  placeholder="ألبان"
                  className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs font-bold outline-none focus:border-[#0B1F4D]"
                />
              </label>
            </div>

            <button
              type="button"
              onClick={() => void confirmNewProduct()}
              className="w-full min-h-[44px] rounded-xl bg-emerald-700 hover:bg-emerald-800 border border-emerald-500 text-white font-extrabold text-sm flex items-center justify-center gap-2 cursor-pointer transition"
            >
              <Plus className="w-4 h-4" /> أضِفه واربطه بالبند
            </button>
          </div>
        </div>
      )}

      {confirmDialog}
    </div>
  );
}
