import React, { useState, useRef, useEffect, useMemo } from 'react';
import { writeBatch, doc, updateDoc, increment, collection, query, where, getDocs } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { useCollection } from '../hooks/useCollection';
import { useConfirm } from '../hooks/useConfirm';
import {
  FileText, Search, Plus, Trash, Share2, Printer, Info,
  Edit, X, Percent, Trash2, Calendar, Save, Calculator, CreditCard, Clock, AlertTriangle, Barcode, RotateCcw
} from 'lucide-react';
import { Invoice, Customer, Product } from '../types';
import { toArabicDigits, toLatinDigits, formatArabicNoun, ARABIC_NOUNS, formatCurrency, parseAmount } from '../utils/arabicFormatters';
import { printInvoices } from '../utils/printInvoices';
import { printSingleInvoice } from '../utils/printReceipt';
import { syncCustomerPublic } from '../utils/customersPublic';
import { serialKeysOf, removedSerialKeys, serialSaleCounts, normalizeSerial } from '../utils/warranty';
import { ExpiryBatch } from '../types';
import { oldestActiveBatch, tracksExpiry, daysBetweenKeys } from '../utils/expiry';
import { removeWarrantyIndexFromBatch } from '../utils/warrantyIndex';
import { stageSale, customerBalanceOps, saleOpCount, BATCH_LIMIT } from '../utils/saleWrite';
import { guardWrite } from '../utils/writeGuard';
import { useActor } from '../hooks/useActor';
import { logAudit } from '../utils/auditLog';
import { allPaymentMethods, CASH_METHOD, PaymentSplit } from '../utils/paymentMethods';
import { useBranches, branchOf } from '../hooks/useBranches';
import { stockUpdate, stockUpdateSeeded, stockOf } from '../utils/branchStock';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { allocateOwnerNumber, duplicateNumbers, getDeviceTag } from '../utils/invoiceNumber';
import { readAmount, readAmountOr, readCount, AMOUNT_ERROR } from '../utils/amountField';
import { reportFirestoreError } from '../utils/writeGuard';
import { onExternalLink } from '../utils/openExternal';

interface InvoicesViewProps {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  ownerName?: string; // لوسم فواتير المالك (createdByName) — تمهيد للطي/سجل النشاط
  // بيانات المحل لترويسة الفاتورة المطبوعة (اسم المحل + عنوان صاحب العمل + هاتفه)
  storeName?: string;
  storeAddress?: string;
  storePhone?: string;
  customPaymentMethods?: string[]; // طرق دفع أضافها المالك فوق الافتراضية
  printFormat?: string;            // 'a4' | 'thermal80' | 'thermal58' — غيابه = A4
}

type FormItem = {
  itemId: string;
  name: string;
  quantity: number;
  price: number;
  productId?: string;
  saleUnit?: 'retail' | 'wholesale'; // undefined/'retail' = وحدة الأساس (المفرد)
  // أرقام تسلسلية/IMEI كنص خام (يفصلها المستخدم بفاصلة أو سطر جديد) — تُحوَّل لمصفوفة عند الحفظ
  serials?: string;
};

// عرض اسم المادة مع وحدة البيع إن وُجدت (مثال: "حليب - كارتون") — متوافق مع الفواتير القديمة بلا unitLabel
const itemDisplayName = (it: { name: string; unitLabel?: string }): string =>
  it.unitLabel ? `${it.name} - ${it.unitLabel}` : it.name;

// نص السيريالات (يفصلها المستخدم بفاصلة عربية/لاتينية أو سطر جديد) → مصفوفة نظيفة بلا تكرار
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

const formatDate = (dateStr: string): string => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (!isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return d.toLocaleDateString('ar-IQ');
  }
  return toArabicDigits(dateStr);
};

