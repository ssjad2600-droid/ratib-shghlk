import React, { useState, useRef, useEffect, useMemo } from 'react';
import { writeBatch, doc, increment, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useCollection } from '../hooks/useCollection';
import { useSession } from '../context/SessionContext';
import { customerPublicRef } from '../utils/customersPublic';
import { addWarrantyIndexToBatch } from '../utils/warrantyIndex';
import { stockOf, stockUpdateSeeded } from '../utils/branchStock';
import { Product, Invoice, Customer } from '../types';
import { toArabicDigits, formatCurrency, formatArabicNoun, ARABIC_NOUNS } from '../utils/arabicFormatters';
import { printSingleInvoice } from '../utils/printReceipt';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { FileText, Plus, Trash, Printer, Barcode, Save, Info, Calculator, Banknote, Wallet, User, UserPlus, X, Search } from 'lucide-react';
import { readAmountOr } from '../utils/amountField';

interface Props {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  // بيانات المحل لترويسة الفاتورة المطبوعة (من public/info — الموظف لا يقرأ بروفايل المالك)
  storeName?: string;
  storeAddress?: string;
  storePhone?: string;
  printFormat?: string; // من public/info — نفس إعداد المالك
}

type FormItem = {
  itemId: string;
  name: string;
  quantity: number;
  price: number;
  productId?: string;
  saleUnit?: 'retail' | 'wholesale'; // undefined/'retail' = وحدة الأساس (المفرد)
  serials?: string; // أرقام تسلسلية/IMEI كنص خام — تُحوَّل لمصفوفة عند الحفظ
};

// نص السيريالات → مصفوفة نظيفة بلا تكرار (نفس منطق شاشة المالك)
const splitSerials = (raw?: string): string[] => {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,،;]/)) {
    const v = part.trim();
    if (!v) continue;
    const k = v.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
};

const itemDisplayName = (it: { name: string; unitLabel?: string }): string =>
  it.unitLabel ? `${it.name} - ${it.unitLabel}` : it.name;

const formatDate = (dateStr: string): string => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (!isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) return d.toLocaleDateString('ar-IQ');
  return toArabicDigits(dateStr);
};

// ---- سجل إخفاقات المزامنة (fix 2) ----
// الكتابات تُنشأ أوفلاين ويؤكّدها الخادم لاحقاً؛ إن رُفضت وقتها (حساب عُطِّل، منتج حُذف) كان
// الخطأ يُبتلع في console فقط. نحفظه محلياً بمعرّف الموظف ليظهر كتحذير بارز عند التشغيل التالي،
// فلا تُفقد فاتورة بصمت. (الوعد يُحسم وقت المزامنة وقد يكون بعد تفريغ المكوّن — لذا localStorage.)
const SYNC_ISSUES_KEY = (uid: string) => `ratib_emp_sync_issues_${uid}`;
interface SyncIssue { msg: string; at: number; }
const readSyncIssues = (uid: string): SyncIssue[] => {
  try { return JSON.parse(localStorage.getItem(SYNC_ISSUES_KEY(uid)) || '[]'); } catch { return []; }
};
const pushSyncIssue = (uid: string, msg: string) => {
  try {
    const list = readSyncIssues(uid);
    list.unshift({ msg, at: Date.now() });
    localStorage.setItem(SYNC_ISSUES_KEY(uid), JSON.stringify(list.slice(0, 20)));
  } catch { /* تعذّر التخزين — غير حرج */ }
};

/**
 * واجهة فاتورة الموظف — بيع نقدي أو بالدين (منتقي زبون من customers_public فقط، اسم بلا رصيد).
 * لا تعديل/حذف لفواتير سابقة. تُنسب كل فاتورة للموظف (createdByUid) وتخصم المخزون بحقل quantity فقط.
 * لا تقرأ product_costs ولا customers الرئيسية (محجوبتان عن الموظف بالقواعد).
 *
 * TODO (دَين تقني مؤجَّل عمداً): منطق الباركود/اقتراحات المنتج/حساب baseQtyOf ووحدة الجملة-المفرد
 * مكرَّر شبه حرفياً من InvoicesView.tsx (نسخة المالك). لم يُستخلص إلى hook مشترك بعد لأن نسختي
 * المالك/الموظف تختلفان في القراءة/الكتابة المسموحة (buyPrice، customers، الترقيم...)، فاستخلاص
 * hook مشترك (مثل useInvoiceItemsForm) تحسين مستقبلي مرغوب — أي إصلاح لمنطق الجملة/المفرد يجب
 * تطبيقه يدوياً في الملفين حتى ذلك الحين.
 */