export default function InvoicesView({ currency, exchangeRate, ownerName, storeName, storeAddress, storePhone, customPaymentMethods, printFormat }: InvoicesViewProps) {
  const paymentMethodOptions = useMemo(() => allPaymentMethods(customPaymentMethods), [customPaymentMethods]);
  // ترويسة المحل المشتركة لكل طباعات هذه الشاشة
  const printStore = { name: storeName, address: storeAddress, phone: storePhone };
  const actor = useActor(); // لسجل التدقيق — مَن نفّذ العمليات الحساسة (حذف/إرجاع/تعديل)
  // الفرع: تُوسم به الفواتير الجديدة، وتُصفّى القائمة حسب الفرع النشط (فرع واحد ⇒ بلا أثر)
  const { activeBranchId, stampBranchId, matchesActiveBranch, isMultiBranch, branchName } = useBranches(storeName);
  /**
   * وضع «كل الفروع» = عرض مجمّع للمراجعة فقط، لا يصلح للبيع.
   * البيع منه كان يُنسب الفاتورة للفرع الرئيسي صامتاً ويخصم من مخزونه — حتى لو خرجت
   * البضاعة من المخزن. لا رسالة ولا أثر. فنمنع الإصدار ونطلب اختيار الفرع صراحةً.
   * (التعديل على فاتورة قائمة يبقى مسموحاً — فرعها محفوظ فيها ولا يتغيّر.)
   */
  const isAggregateView = isMultiBranch && !activeBranchId;
  // ---- 1. FIRESTORE DATA LAYER ----
  const { items: invoices, save: saveInvoice, remove: removeInvoice } = useCollection<Invoice>('invoices');
  const { items: systemCustomers, save: saveCustomer } = useCollection<Customer>('customers');
  const { items: products } = useCollection<Product>('products');
  /**
   * شحنات الصلاحية — لتذكير «بِع بالأقدم أولاً» لحظة اختيار المادة.
   * كانت `oldestActiveBatch` مبنية ومختبَرة و**غير موصولة بأي شاشة**: التذكير الذي يمنع
   * التلف أصلاً — وهو غرض شاشة الصلاحية كلها — لم يصل نقطة البيع قط.
   */
  const { items: expiryBatches } = useCollection<ExpiryBatch>('expiry_batches');
  const inventoryItems: Product[] = products;
  const inventoryCollection = 'products';

  // ---- 2. UI CONTROL & FORM STATES ----
  const [search, setSearch] = useState('');
  // فلتر جهة الإصدار: الكل / فواتيري (المالك) / فواتير الموظفين
  const [issuerFilter, setIssuerFilter] = useState<'all' | 'mine' | 'employees'>('all');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editingInvoiceId, setEditingInvoiceId] = useState<string | null>(null);

  // Form State
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState(''); // used only while editing
  const [invoiceDate, setInvoiceDate] = useState(todayISO);
  const [discountVal, setDiscountVal] = useState('0');
  const [taxRateVal, setTaxRateVal] = useState('0');
  const [paidAmountVal, setPaidAmountVal] = useState(''); // empty = fully paid
  // ---- طرق الدفع ----
  // الوضع البسيط: طريقة واحدة للمبلغ الواصل كله. الوضع المقسَّم: عدّة طرق بمبالغ محدّدة.
  const [payMethod, setPayMethod] = useState<string>(CASH_METHOD);
  const [splitMode, setSplitMode] = useState(false);
  const [paySplits, setPaySplits] = useState<PaymentSplit[]>([{ method: CASH_METHOD, amount: 0 }]);
  const [items, setItems] = useState<FormItem[]>([
    { itemId: '1', name: '', quantity: 1, price: 0 }
  ]);

  // Autocomplete — products
  const [activeAutocompleteIdx, setActiveAutocompleteIdx] = useState<number | null>(null);
  const autocompleteRef = useRef<HTMLDivElement | null>(null);

  // Barcode scanner — dedicated scan field (USB scanner types code + Enter)
  const [barcodeScanVal, setBarcodeScanVal] = useState('');
  const [barcodeScanError, setBarcodeScanError] = useState(false);
  const barcodeScanRef = useRef<HTMLInputElement | null>(null);

  // Autocomplete — customer name
  const [customerSuggestionsOpen, setCustomerSuggestionsOpen] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const customerInputWrapRef = useRef<HTMLDivElement | null>(null);

  // Grouped invoice list expand/collapse state
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // ---- Batch-print selection state (manual checkboxes + date range) ----
  const [selectedForPrint, setSelectedForPrint] = useState<Set<string>>(new Set());
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');

  // Notification states
  const [whatsappShareMsg, setWhatsappShareMsg] = useState<string | null>(null);
  const [isPrintLayout, setIsPrintLayout] = useState(false);
  const [isThermalMode, setIsThermalMode] = useState(true);
  const [alert, setAlert] = useState<{ text: string; type: 'success' | 'danger' } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { requestConfirm, confirmDialog } = useConfirm();

  // ---- إرجاع / استرجاع الفاتورة (كلي أو جزئي) ----
  const [returnModalOpen, setReturnModalOpen] = useState(false);
  const [returnInvoiceId, setReturnInvoiceId] = useState<string | null>(null);
  const [returnQtys, setReturnQtys] = useState<Record<string, number>>({}); // itemId → كمية الاسترجاع
  const [returnSearch, setReturnSearch] = useState('');
  const [isReturning, setIsReturning] = useState(false);

  const triggerAlert = (text: string, type: 'success' | 'danger' = 'success') => {
    setAlert({ text, type });
    setTimeout(() => setAlert(null), 5000);
  };

  // Close product autocomplete when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (autocompleteRef.current && !autocompleteRef.current.contains(e.target as Node)) {
        setActiveAutocompleteIdx(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close customer autocomplete when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (customerInputWrapRef.current && !customerInputWrapRef.current.contains(e.target as Node)) {
        setCustomerSuggestionsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // تركيز حقل الباركود فور فتح الشاشة — كان يحدث فقط بعد ضغط «إنشاء فاتورة جديدة»، فمن يدخل
  // التبويب ويقرأ الباركود مباشرةً لا يُلتقط شيء فيبدو القارئ معطّلاً. لا نسحب التركيز إن كان
  // المستخدم يكتب في حقل آخر.
  useEffect(() => {
    const t = setTimeout(() => {
      const active = document.activeElement;
      const typingElsewhere = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      if (!typingElsewhere) barcodeScanRef.current?.focus();
    }, 120);
    return () => clearTimeout(t);
  }, []);

  // ---- مسودّة الفاتورة الجديدة: تبقى محفوظة عند مغادرة الشاشة والعودة، حتى إصدارها ----
  // InvoicesView يُلغى تركيبه عند تبديل التبويب فتضيع الحقول. نحفظ المسودّة في localStorage
  // ونستعيدها عند العودة. تُمسح تلقائياً حين تفرغ الحقول (بعد الإصدار أو بدء فاتورة جديدة).
  const draftKey = () => {
    const uid = auth.currentUser?.uid;
    return uid ? `ratib_invoice_draft_${uid}` : null;
  };
  const draftRestoredRef = useRef(false);
  const skipFirstDraftSaveRef = useRef(true);

  // استعادة المسودّة مرة واحدة عند التركيب (لفاتورة جديدة فقط — لا أثناء التعديل)
  useEffect(() => {
    if (draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    if (isEditing) return;
    const key = draftKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (Array.isArray(d.items) && d.items.length) setItems(d.items);
      if (typeof d.customerName === 'string') setCustomerName(d.customerName);
      if (typeof d.customerPhone === 'string') setCustomerPhone(d.customerPhone);
      if (typeof d.discountVal === 'string') setDiscountVal(d.discountVal);
      if (typeof d.taxRateVal === 'string') setTaxRateVal(d.taxRateVal);
      if (typeof d.paidAmountVal === 'string') setPaidAmountVal(d.paidAmountVal);
      if (typeof d.invoiceDate === 'string') setInvoiceDate(d.invoiceDate);
      if (d.selectedCustomerId) setSelectedCustomerId(d.selectedCustomerId);
    } catch { /* مسودّة تالفة — تُتجاهل */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // حفظ المسودّة عند كل تغيير (لفاتورة جديدة فقط). نتخطّى أول تشغيل (حالة التركيب الفارغة)
  // كي لا نمسح مسودّة نستعيدها للتوّ. الحقول الفارغة تمسح المسودّة.
  useEffect(() => {
    if (skipFirstDraftSaveRef.current) { skipFirstDraftSaveRef.current = false; return; }
    if (isEditing) return; // لا مسودّة أثناء تعديل فاتورة قائمة
    const key = draftKey();
    if (!key) return;
    const hasContent = items.some(it => it.name.trim() || it.productId) || customerName.trim() !== '';
    if (hasContent) {
      try {
        localStorage.setItem(key, JSON.stringify({
          items, customerName, customerPhone, discountVal, taxRateVal, paidAmountVal, invoiceDate, selectedCustomerId,
        }));
      } catch { /* تعذّر التخزين — غير حرج */ }
    } else {
      localStorage.removeItem(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, items, customerName, customerPhone, discountVal, taxRateVal, paidAmountVal, invoiceDate, selectedCustomerId]);

  // One-time repair (per session): link orphan invoices (no customerId) to their
  // customer when the name matches exactly one existing customer. Balances untouched —
  // they were accumulated correctly; only the link was broken by the old save order.
  const repairRanRef = useRef(false);
  useEffect(() => {
    if (repairRanRef.current) return;
    if (invoices.length === 0 || systemCustomers.length === 0) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    repairRanRef.current = true;

    const orphans = invoices.filter(inv =>
      !inv.customerId &&
      inv.customerName.trim() &&
      inv.customerName.trim() !== 'زبون عام'
    );
    if (orphans.length === 0) return;

    const updates: { invId: string; customerId: string }[] = [];
    for (const inv of orphans) {
      const matches = systemCustomers.filter(
        c => c.name.trim().toLowerCase() === inv.customerName.trim().toLowerCase()
      );
      // اسم يطابق زبوناً واحداً بالضبط — الغموض (0 أو أكثر من مطابقة) يُترك كما هو
      if (matches.length === 1) updates.push({ invId: inv.id, customerId: matches[0].id });
    }
    if (updates.length === 0) return;

    // Chunked batches (Firestore limit 500 ops), fire-and-forget for offline safety
    const CHUNK = 450;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const batch = writeBatch(db);
      for (const u of updates.slice(i, i + CHUNK)) {
        batch.update(doc(db, 'users', uid, 'invoices', u.invId), { customerId: u.customerId });
      }
      batch.commit().catch(err => reportFirestoreError('invoices', 'batch', err, '[Firestore] repair invoice links'));
    }
  }, [invoices, systemCustomers]);

  // ---- 3. CALCULATIONS ----
  const calculatedSubtotal = items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
  const parsedDiscount = readAmountOr(discountVal, 0) ?? 0;
  const parsedTaxRate = readAmountOr(taxRateVal, 0) ?? 0;
  const calculatedTaxAmount = Math.round((calculatedSubtotal - parsedDiscount) * (parsedTaxRate / 100));
  const calculatedFinalAmount = calculatedSubtotal - parsedDiscount + calculatedTaxAmount;

  /**
   * 🔴 أخطر خانة في البرنامج: فراغها يعني «مدفوع بالكامل».
   *
   * حين كانت `type="number"` كان المتصفح يفرّغها عند كتابة الأرقام العربية، فالتاجر يكتب
   * «٢٠٠٠٠» كدفعة أولى ⇒ تُقرأ الخانة فارغة ⇒ **تُسجَّل الفاتورة مدفوعة بالكامل ويختفي
   * الدَّين كله**، ولا يعترض شيء لأن `remaining` صار صفراً.
   *
   * الآن الخانة نصّية تقبل العربية، والنص غير المفهوم يُرفض عند الحفظ صراحةً (أدناه)
   * بدل أن يمرّ صفراً أو «مدفوعاً بالكامل».
   */
  const paidRead = readAmount(paidAmountVal);
  const parsedPaidAmount = paidRead.state === 'empty'
    ? calculatedFinalAmount
    : paidRead.state === 'ok' ? Math.max(0, paidRead.value) : 0;
  const calculatedRemaining = Math.max(0, calculatedFinalAmount - parsedPaidAmount);

  // توزيع المبلغ الواصل على طرق الدفع: في الوضع البسيط كله على طريقة واحدة، وفي المقسَّم
  // حسب ما أدخله المستخدم. splitTotal لعرض الفارق والتحقق قبل الحفظ.
  const splitTotal = paySplits.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const splitDiff = parsedPaidAmount - splitTotal;
  const buildPayments = (paidAmt: number): PaymentSplit[] =>
    splitMode
      ? paySplits.filter(p => (Number(p.amount) || 0) > 0).map(p => ({ method: p.method, amount: Math.round(Number(p.amount) || 0) }))
      : [{ method: payMethod, amount: Math.round(paidAmt) }];

  // ---- 4. DYNAMIC DEFAULTS ----
  // رمز هذا الجهاز — يُستعمل فقط إن ظهر في البيانات جهاز آخر (انظر invoiceNumber.ts)
  const myDeviceTag = useMemo(() => getDeviceTag(auth.currentUser?.uid), [auth.currentUser?.uid]);

  /**
   * الرقم التالي — مضمون أنه حرّ، وموسوم برمز الجهاز عند وجود أكثر من جهاز.
   * (fix 13) فواتير الموظفين (`بادئة-تسلسل`) مستثناة من تسلسل المالك — يتكفّل بذلك ownerSeqOf.
   */
  const getNextInvoiceNumber = (): string => allocateOwnerNumber(invoices, myDeviceTag);

  const displayInvoiceNumber = isEditing ? invoiceNumber : getNextInvoiceNumber();

  /**
   * السيريالات المُباعة سابقاً — لتحذير التاجر **لحظة الكتابة**.
   * أثناء تعديل فاتورة نستثني سطورها هي نفسها، وإلا حذّرناه من سيريالها الذي يعدّله.
   */
  const soldSerialCounts = useMemo(
    () => serialSaleCounts(isEditing && editingInvoiceId ? invoices.filter(i => i.id !== editingInvoiceId) : invoices),
    [invoices, isEditing, editingInvoiceId],
  );

  // أرقام مكرّرة وقعت قبل هذا الإصلاح — تُعرَض للتاجر بدل أن تنفجر يوم الخلاف مع زبون
  const duplicateInvoiceNumbers = useMemo(() => duplicateNumbers(invoices), [invoices]);

  const handleOpenCreateForm = () => {
    setIsEditing(false);
    setEditingInvoiceId(null);
    setCustomerName('');
    setCustomerPhone('');
    setInvoiceDate(todayISO());
    setInvoiceNumber('');
    setDiscountVal('0');
    setTaxRateVal('0');
    setPaidAmountVal('');
    setItems([{ itemId: '1', name: '', quantity: 1, price: 0 }]);
    setActiveAutocompleteIdx(null);
    setCustomerSuggestionsOpen(false);
    setSelectedCustomerId(null);
    setBarcodeScanVal('');
    setTimeout(() => {
      // لا نسحب التركيز إذا بدأ المستخدم الكتابة في حقل آخر خلال المهلة
      const active = document.activeElement;
      const typingElsewhere = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      if (!typingElsewhere) barcodeScanRef.current?.focus();
    }, 80);
    triggerAlert('تم تهيئة نموذج فاتورة جديدة');
  };

  const handleOpenEditForm = (inv: Invoice) => {
    setIsEditing(true);
    setEditingInvoiceId(inv.id);
    setCustomerName(inv.customerName);
    setCustomerPhone('');
    setInvoiceNumber(inv.invoiceNumber);
    let dateISO = todayISO();
    if (/^\d{4}-\d{2}-\d{2}/.test(inv.date)) {
      dateISO = inv.date.split('T')[0];
    } else {
      const parsed = new Date(inv.date);
      if (!isNaN(parsed.getTime())) dateISO = parsed.toISOString().split('T')[0];
    }
    setInvoiceDate(dateISO);
    setDiscountVal(String(inv.discount));
    const disc = inv.discount || 0;
    const preTax = inv.totalAmount - disc;
    const rate = preTax > 0 ? Math.round((inv.tax / preTax) * 100) : 0;
    setTaxRateVal(String(rate));
    setPaidAmountVal(inv.paidAmount !== undefined ? String(inv.paidAmount) : '');
    setItems(inv.items.map(itm => ({
      itemId: itm.itemId,
      name: itm.name,
      quantity: itm.quantity,
      price: itm.price,
      productId: itm.productId,
      // استنتاج الوحدة من معامل التحويل المخزَّن وقت البيع (>1 = جملة)
      saleUnit: (itm.unitConversionQty && itm.unitConversionQty > 1) ? 'wholesale' : 'retail',
      serials: (itm.serials ?? []).join('، '), // إعادة السيريالات للنموذج عند التعديل
    })));
    setActiveAutocompleteIdx(null);
    setCustomerSuggestionsOpen(false);
    setSelectedCustomerId(inv.customerId ?? null);
    triggerAlert(`جاري تحرير الفاتورة رقم ${inv.invoiceNumber}`);
  };

  const getCustomerSuggestions = (): Customer[] => {
    const query = customerName.trim().toLowerCase();
    if (!query) return [];
    return systemCustomers.filter(c =>
      c.name.toLowerCase().includes(query)
    ).slice(0, 8);
  };

  const handleSelectCustomerFromList = (cust: Customer) => {
    setCustomerName(cust.name);
    setCustomerPhone(cust.phone || '');
    setSelectedCustomerId(cust.id);
    setCustomerSuggestionsOpen(false);
  };

  // ---- 4b. BARCODE SCAN → ADD ITEM ----
  const handleBarcodeScanSubmit = () => {
    const code = barcodeScanVal.trim();
    if (!code) return;

    const product = inventoryItems.find(p => p.barcode === code);
    if (!product) {
      setBarcodeScanError(true);
      setTimeout(() => setBarcodeScanError(false), 700);
      triggerAlert(`لا يوجد منتج بهذا الباركود [${toArabicDigits(code)}]`, 'danger');
      setBarcodeScanVal('');
      barcodeScanRef.current?.focus();
      return;
    }

    setItems(prev => {
      // نفس المنتج بنفس وحدة البيع (مفرد افتراضياً للباركود) موجود مسبقاً → زيادة الكمية فقط
      // سطر بوحدة جملة لنفس المنتج يبقى منفصلاً (سعر مختلف — لا يُدمَج)
      const existingIdx = prev.findIndex(
        it => it.productId === product.id && (it.saleUnit ?? 'retail') === 'retail'
      );
      if (existingIdx !== -1) {
        const copy = [...prev];
        copy[existingIdx] = { ...copy[existingIdx], quantity: copy[existingIdx].quantity + 1 };
        return copy;
      }
      // Reuse the first empty row if present, otherwise append a new row
      const emptyIdx = prev.findIndex(it => !it.name.trim() && !it.productId);
      const newRow: FormItem = {
        itemId: emptyIdx !== -1 ? prev[emptyIdx].itemId : String(Date.now()),
        name: product.name,
        quantity: 1,
        price: product.sellPrice,
        productId: product.id,
        saleUnit: 'retail',
      };
      if (emptyIdx !== -1) {
        const copy = [...prev];
        copy[emptyIdx] = newRow;
        return copy;
      }
      return [...prev, newRow];
    });

    setBarcodeScanVal('');
    barcodeScanRef.current?.focus();
  };

  const handleBarcodeScanKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // do not submit the invoice form
      handleBarcodeScanSubmit();
    }
  };

  // ---- 5. ITEM ROW OPERATIONS ----
  const addNewItemRow = () => {
    setItems([...items, { itemId: String(items.length + 1), name: '', quantity: 1, price: 0 }]);
  };

  const removeItemRow = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
    setActiveAutocompleteIdx(null);
  };

  const updateItemField = <K extends keyof FormItem>(idx: number, field: K, value: FormItem[K]) => {
    const copy = [...items];
    copy[idx] = { ...copy[idx], [field]: value };
    setItems(copy);
  };

  const handleItemNameChange = (idx: number, value: string) => {
    const copy = [...items];
    copy[idx] = { ...copy[idx], name: value, productId: undefined };
    setItems(copy);
    setActiveAutocompleteIdx(idx);
  };

  const handleSelectProduct = (idx: number, product: Product) => {
    const copy = [...items];
    copy[idx] = { ...copy[idx], name: product.name, price: product.sellPrice, productId: product.id, saleUnit: 'retail' };
    setItems(copy);
    setActiveAutocompleteIdx(null);
  };

  // تغيير وحدة البيع لسطر مرتبط بمنتج — يعيد ضبط السعر تلقائياً حسب الوحدة الجديدة
  const handleChangeItemSaleUnit = (idx: number, unit: 'retail' | 'wholesale') => {
    const item = items[idx];
    const product = item.productId ? inventoryItems.find(p => p.id === item.productId) : undefined;
    if (!product) return;
    const copy = [...items];
    // (fix 12) بديل آمن لسعر الجملة الغائب = سعر المفرد × عدد القطع بالكرتون (لا سعر قطعة واحدة)
    const wholesaleUnitPrice = product.wholesalePrice ?? (product.sellPrice * (product.wholesaleUnitQty || 1));
    copy[idx] = {
      ...copy[idx],
      saleUnit: unit,
      price: unit === 'wholesale' ? wholesaleUnitPrice : product.sellPrice,
    };
    setItems(copy);
  };

  const getProductSuggestions = (idx: number): (Product)[] => {
    const query = items[idx]?.name?.trim().toLowerCase();
    if (!query) return [];
    return inventoryItems.filter(p =>
      p.name.toLowerCase().includes(query) ||
      (p.barcode && p.barcode.includes(query))
    ).slice(0, 6);
  };

  const handleItemNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, idx: number) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const query = items[idx]?.name?.trim();
      if (!query) return;
      const exactBarcode = inventoryItems.find(p => p.barcode === query);
      if (exactBarcode) {
        handleSelectProduct(idx, exactBarcode);
      }
    }
  };

  // ---- 6. INVENTORY SYNC ----
  // المخزون دائماً بوحدة الأساس — unitConversionQty يحوّل كمية الجملة إليها (1 أو undefined = مفرد)
  const syncInventory = async (
    invoiceItems: Array<{ productId?: string; quantity: number; unitConversionQty?: number }>,
    sign: 1 | -1,
    // فرع المخزون المتأثر: عند التعديل/الحذف يعود المخزون **لفرع الفاتورة الأصلي** لا للفرع
    // النشط حالياً — وإلا نقلنا بضاعة بين الفروع بالخطأ.
    branchForStock: string = stampBranchId,
  ) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    // تخطي المنتجات المحذوفة — batch.update على doc غير موجود يُفشل الدفعة كلها ذرّياً
    const existingProductIds = new Set(inventoryItems.map(p => p.id));
    const relevant = invoiceItems.filter(i => i.productId && existingProductIds.has(i.productId));
    if (relevant.length === 0) return;
    const batch = writeBatch(db);
    for (const item of relevant) {
      const ref = doc(db, 'users', uid, inventoryCollection, item.productId!);
      const baseQty = item.quantity * (item.unitConversionQty ?? 1);
      // يخصم/يضيف من الإجمالي ومن مخزون الفرع معاً في تحديث ذرّي واحد.
      // Seeded: يحمي المنتج القديم لو بِيع قبل أن يكمل ترحيل خريطة الفروع.
      const lp = inventoryItems.find(x => x.id === item.productId);
      batch.update(ref, stockUpdateSeeded(lp ?? { quantity: 0 }, sign * baseQty, branchForStock));
    }
    // Fire-and-forget: local cache applies instantly; awaiting server ack hangs offline
    batch.commit().catch(err => reportFirestoreError('products', 'batch', err, '[Firestore] syncInventory'));
  };

  // كمية السطر محوَّلة لوحدة الأساس — للمقارنة مع المخزون المتاح
  const getItemBaseQuantity = (item: FormItem, product?: Product): number => {
    if (item.saleUnit === 'wholesale' && product?.hasWholesale) {
      return item.quantity * (product.wholesaleUnitQty || 1);
    }
    return item.quantity;
  };

  // ---- 7. STOCK WARNING ----
  const checkStockWarnings = (formItems: FormItem[]): string[] => {
    return formItems
      .filter(item => item.productId)
      .map(item => {
        const product = inventoryItems.find(p => p.id === item.productId);
        const baseQty = getItemBaseQuantity(item, product);
        // التحذير يقارن بمخزون **الفرع الذي يبيع منه** لا بالإجمالي عبر الفروع
        const available = product ? stockOf(product, stampBranchId) : 0;
        if (product && baseQty > available) {
          const unitSuffix = item.saleUnit === 'wholesale' && product.wholesaleUnitName
            ? ` ${product.wholesaleUnitName}`
            : '';
          return `"${item.name}": مطلوب ${toArabicDigits(item.quantity)}${unitSuffix} (${toArabicDigits(baseQty)} ${product.unit || ''}) — متوفر ${toArabicDigits(available)} ${product.unit || ''}`;
        }
        return null;
      })
      .filter(Boolean) as string[];
  };

  // ---- 8. CUSTOMER DEBT UPDATE + IDENTITY RESOLUTION ----
  // يحسم هوية الزبون ويطبّق فرق الدين، ويعيد customerId لربطه بالفاتورة قبل حفظها.
  // يُستدعى قبل saveInvoice حتى لا تُحفظ الفاتورة الأولى للزبون الجديد يتيمة بلا ربط.
  //
  // (fix 7) تحديث الرصيد للزبون الموجود يستخدم increment(delta) لا كتابة قيمة مطلقة من لقطة محلية.
  //   الكتابة المطلقة تتسابق مع increment الخاص بطيّ ديون الموظف (useEmployeeDebtFold) فتمسح
  //   دلتاه ⇒ يضيع دين موظف من رصيد الزبون. increment تبادلي وآمن أوفلاين فيتراكب بأمان.
  // (fix 9) foldDeferred=true لفاتورة دين موظف لم تُطوَ بعد: دَينها ليس في الرصيد أصلاً (الطي
  //   يضيفه لاحقاً)، فلا نمسّ الرصيد هنا إطلاقاً؛ نكتفي بحسم الهوية/الإنشاء (برصيد صفر) لئلا يُضاعَف.
  /**
   * 🔧 صارت **تحسم الهوية ولا تكتب**.
   *
   * كانت تكتب رصيد الزبون بنفسها (`updateDoc … increment`) وتُنشئ الزبون بـ`saveCustomer`،
   * أي كتابتان مستقلّتان عن كتابة الفاتورة. فرصيدٌ يزيد بلا فاتورة تُسنده، أو فاتورةٌ
   * بدين لا يظهر في الرصيد — انحرافٌ صامت يظهر بعد أسابيع.
   *
   * الآن تُعيد ما يلزم لبناء الخطّة، ويكتب `stageSale` كل شيء في **دفعة ذرّية واحدة**.
   * ملاحظة: الرصيد لم يعد يُحسب هنا إطلاقاً — `customerBalanceOps` تملكه وحدها ومحروسة
   * باختبارات، فلا يتفرّق منطق المال على موضعين.
   */
  const resolveSaleCustomer = (
    name: string, phone: string, delta: number, invNum: string, foldDeferred = false
  ): { customerId?: string; newCustomer?: Customer } => {
    const trimmed = name.trim();
    if (!trimmed) return {}; // بيع نقدي بلا اسم (زبون عام) — لا ربط ولا إنشاء

    // الاختيار الصريح من القائمة يُقدَّم على المطابقة بالاسم (يحمي من تشابه الأسماء)
    const match =
      (selectedCustomerId ? systemCustomers.find(c => c.id === selectedCustomerId) : undefined)
      ?? systemCustomers.find(c => c.name.trim().toLowerCase() === trimmed.toLowerCase());

    if (match) return { customerId: match.id };

    // إنشاء زبون جديد عند وجود دين (delta>0) — أو عند تأجيل الطي (نحتاج ربطاً لتُطوى لاحقاً)
    if (delta > 0 || foldDeferred) {
      const newCustomer: Customer = {
        id: genId(),
        name: trimmed,
        phone: phone.trim(),
        address: '',
        notes: `أضيف تلقائياً من الفاتورة رقم ${invNum}`,
        // يُنشأ دائماً برصيد صفر، وحركةُ الدين تأتي من balanceOps في نفس الدفعة —
        // فلا يُحتسب الدين مرّتين (مرة في القيمة الابتدائية ومرة في increment).
        balance: 0,
        dueDate: '',
        createdAt: todayISO(),
      };
      return { customerId: newCustomer.id, newCustomer };
    }

    // اسم جديد بلا دين (نقدي) — لا يُنشأ زبون
    return {};
  };

  // ---- 9. FORM SUBMISSION ----
  // shouldPrint: عند الضغط على «حفظ وطباعة» تُطبع الفاتورة المحفوظة فوراً (حفظ + طباعة بضغطة واحدة)
  const handleSubmitForm = async (e: React.FormEvent | undefined, shouldPrint = false) => {
    e?.preventDefault();
    if (isSubmitting) return; // حماية من الضغط المزدوج السريع
    // البيع من العرض المجمّع ممنوع — لا نخمّن الفرع الذي خرجت منه البضاعة
    if (isAggregateView && !isEditing) {
      triggerAlert('أنت في وضع «كل الفروع» — اختر الفرع الذي تبيع منه من أعلى الشاشة قبل إصدار الفاتورة', 'danger');
      return;
    }
    // فاتورة فارغة: يلزم سطر واحد على الأقل فيه اسم مادة أو منتج مرتبط
    const meaningfulItems = items.filter(it => it.name.trim() || it.productId);
    if (meaningfulItems.length === 0) {
      triggerAlert('يرجى إدراج مادة واحدة على الأقل', 'danger');
      return;
    }

    setIsSubmitting(true);
    try {

    // 🔴 حجب المبالغ غير المفهومة **قبل أي حساب**: لا يجوز أن يصير نصٌّ لا يُقرأ صفراً،
    // ولا أن تُقرأ خانة «الواصل» فارغةً فتُسجَّل الفاتورة مدفوعةً بالكامل ويختفي الدَّين.
    const discRead = readAmountOr(discountVal, 0);
    const taxRead = readAmountOr(taxRateVal, 0);
    const paidReadNow = readAmount(paidAmountVal);
    if (discRead === null) { triggerAlert(`الخصم: ${AMOUNT_ERROR}`, 'danger'); return; }
    if (taxRead === null) { triggerAlert(`نسبة الضريبة: ${AMOUNT_ERROR}`, 'danger'); return; }
    if (paidReadNow.state === 'invalid') { triggerAlert(`المبلغ الواصل: ${AMOUNT_ERROR}`, 'danger'); return; }

    const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
    const disc = discRead;
    const taxAmt = calculatedTaxAmount;
    const final = subtotal - disc + taxAmt;
    const paidAmt = paidReadNow.state === 'empty' ? final : Math.max(0, paidReadNow.value);
    const remaining = Math.max(0, final - paidAmt);

    // حجب المدخلات غير الصالحة — الكميات والأسعار والخصم
    if (meaningfulItems.some(it => (readAmountOr(it.quantity, 0) ?? 0) <= 0)) {
      triggerAlert('كمية المادة يجب أن تكون أكبر من صفر', 'danger');
      return;
    }
    if (meaningfulItems.some(it => Number(it.price) < 0)) {
      triggerAlert('سعر المادة لا يمكن أن يكون سالباً', 'danger');
      return;
    }
    if (disc < 0) {
      triggerAlert('الخصم لا يمكن أن يكون سالباً', 'danger');
      return;
    }
    if (disc > subtotal) {
      triggerAlert('الخصم لا يمكن أن يتجاوز مجموع الفاتورة', 'danger');
      return;
    }
    // التحقق من تقسيم الدفع: مجموع الطرق يجب أن يساوي المبلغ الواصل تماماً
    if (splitMode && paidAmt > 0) {
      const st = paySplits.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      if (Math.round(st) !== Math.round(paidAmt)) {
        triggerAlert(
          `مجموع طرق الدفع (${formatCurrency(st, currency, exchangeRate)}) لا يساوي المبلغ الواصل (${formatCurrency(paidAmt, currency, exchangeRate)})`,
          'danger',
        );
        return;
      }
    }

    // البيع النقدي: الاسم اختياري. البيع بالدين: الاسم إلزامي لتسجيل الدين على الحساب الصحيح
    if (remaining > 0 && !customerName.trim()) {
      triggerAlert('البيع بالدين يتطلب اختيار العميل — اكتب اسم الزبون أو سدّد المبلغ كاملاً', 'danger');
      return;
    }
    // "زبون عام" اسم افتراضي للنقدي فقط — لا يجوز تسجيل دين عليه (يسد ثغرة التعديل أيضاً)
    if (remaining > 0 && customerName.trim() === 'زبون عام') {
      triggerAlert('لا يمكن تحويل فاتورة زبون عام إلى دين — حدّد اسم عميل حقيقي أولاً', 'danger');
      return;
    }
    // اسم افتراضي للبيع النقدي بدون عميل — لا يُنشأ زبون بهذا الاسم ولا يُربط بسجل
    const effectiveCustomerName = customerName.trim() || 'زبون عام';

    const formattedItems = items.map((itm, index) => {
      const linkedProduct = itm.productId ? inventoryItems.find(p => p.id === itm.productId) : undefined;
      const isWholesaleRow = itm.saleUnit === 'wholesale' && linkedProduct?.hasWholesale;
      // معامل التحويل واسم الوحدة يُلتقطان لحظة البيع — لضمان صحة الفاتورة تاريخياً حتى لو تغيّر المنتج لاحقاً
      const unitLabel = isWholesaleRow
        ? linkedProduct?.wholesaleUnitName
        : linkedProduct?.unit;
      const unitConversionQty = isWholesaleRow ? (linkedProduct?.wholesaleUnitQty || 1) : undefined;
      // الأرقام التسلسلية: نص المستخدم → مصفوفة نظيفة (فاصلة/سطر جديد)، ومدة الضمان لقطة وقت البيع
      const serialList = splitSerials(itm.serials);
      const warrantyMonths = linkedProduct?.defaultWarrantyMonths;
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

    const stockWarnings = checkStockWarnings(items);
    if (stockWarnings.length > 0) {
      triggerAlert(
        `تحذير: كمية تتجاوز المخزون:\n${stockWarnings.join(' | ')}`,
        'danger'
      );
    }

    const savedDate = invoiceDate || todayISO();

    if (isEditing && editingInvoiceId) {
      const existing = invoices.find(inv => inv.id === editingInvoiceId);
      if (existing) {
        const oldRemaining = existing.remainingAmount ?? 0;
        // المدفوع المتراكم (يشمل تسديدات قسم الديون) — undefined تعني مسددة كاملاً
        const prevPaid = existing.paidAmount ?? existing.finalAmount;

        // حماية التسديدات المتراكمة: الإجمالي الجديد لا ينزل تحت المدفوع
        if (oldRemaining > 0 && final < prevPaid) {
          triggerAlert(
            `إجمالي الفاتورة الجديد (${formatCurrency(final, currency, exchangeRate)}) أقل من المبلغ المسدد المتراكم (${formatCurrency(prevPaid, currency, exchangeRate)}) — لا يمكن الحفظ`,
            'danger'
          );
          return;
        }
        // ولا يجوز تخفيض "الواصل" تحت المتراكم — التسديدات تُدار من قسم الديون فقط
        if (oldRemaining > 0 && paidAmt < prevPaid) {
          triggerAlert(
            `المبلغ الواصل (${formatCurrency(paidAmt, currency, exchangeRate)}) أقل من المسدد المتراكم فعلياً (${formatCurrency(prevPaid, currency, exchangeRate)}) — التسديدات تُعدَّل من قسم الديون وليس من هنا`,
            'danger'
          );
          return;
        }
        // الواصل لا يتجاوز الإجمالي
        if (paidAmt > final) {
          triggerAlert('المبلغ الواصل أكبر من إجمالي الفاتورة — راجع المبالغ', 'danger');
          return;
        }
        // الرقم صار قابلاً للتعديل (لتصحيح التكرار) — فنمنع أن يُصلَح تكرار بصنع آخر
        const newNum = invoiceNumber.trim();
        if (!newNum) {
          triggerAlert('رقم الفاتورة لا يمكن أن يكون فارغاً', 'danger');
          return;
        }
        const clash = invoices.find(i => i.id !== existing.id && i.invoiceNumber.trim() === newNum);
        if (clash) {
          triggerAlert(`الرقم ${newNum} مستعمل في فاتورة أخرى (${clash.customerName}) — اختر رقماً غيره`, 'danger');
          return;
        }

        const trimmedNewName = customerName.trim();

        // هوية العميل القديم: بالـ id المخزّن، أو بمطابقة الاسم للفواتير القديمة بلا ربط
        const oldCustomer = existing.customerId
          ? systemCustomers.find(c => c.id === existing.customerId)
          : systemCustomers.find(c => c.name.trim().toLowerCase() === existing.customerName.trim().toLowerCase());

        // هوية العميل الجديد المرشّح (اختيار صريح أو مطابقة اسم) — دون إنشاء بعد
        const newMatch = trimmedNewName
          ? ((selectedCustomerId ? systemCustomers.find(c => c.id === selectedCustomerId) : undefined)
            ?? systemCustomers.find(c => c.name.trim().toLowerCase() === trimmedNewName.toLowerCase()))
          : undefined;

        const isSameCustomer = oldCustomer && newMatch
          ? oldCustomer.id === newMatch.id
          : existing.customerName.trim().toLowerCase() === trimmedNewName.toLowerCase();

        // أي تغيير بالدين أثناء التعديل يتطلب اسم عميل حتى يُعدَّل الرصيد الصحيح
        // (الفحص قبل أي كتابة — حتى لا يُمَس المخزون إذا رُفض الحفظ)
        const delta = remaining - oldRemaining;
        if (isSameCustomer && delta !== 0 && !trimmedNewName) {
          triggerAlert('تعديل مبلغ الدين يتطلب اسم العميل لتحديث رصيده', 'danger');
          return;
        }

        // (fix 9) فاتورة دين موظف لم تُطوَ بعد: دَينها القديم ليس في رصيد الزبون (سيضيفه الطي لاحقاً
        //   بالقيمة النهائية). لو طبّقنا الدلتا الآن، سيجمع الطي كامل remaining فوقها ⇒ دين مضاعف.
        //   لذا لا نمسّ الرصيد إطلاقاً (foldDeferred)، ولا نعكس دَيناً قديماً لم يُضَف أصلاً.
        const isUnfoldedEmployeeDebt =
          !!existing.createdByUid &&
          existing.createdByUid !== auth.currentUser?.uid &&
          existing.debtSyncedToBalance !== true;

        // إرجاع بضاعة الفاتورة القديمة إلى **فرعها الأصلي** (لا الفرع النشط)
        await syncInventory(existing.items, 1, branchOf(existing));

        const uid = auth.currentUser?.uid;
        /**
         * 🔴 كان عكسُ الدين عن الزبون القديم كتابةً مستقلّة عن تطبيقه على الجديد وعن حفظ
         * الفاتورة. فنجاحُ العكس وفشلُ التطبيق (أو العكس) يترك ديناً معلّقاً على زبونٍ لم
         * يعد صاحب الفاتورة — ولا شيء يُنبّه. الآن الحركتان وحفظُ الفاتورة في دفعة واحدة.
         */
        const resolved = resolveSaleCustomer(
          customerName, customerPhone,
          isSameCustomer ? delta : remaining,
          invoiceNumber, isUnfoldedEmployeeDebt,
        );
        const linkedCustomerId = resolved.customerId;
        const balanceOps = customerBalanceOps({
          isSameCustomer,
          newCustomerId: linkedCustomerId,
          oldCustomerId: oldCustomer?.id,
          oldRemaining,
          delta: isSameCustomer ? delta : remaining,
          foldDeferred: isUnfoldedEmployeeDebt,
        });

        // بناء الفاتورة مع إسقاط customerId القديم صراحةً (setDoc يستبدل الوثيقة كاملة)
        const { customerId: _oldCid, ...existingRest } = existing;
        const updatedInv = {
          ...existingRest,
          invoiceNumber: newNum,
          customerName: effectiveCustomerName,
          ...(linkedCustomerId ? { customerId: linkedCustomerId } : {}),
          totalAmount: subtotal,
          discount: disc,
          tax: taxAmt,
          finalAmount: final,
          paidAmount: paidAmt,
          remainingAmount: remaining,
          date: savedDate,
          items: formattedItems,
        } as Invoice;
        if (uid) {
          const plan = {
            invoice: updatedInv,
            balanceOps,
            newCustomer: resolved.newCustomer,
            // سيريال حُذف أو صُحِّح إملائياً: يبقى شبحاً ما لم يُحذف مع نفس الدفعة
            removedSerialKeys: removedSerialKeys(existing.items, formattedItems),
          };
          if (saleOpCount(plan) > BATCH_LIMIT) {
            triggerAlert('الفاتورة كبيرة جداً على عملية حفظ واحدة — قسّمها إلى فاتورتين', 'danger');
            setIsSubmitting(false);
            return;
          }
          const saleBatch = writeBatch(db);
          stageSale(saleBatch, uid, plan);
          guardWrite(saleBatch.commit(), 'invoices', 'batch');
        }
        // الخصم الجديد من نفس فرع الفاتورة (التعديل لا ينقل الفاتورة بين الفروع)
        await syncInventory(formattedItems, -1, branchOf(existing));

        // حفظ + طباعة بضغطة واحدة (وضع التعديل)
        if (shouldPrint) {
          printSingleInvoice({
            format: printFormat,
            invoice: updatedInv,
            label: updatedInv.customerName,
            phone: customerPhone,
            currency,
            exchangeRate,
            store: printStore,
            sellerName: updatedInv.createdByName,
            onError: (m) => triggerAlert(m, 'danger'),
          });
        }
      }
      setIsEditing(false);
      setEditingInvoiceId(null);
      // تفريغ النموذج بعد التعديل (كما بعد الإنشاء) — يمنع بقاء فاتورة مُعدَّلة كمسودّة جديدة
      setCustomerName('');
      setCustomerPhone('');
      setSelectedCustomerId(null);
      setDiscountVal('0');
      setTaxRateVal('0');
      setPaidAmountVal('');
      setItems([{ itemId: '1', name: '', quantity: 1, price: 0 }]);
      setInvoiceDate(todayISO());
      if (!stockWarnings.length) triggerAlert('تم تعديل وحفظ الفاتورة بنجاح');
    } else {
      // الرقم يُحجز **لحظة الحفظ** لا لحظة فتح النموذج: النموذج يبقى مفتوحاً وقت مسح
      // المواد، وهي بالضبط اللحظة التي قد يحفظ فيها الجهاز الآخر فاتورته.
      const nextNum = getNextInvoiceNumber();
      const invId = genId(); // (fix 10) لاحقة عشوائية تمنع تصادم معرّفين في نفس الملّي ثانية

      // حسم هوية الزبون (مطابقة أو إنشاء) قبل بناء الفاتورة — بلا أي كتابة
      const resolved = resolveSaleCustomer(customerName, customerPhone, remaining, nextNum);
      const linkedCustomerId = resolved.customerId;

      const newInv: Invoice = {
        id: invId,
        invoiceNumber: nextNum,
        customerName: effectiveCustomerName,
        ...(linkedCustomerId ? { customerId: linkedCustomerId } : {}),
        totalAmount: subtotal,
        discount: disc,
        tax: taxAmt,
        finalAmount: final,
        paidAmount: paidAmt,
        remainingAmount: remaining,
        ...(paidAmt > 0 ? { payments: buildPayments(paidAmt) } : {}),
        date: savedDate,
        createdAt: Date.now(),
        type: 'general',
        items: formattedItems,
        // وسم المُصدِر (المالك) — تمهيد للطي/سجل النشاط. للمالك createdByUid == ownerUid فيستثنيه الطي لاحقاً.
        ...(auth.currentUser?.uid ? { createdByUid: auth.currentUser.uid } : {}),
        createdByName: ownerName || 'صاحب المحل',
        branchId: stampBranchId, // الفرع النشط وقت الإصدار
        // رمز الجهاز — صامت تماماً، لكنه ما يجعل الجهاز الثاني يعرف بوجود الأول فيتفادى رقمه
        ...(myDeviceTag ? { deviceTag: myDeviceTag } : {}),
      };
      /**
       * 🔴 الفاتورة والرصيد ومرآة الضمان في **دفعة ذرّية واحدة**.
       * كانت ثلاث كتابات مستقلّة: رصيدٌ يزيد بلا فاتورة تُسنده، أو فاتورةٌ بدين لا يظهر
       * في رصيد الزبون. والمخزون يبقى منفصلاً عمداً — انظر رأس `utils/saleWrite.ts`.
       */
      const saveUid = auth.currentUser?.uid;
      if (saveUid) {
        const plan = {
          invoice: newInv,
          balanceOps: customerBalanceOps({
            isSameCustomer: true,
            newCustomerId: linkedCustomerId,
            oldRemaining: 0,
            delta: remaining,
            foldDeferred: false,
          }),
          newCustomer: resolved.newCustomer,
        };
        if (saleOpCount(plan) > BATCH_LIMIT) {
          triggerAlert('الفاتورة كبيرة جداً على عملية حفظ واحدة — قسّمها إلى فاتورتين', 'danger');
          setIsSubmitting(false);
          return;
        }
        const saleBatch = writeBatch(db);
        stageSale(saleBatch, saveUid, plan);
        guardWrite(saleBatch.commit(), 'invoices', 'batch');
      }
      // المخزون منفصل عمداً: فشله لا يُفقد الفاتورة (درسٌ مكتوب في مسار الموظف)
      await syncInventory(formattedItems, -1);

      // حفظ + طباعة بضغطة واحدة — تُطبع الفاتورة المحفوظة توّاً (قبل تصفير النموذج، فبياناتها ملتقطة محلياً)
      if (shouldPrint) {
        printSingleInvoice({
          format: printFormat,
          invoice: newInv,
          label: newInv.customerName,
          phone: customerPhone,
          currency,
          exchangeRate,
          store: printStore,
          sellerName: newInv.createdByName,
          onError: (m) => triggerAlert(m, 'danger'),
        });
      }

      setSelectedInvoiceId(newInv.id);
      setCustomerName('');
      setCustomerPhone('');
      setSelectedCustomerId(null);
      setDiscountVal('0');
      setTaxRateVal('0');
      setPaidAmountVal('');
      setItems([{ itemId: '1', name: '', quantity: 1, price: 0 }]);
      setInvoiceDate(todayISO());
      if (!stockWarnings.length) {
        const debtMsg = remaining > 0 ? ` — سُجّل دين ${formatCurrency(remaining, currency, exchangeRate)}` : '';
        triggerAlert(`تم إصدار الفاتورة وحفظها بنجاح${debtMsg}`);
      }
    }
    } finally {
      setIsSubmitting(false);
    }
  };

  // حذف الفاتورة فقط — بدون أي تأثير على المخزون أو رصيد الزبون.
  // الحذف يحذف الفاتورة وسجلاتها المالية المرتبطة فقط.
  const handleDeleteInvoice = async (id: string, invNum: string) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    const invSnapshot = invoices.find(i => i.id === id); // لقطة للسجل قبل الحذف

    /**
     * 🔴 الدين المعلّق: الحذف لا يمسّ الرصيد (بالتصميم)، لكن فاتورة دين محذوفة تترك على
     * الزبون مبلغاً **بلا مستند يشرحه**. فإذا اعترض الزبون لا يملك التاجر ما يريه، وإذا
     * نسي التاجر بقي رقم شبح في الرصيد إلى الأبد. فنسأل صراحةً بدل أن نقرّر عنه.
     *
     * دين الموظف غير المطوي مستثنى: لم يُضَف لرصيد الزبون أصلاً، فحسمه منه يخلق رصيداً سالباً.
     */
    const deletedDebt = invSnapshot?.remainingAmount ?? 0;
    const isUnfoldedEmployeeDebt =
      !!invSnapshot?.createdByUid && invSnapshot.createdByUid !== uid && invSnapshot.debtSyncedToBalance !== true;
    const debtCustomer = deletedDebt > 0 && !isUnfoldedEmployeeDebt && invSnapshot
      ? (invSnapshot.customerId
        ? systemCustomers.find(c => c.id === invSnapshot.customerId)
        : systemCustomers.find(c => c.name.trim().toLowerCase() === invSnapshot.customerName.trim().toLowerCase()))
      : undefined;

    let clearDebt = false;
    if (debtCustomer) {
      if (!(await requestConfirm(
        `⚠️ الفاتورة رقم (${invNum}) عليها دين ${formatCurrency(deletedDebt, currency, exchangeRate)} على «${debtCustomer.name}».\n\n` +
        `«تأكيد» = حذف الفاتورة وحسم هذا الدين من رصيد الزبون.\n` +
        `«إلغاء» = إبقاء كل شيء كما هو.\n\n` +
        `لا نحذف الفاتورة ونُبقي الدين، لأن دَيناً بلا فاتورة لا يمكن إثباته للزبون لاحقاً.`
      ))) return;
      clearDebt = true;
    } else if (!(await requestConfirm(
      `هل أنت متأكد من حذف الفاتورة رقم (${invNum})؟\nلن يتغير المخزون أو رصيد الزبون.`
    ))) return;

    const batch = writeBatch(db);

    // حسم الدين المحذوف من رصيد الزبون — increment ليتراكب بأمان مع أي تسديد متزامن
    if (clearDebt && debtCustomer) {
      batch.update(doc(db, 'users', uid, 'customers', debtCustomer.id), { balance: increment(-deletedDebt) });
    }

    // حذف financial_transactions المرتبطة (إن وجدت)
    const txSnap = await getDocs(
      query(collection(db, 'users', uid, 'financial_transactions'), where('invoiceId', '==', id))
    );
    txSnap.forEach(d => batch.delete(d.ref));

    // مرآة الضمان: الفاتورة تختفي ⇒ تختفي سيريالاتها معها، وإلا بقيت «أشباح ضمان»
    // يجدها الموظف فيُكرم زبوناً بضمانٍ على جهازٍ لا بيع له.
    if (invSnapshot) removeWarrantyIndexFromBatch(batch, uid, [...serialKeysOf(invSnapshot)]);

    batch.delete(doc(db, 'users', uid, 'invoices', id));
    batch.commit().catch(err => reportFirestoreError('invoices', 'remove', err, '[Firestore] delete invoice'));

    // سجل التدقيق — الحذف عملية حساسة لا رجعة فيها؛ نحفظ لقطة الفاتورة كاملة قبل اختفائها
    void logAudit({
      action: 'delete', entity: 'invoice', entityId: id,
      summary: `حذف فاتورة رقم ${invNum}${invSnapshot ? ` — ${formatCurrency(invSnapshot.finalAmount, currency, exchangeRate)} (${invSnapshot.customerName})` : ''}`
        + (clearDebt ? ` — وحُسم دين ${formatCurrency(deletedDebt, currency, exchangeRate)} من رصيد الزبون` : ''),
      before: invSnapshot as unknown as Record<string, unknown>,
      actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
    });

    if (selectedInvoiceId === id) setSelectedInvoiceId(null);
    triggerAlert(`تم حذف الفاتورة رقم ${invNum}`, 'danger');
  };

  // ---- 10. WHATSAPP SHARE ----
  const handleShareWhatsApp = (inv: Invoice) => {
    const invPaid = inv.paidAmount ?? inv.finalAmount;
    const invRemaining = inv.remainingAmount ?? 0;
    let text = `📄 *وصل صرف مالي - رتب شغلك* 💎\n`;
    text += `رقم الفاتورة: ${toArabicDigits(inv.invoiceNumber)}\n`;
    text += `العميل المشتري: *${inv.customerName}*\n`;
    text += `تاريخ الإصدار: ${formatDate(inv.date)}\n`;
    text += `----------------------------------------\n`;
    inv.items.forEach((itm, idx) => {
      text += `${toArabicDigits(idx + 1)}. *${itemDisplayName(itm)}* (عدد ${toArabicDigits(itm.quantity)}) - ${formatCurrency(itm.total, currency, exchangeRate)}\n`;
    });
    text += `----------------------------------------\n`;
    text += `المجموع الأولي: ${formatCurrency(inv.totalAmount, currency, exchangeRate)}\n`;
    if (inv.discount > 0) text += `الخصم: -${formatCurrency(inv.discount, currency, exchangeRate)}\n`;
    if (inv.tax > 0) text += `الضرائب: +${formatCurrency(inv.tax, currency, exchangeRate)}\n`;
    text += `*المبلغ الكلي: ${formatCurrency(inv.finalAmount, currency, exchangeRate)}*\n`;
    text += `المبلغ المدفوع: ${formatCurrency(invPaid, currency, exchangeRate)}\n`;
    if (invRemaining > 0) {
      text += `*المتبقي (دين): ${formatCurrency(invRemaining, currency, exchangeRate)}* ⚠️\n`;
    }
    text += `\nنثمن ثقتكم بنا! ❤️`;
    setWhatsappShareMsg(`📱 مشاركة الفاتورة:\n\n${text}`);
    navigator.clipboard.writeText(text);
    triggerAlert('تم نسخ الفاتورة للحافظة!');
  };

  // ---- 11. PRINT ALL INVOICES FOR A CUSTOMER ----
  const handlePrintCustomerInvoices = (group: { key: string; label: string; invoices: Invoice[]; totalAmount: number; totalDebt: number }) => {
    const custRecord = systemCustomers.find(c =>
      c.id === group.key || c.name.trim().toLowerCase() === group.label.trim().toLowerCase()
    );
    printInvoices({
      label: group.label,
      phone: custRecord?.phone ?? '',
      invoices: group.invoices,
      currency,
      exchangeRate,
      store: printStore,
      onError: (msg) => triggerAlert(msg, 'danger'),
    });
  };

  // ---- 10.5 إرجاع الفاتورة (كلي/جزئي) ----
  // يحسب أثر الاسترجاع: المواد المتبقية بعد خصم المرتجع، وإعادة حساب الخصم/الضريبة تناسبياً،
  // والمبلغ المُعاد (reduction). دالة نقية يستخدمها كل من معاينة الحوار وتنفيذ الاسترجاع.
  const computeReturn = (inv: Invoice, qtys: Record<string, number>) => {
    const clampQ = (it: Invoice['items'][number]) =>
      Math.max(0, Math.min(Math.floor(qtys[it.itemId] ?? 0), it.quantity));
    const returns = inv.items.map(it => ({ it, qty: clampQ(it) })).filter(r => r.qty > 0);
    const remainingItems = inv.items
      .map(it => {
        const newQ = it.quantity - clampQ(it);
        return newQ <= 0 ? null : { ...it, quantity: newQ, total: newQ * it.price };
      })
      .filter(Boolean) as Invoice['items'];
    const newSubtotal = remainingItems.reduce((s, it) => s + it.total, 0);
    const discRatio = inv.totalAmount > 0 ? inv.discount / inv.totalAmount : 0;
    const newDiscount = Math.round(newSubtotal * discRatio);
    const preTax = inv.totalAmount - inv.discount;
    const taxRate = preTax > 0 ? inv.tax / preTax : 0;
    const newTax = Math.round((newSubtotal - newDiscount) * taxRate);
    const newFinal = newSubtotal - newDiscount + newTax;
    const reduction = Math.max(0, inv.finalAmount - newFinal); // المبلغ المُعاد
    const totalQty = returns.reduce((s, r) => s + r.qty, 0);
    return { returns, remainingItems, newSubtotal, newDiscount, newTax, newFinal, reduction, totalQty };
  };

  const handleOpenReturn = () => {
    setReturnModalOpen(true);
    setReturnInvoiceId(null);
    setReturnQtys({});
    setReturnSearch('');
  };

  const selectReturnInvoice = (inv: Invoice) => {
    setReturnInvoiceId(inv.id);
    setReturnQtys(Object.fromEntries(inv.items.map(it => [it.itemId, 0])));
  };

  const handleProcessReturn = async () => {
    if (isReturning) return;
    const inv = invoices.find(i => i.id === returnInvoiceId);
    const uid = auth.currentUser?.uid;
    if (!inv || !uid) return;

    const r = computeReturn(inv, returnQtys);
    if (r.totalQty === 0) { triggerAlert('حدّد كمية مادة واحدة على الأقل للاسترجاع', 'danger'); return; }

    setIsReturning(true);
    try {
      // توزيع المبلغ المُعاد: يُخفّض الدين أولاً، والباقي يُرَدّ نقداً (يُخصم من المدفوع)
      const oldPaid = inv.paidAmount ?? inv.finalAmount;
      const oldRemaining = inv.remainingAmount ?? 0;
      const debtReduced = Math.min(oldRemaining, r.reduction);
      const newRemaining = oldRemaining - debtReduced;
      const newPaid = Math.max(0, oldPaid - (r.reduction - debtReduced));

      const batch = writeBatch(db);
      // 1) تحديث الفاتورة بالمواد المتبقية والمبالغ الجديدة (كأن المرتجع لم يُبَع)
      batch.update(doc(db, 'users', uid, 'invoices', inv.id), {
        items: r.remainingItems,
        totalAmount: r.newSubtotal,
        discount: r.newDiscount,
        tax: r.newTax,
        finalAmount: r.newFinal,
        paidAmount: newPaid,
        remainingAmount: newRemaining,
      });
      // 2) إرجاع المخزون بوحدة الأساس (increment آمن أوفلاين) — للمنتجات الموجودة فقط
      const existingIds = new Set(inventoryItems.map(p => p.id));
      for (const ret of r.returns) {
        if (ret.it.productId && existingIds.has(ret.it.productId)) {
          const baseQty = ret.qty * (ret.it.unitConversionQty ?? 1);
          // المرتجع يعود إلى **فرع الفاتورة** الذي بِيع منه
          batch.update(doc(db, 'users', uid, inventoryCollection, ret.it.productId), stockUpdate(baseQty, branchOf(inv)));
        }
      }
      // 3) تخفيض دين الزبون بمقدار ما أُعيد من الدين — إلا لدين موظف غير مطوي (يطويه المالك بالقيمة الجديدة)
      const isUnfoldedEmployeeDebt = !!inv.createdByUid && inv.createdByUid !== uid && inv.debtSyncedToBalance !== true;
      if (debtReduced > 0 && !isUnfoldedEmployeeDebt) {
        const linkedCustomer = inv.customerId
          ? systemCustomers.find(c => c.id === inv.customerId)
          : systemCustomers.find(c => c.name.trim().toLowerCase() === inv.customerName.trim().toLowerCase());
        if (linkedCustomer) {
          batch.update(doc(db, 'users', uid, 'customers', linkedCustomer.id), { balance: increment(-debtReduced) });
        }
      }
      // مرآة الضمان: الجهاز المُرجَع لم يعد مبيعاً — تُحذف مرآته وإلا بقي ضمانه «فعّالاً»
      // للموظف بعد أن قبض الزبون ثمنه.
      removeWarrantyIndexFromBatch(batch, uid, removedSerialKeys(inv.items, r.remainingItems));

      batch.commit().catch(err => reportFirestoreError('invoices', 'batch', err, '[Firestore] invoice return'));

      // سجل التدقيق — الإرجاع يُعيد بضاعة ومالاً، فيُوثَّق بتفاصيل الأصناف المسترجعة
      void logAudit({
        action: 'update', entity: 'invoice', entityId: inv.id,
        summary: `استرجاع من فاتورة ${inv.invoiceNumber}: ${toArabicDigits(r.totalQty)} قطعة — أُعيد ${formatCurrency(r.reduction, currency, exchangeRate)} (${r.returns.map(x => `${x.it.name}×${x.qty}`).join('، ')})`,
        before: { finalAmount: inv.finalAmount, paidAmount: oldPaid, remainingAmount: oldRemaining, items: inv.items },
        after: { finalAmount: r.newFinal, paidAmount: newPaid, remainingAmount: newRemaining, items: r.remainingItems },
        actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
      });

      triggerAlert(`تم استرجاع ${toArabicDigits(r.totalQty)} قطعة وإرجاع ${formatCurrency(r.reduction, currency, exchangeRate)} للزبون`);
      setReturnModalOpen(false);
      setReturnInvoiceId(null);
      setReturnQtys({});
    } finally {
      setIsReturning(false);
    }
  };

  // ---- 11. FILTERS ----
  // ---- جهة إصدار الفاتورة (المالك مقابل موظف) ----
  // فاتورة موظف = لها createdByUid يختلف عن uid المالك الحالي. الفواتير القديمة (بلا createdByUid)
  // أو المنسوبة للمالك تُعامل كفواتير المالك (السلوك الافتراضي، لا شيء يُعرض).
  const ownerAuthUid = auth.currentUser?.uid;
  const isEmployeeInvoice = (inv: Invoice): boolean => !!inv.createdByUid && inv.createdByUid !== ownerAuthUid;
  const invoiceIssuerName = (inv: Invoice): string =>
    isEmployeeInvoice(inv) ? (inv.createdByName?.trim() || 'موظف') : 'صاحب المحل';

  /**
   * القائمة المعروضة.
   *
   * ⚡ useMemo ضروري لا تجميل: `groupedInvoices` يعتمد عليها، وبناؤها في كل رندر كان يجعل
   * ذاكرته عديمة الفائدة — فيُعاد مسح كل الفواتير وتجميعها وترتيبها **مع كل حرف يُكتب**
   * في البحث. عند آلاف الفواتير تتلعثم الكتابة.
   *
   * 🔎 والأرقام تُطبَّع على الطرفين: رقم الفاتورة مخزَّن عربياً والتاجر يكتب على لوحة
   * الأرقام لاتينياً، فبلا تطبيع لا يجد وصله أبداً.
   */
  const filteredInvoices = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = toLatinDigits(q);
    return invoices.filter(inv => {
      // تصفية الفرع أولاً — في وضع «كل الفروع» أو الفرع الواحد تمرّ كل الفواتير كما كانت
      if (!matchesActiveBranch(inv)) return false;
      const matchesSearch =
        !q ||
        inv.customerName.toLowerCase().includes(q) ||
        toLatinDigits(inv.invoiceNumber).includes(qDigits) ||
        toLatinDigits(inv.date).includes(qDigits) ||
        inv.items.some(it => it.name.toLowerCase().includes(q));
      if (!matchesSearch) return false;
      if (issuerFilter === 'mine') return !isEmployeeInvoice(inv);
      if (issuerFilter === 'employees') return isEmployeeInvoice(inv);
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices, search, issuerFilter, matchesActiveBranch, ownerAuthUid]);

  type InvoiceGroup = {
    key: string;
    label: string;
    invoices: Invoice[];
    totalAmount: number;
    totalDebt: number;
  };

  const groupedInvoices = useMemo((): InvoiceGroup[] => {
    const map = new Map<string, InvoiceGroup>();
    filteredInvoices.forEach(inv => {
      const key = inv.customerId ?? `name:${inv.customerName}`;
      if (!map.has(key)) {
        map.set(key, { key, label: inv.customerName, invoices: [], totalAmount: 0, totalDebt: 0 });
      }
      const g = map.get(key)!;
      g.invoices.push(inv);
      g.totalAmount += inv.finalAmount;
      g.totalDebt += inv.remainingAmount ?? 0;
    });
    map.forEach(g => g.invoices.sort((a, b) => b.date.localeCompare(a.date)));
    return [...map.values()].sort((a, b) =>
      (b.invoices[0]?.date ?? '').localeCompare(a.invoices[0]?.date ?? '')
    );
  }, [filteredInvoices]);

  /**
   * الفاتورة المعروضة في المعاينة — تتبع الفرع كالقائمة تماماً.
   * بدون شرط الفرع كانت القائمة تتغيّر عند التبديل وتبقى المعاينة تعرض فاتورة فرعٍ آخر،
   * فيقرأ التاجر وصلاً ويظنّه من الفرع الذي يراه.
   */
  const activeInvoice = invoices.find(i => i.id === selectedInvoiceId && matchesActiveBranch(i));

  /**
   * تبديل الفرع يُنهي كل ما بُني على الفرع السابق: الفاتورة المعروضة، وتحديد الطباعة.
   * وإلا طُبعت فواتير لم تعد ظاهرة أمام التاجر — وهو لا يدري ما في الدفعة.
   */
  useEffect(() => {
    setSelectedInvoiceId(null);
    setSelectedForPrint(new Set());
  }, [activeBranchId]);

  // ---- 12. BATCH PRINTING (date range / manual selection / print-all) ----
  const MAX_BATCH_PRINT = 300;

  // تنسيق تاريخ محلي YYYY-MM-DD بدون انزياح UTC (مهم لتوقيت العراق +3)
  const toLocalISO = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // تاريخ الفاتورة كـ ISO للمقارنة — يدعم الفواتير القديمة بصيغة نصية غير ISO
  const invoiceISODate = (inv: Invoice): string => {
    if (/^\d{4}-\d{2}-\d{2}/.test(inv.date)) return inv.date.slice(0, 10);
    const d = new Date(inv.date);
    return isNaN(d.getTime()) ? '' : toLocalISO(d);
  };

  // بناء نافذة الطباعة عبر نفس الآلية المحلية (أوفلاين). حد أقصى معقول يتفادى تجميد الواجهة.
  const runBatchPrint = async (invs: Invoice[], label: string, phone = '') => {
    if (!invs.length) { triggerAlert('لا توجد فواتير مطابقة للطباعة', 'danger'); return; }
    let toPrint = invs;
    if (invs.length > MAX_BATCH_PRINT) {
      const ok = await requestConfirm(
        `عدد الفواتير كبير (${toArabicDigits(invs.length)}). لتفادي بطء أو تجميد النظام سيتم طباعة أقدم ${toArabicDigits(MAX_BATCH_PRINT)} فاتورة فقط ضمن هذه الدفعة.\nهل تريد المتابعة؟`
      );
      if (!ok) return;
      toPrint = [...invs].sort((a, b) => a.date.localeCompare(b.date)).slice(0, MAX_BATCH_PRINT);
    }
    printInvoices({ label, phone, invoices: toPrint, currency, exchangeRate, store: printStore, onError: (m) => triggerAlert(m, 'danger') });
  };

  // الفواتير ضمن الفترة المختارة — مستقلة عن بحث النص، لكنها **تحترم الفرع المختار**.
  // كانت تُبنى من كل الفواتير، فمن يختار المخزن ويطبع «اليوم» يحصل على فواتير كل الفروع.
  const rangeInvoices = useMemo(() => {
    if (!rangeFrom && !rangeTo) return [];
    return invoices.filter(inv => {
      if (!matchesActiveBranch(inv)) return false;
      const d = invoiceISODate(inv);
      if (!d) return false;
      if (rangeFrom && d < rangeFrom) return false;
      if (rangeTo && d > rangeTo) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices, rangeFrom, rangeTo, matchesActiveBranch]);

  const applyDatePreset = (preset: 'today' | 'week' | 'month') => {
    const now = new Date();
    const today = toLocalISO(now);
    if (preset === 'today') {
      setRangeFrom(today); setRangeTo(today);
    } else if (preset === 'week') {
      // بداية الأسبوع من السبت (التقويم العراقي)
      const diff = (now.getDay() + 1) % 7; // Sat→0, Sun→1, ... Fri→6
      const start = new Date(now);
      start.setDate(now.getDate() - diff);
      setRangeFrom(toLocalISO(start)); setRangeTo(today);
    } else {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      setRangeFrom(toLocalISO(start)); setRangeTo(today);
    }
  };

  // اسم الفرع في عنوان الطباعة — ليعرف قارئ الورقة من أي موقع هذه الفواتير
  const printBranchSuffix = isMultiBranch
    ? (activeBranchId ? ` — ${branchName(activeBranchId)}` : ' — كل الفروع')
    : '';

  const handlePrintRange = () => {
    const fromLbl = rangeFrom ? formatDate(rangeFrom) : '…';
    const toLbl = rangeTo ? formatDate(rangeTo) : '…';
    runBatchPrint(rangeInvoices, `فواتير الفترة ${fromLbl} — ${toLbl}${printBranchSuffix}`);
  };

  const handlePrintAllFiltered = () => {
    runBatchPrint(
      filteredInvoices,
      (search.trim() ? `فواتير مطابقة للبحث: ${search.trim()}` : 'كل الفواتير المعروضة') + printBranchSuffix
    );
  };

  const handlePrintSelected = () => {
    const invs = invoices.filter(i => selectedForPrint.has(i.id));
    runBatchPrint(invs, `الفواتير المحددة (${toArabicDigits(invs.length)})`);
  };

  // ---- selection toggles ----
  const toggleSelectInvoice = (id: string) => {
    setSelectedForPrint(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const isGroupFullySelected = (g: InvoiceGroup) =>
    g.invoices.length > 0 && g.invoices.every(inv => selectedForPrint.has(inv.id));

  const toggleSelectGroup = (g: InvoiceGroup) => {
    setSelectedForPrint(prev => {
      const next = new Set(prev);
      const allSelected = g.invoices.every(inv => next.has(inv.id));
      g.invoices.forEach(inv => { if (allSelected) next.delete(inv.id); else next.add(inv.id); });
      return next;
    });
  };

  const clearSelection = () => setSelectedForPrint(new Set());

  return (
    <div className="space-y-6">
      {confirmDialog}

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-xl font-extrabold font-cairo text-[#0B1F4D] flex items-center gap-2">
            <FileText className="w-6 h-6 text-emerald-600" />
            <span>إدارة المبيعات والوصولات الفورية 📄</span>
          </h2>
          <p className="text-xs text-[#5B6B86] mt-1 font-tajawal">
            أنشئ فواتير المشتريات، حدد نسب الضريبة والخصم، واطبع كشوفات حرارية فورية
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleOpenCreateForm}
            className="px-5 py-2.5 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-xs shadow transition cursor-pointer flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4 text-emerald-500" />
            <span>إنشاء فاتورة جديدة</span>
          </button>
          <button
            onClick={handleOpenReturn}
            className="px-5 py-2.5 bg-white border-2 border-amber-300 text-amber-700 hover:bg-amber-50 font-extrabold rounded-xl text-xs shadow-sm transition cursor-pointer flex items-center gap-1.5"
          >
            <RotateCcw className="w-4 h-4" />
            <span>إرجاع فاتورة</span>
          </button>
        </div>
      </div>

      {/* Alert */}
      {alert && (
        <div className={`p-3 rounded-xl border text-xs font-bold font-tajawal flex items-start gap-2 transition-all whitespace-pre-line ${
          alert.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
        }`}>
          <Info className="w-4.5 h-4.5 flex-shrink-0 mt-0.5" />
          <span>{alert.text}</span>
        </div>
      )}

      {/* أرقام مكرّرة — تكرارٌ وقع قبل إصلاح الترقيم. نُظهره ليصحّحه التاجر وهو مطمئن */}
      {duplicateInvoiceNumbers.length > 0 && (
        <div className="p-3 rounded-xl border-2 border-rose-300 bg-rose-50 text-rose-900 text-[11px] font-bold font-tajawal flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            انتبه: يوجد رقم فاتورة مستعمل أكثر من مرة —{' '}
            {duplicateInvoiceNumbers.slice(0, 5).map(d => `${d.number} (${toArabicDigits(d.count)} مرات)`).join('، ')}
            {duplicateInvoiceNumbers.length > 5 && ` و${toArabicDigits(duplicateInvoiceNumbers.length - 5)} أخرى`}.
            <br />
            ابحث عن الرقم لتراها كلها، وعدّل رقم الأحدث منها. الفواتير الجديدة لن تتكرّر بعد الآن.
          </span>
        </div>
      )}

      {/* WhatsApp share preview */}
      {whatsappShareMsg && (
        <div className="p-4 bg-gradient-to-br from-emerald-50 to-teal-50 border-2 border-emerald-200 text-slate-800 rounded-2xl text-xs md:text-sm font-medium relative space-y-3">
          <button
            onClick={() => setWhatsappShareMsg(null)}
            className="absolute top-3 left-3 p-1 hover:bg-emerald-100 rounded-full text-emerald-600"
          >
            <X className="w-4 h-4" />
          </button>
          <h4 className="font-extrabold text-xs text-emerald-800 flex items-center gap-1">
            <Share2 className="w-4 h-4 text-emerald-600 animate-pulse" />
            <span>تم نسخ الفاتورة للحافظة — أرسلها مباشرة:</span>
          </h4>
          <pre className="p-3.5 bg-white border border-emerald-200 rounded-xl whitespace-pre-wrap font-sans text-xs select-all text-slate-700 leading-relaxed font-tajawal">
            {whatsappShareMsg.replace('📱 مشاركة الفاتورة:\n\n', '')}
          </pre>
          <div className="flex gap-2">
            <a
              href={`https://wa.me/?text=${encodeURIComponent(whatsappShareMsg.replace('📱 مشاركة الفاتورة:\n\n', ''))}`}
              target="_blank"
              onClick={onExternalLink}
              rel="noopener noreferrer"
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs"
            >
              فتح واتساب وإرسال الوصل
            </a>
            <button
              onClick={() => setWhatsappShareMsg(null)}
              className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-[11px] font-bold text-slate-500"
            >
              إغلاق
            </button>
          </div>
        </div>
      )}

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* LEFT: Form (7 cols) */}
        <div className="lg:col-span-7 bg-white rounded-2xl p-6 border border-[#E4EAF3] shadow-sm space-y-6">
          <div className="flex justify-between items-center border-b border-slate-100 pb-3">
            <h3 className="font-extrabold text-xs md:text-sm text-[#0B1F4D] flex items-center gap-2">
              <Calculator className="w-5 h-5 text-indigo-700 font-bold" />
              <span>
                {isEditing ? `تعديل الفاتورة رقم [${invoiceNumber}]` : 'إصدار فاتورة جديدة'}
              </span>
            </h3>
            {isEditing && (
              <button
                type="button"
                onClick={handleOpenCreateForm}
                className="text-xs text-rose-600 hover:underline font-extrabold flex items-center gap-1 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                <span>إلغاء التعديل</span>
              </button>
            )}
          </div>

          {/* تنبيه العرض المجمّع — البيع يحتاج فرعاً محدّداً، وإلا نسبنا البضاعة لفرع خاطئ */}
          {isAggregateView && !isEditing && (
            <div className="p-3 rounded-xl border-2 border-amber-300 bg-amber-50 text-amber-900 text-[11px] font-bold font-tajawal flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                أنت في وضع <b>«كل الفروع»</b> — وهو للمراجعة فقط.
                اختر من أعلى الشاشة <b>الفرع الذي تبيع منه</b> ليُخصم مخزونه الصحيح ويُسجَّل عليه البيع.
              </span>
            </div>
          )}

          <form onSubmit={(e) => handleSubmitForm(e)} className="space-y-4">

            {/* Barcode scan field — USB scanner or manual entry + Enter */}
            <div
              className={`p-3 rounded-2xl border-2 transition-colors duration-200 ${
                barcodeScanError
                  ? 'bg-rose-50 border-rose-400 animate-pulse'
                  : 'bg-indigo-50/60 border-indigo-200'
              }`}
            >
              <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5 font-tajawal flex items-center gap-1.5">
                <Barcode className="w-4 h-4 text-indigo-600" />
                <span>قراءة الباركود 🔍</span>
                <span className="text-[11px] font-bold text-slate-500 mr-auto">جهاز القارئ أو كتابة يدوية + Enter</span>
              </label>
              <input
                ref={barcodeScanRef}
                type="text"
                value={barcodeScanVal}
                onChange={(e) => setBarcodeScanVal(e.target.value)}
                onKeyDown={handleBarcodeScanKeyDown}
                onClick={() => barcodeScanRef.current?.focus()}
                placeholder="ضع المؤشر هنا واقرأ باركود المادة..."
                dir="ltr"
                autoComplete="off"
                className={`w-full px-3 py-2.5 bg-white border rounded-xl text-sm text-center font-mono font-bold tracking-widest focus:outline-none focus:ring-2 ${
                  barcodeScanError
                    ? 'border-rose-300 focus:ring-rose-400 text-rose-700'
                    : 'border-indigo-200 focus:ring-indigo-400 text-[#0B1F4D]'
                }`}
              />
            </div>

            {/* Header row: customer / invoice# / date */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

              {/* Customer + phone */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5 font-tajawal">
                  العميل المشتري
                  <span className="text-[11px] font-bold text-slate-500 mr-1">(اختياري للبيع النقدي — إلزامي للدين)</span>
                </label>
                <div className="relative mb-2" ref={customerInputWrapRef}>
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => { setCustomerName(e.target.value); setSelectedCustomerId(null); setCustomerSuggestionsOpen(true); }}
                    onFocus={() => { if (customerName.trim()) setCustomerSuggestionsOpen(true); }}
                    placeholder="اتركه فارغاً للبيع النقدي (زبون عام)..."
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-right font-bold"
                  />
                  {customerSuggestionsOpen && getCustomerSuggestions().length > 0 && (
                    <div className="absolute top-full right-0 left-0 z-50 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-40 overflow-y-auto">
                      {getCustomerSuggestions().map(cust => (
                        <button
                          key={cust.id}
                          type="button"
                          onMouseDown={(e) => { e.preventDefault(); handleSelectCustomerFromList(cust); }}
                          className="w-full px-3 py-2 text-right text-xs hover:bg-indigo-50 flex justify-between items-center gap-2 border-b border-slate-50 last:border-0"
                        >
                          <span title={cust.name} className="font-bold text-[#0B1F4D] truncate">{cust.name}</span>
                          <span className="text-[10px] text-slate-500 font-mono flex-shrink-0">{cust.phone || '—'}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* مؤشر ربط الزبون */}
                {customerName.trim() && (
                  <div className="mb-2">
                    {selectedCustomerId ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                        <span>✓</span>
                        <span>مرتبط بسجل زبون</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                        <span>⚠</span>
                        <span>اسم حر — غير مرتبط بسجل</span>
                      </span>
                    )}
                  </div>
                )}
                <input
                  type="tel"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="رقم الهاتف (للزبون الجديد)"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-right font-bold"
                  dir="ltr"
                />
              </div>

              {/* Invoice number — auto-computed, read-only */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5 font-tajawal">رقم الفاتورة</label>
                {/* للقراءة عند الإصدار (يُحجز تلقائياً)، وقابل للتعديل عند تحرير فاتورة —
                    وهذا هو السبيل الوحيد لتصحيح رقم مكرَّر وقع قبل إصلاح الترقيم. */}
                <input
                  type="text"
                  value={displayInvoiceNumber}
                  readOnly={!isEditing}
                  onChange={isEditing ? (e) => setInvoiceNumber(e.target.value) : undefined}
                  className={`w-full px-4 py-2 border rounded-xl text-xs text-right font-bold font-mono ${
                    isEditing
                      ? 'bg-white border-indigo-200 text-[#0B1F4D] focus:outline-none focus:ring-2 focus:ring-indigo-300'
                      : 'bg-slate-100 border-slate-200 text-slate-500 cursor-default'
                  }`}
                />
                <p className="text-[10px] text-slate-500 mt-1 font-tajawal">
                  {isEditing ? 'يمكنك تصحيحه إن تكرّر' : 'يُحسب تلقائياً بالتسلسل'}
                </p>
              </div>

              {/* Date — native date picker */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5 font-tajawal flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-indigo-600" />
                  تاريخ الفاتورة
                </label>
                <input
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold font-mono"
                  required
                />
              </div>
            </div>

            {/* Items rows with product autocomplete */}
            <div className="space-y-3.5 pt-2 border-t border-slate-100" ref={autocompleteRef}>
              <div className="flex justify-between items-center">
                <span className="text-xs font-extrabold text-[#0B1F4D]">المواد والكميات والأسعار</span>
                <button
                  type="button"
                  onClick={addNewItemRow}
                  className="text-xs text-indigo-700 font-extrabold hover:underline inline-flex items-center gap-1 cursor-pointer px-2 py-2 -my-1 rounded-lg hover:bg-indigo-50 min-h-[36px]"
                >
                  <span>+ إضافة مادة</span>
                </button>
              </div>

              <div className="space-y-2 pr-1">
                {items.map((itm, idx) => {
                  const suggestions = getProductSuggestions(idx);
                  const showDropdown = activeAutocompleteIdx === idx && suggestions.length > 0;

                  const linkedProduct = itm.productId ? inventoryItems.find(p => p.id === itm.productId) : undefined;

                  return (
                    <div key={idx} className="flex flex-wrap gap-2 items-center bg-slate-50/50 p-2 rounded-xl border border-slate-100">
                      <span className="text-[10px] text-slate-500 font-bold w-5 text-center flex-shrink-0">
                        {toArabicDigits(idx + 1)}
                      </span>

                      {/* Name with autocomplete dropdown */}
                      <div className="flex-1 relative min-w-0">
                        <input
                          type="text"
                          value={itm.name}
                          placeholder="اسم المادة أو امسح الباركود..."
                          onChange={(e) => handleItemNameChange(idx, e.target.value)}
                          onFocus={() => { if (!itm.productId) setActiveAutocompleteIdx(idx); }}
                          onKeyDown={(e) => handleItemNameKeyDown(e, idx)}
                          className={`w-full px-3 py-1.5 bg-white border rounded-lg text-xs text-right ${
                            itm.productId ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200'
                          }`}
                          required
                        />
                        {showDropdown && (
                          <div className="absolute top-full right-0 left-0 z-50 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
                            {suggestions.map(prod => (
                              <button
                                key={prod.id}
                                type="button"
                                onMouseDown={(e) => { e.preventDefault(); handleSelectProduct(idx, prod); }}
                                className="w-full px-3 py-2 text-right text-xs hover:bg-indigo-50 flex justify-between items-center gap-2 border-b border-slate-50 last:border-0"
                              >
                                <span title={prod.name} className="font-bold text-[#0B1F4D] truncate">{prod.name}</span>
                                <span className="text-[10px] text-slate-500 font-mono flex-shrink-0">
                                  {formatCurrency(prod.sellPrice, currency, exchangeRate)}
                                  {stockOf(prod, stampBranchId) <= 0
                                    ? ' ⚠️ نفد'
                                    : ` (${toArabicDigits(stockOf(prod, stampBranchId))})`}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Unit selector — only when the linked product has wholesale enabled */}
                      {linkedProduct?.hasWholesale && (
                        <div className="basis-full flex items-center gap-1.5 pr-7">
                          <span className="text-[11px] text-slate-500 font-bold flex-shrink-0">وحدة البيع:</span>
                          <select
                            value={itm.saleUnit ?? 'retail'}
                            onChange={(e) => handleChangeItemSaleUnit(idx, e.target.value as 'retail' | 'wholesale')}
                            className="px-2 py-1 bg-white border border-indigo-200 rounded-lg text-[10px] font-bold text-indigo-800 cursor-pointer outline-none"
                          >
                            <option value="retail">مفرد ({linkedProduct.unit || 'قطعة'})</option>
                            <option value="wholesale">
                              {linkedProduct.wholesaleUnitName} ({toArabicDigits(linkedProduct.wholesaleUnitQty || 0)} {linkedProduct.unit || 'قطعة'})
                            </option>
                          </select>
                        </div>
                      )}

                      {/* Serial / IMEI — يظهر فقط للمنتجات المعرّفة بضمان أو بتتبّع سيريال */}
                      {(linkedProduct?.defaultWarrantyMonths || linkedProduct?.tracksSerial) && (
                        <div className="basis-full flex items-center gap-1.5 pr-7">
                          <span className="text-[11px] text-emerald-700 font-extrabold flex-shrink-0">🛡️ السيريال/IMEI:</span>
                          <input
                            type="text"
                            value={itm.serials ?? ''}
                            onChange={(e) => updateItemField(idx, 'serials', e.target.value)}
                            placeholder={itm.quantity > 1 ? 'افصل بين الأرقام بفاصلة' : 'أدخل الرقم التسلسلي'}
                            dir="ltr"
                            className="flex-1 min-w-0 px-2 py-1 bg-white border border-emerald-200 rounded-lg text-[10px] font-mono font-bold text-center outline-none focus:border-emerald-500"
                          />
                          {!!linkedProduct?.defaultWarrantyMonths && (
                            <span className="text-[11px] text-emerald-700 font-bold flex-shrink-0 bg-emerald-50 px-1.5 py-1 rounded">
                              ضمان {toArabicDigits(linkedProduct.defaultWarrantyMonths)} شهر
                            </span>
                          )}
                        </div>
                      )}

                      {/* 🔴 «بِع بالأقدم أولاً» — تذكير لا إجبار.
                          الشحنة الأقدم انتهاءً تُعرض لحظة اختيار المادة، فيأخذها البائع
                          من الرفّ الصحيح. هذا هو ما يمنع التلف أصلاً — وكان محسوباً في
                          `oldestActiveBatch` وغير موصول بأي شاشة. */}
                      {(() => {
                        if (!linkedProduct || !tracksExpiry(linkedProduct)) return null;
                        const oldest = oldestActiveBatch(expiryBatches, linkedProduct.id);
                        if (!oldest) return null;
                        const daysLeft = daysBetweenKeys(todayISO(), oldest.expiryDate);
                        if (daysLeft === null) return null;
                        const urgent = daysLeft < 0;
                        return (
                          <div className="basis-full pr-7">
                            <span className={`inline-flex items-center gap-1 text-[11px] font-extrabold px-2 py-1 rounded-lg border ${
                              urgent ? 'text-rose-700 bg-rose-50 border-rose-200' : 'text-amber-800 bg-amber-50 border-amber-200'
                            }`}>
                              <Clock className="w-3 h-3 flex-shrink-0" />
                              <span>
                                بِع الأقدم أولاً — شحنة تنتهي {toArabicDigits(oldest.expiryDate)}
                                {urgent
                                  ? ` (منتهية منذ ${toArabicDigits(Math.abs(daysLeft))} يوماً — لا تبعها)`
                                  : ` (بقي ${toArabicDigits(daysLeft)} يوماً)`}
                              </span>
                            </span>
                          </div>
                        );
                      })()}

                      {/* 🔴 تحذير السيريال المُباع سابقاً — لحظة الكتابة لا بعد شهور.
                          سيريال يتكرّر يعني خطأ إدخال أو جهازاً مُباعاً مرتين، وكلاهما
                          يُفسد سجل الضمان ولا يُكتشف إلا حين يأتي زبون بجهاز لا يخصّه. */}
                      {(() => {
                        if (!itm.serials?.trim()) return null;
                        const dup = splitSerials(itm.serials)
                          .filter(sv => (soldSerialCounts.get(normalizeSerial(sv)) ?? 0) > 0);
                        if (dup.length === 0) return null;
                        return (
                          <div className="basis-full pr-7">
                            <span className="inline-flex items-center gap-1 text-[11px] font-extrabold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg">
                              <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                              <span dir="rtl">مُباع سابقاً: <span dir="ltr" className="font-mono">{dup.join('، ')}</span> — تأكّد من الرقم</span>
                            </span>
                          </div>
                        );
                      })()}

                      {/* Quantity */}
                      <input
                        type="text" inputMode="decimal"
                        value={itm.quantity}
                        placeholder="الكمية"
                        onChange={(e) => updateItemField(idx, 'quantity', readCount(e.target.value, { whenEmpty: itm.quantity }) ?? itm.quantity)}
                        className="w-16 px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-center font-bold flex-shrink-0"
                        min={1}
                        required
                      />

                      {/* Price */}
                      <input
                        type="text" inputMode="decimal"
                        value={itm.price}
                        placeholder="السعر"
                        onChange={(e) => updateItemField(idx, 'price', Math.max(0, readAmountOr(e.target.value, 0) ?? itm.price))}
                        className="w-24 px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-center font-bold flex-shrink-0"
                        required
                      />

                      {/* Auto-calculated row total */}
                      <span className="text-[11px] text-[#0B1F4D] font-bold w-20 text-left font-mono flex-shrink-0">
                        {formatCurrency(itm.quantity * itm.price, currency, exchangeRate)}
                      </span>

                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeItemRow(idx)}
                          className="p-1.5 border border-rose-100 hover:bg-rose-50 text-red-700 rounded-lg flex-shrink-0"
                        >
                          <Trash className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Discount & Tax */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3.5 border-t border-slate-100">
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">الخصم الإجمالي (نقداً)</label>
                <input
                  type="text" inputMode="decimal"
                  value={discountVal}
                  onChange={(e) => setDiscountVal(e.target.value)}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-right font-bold text-red-600"
                  min={0}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">نسبة الضريبة (%)</label>
                <div className="relative">
                  <input
                    type="text" inputMode="decimal"
                    value={taxRateVal}
                    onChange={(e) => setTaxRateVal(e.target.value)}
                    className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-right font-bold text-indigo-700"
                    min={0}
                    max={100}
                  />
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                    <Percent className="w-4 h-4 text-slate-400" />
                  </span>
                </div>
              </div>
            </div>

            {/* Totals + Payment panel */}
            <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-600 font-bold space-y-1.5">
              <div className="flex justify-between select-none">
                <span>مجموع المواد:</span>
                <span className="font-mono text-slate-800">{formatCurrency(calculatedSubtotal, currency, exchangeRate)}</span>
              </div>
              <div className="flex justify-between text-red-600 select-none">
                <span>الخصم:</span>
                <span>-{formatCurrency(parsedDiscount, currency, exchangeRate)}</span>
              </div>
              <div className="flex justify-between text-indigo-700 select-none">
                <span>الضرائب:</span>
                <span>+{formatCurrency(calculatedTaxAmount, currency, exchangeRate)}</span>
              </div>
              <div className="flex justify-between text-[#0B1F4D] text-sm pt-1.5 border-t border-slate-200">
                <span>المبلغ النهائي:</span>
                <span className="font-extrabold text-base">{formatCurrency(calculatedFinalAmount, currency, exchangeRate)}</span>
              </div>

              {/* Payment section */}
              <div className="pt-2 border-t border-slate-200 space-y-1.5">
                <div className="flex justify-between items-center gap-3">
                  <label className="flex items-center gap-1 text-[#0B1F4D] whitespace-nowrap flex-shrink-0">
                    <CreditCard className="w-3.5 h-3.5 text-indigo-600" />
                    <span>المبلغ المدفوع:</span>
                  </label>
                  <input
                    type="text" inputMode="decimal"
                    value={paidAmountVal}
                    onChange={(e) => setPaidAmountVal(e.target.value)}
                    placeholder={`${calculatedFinalAmount} (كامل)`}
                    className="flex-1 min-w-0 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-center font-bold font-mono"
                    min={0}
                  />
                </div>
                {isEditing && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1 mt-1">
                    ℹ المبلغ الواصل يشمل التسديدات المسجلة من قسم الديون — لا يمكن تخفيضه هنا؛ التسديدات تُدار من قسم الديون
                  </p>
                )}

                {/* ---- طريقة الدفع (تدعم تقسيم الفاتورة) ---- */}
                {parsedPaidAmount > 0 && (
                  <div className="pt-2 mt-1 border-t border-slate-200 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-extrabold text-[#0B1F4D]">💳 طريقة الدفع</span>
                      <button
                        type="button"
                        onClick={() => {
                          const next = !splitMode;
                          setSplitMode(next);
                          if (next) setPaySplits([{ method: payMethod, amount: parsedPaidAmount }, { method: 'Visa', amount: 0 }]);
                        }}
                        className="text-[10px] font-extrabold text-indigo-700 hover:underline cursor-pointer"
                      >
                        {splitMode ? '→ طريقة واحدة' : '→ تقسيم على عدّة طرق'}
                      </button>
                    </div>

                    {!splitMode ? (
                      <select
                        value={payMethod}
                        onChange={(e) => setPayMethod(e.target.value)}
                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-right cursor-pointer outline-none focus:border-indigo-400"
                      >
                        {paymentMethodOptions.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (
                      <div className="space-y-1.5">
                        {paySplits.map((sp, idx) => (
                          <div key={idx} className="flex items-center gap-1.5">
                            <select
                              value={sp.method}
                              onChange={(e) => setPaySplits(prev => prev.map((p, i) => i === idx ? { ...p, method: e.target.value } : p))}
                              className="flex-1 min-w-0 px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px] font-bold text-right cursor-pointer outline-none"
                            >
                              {paymentMethodOptions.map(m => <option key={m} value={m}>{m}</option>)}
                            </select>
                            <input
                              type="text" inputMode="decimal"
                              min={0}
                              value={sp.amount || ''}
                              onChange={(e) => setPaySplits(prev => prev.map((p, i) => i === idx ? { ...p, amount: Math.max(0, readAmountOr(e.target.value, 0) ?? p.amount) } : p))}
                              placeholder="المبلغ"
                              className="w-24 px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px] font-bold text-center font-mono outline-none"
                            />
                            {paySplits.length > 1 && (
                              <button type="button" onClick={() => setPaySplits(prev => prev.filter((_, i) => i !== idx))}
                                className="p-1.5 text-slate-500 hover:text-rose-600 cursor-pointer">
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        ))}
                        <div className="flex items-center justify-between gap-2">
                          <button type="button" onClick={() => setPaySplits(prev => [...prev, { method: 'Visa', amount: Math.max(0, splitDiff) }])}
                            className="text-[10px] font-extrabold text-indigo-700 hover:underline cursor-pointer flex items-center gap-1">
                            <Plus className="w-3 h-3" /> طريقة أخرى
                          </button>
                          <span className={`text-[10px] font-extrabold ${Math.round(splitDiff) === 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                            {Math.round(splitDiff) === 0
                              ? '✅ المجموع مطابق'
                              : splitDiff > 0
                                ? `متبقٍّ ${formatCurrency(splitDiff, currency, exchangeRate)}`
                                : `زائد ${formatCurrency(Math.abs(splitDiff), currency, exchangeRate)}`}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className={`flex justify-between pt-1 ${calculatedRemaining > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                  <span>
                    {calculatedRemaining > 0 ? '⚠️ المتبقي (دين على الزبون):' : '✅ حالة الدفع:'}
                  </span>
                  <span className="font-extrabold font-mono">
                    {calculatedRemaining > 0
                      ? formatCurrency(calculatedRemaining, currency, exchangeRate)
                      : 'مدفوع بالكامل'}
                  </span>
                </div>
              </div>
            </div>

            {/* الإصدار معطّل في العرض المجمّع — التعديل يبقى متاحاً (فرع الفاتورة محفوظ فيها) */}
            <button
              type="submit"
              disabled={isSubmitting || (isAggregateView && !isEditing)}
              title={isAggregateView && !isEditing ? 'اختر الفرع الذي تبيع منه أولاً' : undefined}
              className="w-full py-3 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-xs shadow transition cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="w-4 h-4" />
              <span>
                {isSubmitting ? 'جارٍ الحفظ...'
                  : isEditing ? 'حفظ تعديلات الفاتورة'
                  : isAggregateView ? 'اختر الفرع أولاً لإصدار الفاتورة'
                  : 'إصدار الفاتورة وحفظها'}
              </span>
            </button>

            {/* حفظ + طباعة بضغطة واحدة — للبيع السريع (يحفظ ويطبع فوراً دون البحث في المحفوظة) */}
            <button
              type="button"
              onClick={() => handleSubmitForm(undefined, true)}
              disabled={isSubmitting || (isAggregateView && !isEditing)}
              title={isAggregateView && !isEditing ? 'اختر الفرع الذي تبيع منه أولاً' : undefined}
              className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold rounded-xl text-xs shadow transition cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Printer className="w-4 h-4" />
              <span>{isSubmitting ? 'جارٍ الحفظ...' : isEditing ? 'حفظ التعديلات وطباعة' : 'حفظ وطباعة الفاتورة'}</span>
            </button>
          </form>
        </div>

        {/* RIGHT: Invoice list + preview (5 cols) */}
        <div className="lg:col-span-5 space-y-6">

          {/* Saved invoices list — grouped by customer */}
          <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm space-y-3">
            <div className="flex justify-between items-center">
              <h4 className="font-extrabold text-xs text-[#0B1F4D] font-cairo">الفواتير المحفوظة</h4>
              <span className="text-[10px] bg-slate-100 border border-slate-200 font-black text-[#0B1F4D] px-2.5 py-0.5 rounded-full select-none">
                {formatArabicNoun(filteredInvoices.length, ARABIC_NOUNS.invoice)} — {toArabicDigits(groupedInvoices.length)} زبون
              </span>
            </div>

            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500">
                  <Search className="w-3.5 h-3.5" />
                </span>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="ابحث برقم، عميل، تاريخ، أو بضاعة..."
                  className="w-full pr-8 pl-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-[11px] text-right focus:bg-white outline-none font-bold"
                />
              </div>
              {/* فلتر جهة الإصدار — لمراجعة فواتير الموظفين بسرعة */}
              <select
                value={issuerFilter}
                onChange={(e) => setIssuerFilter(e.target.value as 'all' | 'mine' | 'employees')}
                title="تصفية حسب جهة الإصدار"
                className="flex-shrink-0 px-2 py-2 bg-slate-50 border border-slate-100 rounded-xl text-[11px] font-bold text-slate-700 text-right outline-none focus:bg-white cursor-pointer"
              >
                <option value="all">عرض: الكل</option>
                <option value="mine">فواتيري</option>
                <option value="employees">فواتير الموظفين</option>
              </select>
            </div>

            {/* ---- Batch print toolbar (date range / print-all / print-selected) ---- */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 space-y-2.5">

              {/* Date range */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[10px] font-extrabold text-[#0B1F4D] flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5 text-indigo-600" />
                    طباعة حسب فترة زمنية
                  </span>
                  <div className="flex gap-1">
                    {([['today', 'اليوم'], ['week', 'الأسبوع'], ['month', 'الشهر']] as const).map(([p, lbl]) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => applyDatePreset(p)}
                        className="px-2 py-1 rounded-lg text-[10px] font-bold bg-white border border-slate-200 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 hover:border-indigo-200 transition cursor-pointer"
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={rangeFrom}
                    max={rangeTo || undefined}
                    onChange={(e) => setRangeFrom(e.target.value)}
                    className="flex-1 min-w-0 px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-[10px] font-bold font-mono outline-none focus:border-indigo-400"
                    title="من تاريخ"
                  />
                  <span className="text-slate-500 text-[10px] flex-shrink-0">—</span>
                  <input
                    type="date"
                    value={rangeTo}
                    min={rangeFrom || undefined}
                    onChange={(e) => setRangeTo(e.target.value)}
                    className="flex-1 min-w-0 px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-[10px] font-bold font-mono outline-none focus:border-indigo-400"
                    title="إلى تاريخ"
                  />
                  <button
                    type="button"
                    onClick={handlePrintRange}
                    disabled={rangeInvoices.length === 0}
                    className="flex-shrink-0 px-2.5 py-1.5 bg-[#0B1F4D] hover:bg-[#13295E] text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    title="طباعة كل فواتير الفترة"
                  >
                    <Printer className="w-3 h-3 text-emerald-400" />
                    <span>طباعة ({toArabicDigits(rangeInvoices.length)})</span>
                  </button>
                  {(rangeFrom || rangeTo) && (
                    <button
                      type="button"
                      onClick={() => { setRangeFrom(''); setRangeTo(''); }}
                      className="flex-shrink-0 p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition cursor-pointer"
                      title="مسح الفترة"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Print-all + print-selected */}
              <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200 flex-wrap">
                <button
                  type="button"
                  onClick={handlePrintAllFiltered}
                  disabled={filteredInvoices.length === 0}
                  className="px-2.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-100 text-[#0B1F4D] rounded-lg text-[10px] font-bold flex items-center gap-1 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  title="طباعة كل الفواتير المعروضة حسب الفلتر الحالي"
                >
                  <Printer className="w-3 h-3 text-indigo-600" />
                  <span>طباعة الكل ({toArabicDigits(filteredInvoices.length)})</span>
                </button>

                {selectedForPrint.size > 0 ? (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handlePrintSelected}
                      className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition cursor-pointer"
                      title="طباعة الفواتير المحددة يدوياً"
                    >
                      <Printer className="w-3 h-3" />
                      <span>طباعة المحدد ({toArabicDigits(selectedForPrint.size)})</span>
                    </button>
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition cursor-pointer"
                      title="إلغاء التحديد"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <span className="text-[11px] text-slate-500 font-bold">حدّد فواتير بمربعات الاختيار للطباعة الجماعية ☑</span>
                )}
              </div>
            </div>

            <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
              {groupedInvoices.length > 0 ? groupedInvoices.map((group) => {
                const isOpen = expandedGroups.has(group.key);
                const hasDebt = group.totalDebt > 0;
                return (
                  <div key={group.key} className="rounded-xl border border-slate-200 overflow-hidden">

                    {/* Group header — click to expand/collapse */}
                    <div className="flex items-center bg-slate-50 hover:bg-slate-100 transition">
                      <label
                        className="flex items-center pr-3 pl-1 cursor-pointer flex-shrink-0"
                        onClick={(e) => e.stopPropagation()}
                        title="تحديد كل فواتير هذا الزبون للطباعة"
                      >
                        <input
                          type="checkbox"
                          checked={isGroupFullySelected(group)}
                          onChange={() => toggleSelectGroup(group)}
                          className="w-5 h-5 accent-[#0B1F4D] cursor-pointer"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.key)}
                        className="flex-1 flex justify-between items-center p-3 pr-1 text-right min-w-0"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`text-slate-500 transition-transform duration-200 flex-shrink-0 ${isOpen ? 'rotate-90' : ''}`}>
                            ▶
                          </span>
                          <div className="min-w-0">
                            <span title={group.label} className="font-extrabold text-xs text-[#0B1F4D] block truncate">{group.label}</span>
                            <span className="text-[10px] text-slate-500 font-mono block mt-0.5">
                              {formatArabicNoun(group.invoices.length, ARABIC_NOUNS.invoice)}
                              {hasDebt && (
                                <span className="text-rose-600 font-bold"> — دين: {formatCurrency(group.totalDebt, currency, exchangeRate)}</span>
                              )}
                            </span>
                          </div>
                        </div>
                        <span className="font-extrabold text-xs text-[#0B1F4D] font-mono flex-shrink-0 mx-2">
                          {formatCurrency(group.totalAmount, currency, exchangeRate)}
                        </span>
                      </button>

                      {/* Print button — visible only when expanded */}
                      {isOpen && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handlePrintCustomerInvoices(group); }}
                          className="flex-shrink-0 ml-2 mr-2 px-2.5 py-1.5 bg-[#0B1F4D] hover:bg-[#13295E] text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition cursor-pointer"
                          title="طباعة كل فواتير هذا الزبون"
                        >
                          <Printer className="w-3 h-3 text-emerald-400" />
                          <span>طباعة السجل</span>
                        </button>
                      )}
                    </div>

                    {/* Group invoices — shown when expanded */}
                    {isOpen && (
                      <div className="divide-y divide-slate-50">
                        {group.invoices.map((inv) => {
                          const invHasDebt = (inv.remainingAmount ?? 0) > 0;
                          return (
                            <div
                              key={inv.id}
                              onClick={() => { setSelectedInvoiceId(inv.id); setIsPrintLayout(false); }}
                              className={`px-3 py-2.5 flex justify-between items-center transition cursor-pointer relative group/inv ${
                                selectedInvoiceId === inv.id
                                  ? 'bg-indigo-50 border-r-2 border-indigo-500'
                                  : 'bg-white hover:bg-slate-50'
                              }`}
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <input
                                  type="checkbox"
                                  checked={selectedForPrint.has(inv.id)}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={() => toggleSelectInvoice(inv.id)}
                                  className="w-5 h-5 accent-[#0B1F4D] cursor-pointer flex-shrink-0"
                                  title="تحديد هذه الفاتورة للطباعة"
                                />
                                <div className="min-w-0">
                                  <span className="text-[11px] text-slate-600 font-mono block">
                                    رقم {toArabicDigits(inv.invoiceNumber)} — {formatDate(inv.date)}
                                  </span>
                                  {isEmployeeInvoice(inv) && (
                                    <span className="inline-flex items-center gap-1 text-[11px] font-extrabold text-amber-800 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full mt-0.5 max-w-full">
                                      <span className="truncate">بواسطة: {invoiceIssuerName(inv)}</span>
                                    </span>
                                  )}
                                  {/* الموقع الذي بِيعت منه — في العرض المجمّع لا يميّزها شيء آخر */}
                                  {isMultiBranch && (
                                    <span className="inline-flex items-center gap-1 text-[11px] font-extrabold text-slate-600 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded-full mt-0.5 max-w-full">
                                      <span className="truncate">🏢 {branchName(inv.branchId)}</span>
                                    </span>
                                  )}
                                  {invHasDebt && (
                                    <span className="text-[11px] font-bold text-rose-600 block mt-0.5">
                                      دين: {formatCurrency(inv.remainingAmount!, currency, exchangeRate)} ⚠️
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                <span className="font-extrabold text-[11px] text-[#0B1F4D] font-mono">
                                  {formatCurrency(inv.finalAmount, currency, exchangeRate)}
                                </span>
                                <div className="opacity-100 md:opacity-0 md:group-hover/inv:opacity-100 transition flex items-center gap-1">
                                  <button
                                    onClick={() => handleOpenEditForm(inv)}
                                    className="p-1 hover:bg-indigo-50 text-indigo-700 rounded transition"
                                    title="تعديل"
                                  >
                                    <Edit className="w-3 h-3" />
                                  </button>
                                  <button
                                    onClick={() => handleDeleteInvoice(inv.id, inv.invoiceNumber)}
                                    className="p-1 hover:bg-rose-50 text-rose-600 rounded transition"
                                    title="حذف"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }) : (
                <div className="text-center py-6 text-slate-500 font-bold text-[11px]">
                  لم نعثر على أي فاتورة مطابقة
                </div>
              )}
            </div>
          </div>

          {/* Invoice preview */}
          {activeInvoice ? (
            <div className="space-y-3.5">
              <div className="flex justify-between items-center bg-white p-2.5 border border-slate-200 rounded-xl relative select-none">
                <span className="text-[11px] font-bold text-[#0B1F4D] font-cairo">منسق الطباعة:</span>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => { setIsPrintLayout(true); setIsThermalMode(true); }}
                    className={`px-3 py-1 rounded-lg text-[10px] font-black transition cursor-pointer ${
                      isPrintLayout && isThermalMode ? 'bg-[#0B1F4D] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    حرارية ٥٨ ملم 🖨
                  </button>
                  <button
                    onClick={() => { setIsPrintLayout(true); setIsThermalMode(false); }}
                    className={`px-3 py-1 rounded-lg text-[10px] font-black transition cursor-pointer ${
                      isPrintLayout && !isThermalMode ? 'bg-[#0B1F4D] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    A4 / PDF 📄
                  </button>
                  <button
                    onClick={() => setIsPrintLayout(false)}
                    className={`px-3 py-1 rounded-lg text-[10px] font-black transition cursor-pointer ${
                      !isPrintLayout ? 'bg-[#0B1F4D] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    عادي
                  </button>
                </div>
              </div>

              <div
                className={`transition-all duration-300 ${
                  isPrintLayout
                    ? isThermalMode
                      ? 'bg-neutral-100 p-6 font-mono border-2 border-dashed border-slate-300 max-w-[340px] mx-auto rounded shadow-lg text-black text-xs leading-relaxed'
                      : 'bg-white p-8 font-sans border-2 border-slate-200 rounded shadow-md max-w-full text-slate-950 text-xs'
                    : 'bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-inner space-y-4'
                }`}
                id="printable-sales-sheet"
              >
                {(() => {
                  const invPaid = activeInvoice.paidAmount ?? activeInvoice.finalAmount;
                  const invRemaining = activeInvoice.remainingAmount ?? 0;

                  if (isPrintLayout && isThermalMode) {
                    return (
                      <div className="space-y-4 text-center select-text">
                        <div>
                          <h4 className="font-extrabold text-[14px] uppercase tracking-wider">سند وصل قبض وصرف</h4>
                          <p className="text-[10px] text-neutral-500 mt-1">رتب شغلك 💎</p>
                        </div>
                        <div className="border-t border-b border-black border-dashed py-2.5 text-right font-mono text-[11px] space-y-1">
                          <div className="flex justify-between">
                            <span>الزبون:</span>
                            <span className="font-bold">{activeInvoice.customerName}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>رقم الوصل:</span>
                            <span>{activeInvoice.invoiceNumber}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>التاريخ:</span>
                            <span>{formatDate(activeInvoice.date)}</span>
                          </div>
                        </div>
                        <div className="text-right space-y-1.5 text-[11px]">
                          <span className="font-bold block border-b border-black border-dotted pb-1">المشتريات:</span>
                          {activeInvoice.items.map((it, idx) => (
                            <div key={idx} className="flex justify-between">
                              <span>{itemDisplayName(it)} (عدد {toArabicDigits(it.quantity)})</span>
                              <span className="font-mono">{formatCurrency(it.total, currency, exchangeRate)}</span>
                            </div>
                          ))}
                        </div>
                        <div className="border-t border-black border-dashed pt-2 text-[11px] space-y-1 text-right">
                          <div className="flex justify-between">
                            <span>المجموع:</span>
                            <span>{formatCurrency(activeInvoice.totalAmount, currency, exchangeRate)}</span>
                          </div>
                          {activeInvoice.discount > 0 && (
                            <div className="flex justify-between text-neutral-600">
                              <span>الخصم:</span>
                              <span>-{formatCurrency(activeInvoice.discount, currency, exchangeRate)}</span>
                            </div>
                          )}
                          {activeInvoice.tax > 0 && (
                            <div className="flex justify-between">
                              <span>الضرائب:</span>
                              <span>+{formatCurrency(activeInvoice.tax, currency, exchangeRate)}</span>
                            </div>
                          )}
                          <div className="flex justify-between font-black text-[13px] border-t border-black pt-1">
                            <span>المبلغ المستحق:</span>
                            <span>{formatCurrency(activeInvoice.finalAmount, currency, exchangeRate)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>المدفوع:</span>
                            <span className="font-bold">{formatCurrency(invPaid, currency, exchangeRate)}</span>
                          </div>
                          {invRemaining > 0 && (
                            <div className="flex justify-between font-black border-t border-dashed border-black pt-1">
                              <span>المتبقي (دين):</span>
                              <span>{formatCurrency(invRemaining, currency, exchangeRate)}</span>
                            </div>
                          )}
                        </div>
                        <div className="pt-4 text-center text-[10px] font-tajawal text-slate-500">
                          <p>✨ شكراً لزيارتكم ✨</p>
                          <p>رتب شغلك لإدارة المشاريع</p>
                        </div>
                      </div>
                    );
                  }

                  if (isPrintLayout && !isThermalMode) {
                    return (
                      <div className="space-y-6 select-text">
                        <div className="flex justify-between items-start border-b-2 border-[#0B1F4D] pb-4">
                          <div>
                            <h3 className="font-extrabold font-cairo text-lg text-[#0B1F4D]">مستند فاتورة بيع بضائع</h3>
                            <p className="text-xs text-slate-500 mt-1">رتب شغلك الإدارية السحابية</p>
                          </div>
                          <div className="text-left">
                            <h4 className="font-extrabold text-slate-500 text-xs font-mono">فاتورة رقم: {toArabicDigits(activeInvoice.invoiceNumber)}</h4>
                            <p className="text-[10px] text-slate-500 block mt-1">التاريخ: {formatDate(activeInvoice.date)}</p>
                          </div>
                        </div>
                        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 grid grid-cols-2 gap-4">
                          <div>
                            <span className="text-[10px] text-slate-500 block font-bold">العميل:</span>
                            <span className="font-extrabold text-xs text-[#0B1F4D] block mt-1">{activeInvoice.customerName}</span>
                          </div>
                          <div className="text-left">
                            <span className="text-[10px] text-slate-500 block font-bold">الحالة:</span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full border font-extrabold inline-block mt-1 ${
                              invRemaining > 0
                                ? 'text-rose-800 bg-rose-50 border-rose-100'
                                : 'text-emerald-800 bg-emerald-50 border-emerald-100'
                            }`}>
                              {invRemaining > 0 ? `دين: ${formatCurrency(invRemaining, currency, exchangeRate)} ⚠️` : 'مدفوع نقداً ✅'}
                            </span>
                          </div>
                        </div>
                        <div className="space-y-2.5">
                          <span className="font-extrabold text-[#0B1F4D] text-xs block">جدول المواد:</span>
                          {/* 🔴 `print:overflow-visible` ليس زينة: هذا الجدول داخل ورقة
                              الطباعة (#printable-sales-sheet). غلافُ تمرير بلا هذا الاستثناء
                              يقصّ أعمدة الفاتورة **المطبوعة** على الكمبيوتر. */}
                          <div className="overflow-x-auto print:overflow-visible">
                          <table className="w-full text-right text-xs rounded-xl overflow-hidden border border-slate-100">
                            <thead className="bg-[#EEF2F8] text-[#0B1F4D] font-bold">
                              <tr>
                                <th className="p-2.5 border-b">اسم المادة</th>
                                <th className="p-2.5 text-center border-b">الكمية</th>
                                <th className="p-2.5 text-center border-b">السعر</th>
                                <th className="p-2.5 text-left border-b">المجموع</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {activeInvoice.items.map((it, i) => (
                                <tr key={i}>
                                  <td className="p-2.5 font-bold text-slate-800">{itemDisplayName(it)}</td>
                                  <td className="p-2.5 text-center font-mono">{toArabicDigits(it.quantity)}</td>
                                  <td className="p-2.5 text-center font-mono">{formatCurrency(it.price, currency, exchangeRate)}</td>
                                  <td className="p-2.5 text-left font-mono font-bold text-slate-900">{formatCurrency(it.total, currency, exchangeRate)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          </div>
                        </div>
                        <div className="border-t border-slate-200 pt-4 flex justify-end">
                          <div className="w-64 space-y-1.5 text-xs text-slate-600 font-medium">
                            <div className="flex justify-between">
                              <span>المجموع الفرعي:</span>
                              <span className="font-mono text-slate-800">{formatCurrency(activeInvoice.totalAmount, currency, exchangeRate)}</span>
                            </div>
                            {activeInvoice.discount > 0 && (
                              <div className="flex justify-between text-red-600">
                                <span>الخصم:</span>
                                <span>-{formatCurrency(activeInvoice.discount, currency, exchangeRate)}</span>
                              </div>
                            )}
                            {activeInvoice.tax > 0 && (
                              <div className="flex justify-between text-indigo-700">
                                <span>الضرائب:</span>
                                <span>+{formatCurrency(activeInvoice.tax, currency, exchangeRate)}</span>
                              </div>
                            )}
                            <div className="flex justify-between font-black text-sm text-[#0B1F4D] bg-[#EEF2F8] p-2.5 rounded-xl border border-slate-200">
                              <span>المجموع الكلي:</span>
                              <span>{formatCurrency(activeInvoice.finalAmount, currency, exchangeRate)}</span>
                            </div>
                            <div className="flex justify-between pt-1">
                              <span>المدفوع:</span>
                              <span className="font-mono font-bold text-emerald-700">{formatCurrency(invPaid, currency, exchangeRate)}</span>
                            </div>
                            {invRemaining > 0 && (
                              <div className="flex justify-between text-rose-700 font-black">
                                <span>المتبقي (دين):</span>
                                <span>{formatCurrency(invRemaining, currency, exchangeRate)}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  // Normal view
                  return (
                    <div className="space-y-4">
                      <div className="flex justify-between items-center border-b border-dashed border-slate-200 pb-3">
                        <div>
                          <span className="text-[10px] bg-slate-100 text-[#0B1F4D] px-2 py-0.5 rounded-full font-bold select-none">وصل معتمد 💎</span>
                          <h3 className="text-sm font-extrabold text-[#0B1F4D] font-cairo mt-1">تفاصيل المبيعات</h3>
                          <span className={`text-[11px] font-extrabold block mt-1 ${invRemaining > 0 ? 'text-rose-600' : 'text-[#22c55e]'}`}>
                            {invRemaining > 0 ? `دين: ${formatCurrency(invRemaining, currency, exchangeRate)} ⚠️` : 'تم الدفع نقداً ✅'}
                          </span>
                        </div>
                        <div className="text-left font-mono">
                          <span className="text-[10px] text-slate-500 block font-bold">رقم: {toArabicDigits(activeInvoice.invoiceNumber)}</span>
                          <span className="text-[10px] text-slate-500 block mt-1">{formatDate(activeInvoice.date)}</span>
                        </div>
                      </div>
                      <div className="space-y-1.5 text-xs">
                        <span className="font-extrabold text-slate-500 block select-none">العميل:</span>
                        <span className="font-extrabold text-[#0B1F4D] block text-sm">{activeInvoice.customerName}</span>
                      </div>
                      {/* جهة الإصدار — للمالك داخل التطبيق فقط (لا تُطبع). موظف = كهرماني بارز، المالك = محايد */}
                      <div className={`flex items-center gap-2 text-xs rounded-xl px-3 py-2 border ${
                        isEmployeeInvoice(activeInvoice)
                          ? 'bg-amber-50 border-amber-200 text-amber-900'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                      }`}>
                        <span className="font-extrabold select-none">أصدرها:</span>
                        <span className="font-extrabold">{invoiceIssuerName(activeInvoice)}</span>
                        {isMultiBranch && (
                          <span className="font-extrabold mr-auto text-slate-600">🏢 {branchName(activeInvoice.branchId)}</span>
                        )}
                      </div>
                      <div className="space-y-1.5 text-xs">
                        <span className="font-extrabold text-slate-500 block select-none">المواد:</span>
                        {activeInvoice.items.map((itm, id) => (
                          <div key={id} className="flex justify-between items-center border-b border-slate-50 pb-1.5">
                            <span className="font-bold text-slate-700">{itemDisplayName(itm)} (عدد {toArabicDigits(itm.quantity)})</span>
                            <span className="font-extrabold text-slate-900 font-mono">{formatCurrency(itm.total, currency, exchangeRate)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="border-t border-dashed border-slate-200 pt-3 text-xs font-bold space-y-1.5">
                        <div className="flex justify-between select-none">
                          <span className="text-slate-500">المجموع الأولي</span>
                          <span className="font-mono text-slate-700">{formatCurrency(activeInvoice.totalAmount, currency, exchangeRate)}</span>
                        </div>
                        {activeInvoice.discount > 0 && (
                          <div className="flex justify-between text-red-600 select-none">
                            <span>الخصم</span>
                            <span className="font-mono">-{formatCurrency(activeInvoice.discount, currency, exchangeRate)}</span>
                          </div>
                        )}
                        {activeInvoice.tax > 0 && (
                          <div className="flex justify-between text-indigo-700 select-none">
                            <span>الضرائب</span>
                            <span className="font-mono">+{formatCurrency(activeInvoice.tax, currency, exchangeRate)}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-[#0B1F4D] bg-[#EEF2F8] p-2.5 rounded-xl border border-slate-200">
                          <span>المبلغ الصافي</span>
                          <span className="font-extrabold text-sm font-mono">{formatCurrency(activeInvoice.finalAmount, currency, exchangeRate)}</span>
                        </div>
                        <div className="flex justify-between text-emerald-700">
                          <span>المبلغ المدفوع</span>
                          <span className="font-mono font-extrabold">{formatCurrency(invPaid, currency, exchangeRate)}</span>
                        </div>
                        {invRemaining > 0 && (
                          <div className="flex justify-between text-rose-700 bg-rose-50 p-2.5 rounded-xl border border-rose-100">
                            <span>المتبقي (دين على الزبون)</span>
                            <span className="font-extrabold font-mono">{formatCurrency(invRemaining, currency, exchangeRate)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    window.print();
                    triggerAlert('تم تفعيل الطباعة — اختر PDF لحفظها');
                  }}
                  className="flex-1 py-2.5 px-3 bg-[#0B1F4D] hover:bg-[#13295E] rounded-xl text-xs font-extrabold inline-flex items-center justify-center gap-1.5 text-white transition cursor-pointer shadow-sm"
                >
                  <Printer className="w-4 h-4 text-emerald-500" />
                  <span>{isPrintLayout ? 'تصدير PDF 🖨' : 'طباعة / PDF'}</span>
                </button>
                <button
                  onClick={() => handleShareWhatsApp(activeInvoice)}
                  className="px-4.5 py-2.5 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded-xl hover:text-emerald-800 transition"
                  title="مشاركة واتساب"
                >
                  <Share2 className="w-4.5 h-4.5" />
                </button>
                <button
                  onClick={() => handleOpenEditForm(activeInvoice)}
                  className="px-4.5 py-2.5 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-xl hover:text-indigo-800 transition"
                  title="تعديل الفاتورة"
                >
                  <Edit className="w-4.5 h-4.5" />
                </button>
              </div>

              <div className="p-3 bg-indigo-50/50 hover:bg-indigo-50 border border-indigo-100 rounded-2xl text-[10px] text-indigo-900 leading-relaxed font-bold flex items-start gap-1.5">
                <Info className="w-4.5 h-4.5 flex-shrink-0 text-indigo-600 mt-0.5 animate-bounce" />
                <span>لتصدير الفاتورة كـ PDF، انقر "طباعة" ثم اختر "حفظ كملف PDF" من نافذة المتصفح.</span>
              </div>
            </div>
          ) : (
            <div className="text-center p-8 text-slate-500 bg-white rounded-2xl border border-slate-100 font-bold select-none text-xs">
              حدد فاتورة من الفهرس لمراجعة محتواها وطباعة السندات
            </div>
          )}
        </div>
      </div>

      {/* ===== RETURN / REFUND MODAL — إرجاع فاتورة (كلي/جزئي) ===== */}
      {returnModalOpen && (() => {
        const returnInv = invoices.find(i => i.id === returnInvoiceId) || null;
        const preview = returnInv ? computeReturn(returnInv, returnQtys) : null;
        const returnableInvoices = invoices
          .filter(i => (i.items?.length ?? 0) > 0 && i.finalAmount > 0)
          .filter(i => {
            const q = returnSearch.trim().toLowerCase();
            if (!q) return true;
            return String(i.invoiceNumber).toLowerCase().includes(q) || i.customerName.toLowerCase().includes(q);
          })
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        return (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4" dir="rtl">
            <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
              <div className="p-5 bg-gradient-to-r from-amber-600 to-amber-500 text-white flex justify-between items-center flex-shrink-0">
                <h3 className="font-black text-sm md:text-base font-cairo flex items-center gap-1.5">
                  <RotateCcw className="w-5 h-5" />
                  <span>{returnInv ? `استرجاع من فاتورة ${toArabicDigits(returnInv.invoiceNumber)}` : 'إرجاع فاتورة — اختر الفاتورة'}</span>
                </h3>
                <button onClick={() => setReturnModalOpen(false)} className="p-1.5 hover:bg-white/10 rounded-lg text-white font-black text-xs cursor-pointer">إغلاق ✕</button>
              </div>

              {!returnInv ? (
                <div className="p-4 overflow-y-auto flex-1 space-y-3">
                  <div className="relative">
                    <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input type="text" value={returnSearch} onChange={e => setReturnSearch(e.target.value)}
                      placeholder="ابحث برقم الفاتورة أو اسم الزبون..." autoFocus
                      className="w-full pr-9 pl-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-right outline-none focus:bg-white" />
                  </div>
                  {returnableInvoices.length === 0 ? (
                    <div className="py-12 text-center text-slate-500 font-bold text-xs">لا توجد فواتير قابلة للاسترجاع</div>
                  ) : (
                    <div className="space-y-1.5">
                      {returnableInvoices.slice(0, 100).map(inv => (
                        <button key={inv.id} onClick={() => selectReturnInvoice(inv)}
                          className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-slate-200 hover:bg-amber-50 hover:border-amber-200 transition text-right cursor-pointer">
                          <div className="min-w-0">
                            <span className="text-xs font-extrabold text-[#0B1F4D] block">فاتورة {toArabicDigits(inv.invoiceNumber)}</span>
                            <span className="text-[10px] text-slate-500 font-bold block mt-0.5">{inv.customerName} · {formatDate(inv.date)} · {formatArabicNoun(inv.items.length, ARABIC_NOUNS.product)}</span>
                          </div>
                          <span className="text-xs font-extrabold text-emerald-700 font-mono flex-shrink-0">{formatCurrency(inv.finalAmount, currency, exchangeRate)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="p-4 overflow-y-auto flex-1 space-y-2">
                    <button onClick={() => { setReturnInvoiceId(null); setReturnQtys({}); }}
                      className="text-[11px] text-amber-700 font-bold hover:underline mb-1 cursor-pointer">← اختيار فاتورة أخرى</button>
                    {returnInv.items.map(it => {
                      const rq = Math.max(0, Math.min(Math.floor(returnQtys[it.itemId] ?? 0), it.quantity));
                      return (
                        <div key={it.itemId} className="border border-slate-200 rounded-xl p-3 flex items-center gap-3 flex-wrap sm:flex-nowrap">
                          <div className="min-w-0 flex-1">
                            <span className="text-xs font-extrabold text-[#0B1F4D] block truncate">{it.unitLabel ? `${it.name} - ${it.unitLabel}` : it.name}</span>
                            <span className="text-[10px] text-slate-500 font-bold block mt-0.5">مُباع: {toArabicDigits(it.quantity)} · السعر {formatCurrency(it.price, currency, exchangeRate)}</span>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <span className="text-[10px] text-slate-500 font-bold">استرجاع:</span>
                            <button type="button" onClick={() => setReturnQtys(p => ({ ...p, [it.itemId]: Math.max(0, rq - 1) }))}
                              className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 font-black text-slate-700 cursor-pointer">−</button>
                            <input type="text" inputMode="decimal" min={0} max={it.quantity} value={rq}
                              onChange={e => setReturnQtys(p => ({ ...p, [it.itemId]: Math.max(0, Math.min(it.quantity, readCount(e.target.value, { whenEmpty: 0 }) ?? 0)) }))}
                              className="w-14 px-1 py-1.5 border border-slate-200 rounded-lg text-xs font-bold text-center outline-none" />
                            <button type="button" onClick={() => setReturnQtys(p => ({ ...p, [it.itemId]: Math.min(it.quantity, rq + 1) }))}
                              className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 font-black text-slate-700 cursor-pointer">+</button>
                            <button type="button" onClick={() => setReturnQtys(p => ({ ...p, [it.itemId]: it.quantity }))}
                              className="text-[10px] text-amber-700 font-bold px-1.5 hover:underline cursor-pointer">الكل</button>
                          </div>
                          <div className="w-24 text-left flex-shrink-0">
                            <span className="text-xs font-extrabold text-amber-700 font-mono">{formatCurrency(rq * it.price, currency, exchangeRate)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="p-4 bg-slate-50 border-t border-slate-100 flex-shrink-0 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-[11px] text-slate-500 font-bold block">المبلغ المُعاد للزبون</span>
                        <span className="text-[10px] text-slate-500 font-bold">{preview ? `${toArabicDigits(preview.totalQty)} قطعة` : ''}</span>
                      </div>
                      <span className="font-black text-lg text-amber-700 font-mono">{formatCurrency(preview?.reduction ?? 0, currency, exchangeRate)}</span>
                    </div>
                    <button onClick={handleProcessReturn} disabled={isReturning || !preview || preview.totalQty === 0}
                      className="w-full py-3 bg-amber-600 hover:bg-amber-700 text-white font-extrabold rounded-xl text-sm shadow transition cursor-pointer flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed">
                      <RotateCcw className="w-4 h-4" />
                      <span>{isReturning ? 'جارٍ الاسترجاع...' : 'تأكيد الاسترجاع'}</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