export default function EmployeeInvoicesView({ currency, exchangeRate, storeName, storeAddress, storePhone, printFormat }: Props) {
  const { ownerUid, employeeUid, employeeName, branchId: employeeBranchId } = useSession();
  // فرع الموظف يأتي من جلسته (employeeIndex). موظف بلا فرع مسجَّل ⇒ الفرع الرئيسي:
  // سلوك كل الحسابات القائمة قبل الفروع يبقى حرفياً كما هو.

  // المنتجات: قراءة مسموحة للموظف (بلا buyPrice — مفصول). الاستماع غير المفلتر مقبول للمنتجات.
  const { items: products } = useCollection<Product>('products');

  // فواتيره هو فقط — القاعدة تتطلب فلترة createdByUid وإلا رُفض الاستماع. المصفوفة مُذكّرة على uid.
  const myInvoiceConstraints = useMemo(
    () => (employeeUid ? [where('createdByUid', '==', employeeUid)] : []),
    [employeeUid]
  );
  const { items: myInvoices } = useCollection<Invoice>('invoices', myInvoiceConstraints);

  // مرآة أسماء الزبائن (اسم فقط — بلا رصيد/تاريخ). لمنتقي بيع الدين.
  const { items: customersPublic } = useCollection<{ id: string; name: string }>('customers_public');

  // ---- FORM STATE ----
  const [items, setItems] = useState<FormItem[]>([{ itemId: '1', name: '', quantity: 1, price: 0 }]);
  const [saleType, setSaleType] = useState<'cash' | 'debt'>('cash');
  // منتقي زبون الدين
  const [custSearch, setCustSearch] = useState('');
  const [selectedCust, setSelectedCust] = useState<{ id: string; name: string } | null>(null);
  const [addingNewCust, setAddingNewCust] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const custPickerRef = useRef<HTMLDivElement | null>(null);
  const [custDropdownOpen, setCustDropdownOpen] = useState(false);
  const [barcodeScanVal, setBarcodeScanVal] = useState('');
  const [barcodeScanError, setBarcodeScanError] = useState(false);
  const barcodeScanRef = useRef<HTMLInputElement | null>(null);
  const [activeAutocompleteIdx, setActiveAutocompleteIdx] = useState<number | null>(null);
  const autocompleteRef = useRef<HTMLDivElement | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastPrintable, setLastPrintable] = useState<Invoice | null>(null);
  const [alert, setAlert] = useState<{ text: string; type: 'success' | 'danger' } | null>(null);

  const triggerAlert = (text: string, type: 'success' | 'danger' = 'success') => {
    setAlert({ text, type });
    setTimeout(() => setAlert(null), 4000);
  };

  // إخفاقات مزامنة سابقة (fix 2) — تُحمَّل عند حسم هوية الموظف وتُعرض كتحذير دائم حتى يُقرّها
  const [syncIssues, setSyncIssues] = useState<SyncIssue[]>([]);
  useEffect(() => { if (employeeUid) setSyncIssues(readSyncIssues(employeeUid)); }, [employeeUid]);
  const recordSyncIssue = (msg: string) => {
    if (!employeeUid) return;
    pushSyncIssue(employeeUid, msg);
    setSyncIssues(readSyncIssues(employeeUid));
  };
  const dismissSyncIssues = () => {
    if (!employeeUid) return;
    try { localStorage.removeItem(SYNC_ISSUES_KEY(employeeUid)); } catch { /* غير حرج */ }
    setSyncIssues([]);
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (autocompleteRef.current && !autocompleteRef.current.contains(e.target as Node)) {
        setActiveAutocompleteIdx(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ---- INVOICE NUMBERING (namespace بادئة الموظف — لا يتضارب مع ترقيم المالك) ----
  const empPrefix = (employeeUid || 'EMP').slice(-4);
  const nextSeq = useMemo(() => {
    let max = 0;
    for (const inv of myInvoices) {
      const m = String(inv.invoiceNumber).match(/-(\d+)$/); // اللاحقة الرقمية المخزّنة لاتينياً
      if (m) { const n = parseInt(m[1], 10); if (!isNaN(n) && n > max) max = n; }
    }
    return max + 1;
  }, [myInvoices]);
  const displayInvoiceNumber = `${empPrefix}-${nextSeq}`;

  // ---- CALCULATIONS ----
  const subtotal = items.reduce((s, it) => s + it.quantity * it.price, 0);

  // ---- DEBT CUSTOMER PICKER (customers_public — اسم فقط) ----
  const custSuggestions = useMemo(() => {
    const q = custSearch.trim().toLowerCase();
    if (!q) return [];
    return customersPublic.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [custSearch, customersPublic]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (custPickerRef.current && !custPickerRef.current.contains(e.target as Node)) setCustDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const pickCustomer = (c: { id: string; name: string }) => {
    setSelectedCust(c); setAddingNewCust(false); setNewCustName(''); setCustDropdownOpen(false); setCustSearch('');
  };
  const clearCustomer = () => { setSelectedCust(null); setAddingNewCust(false); setNewCustName(''); setCustSearch(''); };

  // ---- BARCODE SCAN → ADD ITEM ----
  const handleBarcodeScanSubmit = () => {
    const code = barcodeScanVal.trim();
    if (!code) return;
    const product = products.find(p => p.barcode === code);
    if (!product) {
      setBarcodeScanError(true);
      setTimeout(() => setBarcodeScanError(false), 700);
      triggerAlert(`لا يوجد منتج بهذا الباركود [${toArabicDigits(code)}]`, 'danger');
      setBarcodeScanVal('');
      barcodeScanRef.current?.focus();
      return;
    }
    setItems(prev => {
      const existingIdx = prev.findIndex(it => it.productId === product.id && (it.saleUnit ?? 'retail') === 'retail');
      if (existingIdx !== -1) {
        const copy = [...prev];
        copy[existingIdx] = { ...copy[existingIdx], quantity: copy[existingIdx].quantity + 1 };
        return copy;
      }
      const emptyIdx = prev.findIndex(it => !it.name.trim() && !it.productId);
      const newRow: FormItem = {
        itemId: emptyIdx !== -1 ? prev[emptyIdx].itemId : String(Date.now()),
        name: product.name, quantity: 1, price: product.sellPrice, productId: product.id, saleUnit: 'retail',
      };
      if (emptyIdx !== -1) { const copy = [...prev]; copy[emptyIdx] = newRow; return copy; }
      return [...prev, newRow];
    });
    setBarcodeScanVal('');
    barcodeScanRef.current?.focus();
  };

  const handleBarcodeScanKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); handleBarcodeScanSubmit(); }
  };

  // ---- ITEM ROW OPS ----
  const addNewItemRow = () => setItems([...items, { itemId: String(items.length + 1), name: '', quantity: 1, price: 0 }]);
  const removeItemRow = (idx: number) => { setItems(items.filter((_, i) => i !== idx)); setActiveAutocompleteIdx(null); };
  const updateItemField = <K extends keyof FormItem>(idx: number, field: K, value: FormItem[K]) => {
    const copy = [...items]; copy[idx] = { ...copy[idx], [field]: value }; setItems(copy);
  };
  const handleItemNameChange = (idx: number, value: string) => {
    const copy = [...items]; copy[idx] = { ...copy[idx], name: value, productId: undefined }; setItems(copy);
    setActiveAutocompleteIdx(idx);
  };
  const handleSelectProduct = (idx: number, product: Product) => {
    const copy = [...items];
    copy[idx] = { ...copy[idx], name: product.name, price: product.sellPrice, productId: product.id, saleUnit: 'retail' };
    setItems(copy); setActiveAutocompleteIdx(null);
  };
  const handleChangeItemSaleUnit = (idx: number, unit: 'retail' | 'wholesale') => {
    const item = items[idx];
    const product = item.productId ? products.find(p => p.id === item.productId) : undefined;
    if (!product) return;
    const copy = [...items];
    // (fix 12) منتج جملة بلا wholesalePrice: لا نسعّر الكرتون بسعر القطعة المفردة (تسريب خسارة).
    // البديل الآمن = سعر المفرد × عدد القطع في الكرتون (تقدير معقول حتى يُدخِل المالك سعر الجملة).
    const wholesaleUnitPrice = product.wholesalePrice ?? (product.sellPrice * (product.wholesaleUnitQty || 1));
    copy[idx] = { ...copy[idx], saleUnit: unit, price: unit === 'wholesale' ? wholesaleUnitPrice : product.sellPrice };
    setItems(copy);
  };
  const getProductSuggestions = (idx: number): Product[] => {
    const q = items[idx]?.name?.trim().toLowerCase();
    if (!q) return [];
    return products.filter(p => p.name.toLowerCase().includes(q) || (p.barcode && p.barcode.includes(q))).slice(0, 6);
  };

  // كمية السطر بوحدة الأساس (للجملة تُضرب بمعامل التحويل) — لخصم المخزون بشكل صحيح
  const baseQtyOf = (item: FormItem, product?: Product): number =>
    (item.saleUnit === 'wholesale' && product?.hasWholesale) ? item.quantity * (product.wholesaleUnitQty || 1) : item.quantity;

  // تحذير تجاوز المخزون (fix 8) — الموظف كان يبيع أي كمية فيصير المخزون سالباً بصمت.
  // تحذير غير مانع (كسلوك المالك): يُصدر الفاتورة لكن يُظهر التنبيه بوضوح.
  const checkStockWarnings = (formItems: FormItem[]): string[] =>
    formItems
      .filter(it => it.productId)
      .map(it => {
        const product = products.find(p => p.id === it.productId);
        if (!product) return null;
        const baseQty = baseQtyOf(it, product);
        if (baseQty > stockOf(product, employeeBranchId)) {
          const unitSuffix = it.saleUnit === 'wholesale' && product.wholesaleUnitName ? ` ${product.wholesaleUnitName}` : '';
          return `«${it.name}»: مطلوب ${toArabicDigits(it.quantity)}${unitSuffix} (${toArabicDigits(baseQty)} ${product.unit || ''}) — متوفر ${toArabicDigits(stockOf(product, employeeBranchId))}`;
        }
        return null;
      })
      .filter(Boolean) as string[];

  // ---- SUBMIT (نقدي أو دين — batch ذرّية: [زبون جديد] + فاتورة + خصم المخزون) ----
  // shouldPrint: زر «حفظ وطباعة» — يحفظ الفاتورة ويطبعها فوراً بضغطة واحدة
  const handleSubmit = async (e: React.FormEvent | undefined, shouldPrint = false) => {
    e?.preventDefault();
    if (isSubmitting) return;
    if (!ownerUid || !employeeUid) return;

    const meaningful = items.filter(it => it.name.trim() || it.productId);
    if (meaningful.length === 0) { triggerAlert('يرجى إدراج مادة واحدة على الأقل', 'danger'); return; }
    if (meaningful.some(it => (readAmountOr(it.quantity, 0) ?? 0) <= 0)) { triggerAlert('كمية المادة يجب أن تكون أكبر من صفر', 'danger'); return; }
    if (meaningful.some(it => Number(it.price) < 0)) { triggerAlert('سعر المادة لا يمكن أن يكون سالباً', 'danger'); return; }

    // حسم الزبون لفاتورة الدين
    let debtCustomerId: string | null = null;
    let debtCustomerName = '';
    let createNewCustomer = false;
    if (saleType === 'debt') {
      if (selectedCust) {
        debtCustomerId = selectedCust.id;
        debtCustomerName = selectedCust.name;
      } else if (addingNewCust && newCustName.trim()) {
        createNewCustomer = true;
        debtCustomerName = newCustName.trim();
      } else {
        triggerAlert('البيع بالدين يتطلب اختيار زبون من القائمة أو إضافة زبون جديد', 'danger');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const sub = items.reduce((s, it) => s + it.quantity * it.price, 0);

      const formattedItems = items
        .filter(it => it.name.trim() || it.productId)
        .map((itm, index) => {
          const lp = itm.productId ? products.find(p => p.id === itm.productId) : undefined;
          const isWholesale = itm.saleUnit === 'wholesale' && lp?.hasWholesale;
          const unitLabel = isWholesale ? lp?.wholesaleUnitName : lp?.unit;
          const unitConversionQty = isWholesale ? (lp?.wholesaleUnitQty || 1) : undefined;
          const serialList = splitSerials(itm.serials);
          const warrantyMonths = lp?.defaultWarrantyMonths;
          return {
            itemId: String(index + 1),
            name: itm.name || 'بضاعة عامة',
            quantity: Number(itm.quantity) || 1,
            price: Number(itm.price) || 0,
            total: (Number(itm.quantity) || 1) * (Number(itm.price) || 0),
            ...(itm.productId ? { productId: itm.productId } : {}),
            ...(unitLabel ? { unitLabel } : {}),
            ...(unitConversionQty ? { unitConversionQty } : {}),
            ...(serialList.length ? { serials: serialList } : {}),
            ...(serialList.length && warrantyMonths ? { warrantyMonths } : {}),
          };
        });

      const now = Date.now();
      const invId = genId(); // (fix 10) لاحقة عشوائية تمنع تصادم معرّفين في نفس الملّي ثانية
      const isDebt = saleType === 'debt';
      const invNumber = `${empPrefix}-${nextSeq}`;

      // (fix 1) دفعتان منفصلتان: الفاتورة (+الزبون الجديد) ذرّياً في دفعة، وخصم المخزون في أخرى.
      // كانتا معاً؛ فلو حُذف منتج بينما الموظف أوفلاين، أفشل batch.update على وثيقة محذوفة الدفعةَ
      // كلها عند المزامنة ⇒ اختفت الفاتورة بصمت. الفصل يضمن بقاء الفاتورة حتى لو تعذّر خصم المخزون.

      // ---- دفعة (أ): الزبون الجديد (إن وُجد) + الفاتورة — ذرّية ----
      const invoiceBatch = writeBatch(db);
      if (createNewCustomer) {
        debtCustomerId = genId(); // (fix 10) معرّف زبون فريد
        const newCust: Customer = {
          id: debtCustomerId, name: debtCustomerName, phone: '', address: '',
          notes: `أضيف من فاتورة موظف ${employeeName || ''}`.trim(), balance: 0,
          dueDate: '', createdAt: todayISO(),
        };
        invoiceBatch.set(doc(db, 'users', ownerUid, 'customers', debtCustomerId), newCust);
        invoiceBatch.set(customerPublicRef(ownerUid, debtCustomerId), { name: debtCustomerName });
      }

      const newInv: Invoice = {
        id: invId,
        invoiceNumber: invNumber,
        customerName: isDebt ? debtCustomerName : 'زبون عام',
        ...(isDebt && debtCustomerId ? { customerId: debtCustomerId } : {}),
        totalAmount: sub,
        discount: 0,
        tax: 0,
        finalAmount: sub,
        paidAmount: isDebt ? 0 : sub,        // نقدي: مسدّد بالكامل | دين: غير مدفوع
        remainingAmount: isDebt ? sub : 0,   // الدين يُطوى لاحقاً في customer.balance من جلسة المالك
        date: todayISO(),
        createdAt: now,
        type: 'general',
        items: formattedItems,
        createdByUid: employeeUid,
        branchId: employeeBranchId, // فرع البيع — يحدّده المالك، لا الموظف
        createdByName: employeeName || '',
        // لا نضبط debtSyncedToBalance إطلاقاً — القاعدة تمنعه، والمالك يطويه
      };
      invoiceBatch.set(doc(db, 'users', ownerUid, 'invoices', invId), newInv);
      // مرآة الضمان ضمن نفس الدفعة الذرّية (لا تفعل شيئاً إن لم توجد سيريالات)
      addWarrantyIndexToBatch(invoiceBatch, ownerUid, newInv);
      // (fix 2) رفض الخادم للفاتورة (حساب عُطِّل أثناء العمل أوفلاين) لم يعد يُبتلع بصمت
      invoiceBatch.commit().catch(err => {
        console.error('[Firestore] employee invoice save:', err);
        recordSyncIssue(`تعذّر حفظ الفاتورة ${toArabicDigits(invNumber)} على الخادم — راجع صاحب المحل (قد يكون الحساب عُطِّل).`);
      });

      // ---- دفعة (ب): خصم المخزون — منفصلة، فشلها لا يُفقد الفاتورة ----
      const stockItems = items.filter(itm => itm.productId && products.some(p => p.id === itm.productId));
      if (stockItems.length > 0) {
        const stockBatch = writeBatch(db);
        for (const itm of stockItems) {
          const lp = products.find(p => p.id === itm.productId);
          const baseQty = baseQtyOf(itm, lp);
          // يخصم من الإجمالي ومن مخزون فرع الموظف معاً في تحديث ذرّي واحد.
          // Seeded: منتج قديم لم يمرّ عليه ترحيل المالك بعد ⇒ تُبذَر خريطته بقيمتها الحقيقية
          // في أول حركة، فلا يظهر رصيد فرع سالب ولا ينكسر «مجموع الفروع = الإجمالي».
          stockBatch.update(doc(db, 'users', ownerUid, 'products', itm.productId!), stockUpdateSeeded(lp ?? { quantity: 0 }, -baseQty, employeeBranchId));
        }
        stockBatch.commit().catch(err => {
          console.error('[Firestore] employee stock sync:', err);
          recordSyncIssue(`لم يُخصم مخزون الفاتورة ${toArabicDigits(invNumber)} (قد يكون منتج حُذف) — راجع صاحب المحل ليصحّح المخزون.`);
        });
      }

      // (fix 8) تحذير غير مانع بتجاوز المخزون — يظهر بدل رسالة النجاح إن وُجد
      const stockWarnings = checkStockWarnings(items);

      setLastPrintable(newInv);
      // حفظ + طباعة بضغطة واحدة — نطبع الفاتورة المحفوظة توّاً (newInv ملتقَط محلياً)
      if (shouldPrint) printInvoice(newInv);
      setItems([{ itemId: '1', name: '', quantity: 1, price: 0 }]);
      setBarcodeScanVal('');
      clearCustomer();
      setSaleType('cash');
      if (stockWarnings.length > 0) {
        triggerAlert(`تم الحفظ ⚠️ لكن كمية تتجاوز المخزون: ${stockWarnings.join(' | ')}`, 'danger');
      } else {
        triggerAlert(isDebt ? `تم تسجيل فاتورة دين على «${debtCustomerName}» ✅` : 'تم إصدار الفاتورة النقدية وحفظها بنجاح ✅');
      }
      setTimeout(() => barcodeScanRef.current?.focus(), 80);
    } finally {
      setIsSubmitting(false);
    }
  };

  const printInvoice = (inv: Invoice) => {
    printSingleInvoice({
      format: printFormat,
      invoice: inv,
      label: inv.customerName,
      currency,
      exchangeRate,
      store: { name: storeName, address: storeAddress, phone: storePhone },
      sellerName: inv.createdByName || employeeName,
      onError: (msg) => triggerAlert(msg, 'danger'),
    });
  };

  const sortedMyInvoices = useMemo(
    () => [...myInvoices].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [myInvoices]
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6" dir="rtl">

      {/* Alert */}
      {alert && (
        <div className={`lg:col-span-12 p-3 rounded-xl border text-xs font-bold flex items-center gap-2 ${
          alert.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
        }`}>
          <Info className="w-4 h-4 flex-shrink-0" />
          <span>{alert.text}</span>
        </div>
      )}

      {/* (fix 2) تحذير دائم بإخفاقات مزامنة سابقة — لا تُفقد فاتورة بصمت */}
      {syncIssues.length > 0 && (
        <div className="lg:col-span-12 p-3.5 rounded-xl border-2 border-rose-300 bg-rose-50 text-rose-800">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="font-extrabold text-xs flex items-center gap-1.5">
              <Info className="w-4 h-4 flex-shrink-0" />
              تنبيه: فواتير لم تُزامَن مع الخادم ({toArabicDigits(syncIssues.length)})
            </span>
            <button type="button" onClick={dismissSyncIssues}
              className="text-[11px] font-bold px-2.5 py-1 bg-white border border-rose-200 rounded-lg hover:bg-rose-100 transition cursor-pointer flex-shrink-0">
              فهمت — إخفاء
            </button>
          </div>
          <ul className="space-y-1 pr-1">
            {syncIssues.slice(0, 6).map((s, i) => (
              <li key={i} className="text-[11px] font-bold flex items-start gap-1.5">
                <span className="text-rose-400 mt-0.5">•</span>
                <span>{s.msg} <span className="text-rose-400 font-normal">({formatDate(new Date(s.at).toISOString().split('T')[0])})</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* LEFT: New cash invoice form */}
      <div className="lg:col-span-7 bg-white rounded-2xl p-6 border border-[#E4EAF3] shadow-sm space-y-5">
        <div className="flex justify-between items-center border-b border-slate-100 pb-3">
          <h3 className="font-extrabold text-sm text-[#0B1F4D] flex items-center gap-2">
            <Calculator className="w-5 h-5 text-indigo-700" />
            <span>فاتورة بيع نقدي جديدة</span>
          </h3>
          <span className="text-[11px] font-mono font-bold text-slate-500 bg-slate-100 px-2.5 py-1 rounded-lg">
            {toArabicDigits(displayInvoiceNumber)}
          </span>
        </div>

        <form onSubmit={(e) => handleSubmit(e)} className="space-y-4">
          {/* Barcode scan */}
          <div className={`p-3 rounded-2xl border-2 transition-colors ${barcodeScanError ? 'bg-rose-50 border-rose-400 animate-pulse' : 'bg-indigo-50/60 border-indigo-200'}`}>
            <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5 flex items-center gap-1.5">
              <Barcode className="w-4 h-4 text-indigo-600" />
              <span>قراءة الباركود 🔍</span>
              <span className="text-[9px] font-bold text-slate-400 mr-auto">قارئ USB أو يدوي + Enter</span>
            </label>
            <input
              ref={barcodeScanRef}
              type="text"
              value={barcodeScanVal}
              onChange={(e) => setBarcodeScanVal(e.target.value)}
              onKeyDown={handleBarcodeScanKeyDown}
              placeholder="ضع المؤشر هنا واقرأ باركود المادة..."
              dir="ltr"
              autoComplete="off"
              className={`w-full px-3 py-2.5 bg-white border rounded-xl text-sm text-center font-mono font-bold tracking-widest focus:outline-none focus:ring-2 ${barcodeScanError ? 'border-rose-300 focus:ring-rose-400 text-rose-700' : 'border-indigo-200 focus:ring-indigo-400 text-[#0B1F4D]'}`}
            />
          </div>

          {/* Items */}
          <div className="space-y-3 pt-1 border-t border-slate-100" ref={autocompleteRef}>
            <div className="flex justify-between items-center">
              <span className="text-xs font-extrabold text-[#0B1F4D]">المواد والكميات والأسعار</span>
              <button type="button" onClick={addNewItemRow} className="text-xs text-indigo-750 font-extrabold hover:underline inline-flex items-center gap-1 cursor-pointer">
                <Plus className="w-3.5 h-3.5" /><span>إضافة مادة</span>
              </button>
            </div>

            <div className="space-y-2 pr-1">
              {items.map((itm, idx) => {
                const suggestions = getProductSuggestions(idx);
                const showDropdown = activeAutocompleteIdx === idx && suggestions.length > 0;
                const linkedProduct = itm.productId ? products.find(p => p.id === itm.productId) : undefined;
                return (
                  <div key={idx} className="flex flex-wrap gap-2 items-center bg-slate-50/50 p-2 rounded-xl border border-slate-100">
                    <span className="text-[10px] text-slate-400 font-bold w-5 text-center flex-shrink-0">{toArabicDigits(idx + 1)}</span>

                    <div className="flex-1 relative min-w-0">
                      <input
                        type="text"
                        value={itm.name}
                        placeholder="اسم المادة أو امسح الباركود..."
                        onChange={(e) => handleItemNameChange(idx, e.target.value)}
                        onFocus={() => { if (!itm.productId) setActiveAutocompleteIdx(idx); }}
                        className={`w-full px-3 py-1.5 bg-white border rounded-lg text-xs text-right ${itm.productId ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200'}`}
                        required
                      />
                      {showDropdown && (
                        <div className="absolute top-full right-0 left-0 z-50 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
                          {suggestions.map(prod => (
                            <button key={prod.id} type="button" onMouseDown={(e) => { e.preventDefault(); handleSelectProduct(idx, prod); }}
                              className="w-full px-3 py-2 text-right text-xs hover:bg-indigo-50 flex justify-between items-center gap-2 border-b border-slate-50 last:border-0">
                              <span className="font-bold text-[#0B1F4D] truncate">{prod.name}</span>
                              <span className="text-[10px] text-slate-400 font-mono flex-shrink-0">
                                {formatCurrency(prod.sellPrice, currency, exchangeRate)}
                                {stockOf(prod, employeeBranchId) <= 0 ? ' ⚠️ نفد' : ` (${toArabicDigits(stockOf(prod, employeeBranchId))})`}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {linkedProduct?.hasWholesale && (
                      <div className="basis-full flex items-center gap-1.5 pr-7">
                        <span className="text-[9px] text-slate-400 font-bold flex-shrink-0">وحدة البيع:</span>
                        <select
                          value={itm.saleUnit ?? 'retail'}
                          onChange={(e) => handleChangeItemSaleUnit(idx, e.target.value as 'retail' | 'wholesale')}
                          className="px-2 py-1 bg-white border border-indigo-200 rounded-lg text-[10px] font-bold text-indigo-800 cursor-pointer outline-none"
                        >
                          <option value="retail">مفرد ({linkedProduct.unit || 'قطعة'})</option>
                          <option value="wholesale">{linkedProduct.wholesaleUnitName} ({toArabicDigits(linkedProduct.wholesaleUnitQty || 0)} {linkedProduct.unit || 'قطعة'})</option>
                        </select>
                      </div>
                    )}

                    {/* Serial / IMEI — يظهر فقط للأجهزة المعرّفة بضمان أو بتتبّع سيريال */}
                    {(linkedProduct?.defaultWarrantyMonths || linkedProduct?.tracksSerial) && (
                      <div className="basis-full flex items-center gap-1.5 pr-7">
                        <span className="text-[9px] text-emerald-700 font-extrabold flex-shrink-0">🛡️ السيريال/IMEI:</span>
                        <input
                          type="text"
                          value={itm.serials ?? ''}
                          onChange={(e) => updateItemField(idx, 'serials', e.target.value)}
                          placeholder={itm.quantity > 1 ? 'افصل بين الأرقام بفاصلة' : 'أدخل الرقم التسلسلي'}
                          dir="ltr"
                          className="flex-1 min-w-0 px-2 py-1 bg-white border border-emerald-200 rounded-lg text-[10px] font-mono font-bold text-center outline-none focus:border-emerald-500"
                        />
                        {!!linkedProduct?.defaultWarrantyMonths && (
                          <span className="text-[9px] text-emerald-700 font-bold flex-shrink-0 bg-emerald-50 px-1.5 py-1 rounded">
                            ضمان {toArabicDigits(linkedProduct.defaultWarrantyMonths)} شهر
                          </span>
                        )}
                      </div>
                    )}

                    <input type="text" inputMode="decimal" value={itm.quantity} placeholder="الكمية" min={1}
                      onChange={(e) => updateItemField(idx, 'quantity', Math.max(1, Number(e.target.value) || 1))}
                      className="w-16 px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-center font-bold flex-shrink-0" required />
                    <input type="text" inputMode="decimal" value={itm.price} placeholder="السعر"
                      onChange={(e) => updateItemField(idx, 'price', Math.max(0, readAmountOr(e.target.value, 0) ?? itm.price))}
                      className="w-24 px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-center font-bold flex-shrink-0" required />
                    <span className="text-[11px] text-[#0B1F4D] font-bold w-20 text-left font-mono flex-shrink-0">
                      {formatCurrency(itm.quantity * itm.price, currency, exchangeRate)}
                    </span>

                    {items.length > 1 && (
                      <button type="button" onClick={() => removeItemRow(idx)} className="p-1.5 border border-rose-100 hover:bg-rose-50 text-red-500 rounded-lg flex-shrink-0">
                        <Trash className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Sale type toggle */}
          <div className="pt-1 border-t border-slate-100 space-y-2.5">
            <span className="text-xs font-extrabold text-[#0B1F4D]">نوع البيع</span>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => { setSaleType('cash'); clearCustomer(); }}
                className={`py-2.5 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 border transition cursor-pointer ${saleType === 'cash' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                <Wallet className="w-4 h-4" /> نقدي
              </button>
              <button type="button" onClick={() => setSaleType('debt')}
                className={`py-2.5 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 border transition cursor-pointer ${saleType === 'debt' ? 'bg-amber-600 text-white border-amber-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                <Banknote className="w-4 h-4" /> بيع بالدين
              </button>
            </div>

            {/* Debt customer picker */}
            {saleType === 'debt' && (
              <div className="space-y-2 bg-amber-50/50 border border-amber-200 rounded-xl p-3" ref={custPickerRef}>
                <p className="text-[10px] text-amber-800 font-bold flex items-start gap-1">
                  <Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
                  بيع بالدين — لا يمكنك رؤية رصيد الزبون الحالي (تصميم مقصود لحماية بيانات الزبائن).
                </p>

                {selectedCust ? (
                  <div className="flex items-center justify-between gap-2 bg-white border border-amber-200 rounded-lg px-3 py-2">
                    <span className="text-xs font-extrabold text-[#0B1F4D] flex items-center gap-1.5 truncate"><User className="w-3.5 h-3.5 text-amber-600" />{selectedCust.name}</span>
                    <button type="button" onClick={clearCustomer} className="p-1 text-slate-400 hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ) : addingNewCust ? (
                  <div className="flex items-center gap-1.5">
                    <input type="text" value={newCustName} onChange={(e) => setNewCustName(e.target.value)} autoFocus
                      placeholder="اسم الزبون الجديد..." className="flex-1 px-3 py-2 bg-white border border-amber-300 rounded-lg text-xs text-right font-bold outline-none" />
                    <button type="button" onClick={() => { setAddingNewCust(false); setNewCustName(''); }} className="p-2 text-slate-400 hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ) : (
                  <div className="relative">
                    <div className="flex gap-1.5">
                      <div className="relative flex-1">
                        <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                        <input type="text" value={custSearch}
                          onChange={(e) => { setCustSearch(e.target.value); setCustDropdownOpen(true); }}
                          onFocus={() => setCustDropdownOpen(true)}
                          placeholder="ابحث عن زبون بالاسم..." className="w-full pr-8 pl-3 py-2 bg-white border border-amber-200 rounded-lg text-xs text-right font-bold outline-none" />
                      </div>
                      <button type="button" onClick={() => { setAddingNewCust(true); setCustDropdownOpen(false); }}
                        className="px-2.5 bg-white border border-amber-300 rounded-lg text-amber-700 hover:bg-amber-100 transition cursor-pointer flex items-center gap-1 text-[11px] font-bold">
                        <UserPlus className="w-3.5 h-3.5" /> جديد
                      </button>
                    </div>
                    {custDropdownOpen && custSuggestions.length > 0 && (
                      <div className="absolute top-full right-0 left-0 z-50 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden max-h-44 overflow-y-auto">
                        {custSuggestions.map(c => (
                          <button key={c.id} type="button" onMouseDown={(e) => { e.preventDefault(); pickCustomer(c); }}
                            className="w-full px-3 py-2 text-right text-xs hover:bg-amber-50 font-bold text-[#0B1F4D] border-b border-slate-50 last:border-0 truncate">
                            {c.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {custDropdownOpen && custSearch.trim() && custSuggestions.length === 0 && (
                      <div className="absolute top-full right-0 left-0 z-50 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg p-3 text-[11px] text-slate-400 font-bold text-center">
                        لا زبون بهذا الاسم — اضغط «جديد» لإضافته
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Total */}
          <div className={`p-3.5 rounded-xl border text-xs font-bold flex justify-between items-center ${saleType === 'debt' ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`}>
            <span className="text-[#0B1F4D]">{saleType === 'debt' ? 'إجمالي الدين:' : 'الإجمالي (نقداً):'}</span>
            <span className={`font-extrabold text-base font-mono ${saleType === 'debt' ? 'text-amber-700' : 'text-[#0B1F4D]'}`}>{formatCurrency(subtotal, currency, exchangeRate)}</span>
          </div>

          <button type="submit" disabled={isSubmitting}
            className={`w-full py-3 text-white font-extrabold rounded-xl text-xs shadow transition cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-wait ${saleType === 'debt' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-[#0B1F4D] hover:bg-[#13295E]'}`}>
            <Save className="w-4 h-4" />
            <span>{isSubmitting ? 'جارٍ الحفظ...' : saleType === 'debt' ? 'تسجيل فاتورة الدين' : 'إصدار الفاتورة النقدية'}</span>
          </button>

          {/* حفظ + طباعة بضغطة واحدة — للبيع السريع */}
          <button type="button" onClick={() => handleSubmit(undefined, true)} disabled={isSubmitting}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold rounded-xl text-xs shadow transition cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-wait">
            <Printer className="w-4 h-4" />
            <span>{isSubmitting ? 'جارٍ الحفظ...' : 'حفظ وطباعة الفاتورة'}</span>
          </button>
        </form>

        {lastPrintable && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-emerald-800">آخر فاتورة: {toArabicDigits(lastPrintable.invoiceNumber)}</span>
            <button type="button" onClick={() => printInvoice(lastPrintable)}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-bold flex items-center gap-1 transition cursor-pointer">
              <Printer className="w-3.5 h-3.5" /><span>طباعة</span>
            </button>
          </div>
        )}
      </div>

      {/* RIGHT: my invoices list */}
      <div className="lg:col-span-5 bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm space-y-3">
        <div className="flex justify-between items-center">
          <h4 className="font-extrabold text-xs text-[#0B1F4D] font-cairo flex items-center gap-1.5">
            <FileText className="w-4 h-4 text-emerald-600" />
            <span>فواتيري</span>
          </h4>
          <span className="text-[10px] bg-slate-100 border border-slate-200 font-black text-[#0B1F4D] px-2.5 py-0.5 rounded-full">
            {formatArabicNoun(sortedMyInvoices.length, ARABIC_NOUNS.invoice)}
          </span>
        </div>

        <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
          {sortedMyInvoices.length > 0 ? sortedMyInvoices.map(inv => (
            <div key={inv.id} className="rounded-xl border border-slate-200 px-3 py-2.5 flex justify-between items-center gap-2">
              <div className="min-w-0">
                <span className="text-[11px] text-slate-600 font-mono block">رقم {toArabicDigits(inv.invoiceNumber)} — {formatDate(inv.date)}</span>
                <span className="text-[10px] text-slate-400 block mt-0.5">{formatArabicNoun(inv.items.length, ARABIC_NOUNS.product)}</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="font-extrabold text-[11px] text-[#0B1F4D] font-mono">{formatCurrency(inv.finalAmount, currency, exchangeRate)}</span>
                <button type="button" onClick={() => printInvoice(inv)} title="طباعة"
                  className="p-1.5 bg-slate-100 hover:bg-[#0B1F4D] hover:text-white text-slate-600 rounded-lg transition cursor-pointer">
                  <Printer className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )) : (
            <div className="text-center py-10 text-slate-400 font-bold text-[11px]">لم تُصدر أي فاتورة بعد</div>
          )}
        </div>
      </div>
    </div>
  );
}
