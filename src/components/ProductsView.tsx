import React, { useState, useRef, useEffect, useMemo } from 'react';
import { writeBatch, doc, updateDoc, deleteField } from 'firebase/firestore';
import NumberInput from './NumberInput';
import { db } from '../firebase';
import { useCollection } from '../hooks/useCollection';
import { useProductCosts } from '../hooks/useProductCosts';
import { useSession } from '../context/SessionContext';
import { useConfirm } from '../hooks/useConfirm';
import {
  Package, Plus, Search, Trash2, Edit, AlertTriangle,
  TrendingUp, Box, Check, CheckCircle2, ShieldAlert,
  Barcode, Upload, Layers, X, Settings2, Tag, Ruler, ClipboardList, Printer, Download, FileText
} from 'lucide-react';
import { toArabicDigits, formatArabicNoun, ARABIC_NOUNS, formatCurrency, parseAmount } from '../utils/arabicFormatters';
import { Product, ProductCost, SystemSettings } from '../types';
import { printPurchaseList, PurchaseLine } from '../utils/printPurchaseList';
import { exportAsWord, exportAsPdf, ExportSpec } from '../utils/exportDoc';
import { useActor } from '../hooks/useActor';
import { logAudit } from '../utils/auditLog';
import BulkImportModal from './BulkImportModal';
import BarcodeLabelsModal from './BarcodeLabelsModal';
import { parseProductRows, PRODUCT_HEADERS, PRODUCT_SAMPLE_ROW, PRODUCT_GRID, ParsedRow } from '../utils/bulkImport';
import { useBranches } from '../hooks/useBranches';
import { visibleStock, stockOf, stockUpdate, stockUpdateSeeded } from '../utils/branchStock';
import { genId } from '../utils/genId';
import { inventoryValue } from '../utils/decisionReports';
import { reportFirestoreError } from '../utils/writeGuard';
import { todayISO } from '../utils/dateLocal';

// توحيد النص: إزالة المسافات الطرفية وتقليص المسافات المتكررة لمسافة واحدة
const normalizeOption = (s: string) => (s || '').trim().replace(/\s+/g, ' ');

// دمج قوائم الخيارات من مصادر متعددة مع منع التكرار (بغض النظر عن حالة الأحرف/المسافات).
// الأولوية للنص الأول الذي يظهر (الثابت ثم المخصّص ثم الموجود بالمنتجات) كصيغة معتمدة.
const mergeOptions = (...sources: (string | undefined)[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of sources) {
    const val = normalizeOption(raw || '');
    if (!val) continue;
    const key = val.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(val);
    }
  }
  return out;
};

interface ProductsViewProps {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  settings: SystemSettings;
  updateSettings: (newSettings: Partial<SystemSettings>) => void;
  storeName: string;
}

export default function ProductsView({ currency, exchangeRate, settings, updateSettings, storeName }: ProductsViewProps) {
  const { requestConfirm, confirmDialog } = useConfirm();
  // ---- 1. FIRESTORE DATA LAYER ----
  const { items: products, save: saveProduct } = useCollection<Product>('products');
  // التكلفة مفصولة في product_costs — buyPriceOf يوحّد قراءة تكلفة المفرد (مع fallback موروث)،
  // وwholesaleBuyPriceOf يقرأ تكلفة الجملة (بلا fallback — غيابها = غير معروفة)
  const { buyPriceOf, wholesaleBuyPriceOf } = useProductCosts();
  const { ownerUid } = useSession();
  const actor = useActor(); // لسجل التدقيق — توثيق تعديل الأسعار وحذف المنتجات
  // مخزون الفرع: في وضع «كل الفروع» يعرض الإجمالي، وفي فرع محدّد يعرض مخزون ذلك الفرع.
  // لصاحب الفرع الواحد النتيجة مطابقة تماماً لما كان (الإجمالي = مخزون الرئيسي).
  const { activeBranchId, stampBranchId, isMultiBranch, branchName } = useBranches(storeName);
  const qtyOf = (p: Pick<Product, 'quantity' | 'branchStock'>) => visibleStock(p, activeBranchId);

  // ---- 2. FILTER & SEARCH CONTROL ----
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterStock, setFilterStock] = useState<'all' | 'low' | 'instock'>('all');
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [barcodeSearchInput, setBarcodeSearchInput] = useState('');

  // ---- قائمة تجهيز النواقص (طلبية الشراء) ----
  const [showReorderModal, setShowReorderModal] = useState(false);
  // الكمية المقترحة القابلة للتعديل لكل مادة، بوحدة الشراء (كارتون للجملة، وإلا وحدة الأساس)
  const [reorderQty, setReorderQty] = useState<Record<string, string>>({});

  // Form Modals controlling
  const [showFormModal, setShowFormModal] = useState(false);
  const [formIsEditing, setFormIsEditing] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);

  // Form standard fields
  const [formName, setFormName] = useState('');
  const [formBarcode, setFormBarcode] = useState('');
  const [formBuyPrice, setFormBuyPrice] = useState('');
  const [formSellPrice, setFormSellPrice] = useState('');
  const [formQuantity, setFormQuantity] = useState('');
  /**
   * كمية الفرع لحظة فتح النموذج — أساس السؤال «هل غيّر التاجر الحقل؟».
   * نفس نمط `loadedBalance` في شاشة الزبائن، ولنفس السبب حرفياً.
   */
  const [loadedBranchQty, setLoadedBranchQty] = useState(0);
  const [formLowStock, setFormLowStock] = useState('5');
  const [formCategory, setFormCategory] = useState('');
  const [formUnit, setFormUnit] = useState('');

  // Wholesale (بيع بالجملة) — optional per product
  const [formHasWholesale, setFormHasWholesale] = useState(false);
  const [formWholesaleUnitName, setFormWholesaleUnitName] = useState('كارتون');
  const [formWholesaleUnitQty, setFormWholesaleUnitQty] = useState('');
  const [formWholesalePrice, setFormWholesalePrice] = useState('');
  const [formWholesaleBuyPrice, setFormWholesaleBuyPrice] = useState(''); // تكلفة شراء الكرتون
  // الضمان/السيريال — فارغ للمواد العادية (حليب/شامبو) فلا يظهر حقل السيريال في الفاتورة
  const [formWarrantyMonths, setFormWarrantyMonths] = useState('');
  const [formTracksSerial, setFormTracksSerial] = useState(false);

  // Barcode scanner support
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const [barcodeCheckResult, setBarcodeCheckResult] = useState<'new' | 'duplicate' | null>(null);
  const [foundProductForBarcode, setFoundProductForBarcode] = useState<Product | null>(null);

  // ---- Inline "add new category / unit" controls (quick add from the product form) ----
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryText, setNewCategoryText] = useState('');
  const [addingUnit, setAddingUnit] = useState(false);
  const [newUnitText, setNewUnitText] = useState('');

  // ---- "Manage categories/units" modal (full CRUD: add / rename / delete) ----
  const [showManageModal, setShowManageModal] = useState(false);
  const [manageCatInput, setManageCatInput] = useState('');   // إضافة صنف جديد من نافذة الإدارة
  const [manageUnitInput, setManageUnitInput] = useState('');  // إضافة وحدة جديدة من نافذة الإدارة
  const [editingCat, setEditingCat] = useState<string | null>(null);   // الصنف الجاري تعديل اسمه (قيمته الأصلية)
  const [editingCatText, setEditingCatText] = useState('');
  const [editingUnit, setEditingUnit] = useState<string | null>(null); // الوحدة الجاري تعديل اسمها (قيمتها الأصلية)
  const [editingUnitText, setEditingUnitText] = useState('');

  // Auto-focus barcode when adding new product
  useEffect(() => {
    if (showFormModal && !formIsEditing) {
      const t = setTimeout(() => {
        // لا نسحب التركيز إذا بدأ المستخدم الكتابة في حقل آخر خلال المهلة
        const active = document.activeElement;
        const typingElsewhere = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
        if (!typingElsewhere) barcodeInputRef.current?.focus();
      }, 80);
      return () => clearTimeout(t);
    }
  }, [showFormModal, formIsEditing]);

  // Alerts box
  const [alert, setAlert] = useState<{ text: string; type: 'success' | 'info' | 'danger' } | null>(null);
  const triggerAlert = (text: string, type: 'success' | 'info' | 'danger' = 'success') => {
    setAlert({ text, type });
    setTimeout(() => setAlert(null), 4000);
  };

  // ---- Central category/unit option lists (merged from a single source) ----
  const customCategories = settings.customCategories ?? [];
  const customUnits = settings.customUnits ?? [];

  // القائمة المركزية = ما أضافه المستخدم فقط (تبدأ فارغة). لا توجد أصناف/وحدات افتراضية مبرمجة.
  const allCategories = useMemo(() => mergeOptions(...customCategories), [customCategories]);

  /**
   * أصناف **الفلتر** = المركزية + ما تحمله المنتجات فعلاً.
   * بدون الثانية يختفي الصنف من الفلتر بمجرد حذفه من القائمة، فتصير منتجاته غير قابلة
   * للتصفية وهي أمام العين في القائمة — نقصٌ صامت في أداة بحث.
   */
  const filterCategories = useMemo(
    () => mergeOptions(...allCategories, ...products.map(p => p.category)),
    [allCategories, products],
  );
  const allUnits = useMemo(() => mergeOptions(...customUnits), [customUnits]);

  // خيارات القائمة داخل نموذج المنتج: القائمة المركزية + القيمة المختارة حالياً (حتى لو حُذفت من
  // المركز أثناء تعديل منتج قديم يحمل صنفاً/وحدة لم تعد موجودة، فلا تُفقد قيمته المخزّنة).
  const categoryFormOptions = useMemo(
    () => mergeOptions(...allCategories, formCategory),
    [allCategories, formCategory]
  );
  const unitFormOptions = useMemo(
    () => mergeOptions(...allUnits, formUnit),
    [allUnits, formUnit]
  );

  // إضافة صنف جديد للمصدر المركزي (fire-and-forget) مع منع التكرار واختياره تلقائياً
  const handleAddCategory = () => {
    const val = normalizeOption(newCategoryText);
    if (!val) {
      triggerAlert('يرجى كتابة اسم الصنف الجديد', 'danger');
      return;
    }
    const existing = allCategories.find(c => c.toLowerCase() === val.toLowerCase());
    if (existing) {
      setFormCategory(existing);
      triggerAlert(`الصنف "${existing}" موجود مسبقاً — تم اختياره`, 'info');
    } else {
      updateSettings({ customCategories: [...customCategories, val] });
      setFormCategory(val);
      triggerAlert(`تمت إضافة الصنف الجديد "${val}" ✅`);
    }
    setNewCategoryText('');
    setAddingCategory(false);
  };

  // إضافة وحدة قياس جديدة للمصدر المركزي (fire-and-forget) مع منع التكرار واختيارها تلقائياً
  const handleAddUnit = () => {
    const val = normalizeOption(newUnitText);
    if (!val) {
      triggerAlert('يرجى كتابة اسم وحدة القياس الجديدة', 'danger');
      return;
    }
    const existing = allUnits.find(u => u.toLowerCase() === val.toLowerCase());
    if (existing) {
      setFormUnit(existing);
      triggerAlert(`وحدة القياس "${existing}" موجودة مسبقاً — تم اختيارها`, 'info');
    } else {
      updateSettings({ customUnits: [...customUnits, val] });
      setFormUnit(val);
      triggerAlert(`تمت إضافة وحدة القياس الجديدة "${val}" ✅`);
    }
    setNewUnitText('');
    setAddingUnit(false);
  };

  // ---- Manage modal: full CRUD on the central category/unit lists (fire-and-forget) ----

  const openManageModal = () => {
    setManageCatInput('');
    setManageUnitInput('');
    setEditingCat(null);
    setEditingCatText('');
    setEditingUnit(null);
    setEditingUnitText('');
    setShowManageModal(true);
  };

  // إضافة صنف من نافذة الإدارة (لا يُختار تلقائياً في النموذج — إدارة القائمة فقط)
  const handleManageAddCategory = () => {
    const val = normalizeOption(manageCatInput);
    if (!val) { triggerAlert('يرجى كتابة اسم الصنف الجديد', 'danger'); return; }
    if (customCategories.some(c => c.toLowerCase() === val.toLowerCase())) {
      triggerAlert(`الصنف "${val}" موجود مسبقاً`, 'info');
    } else {
      updateSettings({ customCategories: [...customCategories, val] });
      triggerAlert(`تمت إضافة الصنف "${val}" ✅`);
    }
    setManageCatInput('');
  };

  // تعديل اسم صنف في القائمة المركزية فقط (حر). لا يؤثر على المنتجات القديمة التي خزّنت النص.
  const handleRenameCategory = (oldVal: string) => {
    const val = normalizeOption(editingCatText);
    if (!val) { triggerAlert('اسم الصنف لا يمكن أن يكون فارغاً', 'danger'); return; }
    if (customCategories.some(c => c !== oldVal && c.toLowerCase() === val.toLowerCase())) {
      triggerAlert(`الصنف "${val}" موجود مسبقاً`, 'danger'); return;
    }
    updateSettings({ customCategories: customCategories.map(c => (c === oldVal ? val : c)) });
    if (formCategory === oldVal) setFormCategory(val); // إبقاء النموذج المفتوح متسقاً
    setEditingCat(null);
    setEditingCatText('');
    triggerAlert(`تم تعديل اسم الصنف إلى "${val}"`);
  };

  /**
   * 🔴 حذف الصنف يُعلن أثره على المنتجات.
   *
   * قائمة الفلتر كانت تُبنى من الإعدادات وحدها، فحذف صنف يترك منتجاته تحمل اسمه
   * **بلا سبيل لتصفيتها** — تختفي من الفلتر بلا كلمة. عالجنا ذلك من طرفين: الفلتر يضمّ
   * الآن أصناف المنتجات الفعلية (فلا يضيع شيء)، والحذف يقول كم منتجاً يحمل الصنف.
   */
  const handleDeleteCategory = async (val: string) => {
    const used = products.filter(p => p.category === val).length;
    if (used > 0) {
      const ok = await requestConfirm(
        `حذف الصنف «${val}» من القائمة؟\n\n`
        + `${formatArabicNoun(used, ARABIC_NOUNS.product)} تحمل هذا الصنف — لن تتغيّر، `
        + `وسيبقى الصنف ظاهراً في فلتر البحث ما دام مستعملاً.\n`
        + `لكنه لن يظهر في قائمة الاختيار عند إضافة منتج جديد.`,
      );
      if (!ok) return;
    }
    updateSettings({ customCategories: customCategories.filter(c => c !== val) });
    if (formCategory === val) setFormCategory('');
    if (filterCategory === val) setFilterCategory('all');
    if (editingCat === val) { setEditingCat(null); setEditingCatText(''); }
    triggerAlert(`تم حذف الصنف "${val}" من القائمة`, 'danger');
  };

  const handleManageAddUnit = () => {
    const val = normalizeOption(manageUnitInput);
    if (!val) { triggerAlert('يرجى كتابة اسم وحدة القياس الجديدة', 'danger'); return; }
    if (customUnits.some(u => u.toLowerCase() === val.toLowerCase())) {
      triggerAlert(`وحدة القياس "${val}" موجودة مسبقاً`, 'info');
    } else {
      updateSettings({ customUnits: [...customUnits, val] });
      triggerAlert(`تمت إضافة وحدة القياس "${val}" ✅`);
    }
    setManageUnitInput('');
  };

  const handleRenameUnit = (oldVal: string) => {
    const val = normalizeOption(editingUnitText);
    if (!val) { triggerAlert('اسم وحدة القياس لا يمكن أن يكون فارغاً', 'danger'); return; }
    if (customUnits.some(u => u !== oldVal && u.toLowerCase() === val.toLowerCase())) {
      triggerAlert(`وحدة القياس "${val}" موجودة مسبقاً`, 'danger'); return;
    }
    updateSettings({ customUnits: customUnits.map(u => (u === oldVal ? val : u)) });
    if (formUnit === oldVal) setFormUnit(val);
    setEditingUnit(null);
    setEditingUnitText('');
    triggerAlert(`تم تعديل اسم وحدة القياس إلى "${val}"`);
  };

  const handleDeleteUnit = (val: string) => {
    updateSettings({ customUnits: customUnits.filter(u => u !== val) });
    if (formUnit === val) setFormUnit('');
    if (editingUnit === val) { setEditingUnit(null); setEditingUnitText(''); }
    triggerAlert(`تم حذف وحدة القياس "${val}" من القائمة`, 'danger');
  };

  // Barcode search (top search bar — works with USB scanner: scanner types + Enter = submit)
  const handleBarcodeSubmitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!barcodeSearchInput.trim()) return;
    const found = products.find(p => p.barcode === barcodeSearchInput.trim());
    if (found) {
      setSelectedProductId(found.id);
      triggerAlert(`تم كشف المنتج بالباركود: [${found.name}]`, 'success');
      setBarcodeSearchInput('');
    } else {
      triggerAlert(`الرمز الباركودي [${toArabicDigits(barcodeSearchInput)}] لم يُسجل مسبقاً.`, 'danger');
      setFormBarcode(barcodeSearchInput.trim());
      setBarcodeSearchInput('');
    }
  };

  // Real-time barcode check as user types or scanner fills the field
  const handleBarcodeChange = (val: string) => {
    setFormBarcode(val);
    if (!val.trim()) {
      setBarcodeCheckResult(null);
      setFoundProductForBarcode(null);
      return;
    }
    const dup = products.find(p => p.barcode === val.trim() && p.id !== editingProductId);
    if (dup) {
      setBarcodeCheckResult('duplicate');
      setFoundProductForBarcode(dup);
    } else {
      setBarcodeCheckResult('new');
      setFoundProductForBarcode(null);
    }
  };

  // USB scanner sends digits then Enter — intercept to open edit or move to name field
  const handleBarcodeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!formBarcode.trim()) return;
      if (barcodeCheckResult === 'duplicate' && foundProductForBarcode) {
        triggerAlert(`الباركود موجود للمنتج "${foundProductForBarcode.name}" — سيُفتح للتعديل`, 'info');
        setShowFormModal(false);
        setBarcodeCheckResult(null);
        setFoundProductForBarcode(null);
        setTimeout(() => handleOpenEditForm(foundProductForBarcode), 180);
      } else {
        document.getElementById('form_product_name')?.focus();
      }
    }
  };

  const handleOpenCreateForm = () => {
    setFormIsEditing(false);
    setEditingProductId(null);
    setFormName('');
    setFormBarcode('');
    setFormBuyPrice('');
    setFormSellPrice('');
    setFormQuantity('');
    setLoadedBranchQty(0);
    setFormLowStock('5');
    setFormCategory('');
    setFormUnit('');
    setFormHasWholesale(false);
    setFormWholesaleUnitName('كارتون');
    setFormWholesaleUnitQty('');
    setFormWholesalePrice('');
    setFormWholesaleBuyPrice('');
    setFormWarrantyMonths('');
    setFormTracksSerial(false);
    setBarcodeCheckResult(null);
    setFoundProductForBarcode(null);
    setAddingCategory(false);
    setNewCategoryText('');
    setAddingUnit(false);
    setNewUnitText('');
    setShowFormModal(true);
  };

  const handleOpenEditForm = (prod: Product) => {
    setFormIsEditing(true);
    setEditingProductId(prod.id);
    setFormName(prod.name);
    setFormBarcode(prod.barcode);
    setFormBuyPrice(String(buyPriceOf(prod) ?? '')); // التكلفة من product_costs (مع fallback موروث)
    setFormSellPrice(String(prod.sellPrice));
    setFormQuantity(String(stockOf(prod, stampBranchId))); // كمية الفرع النشط لا الإجمالي
    setLoadedBranchQty(stockOf(prod, stampBranchId));
    setFormLowStock(String(prod.lowStockThreshold));
    setFormCategory(prod.category || '');
    setFormUnit(prod.unit || '');
    setFormHasWholesale(prod.hasWholesale ?? false);
    setFormWholesaleUnitName(prod.wholesaleUnitName || 'كارتون');
    setFormWholesaleUnitQty(prod.wholesaleUnitQty !== undefined ? String(prod.wholesaleUnitQty) : '');
    setFormWholesalePrice(prod.wholesalePrice !== undefined ? String(prod.wholesalePrice) : '');
    // تكلفة شراء الجملة من product_costs — فارغة للمنتجات القديمة (يُدخلها المالك لاحقاً)
    setFormWholesaleBuyPrice(String(wholesaleBuyPriceOf(prod) ?? ''));
    setFormWarrantyMonths(prod.defaultWarrantyMonths !== undefined ? String(prod.defaultWarrantyMonths) : '');
    setFormTracksSerial(prod.tracksSerial === true);
    setBarcodeCheckResult(null);
    setFoundProductForBarcode(null);
    setAddingCategory(false);
    setNewCategoryText('');
    setAddingUnit(false);
    setNewUnitText('');
    setShowFormModal(true);
  };

  // Submit operations
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      triggerAlert('يرجى كتابة اسم صحيح للمنتج', 'danger');
      return;
    }

    // Duplicate barcode check (only if barcode is provided)
    const bc = formBarcode.trim();
    if (bc) {
      const duplicate = products.find(
        p => p.barcode === bc && p.id !== editingProductId
      );
      if (duplicate) {
        triggerAlert(`تنبيه: الباركود [${bc}] مستخدم مسبقاً للمنتج "${duplicate.name}" — عدّله قبل الحفظ`, 'danger');
        return;
      }
    }

    const bought = parseAmount(formBuyPrice);
    const sold = parseAmount(formSellPrice);
    const qty = parseAmount(formQuantity);
    const lowLimit = parseAmount(formLowStock);

    if (isNaN(bought) || bought <= 0 || isNaN(sold) || sold <= 0) {
      triggerAlert('سعر الشراء وسعر البيع يجب أن تكون قيم عددية إيجابية', 'danger');
      return;
    }

    if (sold < bought) {
      if (!(await requestConfirm('ملاحظة: السعر الذي تبيع به أقل من سعر المذخر/المصنع، هل تود الحفظ بأي حال؟'))) {
        return;
      }
    }

    if (isNaN(qty) || qty < 0) {
      triggerAlert('الكمية الحالية بالمتجر لا يمكن أن تكون قيمة سالبة', 'danger');
      return;
    }

    if (isNaN(lowLimit) || lowLimit < 0) {
      triggerAlert('حد التنبيه للمخزون لا يمكن أن يكون قيمة سالبة', 'danger');
      return;
    }

    // Wholesale validation — only when enabled
    const wholesaleQty = parseAmount(formWholesaleUnitQty);
    const wholesalePriceNum = parseAmount(formWholesalePrice);
    if (formHasWholesale) {
      if (!formWholesaleUnitName.trim()) {
        triggerAlert('يرجى كتابة اسم وحدة الجملة', 'danger');
        return;
      }
      if (isNaN(wholesaleQty) || wholesaleQty <= 0) {
        triggerAlert('عدد وحدات الأساس داخل وحدة الجملة يجب أن يكون أكبر من صفر', 'danger');
        return;
      }
      if (isNaN(wholesalePriceNum) || wholesalePriceNum <= 0) {
        triggerAlert('سعر بيع وحدة الجملة يجب أن يكون أكبر من صفر', 'danger');
        return;
      }
    }

    // ---- الضمان (اختياري) — فارغ = بلا ضمان، والحقل لا يظهر أصلاً في الفاتورة ----
    const warrantyMonthsNum = formWarrantyMonths.trim() === '' ? 0 : parseAmount(formWarrantyMonths);
    if (formWarrantyMonths.trim() !== '' && (isNaN(warrantyMonthsNum) || warrantyMonthsNum < 0)) {
      triggerAlert('مدة الضمان يجب أن تكون رقم أشهر صحيحاً (أو اتركها فارغة)', 'danger');
      return;
    }

    // ---- تكلفة شراء الجملة (الكرتون) — تحقق ذكي لا يجبر المالك على إعادة إدخال بيانات الجملة ----
    // القاعدة: تُطلب فقط عند لمس إعدادات الجملة (تفعيلها/تغيير الاسم/الكمية/سعر البيع) أو للمنتج
    // الجديد بجملة. المنتج القديم بجملة بلا سعر شراء: يُحفَظ أي تغيير غير متعلق بالجملة دون طلبه،
    // ويُدخِله المالك لاحقاً بمجرد كتابته في هذا الحقل داخل نموذج التعديل (الباقي مُعبّأ مسبقاً).
    const existingForWholesale = formIsEditing && editingProductId
      ? products.find(p => p.id === editingProductId)
      : undefined;
    const typedWholesaleBuy = parseAmount(formWholesaleBuyPrice);
    const wholesaleBuyProvided = formWholesaleBuyPrice.trim() !== '';
    const existingWholesaleBuy = existingForWholesale ? wholesaleBuyPriceOf(existingForWholesale) : undefined;
    const wholesaleSettingsTouched =
      formHasWholesale !== (existingForWholesale?.hasWholesale ?? false) ||
      (formHasWholesale && (
        formWholesaleUnitName.trim() !== (existingForWholesale?.wholesaleUnitName ?? '') ||
        wholesaleQty !== (existingForWholesale?.wholesaleUnitQty ?? NaN) ||
        wholesalePriceNum !== (existingForWholesale?.wholesalePrice ?? NaN)
      ));

    let wholesaleBuyToStore: number | undefined = undefined;
    if (formHasWholesale) {
      if (wholesaleBuyProvided) {
        if (isNaN(typedWholesaleBuy) || typedWholesaleBuy <= 0) {
          triggerAlert('سعر شراء وحدة الجملة (الكرتون) يجب أن يكون أكبر من صفر', 'danger');
          return;
        }
        // 🔴 ربح الجملة كان بلا حماية: المفرد يُحذَّر إن بِيع بأقل من تكلفته، والكرتون لا.
        // فيبيع التاجر كرتوناً بخسارة صامتة — وهي أكبر من خسارة القطعة بعدد ما فيه.
        if (wholesalePriceNum < typedWholesaleBuy) {
          const ok = await requestConfirm(
            `تنبيه: سعر بيع ${formWholesaleUnitName.trim() || 'وحدة الجملة'} `
            + `(${formatCurrency(wholesalePriceNum, currency, exchangeRate)}) `
            + `أقل من سعر شرائها (${formatCurrency(typedWholesaleBuy, currency, exchangeRate)}) — `
            + `خسارة ${formatCurrency(typedWholesaleBuy - wholesalePriceNum, currency, exchangeRate)} على كل وحدة.\n\n`
            + `هل تريد الحفظ رغم ذلك؟`,
          );
          if (!ok) return;
        }
        wholesaleBuyToStore = typedWholesaleBuy;
      } else if (wholesaleSettingsTouched) {
        triggerAlert('يرجى إدخال سعر شراء وحدة الجملة (الكرتون) — لازم لحساب ربح الجملة', 'danger');
        return;
      } else {
        // إعدادات الجملة لم تُمَس والحقل فارغ ⇒ نُبقي القيمة القديمة (قد تكون غير معروفة)
        wholesaleBuyToStore = existingWholesaleBuy;
      }
    }

    // يبني وثيقة التكلفة: buyPrice دائماً + wholesaleBuyPrice عند توفّره (بلا undefined — يرفضه Firestore)
    const buildCostDoc = (id: string): ProductCost => {
      const doc: ProductCost = { id, buyPrice: bought };
      if (wholesaleBuyToStore !== undefined) doc.wholesaleBuyPrice = wholesaleBuyToStore;
      return doc;
    };

    if (!ownerUid) return; // المسارات تُبنى من ownerUid — لا كتابة قبل حسم الجلسة

    if (formIsEditing && editingProductId) {
      const existing = products.find(p => p.id === editingProductId);
      if (existing) {
        // يُبنى كائن التحديث بحقول الجملة المشروطة؛ أمّا الصورة فتُجرَّد دائماً (أُلغيت الميزة).
        // Firestore rejects undefined field values, so we never pass undefined.
        /**
         * 🔴 حقولٌ صريحة بـ`update` — لا `set` بوثيقة كاملة من لقطة محلية.
         *
         * كان الحفظ يستبدل وثيقة المنتج بأكملها انطلاقاً من `existing` (لقطة قد تكون
         * قديمة بدقائق). فمن يفتح المنتج ليصحّح اسمه، ويبيع الكاشير منه ثلاث قطع في
         * تلك الأثناء، يُعيد بحفظه القطع الثلاث إلى المخزون. المخزون مالٌ، والخطأ صامت.
         *
         * والكمية الآن **لا تُكتب إطلاقاً ما لم يغيّرها التاجر فعلاً**، وإن غيّرها فبالفارق
         * الذرّي (`stockUpdateSeeded`) الذي يتراكب بأمان مع أي بيع متزامن.
         */
        /**
         * 🔴 المقارنة بما حُمّل في الحقل، لا بالمخزون الحيّ.
         *
         * المقارنة بالحيّ تبدو صحيحة وهي أسوأ ما يكون: الحقل يقول ٥٠ لأنه حُمّل قبل أن
         * يبيع الكاشير ثلاثاً، والحيّ صار ٤٧ — فتُحسب «زيادة ٣» ويعود المبيع. أثبته
         * الفحص الحيّ بعد أن ظننت العلّة عولجت.
         *
         * فالسؤال ليس «هل يختلف الحقل عن الواقع؟» بل **«هل غيّر التاجر الحقل؟»**.
         */
        const liveBranchQty = stockOf(existing, stampBranchId);
        const userChangedQty = qty !== loadedBranchQty;
        const stockDelta = userChangedQty ? qty - liveBranchQty : 0;
        const branchQtyBefore = loadedBranchQty;

        // غُيّر الحقل وتغيّر المخزون من مكان آخر معاً — لا نكتب فوق البيع بصمت
        if (userChangedQty && liveBranchQty !== loadedBranchQty) {
          const ok = await requestConfirm(
            `تنبيه: تغيّر مخزون «${existing.name}» أثناء تعديلك.\n\n`
            + `عند فتح النموذج: ${toArabicDigits(loadedBranchQty)}\n`
            + `الآن: ${toArabicDigits(liveBranchQty)}\n`
            + `وأنت كتبت: ${toArabicDigits(qty)}\n\n`
            + `هل تثبّت ما كتبته وتلغي التغيير الذي حدث؟`,
          );
          if (!ok) return;
        }

        const fields: Record<string, unknown> = {
          name: formName,
          barcode: bc,
          sellPrice: sold,
          lowStockThreshold: lowLimit,
          category: formCategory,
          unit: formUnit,
          hasWholesale: formHasWholesale,
          // التكلفة تُحفظ في product_costs — نجرّد الحقل الموروث من الوثيقة
          buyPrice: deleteField(),
          // 🧹 صور المنتجات أُلغيت. التجريد هنا **غير مشروط** عمداً: كل تعديل
          // ينظّف الصورة الموروثة من وثيقة المنتج، فتخفّ الوثيقة وتخفّ المزامنة
          // معها تدريجياً بلا ترحيلٍ دفعةً واحدة.
          imageUrl: deleteField(),
          wholesaleUnitName: formHasWholesale ? formWholesaleUnitName.trim() : deleteField(),
          wholesaleUnitQty: formHasWholesale ? wholesaleQty : deleteField(),
          wholesalePrice: formHasWholesale ? wholesalePriceNum : deleteField(),
          defaultWarrantyMonths: warrantyMonthsNum > 0 ? warrantyMonthsNum : deleteField(),
          tracksSerial: formTracksSerial ? true : deleteField(),
        };
        // لا نمسّ المخزون إلا إن غُيّر فعلاً — تعديل الاسم أو السعر لا يلمس بضاعةً
        if (stockDelta !== 0) Object.assign(fields, stockUpdateSeeded(existing, stockDelta, stampBranchId));

        // batch ذرّية: وثيقة المنتج (بلا buyPrice) + تكلفتها معاً — fire-and-forget (آمن أوفلاين)
        const batch = writeBatch(db);
        batch.update(doc(db, 'users', ownerUid, 'products', existing.id), fields);
        batch.set(doc(db, 'users', ownerUid, 'product_costs', existing.id), buildCostDoc(existing.id));
        // 🔴 الفشل لا يمرّ صامتاً: كان الخطأ يُطبع في الكونسول وحده بينما يرى التاجر
        // «تم الحفظ». الكتابة تبقى fire-and-forget (آمنة أوفلاين) لكن رفض الخادم يُعلَن.
        batch.commit().catch(err => {
          console.error('[Firestore] save product:', err);
          triggerAlert(`لم يُحفَظ «${formName}» على الخادم — راجع الصورة أو حجم البيانات ثم أعد المحاولة`, 'danger');
        });

        // سجل التدقيق — نُبرز تغيّر الأسعار والكمية تحديداً في الملخّص (أكثر ما يُراجَع لاحقاً)
        const oldBuy = buyPriceOf(existing);
        const changes: string[] = [];
        if (existing.sellPrice !== sold) changes.push(`سعر البيع ${toArabicDigits(existing.sellPrice)} ← ${toArabicDigits(sold)}`);
        if (oldBuy !== undefined && oldBuy !== bought) changes.push(`سعر الشراء ${toArabicDigits(oldBuy)} ← ${toArabicDigits(bought)}`);
        // 🔴 المقارنة بمخزون **الفرع** لا بالإجمالي: الحقل في النموذج يخصّ الفرع النشط،
        // فمقارنته بالإجمالي كانت تكتب في السجل «الكمية ١٠٠ ← ٢٠» وأنت لم تغيّر إلا فرعاً.
        if (stockDelta !== 0) {
          changes.push(
            `الكمية${isMultiBranch ? ` في ${branchName(stampBranchId)}` : ''}`
            + ` ${toArabicDigits(branchQtyBefore)} ← ${toArabicDigits(qty)}`,
          );
        }
        if (existing.name !== formName) changes.push(`الاسم «${existing.name}» ← «${formName}»`);
        void logAudit({
          action: 'update', entity: 'product', entityId: existing.id,
          summary: `تعديل المنتج «${formName}»${changes.length ? ` — ${changes.join('، ')}` : ' (بيانات عامة)'}`,
          before: { ...existing, buyPrice: oldBuy } as unknown as Record<string, unknown>,
          after: { ...existing, ...fields, buyPrice: bought } as unknown as Record<string, unknown>,
          actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
        });
      }
      triggerAlert(`تم حفظ وتحديث بيانات المواد للمنتج [${formName}] بنجاح`);
    } else {
      const newProduct: Product = {
        // genId: لاحقة عشوائية تمنع تصادم منتجين أُنشئا في نفس الملّي ثانية (إصلاح ١٠)
        id: `prod_${genId()}`,
        name: formName,
        barcode: bc,
        sellPrice: sold,
        quantity: qty,
        branchStock: { [stampBranchId]: qty }, // كمية الافتتاح تدخل مخزون الفرع النشط
        lowStockThreshold: lowLimit,
        category: formCategory,
        unit: formUnit,
        // 🔴 كان `toISOString()` أي **تاريخ UTC**: منتجٌ يُضاف الساعة ١ فجراً بتوقيت
        // العراق (UTC+3) كان يُختم بتاريخ الأمس. `todayISO` يبنيه من مكوّنات اليوم
        // المحلية — وهي الدالة التي أُنشئت لهذه العلّة بالذات (utils/dateLocal).
        createdAt: todayISO(),
        hasWholesale: formHasWholesale,
      };
      if (formHasWholesale) {
        newProduct.wholesaleUnitName = formWholesaleUnitName.trim();
        newProduct.wholesaleUnitQty = wholesaleQty;
        newProduct.wholesalePrice = wholesalePriceNum;
      }
      if (warrantyMonthsNum > 0) newProduct.defaultWarrantyMonths = warrantyMonthsNum;
      if (formTracksSerial) newProduct.tracksSerial = true;
      const batch = writeBatch(db);
      batch.set(doc(db, 'users', ownerUid, 'products', newProduct.id), newProduct);
      batch.set(doc(db, 'users', ownerUid, 'product_costs', newProduct.id), buildCostDoc(newProduct.id));
      batch.commit().catch(err => {
        console.error('[Firestore] save product:', err);
        triggerAlert(`لم يُحفَظ «${formName}» على الخادم — راجع الصورة أو حجم البيانات ثم أعد المحاولة`, 'danger');
      });
      setSelectedProductId(newProduct.id);
      triggerAlert(`تم تسجيل وتوثيق المنتج الجديد [${formName}] بالمتجر`);
    }

    setShowFormModal(false);
  };

  // Delete product — تُحذف وثيقة المنتج وتكلفتها معاً (batch ذرّية) تفادياً لتكلفة يتيمة
  const handleDeleteProduct = async (id: string, name: string) => {
    if (!ownerUid) return;
    const snapshot = products.find(p => p.id === id); // لقطة للسجل قبل الحذف

    /**
     * 🔴 الحذف يعرض ما سيُمحى من قيمة، لا سؤالاً مجرّداً.
     *
     * كان الرقم يُسجَّل في سجل التدقيق **بعد** الحذف لا في السؤال قبله — فيحذف التاجر
     * منتجاً فيه ٥٠٠ قطعة قيمتها مليون دينار وهو يظنّه صنفاً فارغاً.
     */
    const stockLeft = snapshot ? visibleStock(snapshot, activeBranchId) : 0;
    const unitCost = snapshot ? buyPriceOf(snapshot) : undefined;
    const stockLine = stockLeft > 0
      ? `\n\n⚠️ بالمخزون ${toArabicDigits(stockLeft)} ${snapshot?.unit || 'قطعة'}`
        + (unitCost !== undefined ? ` بقيمة شرائية ${formatCurrency(stockLeft * unitCost, currency, exchangeRate)}` : ' (تكلفتها غير مسجّلة)')
        + `.\nالحذف يمحوها من الجرد — إن كانت البضاعة تالفة فالأصحّ «تسوية المخزون» ليبقى أثرها في التقارير.`
      : '';

    if (await requestConfirm(`حذف المنتج «${name}» نهائياً من الجرد؟${stockLine}`)) {
      const batch = writeBatch(db);
      batch.delete(doc(db, 'users', ownerUid, 'products', id));
      batch.delete(doc(db, 'users', ownerUid, 'product_costs', id));
      batch.commit().catch(err => reportFirestoreError('products', 'remove', err, '[Firestore] delete product'));
      void logAudit({
        action: 'delete', entity: 'product', entityId: id,
        summary: `حذف المنتج «${name}»${snapshot ? ` — كان بالمخزون ${toArabicDigits(snapshot.quantity)} ${snapshot.unit || 'قطعة'}` : ''}`,
        before: snapshot as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
      });
      triggerAlert(`تم إزالة وثيقة جرد المنتج [${name}] من المتجر بنجاح`, 'danger');
      if (selectedProductId === id) setSelectedProductId(null);
    }
  };

  // زيادة/إنقاص سريع — يؤثر على **الفرع النشط** ويحدّث الإجمالي بنفس الفارق (increment ذرّي)
  const handleAdjustQuantity = async (id: string, qtyAmount: number) => {
    const existing = products.find(p => p.id === id);
    if (!existing || !ownerUid) return;
    const branchQty = stockOf(existing, stampBranchId);
    const delta = qtyAmount < 0 ? -Math.min(Math.abs(qtyAmount), branchQty) : qtyAmount; // لا رصيد سالب
    if (delta === 0) return;
    updateDoc(doc(db, 'users', ownerUid, 'products', id), stockUpdate(delta, stampBranchId))
      .catch(err => reportFirestoreError('products', 'update', err, '[Firestore] adjust quantity'));
    triggerAlert('تم تحديث الرصيد المخزني والرفوف للمنتج فوراً');
  };

  // ملاحظة: ترحيل buyPrice المضمّن (الموروث) إلى product_costs انتقل إلى useBuyPriceMigration
  // ويُستدعى من OwnerShell مباشرة (مستوى الجلسة) — وليس من هنا. هذا يضمن عمله فور بداية جلسة
  // المالك بصرف النظر عن زيارة هذا التبويب، ويغلق ثغرة تسرّب buyPrice لموظف قبل اكتمال الترحيل.

  // ---- 3. RUNNING PRODUCT FILTERS ----
  const filteredProducts = products.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          (p.barcode || '').includes(searchQuery) ||
                          p.category.includes(searchQuery);

    const matchesCategory = filterCategory === 'all' || p.category === filterCategory;

    const isLow = qtyOf(p) <= p.lowStockThreshold;
    const matchesStock = filterStock === 'all' ||
                         (filterStock === 'low' && isLow) ||
                         (filterStock === 'instock' && !isLow);

    return matchesSearch && matchesCategory && matchesStock;
  });

  /**
   * 🔴 عرض تدريجي — العلاج الحقيقي لبطء المحلات الكبيرة.
   *
   * القياس على ٣١٥١ منتجاً: الفلترة نفسها تكلّف **١٫٥ مللي فقط**، لكن الشاشة كانت ترسم
   * **١٣٥٬٦١٥ عنصر DOM** دفعةً واحدة — فصار كل حرف يكتبه البائع في البحث نصف ثانية تجمّد.
   * والقائمة داخل صندوق بارتفاع ثابت أصلاً، فما يراه العين لا يتجاوز عشرة صفوف.
   * نرسم دفعة ونزيدها بالطلب: نفس النتائج تماماً، بلا تجميد.
   */
  const PAGE_SIZE = 60;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // أي تغيير في الفلاتر يعيد العدّ — وإلا بقي المستخدم على دفعة قديمة بعد بحث جديد
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [searchQuery, filterCategory, filterStock]);
  const visibleProducts = filteredProducts.slice(0, visibleCount);

  const selectedProduct = products.find(p => p.id === selectedProductId);
  const selectedBuyPrice = selectedProduct ? (buyPriceOf(selectedProduct) ?? 0) : 0;
  // تكلفة شراء الجملة للمنتج المحدّد — undefined = غير معروفة (منتج قديم لم يُدخَل له السعر)
  const selectedWholesaleBuy = selectedProduct ? wholesaleBuyPriceOf(selectedProduct) : undefined;

  // Stats Counters
  const totalProds = products.length;
  const totalInventoryQuantity = products.reduce((sum, p) => sum + qtyOf(p), 0);
  const lowStockProdsCount = products.filter(p => qtyOf(p) <= p.lowStockThreshold).length;

  /**
   * 🔴 قيمة المخزون من `inventoryValue` — لا حساب موازٍ في الشاشة.
   *
   * كان هنا `(buyPriceOf(p) ?? 0)`، أي أن **المنتج مجهول التكلفة تكلفته صفر** فيصير كل
   * سعر بيعه ربحاً صافياً. تاجر عنده مئة منتج قديم بلا تكلفة يرى ربحاً متوقّعاً أضعاف
   * الحقيقة ويبني عليه قرار شراء.
   *
   * والمشروع كان قد حسم هذا في «تقارير القرار»: الربح الكامن يُحسب على معروفة التكلفة
   * وحدها، ومجهولها يُعرَض على حدة. فكان في البرنامج رقمان لنفس الشيء وأحدهما يكذب —
   * الآن مصدر واحد.
   */
  const invValue = useMemo(
    () => inventoryValue(products, buyPriceOf, activeBranchId || undefined),
    [products, buyPriceOf, activeBranchId],
  );
  const totalBuyWorth = invValue.costValue;
  const totalSellWorth = invValue.sellValue;
  const totalPotentialProfit = Math.max(0, invValue.latentProfit);

  // ---- بناء أساس قائمة النواقص ----
  // لكل مادة تحت حد الأمان: نقترح كمية تُعيد المخزون إلى ضعف حد الأمان. المنتج بالجملة يُشترى
  // بالكرتون فنقترح بالكرتونات (تقريب لأعلى) ونقدّر التكلفة بسعر شراء الكرتون؛ وإلا بوحدة الأساس
  // وسعر شراء القطعة. التكلفة undefined عند غياب السعر (لا تخمين — تُعرض "غير محسوبة").
  const reorderBase = useMemo(() => {
    return products
      .filter(p => qtyOf(p) <= p.lowStockThreshold)
      .map(p => {
        const threshold = p.lowStockThreshold || 0;
        const targetLevel = Math.max(threshold * 2, threshold + 1);
        const needUnits = Math.max(targetLevel - qtyOf(p), 1);
        const baseUnit = p.unit || 'قطعة';
        const isWholesale = !!(p.hasWholesale && p.wholesaleUnitName && (p.wholesaleUnitQty || 0) > 0);
        if (isWholesale) {
          const perCarton = p.wholesaleUnitQty as number;
          return {
            id: p.id, name: p.name, currentQty: qtyOf(p), threshold, baseUnit,
            purchaseUnit: p.wholesaleUnitName as string,
            baseUnitsPerPurchase: perCarton,
            unitCost: wholesaleBuyPriceOf(p),                    // لكل كرتون (قد تكون undefined)
            defaultQty: Math.max(1, Math.ceil(needUnits / perCarton)),
          };
        }
        return {
          id: p.id, name: p.name, currentQty: qtyOf(p), threshold, baseUnit,
          purchaseUnit: baseUnit,
          baseUnitsPerPurchase: 1,
          unitCost: buyPriceOf(p),                               // لكل قطعة (قد تكون undefined)
          defaultQty: needUnits,
        };
      })
      .sort((a, b) => (a.currentQty - a.threshold) - (b.currentQty - b.threshold)); // الأشدّ نقصاً أولاً
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, buyPriceOf, wholesaleBuyPriceOf]);

  // دمج الكمية القابلة للتعديل مع الأساس لإنتاج سطور القائمة النهائية (للعرض والطباعة)
  const reorderLines: (PurchaseLine & { id: string })[] = reorderBase.map(l => {
    const raw = reorderQty[l.id];
    const qty = Math.max(0, Math.floor(parseAmount(raw ?? String(l.defaultQty)) || 0));
    const lineCost = l.unitCost !== undefined ? qty * l.unitCost : undefined;
    return {
      id: l.id, name: l.name, currentQty: l.currentQty, threshold: l.threshold,
      baseUnit: l.baseUnit, purchaseQty: qty, purchaseUnit: l.purchaseUnit,
      baseUnitsAcquired: qty * l.baseUnitsPerPurchase, lineCost,
    };
  });

  const reorderKnownTotal = reorderLines.reduce((s, l) => s + (l.lineCost ?? 0), 0);
  const reorderUnknownCount = reorderLines.filter(l => l.lineCost === undefined).length;

  const handleOpenReorder = () => {
    // تهيئة الكميات بالقيم المقترحة الافتراضية عند كل فتح
    setReorderQty(Object.fromEntries(reorderBase.map(l => [l.id, String(l.defaultQty)])));
    setShowReorderModal(true);
  };

  const handlePrintReorder = () => {
    const printable = reorderLines.filter(l => l.purchaseQty > 0);
    if (!printable.length) {
      triggerAlert('لا توجد كميات للطباعة — حدّد كمية واحدة على الأقل', 'danger');
      return;
    }
    printPurchaseList({
      storeName,
      lines: printable,
      currency,
      exchangeRate,
      onError: (msg) => triggerAlert(msg, 'danger'),
    });
  };

  // تصدير قائمة المنتجات إلى Word/PDF (قراءة فقط — لا يمسّ البيانات)
  const handleExportProducts = (format: 'word' | 'pdf') => {
    if (products.length === 0) { triggerAlert('لا توجد منتجات للتصدير', 'danger'); return; }
    const money = (n: number) => formatCurrency(n, currency, exchangeRate);
    const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    const spec: ExportSpec = {
      title: storeName || 'رتب شغلك',
      subtitle: `قائمة المنتجات والمخزون — ${toArabicDigits(products.length)} منتج`,
      columns: [
        { header: '#', align: 'center' },
        { header: 'المنتج' },
        { header: 'التصنيف' },
        { header: 'الوحدة', align: 'center' },
        { header: 'الباركود', align: 'center' },
        { header: 'المخزون', align: 'center' },
        { header: 'سعر الشراء', align: 'center' },
        { header: 'سعر البيع', align: 'center' },
        { header: 'بيع بالجملة' },
      ],
      rows: sorted.map((p, i) => {
        const buy = buyPriceOf(p);
        const wsBuy = wholesaleBuyPriceOf(p);
        const wholesale = p.hasWholesale && p.wholesaleUnitName
          ? `${p.wholesaleUnitName} (${toArabicDigits(p.wholesaleUnitQty || 0)}) — بيع ${money(p.wholesalePrice || 0)}${wsBuy !== undefined ? ` · شراء ${money(wsBuy)}` : ''}`
          : '—';
        return [
          toArabicDigits(i + 1),
          p.name,
          p.category || '—',
          p.unit || 'قطعة',
          p.barcode ? toArabicDigits(p.barcode) : '—',
          toArabicDigits(qtyOf(p)),
          buy !== undefined ? money(buy) : '—',
          money(p.sellPrice),
          wholesale,
        ];
      }),
      note: `القيمة الإجمالية للمخزون بسعر البيع: ${money(totalSellWorth)}`,
    };
    const filename = `منتجات_${(storeName || 'المتجر').replace(/\s+/g, '_')}`;
    if (format === 'word') { exportAsWord(spec, filename); triggerAlert('تم تصدير ملف Word للمنتجات 📄'); }
    else exportAsPdf(spec, (m) => triggerAlert(m, 'danger'));
  };

  // ---- الاستيراد الجماعي (CSV) ----
  const [showImport, setShowImport] = useState(false);
  const [showLabels, setShowLabels] = useState(false);

  /**
   * يحفظ الأكواد الداخلية المولَّدة. يُمرّر وثيقة المنتج كما هي مع حقل barcode الجديد فقط،
   * فلا يمسّ أي حقل آخر. ولا يُستدعى إلا لمنتجات باركودها فارغ — الكود الموجود لا يُغيَّر أبداً
   * لأن تغييره يعني تغيير هوية المادة على كل ملصق طُبع سابقاً.
   */
  const saveGeneratedBarcodes = async (updates: Array<{ product: Product; barcode: string }>) => {
    if (!ownerUid) return;
    for (const u of updates) {
      if (u.product.barcode?.trim()) continue; // حارس نهائي — لا نلمس كوداً قائماً
      // 🔴 حقل واحد بـ`updateDoc` — لا `save` باستبدال الوثيقة كاملةً من لقطة محلية.
      // الاستبدال كان يُرجع أي بضاعة بيعت بين تحميل الشاشة وضغط التوليد.
      updateDoc(doc(db, 'users', ownerUid, 'products', u.product.id), { barcode: u.barcode })
        .catch(err => reportFirestoreError('products', 'update', err, '[Firestore] generated barcode'));
    }
    const listed = updates.slice(0, 5).map(u => `${u.product.name}=${u.barcode}`).join('، ');
    void logAudit({
      action: 'update', entity: 'product', entityId: 'barcode_generation',
      summary: `توليد باركود داخلي لـ ${updates.length} مادة: ${listed}${updates.length > 5 ? ' وغيرها' : ''}`,
      after: Object.fromEntries(updates.map(u => [u.product.name, u.barcode])),
      actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
    });
  };

  const commitProductImport = async (parsed: ParsedRow<Product>[]) => {
    if (!ownerUid) return;
    // دفعات ≤٤٥٠ عملية (منتج + تكلفته = عمليتان لكل صف) — نفس نمط الاستعادة الموجود
    const CHUNK = 200;
    for (let i = 0; i < parsed.length; i += CHUNK) {
      const batch = writeBatch(db);
      for (const row of parsed.slice(i, i + CHUNK)) {
        if (!row.data) continue;
        const productRef = doc(db, 'users', ownerUid, 'products', row.data.id);
        const existing = products.find(p => p.id === row.data!.id);
        /**
         * 🔴 المنتج القائم يُحدَّث بالدمج، والكمية بالفارق — لا استبدال للوثيقة.
         *
         * `parseProductRows` تبني منتجاً **بلا حقل `branchStock`**، و`set` بلا دمج
         * استبدالٌ كامل. فاستيراد ملف لتصحيح الأسعار كان **يمحو خريطة الفروع كلها**
         * وتعود كل الكميات إلى الفرع الرئيسي — بضاعة المخزن تنتقل للمحل في السجلات.
         */
        if (existing) {
          const { quantity, ...rest } = row.data;
          batch.set(productRef, rest, { merge: true });
          const delta = quantity - (existing.quantity ?? 0);
          if (delta !== 0) {
            batch.update(productRef, stockUpdateSeeded(existing, delta, stampBranchId));
          }
        } else {
          // منتج جديد: كمية الافتتاح تدخل مخزون الفرع النشط (كما في نموذج الإضافة)
          batch.set(productRef, { ...row.data, branchStock: { [stampBranchId]: row.data.quantity } });
        }
        // التكلفة في مجموعتها المحمية — تُكتب فقط إن وُردت في الملف (لا نمسح تكلفة قائمة)
        if (row.cost !== undefined || row.wholesaleCost !== undefined) {
          /**
           * 🔴 لا نكتب `buyPrice: 0` لمنتج لم يذكر الملف تكلفته.
           *
           * كان الاحتياط `row.cost ?? (buyPriceOf(row.data) ?? 0)`، فملفٌ فيه تكلفة جملة
           * وحدها يكتب تكلفة مفرد **صفراً** — وصفرٌ يعني «مجاناً» فيصير كل سعر البيع
           * ربحاً في التقارير. غياب التكلفة يبقى غياباً يُعرَض «غير محسوبة»، لا صفراً
           * يكذب. (الكتابة بالدمج فلا تُمحى تكلفة قائمة.)
           */
          const costDoc: Record<string, unknown> = { id: row.data.id };
          const knownBuy = row.cost ?? buyPriceOf(row.data);
          if (knownBuy !== undefined) costDoc.buyPrice = knownBuy;
          if (row.wholesaleCost !== undefined) costDoc.wholesaleBuyPrice = row.wholesaleCost;
          if (Object.keys(costDoc).length > 1) {
            batch.set(doc(db, 'users', ownerUid, 'product_costs', row.data.id), costDoc, { merge: true });
          }
        }
      }
      // بلا await — نفس سبب استيراد الزبائن: انتظار إقرار الخادم يتجمّد أوفلاين بينما
      // الصفوف كُتبت محلياً فعلاً. والمعرّفات مشتقّة من المحتوى فإعادة المحاولة تصحّح.
      batch.commit().catch(err => reportFirestoreError('products', 'batch', err, '[Firestore] products bulk import'));
    }
    void logAudit({
      action: 'create', entity: 'product', entityId: 'bulk_import',
      summary: `استيراد جماعي للمنتجات — ${toArabicDigits(parsed.length)} سجلاً`,
      actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
    });
    triggerAlert(`تم استيراد ${toArabicDigits(parsed.length)} منتجاً بنجاح ✅`);
  };

  const getCategoryEmoji = (catName: string): string => {
    switch(catName) {
      case 'زيوت وسمن': return '🧴';
      case 'حبوب وبقوليات': return '🌾';
      case 'ألبان وأجبان': return '🧀';
      case 'شاي وقهوة': return '☕';
      case 'منظفات ومعقمات': return '🧼';
      case 'معلبات ومواد جافة': return '🥫';
      case 'حلويات ومسليات': return '🍫';
      default: return '📦';
    }
  };

  return (
    <div className="space-y-6 animate-fade-in font-tajawal">
      {confirmDialog}

      {/* MODULE HEADER BAR */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-xl font-extrabold font-cairo text-[#1E3A8A] flex items-center gap-2">
            <Package className="w-6 h-6 text-[#1E3A8A] animate-pulse" />
            <span>وحدة جرد المنتجات والمستودع العام 📦</span>
          </h2>
          <p className="text-xs text-[#5B6B86] mt-1">
            إدارة متكاملة لمنتجات ومخزون المحل المتنوع: تنبيهات النواقص تحت حد الأمان، حساب أوتوماتيكي لربح البيع والشراء، والتعامل الذكي مع الباركود والصور
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* تصدير المنتجات Word / PDF */}
          <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl px-1.5 py-1 shadow-sm">
            <span className="text-[10px] text-slate-600 font-bold px-1 select-none">تصدير:</span>
            <button onClick={() => handleExportProducts('word')} title="تصدير Word"
              className="px-2.5 py-2 rounded-lg text-[11px] font-extrabold text-blue-700 hover:bg-blue-50 flex items-center gap-1 cursor-pointer transition">
              <FileText className="w-3.5 h-3.5" /> Word
            </button>
            <button onClick={() => handleExportProducts('pdf')} title="تصدير PDF"
              className="px-2.5 py-2 rounded-lg text-[11px] font-extrabold text-rose-700 hover:bg-rose-50 flex items-center gap-1 cursor-pointer transition">
              <Download className="w-3.5 h-3.5" /> PDF
            </button>
          </div>

          <button
            onClick={() => setShowImport(true)}
            title="استيراد منتجات من ملف Excel/CSV"
            className="px-5 py-2.5 bg-white border-2 border-emerald-300 text-emerald-700 hover:bg-emerald-50 font-extrabold rounded-xl text-xs flex items-center gap-1.5 shadow-sm transition active:scale-95 cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            <span>استيراد جماعي</span>
          </button>

          <button
            onClick={() => setShowLabels(true)}
            title="توليد أكواد داخلية وطباعة ملصقات باركود"
            className="px-5 py-2.5 bg-white border-2 border-indigo-300 text-indigo-700 hover:bg-indigo-50 font-extrabold rounded-xl text-xs flex items-center gap-1.5 shadow-sm transition active:scale-95 cursor-pointer"
          >
            <Barcode className="w-4 h-4" />
            <span>ملصقات الباركود</span>
          </button>

          <button
            onClick={handleOpenReorder}
            disabled={reorderBase.length === 0}
            title={reorderBase.length === 0 ? 'لا توجد مواد تحت حد الأمان' : 'قائمة شراء بالنواقص للمجهّز'}
            className="relative px-5 py-2.5 bg-white border-2 border-amber-300 text-amber-700 hover:bg-amber-50 font-extrabold rounded-xl text-xs flex items-center gap-1.5 shadow-sm transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
          >
            <ClipboardList className="w-4 h-4" />
            <span>قائمة تجهيز النواقص</span>
            {reorderBase.length > 0 && (
              <span className="bg-amber-700 text-white text-[11px] font-black rounded-full min-w-4.5 h-4.5 px-1 flex items-center justify-center">
                {toArabicDigits(reorderBase.length)}
              </span>
            )}
          </button>

          <button
            onClick={handleOpenCreateForm}
            className="px-5 py-2.5 bg-gradient-to-l from-blue-750 to-[#1E3A1A] hover:bg-blue-800 text-white font-extrabold rounded-xl text-xs flex items-center gap-1.5 shadow-md hover:shadow-lg transition active:scale-95 cursor-pointer"
            style={{ background: '#1E3A8A' }}
          >
            <Plus className="w-4 h-4 text-white" />
            <span>إضافة منتج جديد</span>
          </button>
        </div>
      </div>

      {/* DYNAMIC ALERT BANNER */}
      {alert && (
        <div className={`p-4 rounded-xl border text-xs font-extrabold flex items-center gap-2.5 transition-all duration-300 ${
          alert.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' :
          alert.type === 'danger' ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-blue-50 border-blue-200 text-blue-900'
        }`}>
          {alert.type === 'success' ? <CheckCircle2 className="w-5 h-5 text-emerald-700" /> : <ShieldAlert className="w-5 h-5 text-red-700" />}
          <span>{alert.text}</span>
        </div>
      )}

      {/* TOP KPI BLOCK */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" id="kpi_products_general_block">

        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-xs relative overflow-hidden">
          <span className="text-[10px] text-slate-600 block font-bold select-none">أصناف المواد المسجلة</span>
          <h4 className="text-xl md:text-2xl font-black font-cairo mt-2 text-[#1E3A8A]">
            {formatArabicNoun(totalProds, ARABIC_NOUNS.product)}
          </h4>
          <span className="text-[10px] text-slate-600 block mt-1 leading-none font-bold">بمجموع {toArabicDigits(totalInventoryQuantity)} وحدة</span>
          <div className="absolute left-0 bottom-0 w-full h-1 bg-blue-500"></div>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-xs relative overflow-hidden">
          <span className="text-[10px] text-slate-600 block font-bold select-none">مواد قاربت على النفاد 📉</span>
          <h4 className="text-xl md:text-2xl font-black font-cairo mt-2 text-amber-700">
            {formatArabicNoun(lowStockProdsCount, ARABIC_NOUNS.product)}
          </h4>
          <span className="text-[10px] text-amber-700 block mt-1 leading-none font-bold">تقع دون أو تساور سقف الأمان</span>
          <div className="absolute left-0 bottom-0 w-full h-1 bg-yellow-500"></div>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-xs relative overflow-hidden">
          <span className="text-[10px] text-slate-600 block font-bold select-none">القيمة المالية الكلية للتكلفة</span>
          <h4 className="text-xl md:text-2xl font-black text-slate-700 font-sans mt-2">
            {formatCurrency(totalBuyWorth, currency, exchangeRate)}
          </h4>
          <span className="text-[10px] text-[#5B6B86] block mt-1 leading-none font-bold">بمعدل أسعار الشراء الأساسية</span>
          {invValue.unknownCostCount > 0 && (
            <span className="text-[10px] text-amber-700 block mt-1 leading-relaxed font-bold">
              لا تشمل {formatArabicNoun(invValue.unknownCostCount, ARABIC_NOUNS.product)} بلا سعر شراء
            </span>
          )}
          <div className="absolute left-0 bottom-0 w-full h-1 bg-slate-400"></div>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-xs relative overflow-hidden">
          <span className="text-[10px] text-slate-600 block font-bold select-none">إجمالي الأرباح الكامنة بالجرد</span>
          <h4 className="text-xl md:text-2xl font-black text-emerald-800 font-sans mt-2">
            {formatCurrency(totalPotentialProfit, currency, exchangeRate)}
          </h4>
          <span className="text-[10px] text-emerald-700 block mt-1 leading-none font-bold">على المواد معروفة التكلفة فقط</span>
          {invValue.unknownCostCount > 0 && (
            <span className="text-[10px] text-amber-700 block mt-1 leading-relaxed font-bold">
              ⚠️ {formatArabicNoun(invValue.unknownCostCount, ARABIC_NOUNS.product)} بلا سعر شراء —
              قيمتها البيعية {formatCurrency(invValue.unknownCostSellValue, currency, exchangeRate)} غير محتسبة
            </span>
          )}
          <div className="absolute left-0 bottom-0 w-full h-1 bg-emerald-500"></div>
        </div>
      </div>

      {/* FILTER & MAIN WORKSPACE */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* RIGHT COLUMN: PRODUCTS INVENTORY GRID/LIST (7 cols) */}
        <div className="lg:col-span-7 bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm space-y-4">

          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h3 className="font-extrabold text-[#1E3A8A] text-sm md:text-base font-cairo flex items-center gap-1.5">
                <Box className="w-4.5 h-4.5 text-blue-600" />
                <span>قائمة وجرد المواد المتوفرة بالرفوف</span>
              </h3>
              <p className="text-[10px] text-slate-600">ابحث وقم بتصفية المخزون العام وتنزيل النواقص بلمسة واحدة</p>
            </div>

            <span className="text-[10px] bg-slate-100 px-3 py-1 rounded-full text-slate-700 font-extrabold block">
              مطابق بالتصفية: {formatArabicNoun(filteredProducts.length, ARABIC_NOUNS.product)}
            </span>
          </div>

          {/* Search bar and barcode scanner input */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">

            <div className="md:col-span-8 relative">
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
                <Search className="w-4 h-4" />
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ابحث باسم المنتج، باركود الصنف، الفئة..."
                className="w-full pr-9 pl-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-right outline-none focus:bg-white focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div className="md:col-span-4">
              <form onSubmit={handleBarcodeSubmitSearch} className="relative flex">
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-blue-800">
                  <Barcode className="w-4.5 h-4.5" />
                </span>
                <input
                  type="text"
                  value={barcodeSearchInput}
                  onChange={(e) => setBarcodeSearchInput(e.target.value)}
                  placeholder="مسدس الباركود..."
                  className="w-full pr-9 pl-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-right outline-none font-bold text-blue-800 focus:bg-white focus:ring-1 focus:ring-blue-500"
                />
              </form>
            </div>

          </div>

          {/* Dropdown filters */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            <div>
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="w-full px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-700 text-right outline-none"
              >
                <option value="all">كافة الفئات والأقسام 📚</option>
                {filterCategories.map(cat => (
                  <option key={cat} value={cat}>{getCategoryEmoji(cat)} {cat}</option>
                ))}
              </select>
            </div>

            <div>
              <select
                value={filterStock}
                onChange={(e) => setFilterStock(e.target.value as any)}
                className="w-full px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-700 text-right outline-none"
              >
                <option value="all">وضعية كميات المخزن 🗳</option>
                <option value="low">مواد حرج / نواقص ⚠️</option>
                <option value="instock">متوفر وفير 👍</option>
              </select>
            </div>
          </div>

          {/* Main List of Products */}
          <div className="space-y-3 max-h-[34rem] overflow-y-auto pr-1">
            {filteredProducts.length > 0 ? (
              visibleProducts.map((prod) => {
                const isSelected = selectedProductId === prod.id;
                const isLowStock = qtyOf(prod) <= prod.lowStockThreshold;
                // 🔴 التكلفة المجهولة لا تُحتسب صفراً هنا أيضاً: كان الربح يُعرض
                // بكامل سعر البيع لمنتج لا نعرف كلفته — رقمٌ يبدو خبراً ساراً وهو جهل.
                const prodBuy = buyPriceOf(prod);
                const singleProfit = prodBuy === undefined ? undefined : prod.sellPrice - prodBuy;
                const unit = prod.unit || 'قطعة';

                return (
                  <div
                    key={prod.id}
                    onClick={() => setSelectedProductId(prod.id)}
                    className={`p-3 border rounded-2xl cursor-pointer transition-all flex flex-col md:flex-row justify-between items-start md:items-center gap-3 relative overflow-hidden ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50/20 ring-1 ring-blue-500'
                        : 'border-slate-200 hover:bg-slate-50 bg-white'
                    }`}
                  >

                    <div className={`absolute top-0 right-0 h-full w-1.5 ${
                      isLowStock ? 'bg-amber-500' : 'bg-emerald-500'
                    }`}></div>

                    <div className="flex items-center gap-3 flex-1 min-w-0 pr-1.5">

                      <div className="w-12 h-12 rounded-xl bg-slate-50 border border-slate-200 flex-shrink-0 flex items-center justify-center overflow-hidden relative">
                        <span className="text-xl select-none">
                          {getCategoryEmoji(prod.category)}
                        </span>
                        {isLowStock && (
                          <span className="absolute bottom-0 right-0 w-3 h-3 bg-amber-500 rounded-full border-1 border-white animate-pulse"></span>
                        )}
                      </div>

                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {prod.category && (
                            <span className="px-2 py-0.5 bg-blue-50 text-[#1E3A8A] rounded-md text-[11px] font-black select-none">
                              {prod.category}
                            </span>
                          )}
                          <h4 className="text-xs md:text-sm font-black text-[#0B1F4D] truncate max-w-[200px]">
                            {prod.name}
                          </h4>
                        </div>

                        <div className="flex items-center gap-2 text-[10px] text-slate-600 font-bold flex-wrap">
                          {prod.barcode && (
                            <>
                              <span className="font-mono text-blue-800">🏷 {toArabicDigits(prod.barcode)}</span>
                              <span>•</span>
                            </>
                          )}
                          <span className="text-slate-500">مخزون:</span>
                          <span className={`font-black flex items-center gap-1 ${isLowStock ? 'text-amber-700' : 'text-[#0B1F4D]'}`}>
                            {toArabicDigits(qtyOf(prod))} {unit}
                            {isLowStock && (
                              <span className="bg-amber-50 text-amber-800 text-[11px] px-1 py-0.5 rounded font-black">تحت الأمان</span>
                            )}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 text-[10px] text-slate-600 font-bold flex-wrap">
                          <span>شراء: <span className="font-sans text-slate-600">{prodBuy === undefined ? '—' : toArabicDigits(prodBuy.toLocaleString())}</span></span>
                          <span>|</span>
                          <span>بيع: <span className="font-sans text-emerald-800">{toArabicDigits(prod.sellPrice.toLocaleString())}</span></span>
                          <span>|</span>
                          <span className={singleProfit === undefined ? "text-amber-700" : "text-emerald-700"}>ربح: <span className="font-sans font-extrabold">{singleProfit === undefined ? "غير محسوب — لا سعر شراء" : `${toArabicDigits(singleProfit.toLocaleString())} د.ع`}</span></span>
                        </div>

                        {prod.hasWholesale && prod.wholesaleUnitName && (
                          <div className="flex items-center gap-1 text-[10px] font-bold flex-wrap">
                            <span className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-800 border border-indigo-100 px-2 py-0.5 rounded-md">
                              <Layers className="w-3 h-3" />
                              المفرد: {toArabicDigits(prod.sellPrice.toLocaleString())} | الجملة: {prod.wholesaleUnitName} ({toArabicDigits(prod.wholesaleUnitQty || 0)}) = {toArabicDigits((prod.wholesalePrice || 0).toLocaleString())}
                            </span>
                          </div>
                        )}
                      </div>

                    </div>

                    {/* Quick controllers */}
                    <div className="flex items-center justify-between md:justify-end gap-2 w-full md:w-auto mt-2 md:mt-0 pt-2 md:pt-0 border-t md:border-t-0 border-dashed border-slate-100 flex-shrink-0">

                      <div className="text-right select-none">
                        <span className={`text-[11px] font-black px-2 py-0.5 border rounded-lg ${
                          isLowStock ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        }`}>
                          {isLowStock ? '⚠️ بحاجة لطلب توريد' : '✅ الرصيد آمن'}
                        </span>
                        <span className="text-[11px] text-slate-500 block mt-1 font-bold">
                          الحد الآمن: {toArabicDigits(prod.lowStockThreshold)} {unit}
                        </span>
                      </div>

                      {/* Quantity ± */}
                      <div className="flex items-center gap-1 border border-slate-200 p-1 rounded-xl bg-slate-50 select-none">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleAdjustQuantity(prod.id, 1); }}
                          className="w-9 h-9 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-900 flex items-center justify-center font-extrabold text-sm cursor-pointer active:scale-90"
                          title="إضافة رصيد رفوف"
                        >
                          +
                        </button>
                        <span className="w-6 text-center font-black text-xs font-mono text-[#0B1F4D]">
                          {toArabicDigits(qtyOf(prod))}
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleAdjustQuantity(prod.id, -1); }}
                          className="w-9 h-9 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-800 flex items-center justify-center font-extrabold text-sm cursor-pointer active:scale-90"
                          title="بيع مفرّد (إنقاص)"
                        >
                          -
                        </button>
                      </div>

                      {/* Edit + Delete */}
                      <div className="flex gap-1 flex-shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleOpenEditForm(prod); }}
                          className="w-9 h-9 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 flex items-center justify-center cursor-pointer active:scale-90 transition"
                          title="تعديل المنتج"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteProduct(prod.id, prod.name); }}
                          className="w-9 h-9 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 flex items-center justify-center cursor-pointer active:scale-90 transition"
                          title="حذف المنتج"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                    </div>

                  </div>
                );
              })
            ) : (
              <div className="py-20 bg-slate-50 rounded-2xl text-center font-bold text-xs text-slate-500">
                لا توجد بضائع تطابق التصفية أو الفرز الحالي بالمتجر.. أعد مراجعتها! 📡
              </div>
            )}

            {/* عرض المزيد — يظهر فقط عند وجود بقية، فمحل بمئة صنف لا يرى شيئاً جديداً */}
            {filteredProducts.length > visibleProducts.length && (
              <button
                type="button"
                onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
                className="w-full py-3 rounded-2xl border-2 border-dashed border-slate-200 text-slate-500 hover:border-[#0B1F4D] hover:text-[#0B1F4D] text-xs font-extrabold cursor-pointer transition"
              >
                عرض المزيد — ظاهر {toArabicDigits(visibleProducts.length)} من {toArabicDigits(filteredProducts.length)}
              </button>
            )}
          </div>
        </div>

        {/* LEFT COLUMN: ACTIVE PRODUCT SPEC PROFILE DETAIL DOSSIER (5 cols) */}
        <div className="lg:col-span-5 bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden flex flex-col justify-between">

          {selectedProduct ? (
            <div className="flex flex-col h-full justify-between">

              {/* Profile Card Header */}
              <div className="p-5 bg-gradient-to-br from-[#0B1F4D] to-[#1E3A8A] text-white space-y-3 relative">
                <div className="absolute top-0 left-0 w-24 h-24 bg-white/5 rounded-full blur-xl"></div>

                <div className="flex items-center gap-3">
                  <div className="w-14 h-14 rounded-2xl bg-white/10 border border-white/20 flex-shrink-0 flex items-center justify-center overflow-hidden">
                    <span className="text-2xl select-none">
                      {getCategoryEmoji(selectedProduct.category)}
                    </span>
                  </div>
                  <div>
                    <h4 className="font-extrabold text-xs md:text-sm font-cairo leading-snug">{selectedProduct.name}</h4>
                    <p className="text-[10px] text-blue-200 mt-0.5">🏷 {selectedProduct.category || 'بدون تصنيف'}</p>
                    <p className="text-[10px] text-blue-300 mt-0.5">📐 الوحدة: {selectedProduct.unit || 'بدون وحدة'}</p>
                  </div>
                </div>

                {/* Sub Metadata Info */}
                <div className="grid grid-cols-2 gap-2 pt-2.5 border-t border-white/10 text-xs text-slate-100 font-bold">
                  <div>
                    <span className="text-[11px] text-blue-200 block">الباركود:</span>
                    {selectedProduct.barcode ? (
                      <span className="font-mono text-white flex items-center gap-1">
                        <Barcode className="w-3.5 h-3.5 inline text-blue-300" />
                        {toArabicDigits(selectedProduct.barcode)}
                      </span>
                    ) : (
                      <span className="text-blue-300/70 text-[10px]">بدون باركود</span>
                    )}
                  </div>
                  <div>
                    <span className="text-[11px] text-blue-200 block">رصيد بالرفوف:</span>
                    <span className="font-mono text-white flex items-center gap-1 font-black">
                      <Box className="w-3.5 h-3.5 inline text-blue-300" />
                      {toArabicDigits(qtyOf(selectedProduct))} {selectedProduct.unit || 'قطعة'}
                    </span>
                  </div>
                </div>

              </div>

              {/* Specification Profiles */}
              <div className="p-5 flex-1 space-y-4 max-h-[30rem] overflow-y-auto">

                {/* Profit Calculator module */}
                <div className="border border-slate-200 p-4 rounded-xl space-y-3 bg-white">

                  <h4 className="font-extrabold text-xs text-[#0B1F4D] flex items-center gap-1 border-b border-dashed pb-2 border-slate-200">
                    <TrendingUp className="w-4 h-4 text-[#1E3A8A]" />
                    <span>هامش الربحية والنسب للمشروع</span>
                  </h4>

                  <div className="grid grid-cols-2 gap-3 text-xs font-bold text-slate-500">

                    <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                      <span className="text-[11px] text-slate-500 block">تكلفة شراء المغلف/المذخر:</span>
                      <span className="text-[#0B1F4D] block mt-1 font-sans">{toArabicDigits(selectedBuyPrice.toLocaleString())} د.ع</span>
                    </div>

                    <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                      <span className="text-[11px] text-slate-500 block">تسعيرة بيع الزبون:</span>
                      <span className="text-emerald-800 block mt-1 font-sans font-black">{toArabicDigits(selectedProduct.sellPrice.toLocaleString())} د.ع</span>
                    </div>

                  </div>

                  <div className="pt-2 flex justify-between items-center text-xs">

                    <div>
                      <span className="text-[11px] text-slate-500 block font-bold">ربحية الوحدة الواحدة:</span>
                      <span className="text-[#1E3A8A] font-black text-sm font-sans">
                        +{toArabicDigits((selectedProduct.sellPrice - selectedBuyPrice).toLocaleString())} د.ع
                      </span>
                    </div>

                    <div className="text-left">
                      <span className="text-[11px] text-slate-500 block font-bold">صافي الربح الإجمالي المحتمل:</span>
                      <span className="text-emerald-700 font-black text-sm font-sans">
                        {toArabicDigits(((selectedProduct.sellPrice - selectedBuyPrice) * qtyOf(selectedProduct)).toLocaleString())} د.ع
                      </span>
                    </div>

                  </div>

                  <div className="bg-blue-50/50 p-2.5 rounded-lg text-[10px] text-blue-900 font-extrabold flex items-center justify-between">
                    <span>نسبة العائد الإجمالي من رأس مال المادة:</span>
                    <span>%{toArabicDigits(selectedBuyPrice > 0 ? Math.round(((selectedProduct.sellPrice - selectedBuyPrice) / selectedBuyPrice) * 100) : 0)}</span>
                  </div>

                </div>

                {/* Wholesale pricing + profit info — only when enabled */}
                {selectedProduct.hasWholesale && selectedProduct.wholesaleUnitName && (() => {
                  const wholesaleSell = selectedProduct.wholesalePrice || 0;
                  const wholesaleProfit = selectedWholesaleBuy !== undefined ? wholesaleSell - selectedWholesaleBuy : undefined;
                  const wholesaleRoi = (selectedWholesaleBuy !== undefined && selectedWholesaleBuy > 0)
                    ? Math.round(((wholesaleSell - selectedWholesaleBuy) / selectedWholesaleBuy) * 100)
                    : undefined;
                  const retailProfit = selectedProduct.sellPrice - selectedBuyPrice;
                  const retailRoi = selectedBuyPrice > 0 ? Math.round((retailProfit / selectedBuyPrice) * 100) : 0;
                  return (
                  <div className="border border-indigo-200 p-4 rounded-xl space-y-2.5 bg-indigo-50/20">
                    <h4 className="font-extrabold text-xs text-indigo-900 flex items-center gap-1 border-b border-dashed pb-2 border-indigo-200">
                      <Layers className="w-4 h-4 text-indigo-700" />
                      <span>تسعيرة وأرباح البيع بالجملة</span>
                    </h4>
                    <div className="flex items-center justify-between text-xs font-bold">
                      <span className="text-slate-500">المفرد ({selectedProduct.unit || 'قطعة'}):</span>
                      <span className="text-emerald-800 font-sans">{toArabicDigits(selectedProduct.sellPrice.toLocaleString())} د.ع</span>
                    </div>
                    <div className="flex items-center justify-between text-xs font-bold">
                      <span className="text-slate-500">الجملة ({selectedProduct.wholesaleUnitName} = {toArabicDigits(selectedProduct.wholesaleUnitQty || 0)} {selectedProduct.unit || 'قطعة'}):</span>
                      <span className="text-indigo-800 font-sans">{toArabicDigits(wholesaleSell.toLocaleString())} د.ع</span>
                    </div>

                    {/* الربحان منفصلان تماماً */}
                    <div className="pt-2 border-t border-dashed border-indigo-200 grid grid-cols-2 gap-2">
                      <div className="bg-white rounded-lg border border-slate-100 p-2">
                        <span className="text-[11px] text-slate-500 block font-bold">ربح البيع بالمفرد</span>
                        <span className="text-[#1E3A8A] font-black text-xs font-sans block mt-0.5">
                          +{toArabicDigits(retailProfit.toLocaleString())} د.ع
                        </span>
                        <span className="text-[11px] text-slate-500 block mt-0.5">عائد: %{toArabicDigits(retailRoi)}</span>
                      </div>
                      <div className="bg-white rounded-lg border border-slate-100 p-2">
                        <span className="text-[11px] text-slate-500 block font-bold">ربح البيع بالجملة</span>
                        {wholesaleProfit !== undefined ? (
                          <>
                            <span className="text-indigo-800 font-black text-xs font-sans block mt-0.5">
                              +{toArabicDigits(wholesaleProfit.toLocaleString())} د.ع
                            </span>
                            <span className="text-[11px] text-slate-500 block mt-0.5">عائد: %{toArabicDigits(wholesaleRoi ?? 0)}</span>
                          </>
                        ) : (
                          <span className="text-amber-700 font-black text-[10px] block mt-1 leading-tight">
                            غير محتسب — أدخل سعر شراء الكرتون
                          </span>
                        )}
                      </div>
                    </div>
                    {wholesaleProfit === undefined && (
                      <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1 leading-relaxed">
                        لم يُدخَل سعر شراء الكرتون بعد، لذا ربح الجملة غير محتسب في التقارير. عدّل المنتج وأدخِله (باقي بيانات الجملة محفوظة).
                      </p>
                    )}
                  </div>
                  );
                })()}

                {/* Stock safety rules alert detail */}
                <div className={`p-4 border rounded-xl space-y-1.5 ${
                  qtyOf(selectedProduct) <= selectedProduct.lowStockThreshold
                    ? 'border-amber-200 bg-amber-50/30 text-amber-900'
                    : 'border-emerald-200 bg-emerald-50/10 text-emerald-950'
                }`}>

                  <div className="flex justify-between items-center text-xs font-bold text-[#0B1F4D]">
                    <span className="flex items-center gap-1 font-black text-[11px]">
                      <ShieldAlert className="w-4 h-4 text-emerald-700" />
                      مستحضر جرد الرصيد والأمان
                    </span>
                    <span className="text-slate-500 font-mono text-[10px]">
                      الحد الأدنى: {toArabicDigits(selectedProduct.lowStockThreshold)} {selectedProduct.unit || 'قطعة'}
                    </span>
                  </div>

                  <p className="text-[10px] text-slate-600 leading-relaxed">
                    {qtyOf(selectedProduct) <= selectedProduct.lowStockThreshold
                      ? 'الكمية حالياً غير كافية وتقع عند حافة الخرط والأمان ⚠️. ينصح فوراً بالاتصال في المورد للتعبئة وتجديد الأرفف لئلا تتأثر طلبية زبائنك الكرام.'
                      : 'الكمية المتوفرة كافية وتدعم المبيعات اليومية دون مشكلات 👍. سنقوم بإرسال جرس وتنبيه بالألوان لافت في حال الوصول أو الدنو تحت حد الأمان.'}
                  </p>

                </div>

                {/* Barcode visual — only shown when barcode is set */}
                {selectedProduct.barcode && (
                  <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 text-center space-y-2 select-none">
                    <span className="text-[11px] text-slate-500 block font-bold">معاينة الرمز الباركودي للطباعة</span>
                    <div className="mx-auto flex flex-col items-center justify-center bg-white p-3.5 rounded-lg border border-slate-200 inline-block">
                      <div className="flex justify-center items-end gap-0.5 h-10 w-full max-w-[200px]">
                        {[1,3,2,1,4,2,1,3,2,1,3,4,1,2,3,1,2,1,4,1,2,3,1,2].map((weight, i) => (
                          <div
                            key={i}
                            className={`bg-slate-900 h-full ${
                              weight === 1 ? 'w-[1.5px]' : weight === 2 ? 'w-[3px]' : weight === 3 ? 'w-[4px]' : 'w-[5px]'
                            }`}
                          />
                        ))}
                      </div>
                      <span className="font-mono text-slate-700 text-xs mt-2 block tracking-widest">{toArabicDigits(selectedProduct.barcode)}</span>
                    </div>
                  </div>
                )}

              </div>

              {/* Dossier footer */}
              <div className="p-4 bg-slate-50 border-t border-slate-100 text-[10px] text-slate-600 text-center font-bold">
                تاريخ تسجيل الصنف: {toArabicDigits(selectedProduct.createdAt)} • نظام جرد المحلات السحابي العراقي
              </div>

            </div>
          ) : (
            <div className="p-16 text-center text-slate-500 font-bold text-xs flex flex-col items-center justify-center h-full space-y-3">
              <Package className="w-12 h-12 text-slate-400 animate-bounce" />
              <span>يرجى اختيار مادة من لوحة الجرد لاستعراض التفاصيل الكاملة لحساب الأرباح ومستوى الأمان 📦</span>
            </div>
          )}

        </div>

      </div>

      {/* MODAL DIALOG FORM TO CREATE / UPDATE PRODUCTS */}
      {showFormModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl border border-slate-200 overflow-hidden transform transition-all animate-scale-up text-right">

            <div className="p-5 bg-gradient-to-r from-blue-900 to-[#1E3A8A] text-white flex justify-between items-center">
              <h3 className="font-black text-sm md:text-base font-cairo flex items-center gap-1.5">
                <Box className="w-5 h-4.5 text-blue-100" />
                <span>{formIsEditing ? 'تعديل وحفظ بيانات المنتج' : 'إضافة وتدشين منتج جديد'}</span>
              </h3>
              <button
                onClick={() => setShowFormModal(false)}
                className="p-1.5 hover:bg-white/10 rounded-lg text-white font-black text-xs cursor-pointer"
              >
                إغلاق ✕
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">

              {/* Barcode — FIRST field, auto-focused, supports USB scanner */}
              <div>
                <label className="text-[10px] text-slate-600 font-extrabold block mb-1">
                  الباركود <span className="text-slate-500 font-normal">(اختياري — امسح بالمسدس أو اكتب يدوياً)</span>
                </label>
                <div className="relative">
                  <Barcode className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-blue-400 pointer-events-none" />
                  <input
                    ref={barcodeInputRef}
                    type="text"
                    value={formBarcode}
                    onChange={(e) => handleBarcodeChange(e.target.value)}
                    onKeyDown={handleBarcodeKeyDown}
                    placeholder="امسح بالمسدس أو أدخل يدوياً..."
                    className={`w-full pr-9 pl-3 py-2.5 border rounded-xl text-xs font-mono outline-none transition ${
                      barcodeCheckResult === 'duplicate'
                        ? 'border-amber-400 bg-amber-50 focus:border-amber-500'
                        : barcodeCheckResult === 'new'
                        ? 'border-emerald-400 bg-emerald-50 focus:border-emerald-500'
                        : 'border-slate-200 focus:border-blue-500'
                    }`}
                    inputMode="numeric"
                    autoComplete="off"
                  />
                </div>

                {/* Inline feedback */}
                {barcodeCheckResult === 'duplicate' && foundProductForBarcode && (
                  <div className="mt-2 flex items-center gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded-xl text-xs">
                    <AlertTriangle className="w-4 h-4 text-amber-700 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="font-bold text-amber-800 block truncate">
                        هذا المنتج موجود مسبقاً: {foundProductForBarcode.name}
                      </span>
                      <span className="text-amber-700 text-[10px]">
                        اضغط Enter أو{' '}
                        <button
                          type="button"
                          onClick={() => {
                            setShowFormModal(false);
                            setBarcodeCheckResult(null);
                            setTimeout(() => handleOpenEditForm(foundProductForBarcode!), 180);
                          }}
                          className="underline font-bold cursor-pointer"
                        >
                          انقر هنا
                        </button>
                        {' '}لفتح بياناته وتعديله
                      </span>
                    </div>
                  </div>
                )}
                {barcodeCheckResult === 'new' && formBarcode.trim() && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-emerald-700 font-bold">
                    <Check className="w-3.5 h-3.5" />
                    <span>باركود جديد — يمكن تسجيل المنتج (اضغط Enter للانتقال لاسم المنتج)</span>
                  </div>
                )}
                {!formBarcode.trim() && !formIsEditing && (
                  <p className="text-[11px] text-slate-500 mt-1">
                    مسدس USB يكتب الرقم ثم يضغط Enter تلقائياً ⚡
                  </p>
                )}
              </div>

              {/* Product name */}
              <div>
                <label className="text-[10px] text-slate-600 font-extrabold block mb-1">اسم المنتج الكلي (بالعربي):</label>
                <input
                  id="form_product_name"
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="مثال: حليب نيدو مجفف بوردة ٩٠٠ غ"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs text-right outline-none focus:border-blue-500"
                  required
                />
              </div>

              {/* Category + Unit — كلاهما اختياري بالكامل */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-600 font-bold">التصنيف ووحدة القياس (اختياري — يمكن تركهما فارغين)</span>
                <button
                  type="button"
                  onClick={openManageModal}
                  title="إدارة قوائم الأصناف ووحدات القياس (إضافة / تعديل / حذف)"
                  className="flex items-center gap-1 text-[10px] font-extrabold text-blue-700 hover:text-blue-900 bg-blue-50 hover:bg-blue-100 border border-blue-100 px-2 py-1 rounded-lg transition active:scale-95 cursor-pointer"
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  إدارة القوائم
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-slate-600 font-extrabold block mb-1">تصنيف المادة بالرفوف:</label>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={formCategory}
                      onChange={(e) => setFormCategory(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-right outline-none focus:border-blue-500"
                    >
                      <option value="">— بدون تصنيف —</option>
                      {categoryFormOptions.map(cat => (
                        <option key={cat} value={cat}>{getCategoryEmoji(cat)} {cat}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => { setAddingCategory(v => !v); setNewCategoryText(''); }}
                      title="إضافة صنف جديد"
                      className="flex-shrink-0 w-8 h-8 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 flex items-center justify-center transition active:scale-90 cursor-pointer border border-blue-100"
                    >
                      {addingCategory ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                    </button>
                  </div>
                  {addingCategory && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <input
                        type="text"
                        value={newCategoryText}
                        onChange={(e) => setNewCategoryText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); handleAddCategory(); }
                          if (e.key === 'Escape') { setAddingCategory(false); setNewCategoryText(''); }
                        }}
                        autoFocus
                        placeholder="اسم الصنف الجديد..."
                        className="w-full px-2.5 py-1.5 border border-blue-300 bg-blue-50/40 rounded-lg text-xs text-right outline-none focus:border-blue-500"
                      />
                      <button
                        type="button"
                        onClick={handleAddCategory}
                        title="تأكيد الإضافة"
                        className="flex-shrink-0 w-7 h-7 rounded-lg bg-emerald-500 hover:bg-emerald-800 text-white flex items-center justify-center transition active:scale-90 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => { setAddingCategory(false); setNewCategoryText(''); }}
                        title="إلغاء"
                        className="flex-shrink-0 w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition active:scale-90 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
                <div>
                  <label className="text-[10px] text-slate-600 font-extrabold block mb-1">وحدة القياس:</label>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={formUnit}
                      onChange={(e) => setFormUnit(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-right outline-none focus:border-blue-500"
                    >
                      <option value="">— بدون وحدة —</option>
                      {unitFormOptions.map(u => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => { setAddingUnit(v => !v); setNewUnitText(''); }}
                      title="إضافة وحدة قياس جديدة"
                      className="flex-shrink-0 w-8 h-8 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 flex items-center justify-center transition active:scale-90 cursor-pointer border border-blue-100"
                    >
                      {addingUnit ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                    </button>
                  </div>
                  {addingUnit && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <input
                        type="text"
                        value={newUnitText}
                        onChange={(e) => setNewUnitText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); handleAddUnit(); }
                          if (e.key === 'Escape') { setAddingUnit(false); setNewUnitText(''); }
                        }}
                        autoFocus
                        placeholder="اسم الوحدة الجديدة..."
                        className="w-full px-2.5 py-1.5 border border-blue-300 bg-blue-50/40 rounded-lg text-xs text-right outline-none focus:border-blue-500"
                      />
                      <button
                        type="button"
                        onClick={handleAddUnit}
                        title="تأكيد الإضافة"
                        className="flex-shrink-0 w-7 h-7 rounded-lg bg-emerald-500 hover:bg-emerald-800 text-white flex items-center justify-center transition active:scale-90 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => { setAddingUnit(false); setNewUnitText(''); }}
                        title="إلغاء"
                        className="flex-shrink-0 w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition active:scale-90 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Buy price + Sell price */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-slate-600 font-extrabold block mb-1">سعر الشراء / التكلفة (د.ع):</label>
                  <NumberInput inputMode="decimal"
                    value={formBuyPrice}
                    onValueChange={(v) => setFormBuyPrice(v)}
                    placeholder="مثال: 12000"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:border-blue-500"
                    required
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-600 font-extrabold block mb-1">سعر البيع للزبون (د.ع):</label>
                  <NumberInput inputMode="decimal"
                    value={formSellPrice}
                    onValueChange={(v) => setFormSellPrice(v)}
                    placeholder="مثال: 14500"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:border-blue-500"
                    required
                  />
                </div>
              </div>

              {/* Quantity + Low stock */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-slate-600 font-extrabold block mb-1">الكمية المتوفرة ({formUnit || 'وحدة'}):</label>
                  <NumberInput inputMode="decimal"
                    value={formQuantity}
                    onValueChange={(v) => setFormQuantity(v)}
                    placeholder="العدد الحالي"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:border-blue-500"
                    required
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-600 font-extrabold block mb-1">حد النفاد والتنبيه ({formUnit || 'وحدة'}):</label>
                  <NumberInput inputMode="decimal"
                    value={formLowStock}
                    onValueChange={(v) => setFormLowStock(v)}
                    placeholder="أقل حد مطلوب"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:border-blue-500"
                    required
                  />
                </div>
              </div>

              {/* Wholesale toggle + fields */}
              <div className="border border-slate-200 rounded-xl p-3.5 bg-slate-50/60 space-y-3">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={formHasWholesale}
                    onChange={(e) => setFormHasWholesale(e.target.checked)}
                    className="w-4 h-4 accent-[#1E3A8A] cursor-pointer"
                  />
                  <span className="text-xs font-extrabold text-[#1E3A8A] flex items-center gap-1.5">
                    <Layers className="w-4 h-4" />
                    تفعيل بيع بالجملة لهذا المنتج
                  </span>
                </label>

                {formHasWholesale && (
                  <div className="space-y-3 pt-1 border-t border-dashed border-slate-200">
                    <div>
                      <label className="text-[10px] text-slate-600 font-extrabold block mb-1">اسم وحدة الجملة:</label>
                      <input
                        type="text"
                        value={formWholesaleUnitName}
                        onChange={(e) => setFormWholesaleUnitName(e.target.value)}
                        placeholder="مثال: كارتون"
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs text-right outline-none focus:border-blue-500"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] text-slate-600 font-extrabold block mb-1">
                          عدد ({formUnit || 'وحدة'}) بالوحدة الواحدة:
                        </label>
                        <NumberInput inputMode="decimal"
                          value={formWholesaleUnitQty}
                          onValueChange={(v) => setFormWholesaleUnitQty(v)}
                          placeholder="مثال: 30"
                          min={1}
                          className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-600 font-extrabold block mb-1">سعر بيع وحدة الجملة (د.ع):</label>
                        <NumberInput inputMode="decimal"
                          value={formWholesalePrice}
                          onValueChange={(v) => setFormWholesalePrice(v)}
                          placeholder="مثال: 50000"
                          min={1}
                          className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:border-blue-500"
                        />
                      </div>
                    </div>
                    {/* تكلفة شراء الكرتون الفعلية — منفصلة عن (سعر شراء القطعة × العدد) بسبب خصم المورد */}
                    <div>
                      <label className="text-[10px] text-slate-600 font-extrabold block mb-1">
                        سعر شراء الكرتون / الوحدة الكاملة (د.ع):
                        <span className="text-slate-500 font-normal"> (تكلفتك الفعلية من المورد)</span>
                      </label>
                      <NumberInput inputMode="decimal"
                        value={formWholesaleBuyPrice}
                        onValueChange={(v) => setFormWholesaleBuyPrice(v)}
                        placeholder="مثال: 42000"
                        min={1}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:border-blue-500"
                      />
                      <p className="text-[11px] text-slate-500 mt-1">
                        قد تختلف عن سعر شراء القطعة × عدد القطع بسبب خصم الشراء بالجملة — تُستخدم لحساب ربح الجملة الحقيقي (لا تظهر للموظف).
                      </p>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      مثال: إن كانت {formWholesaleUnitName || 'وحدة الجملة'} تحوي {formWholesaleUnitQty || '30'} {formUnit || 'وحدة'}، فبيع وحدة واحدة يخصم {formWholesaleUnitQty || '30'} {formUnit || 'وحدة'} من المخزون تلقائياً.
                    </p>
                  </div>
                )}
              </div>

              {/* ---- الضمان والسيريال (اختياري — لمحلات الموبايل/الإلكترونيات) ---- */}
              <div className="border-t border-slate-100 pt-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-extrabold text-[#0B1F4D] flex items-center gap-1.5">
                    🛡️ <span>الضمان والرقم التسلسلي</span>
                    <span className="text-[11px] text-slate-500 font-normal">(اختياري — للأجهزة فقط)</span>
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-slate-600 font-extrabold block mb-1">مدة الضمان (بالأشهر):</label>
                    <input
                      type="text" inputMode="decimal"
                      value={formWarrantyMonths}
                      onChange={(e) => setFormWarrantyMonths(e.target.value)}
                      placeholder="مثال: 12"
                      min={0}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:border-blue-500"
                    />
                  </div>
                  <div className="flex items-end">
                    <label className="flex items-center gap-2 cursor-pointer bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 w-full">
                      <input
                        type="checkbox"
                        checked={formTracksSerial}
                        onChange={(e) => setFormTracksSerial(e.target.checked)}
                        className="w-4 h-4 cursor-pointer"
                      />
                      <span className="text-[10px] font-extrabold text-[#0B1F4D]">اطلب السيريال حتى بلا ضمان</span>
                    </label>
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  اترك المدة فارغة للمواد العادية (حليب، شامبو...) فلا يظهر أي حقل إضافي عند البيع.
                  عند تعبئتها يطلب البرنامج الرقم التسلسلي/IMEI وقت البيع، ويمكنك بعدها البحث عن الجهاز من شاشة «الضمان والسيريال».
                </p>
              </div>

              {/* Form submit footer */}
              <div className="pt-3 border-t border-slate-100 flex justify-end gap-3 select-none">
                <button
                  type="button"
                  onClick={() => setShowFormModal(false)}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-bold hover:bg-slate-50 text-slate-600 transition cursor-pointer"
                >
                  إلغاء التراجع
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 text-white rounded-xl text-xs font-extrabold transition cursor-pointer"
                  style={{ background: '#1E3A8A' }}
                >
                  {formIsEditing ? 'حفظ وتثبيت التعديلات الكلية' : 'تفعيل السلعة وبدء الجرد'}
                </button>
              </div>

            </form>

          </div>
        </div>
      )}

      {/* MANAGE CATEGORIES / UNITS MODAL — add / rename / delete on the central lists */}
      {showManageModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl border border-slate-200 overflow-hidden transform transition-all animate-scale-up text-right">

            <div className="p-5 bg-gradient-to-r from-blue-900 to-[#1E3A8A] text-white flex justify-between items-center">
              <h3 className="font-black text-sm md:text-base font-cairo flex items-center gap-1.5">
                <Settings2 className="w-5 h-5 text-blue-100" />
                <span>إدارة الأصناف ووحدات القياس</span>
              </h3>
              <button
                onClick={() => setShowManageModal(false)}
                className="p-1.5 hover:bg-white/10 rounded-lg text-white font-black text-xs cursor-pointer"
              >
                إغلاق ✕
              </button>
            </div>

            <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-5 max-h-[75vh] overflow-y-auto">

              {/* ---- CATEGORIES PANEL ---- */}
              <div className="space-y-3">
                <h4 className="font-extrabold text-xs text-[#0B1F4D] flex items-center gap-1.5 border-b border-dashed border-slate-200 pb-2">
                  <Tag className="w-4 h-4 text-blue-700" />
                  قائمة الأصناف
                  <span className="text-[11px] text-slate-500 font-bold">({toArabicDigits(allCategories.length)})</span>
                </h4>

                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={manageCatInput}
                    onChange={(e) => setManageCatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleManageAddCategory(); } }}
                    placeholder="اسم صنف جديد..."
                    className="w-full px-2.5 py-2 border border-slate-200 rounded-lg text-xs text-right outline-none focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={handleManageAddCategory}
                    title="إضافة صنف"
                    className="flex-shrink-0 w-8 h-8 rounded-lg bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center transition active:scale-90 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-1.5 max-h-[45vh] overflow-y-auto pr-0.5">
                  {allCategories.length === 0 ? (
                    <p className="text-[10px] text-slate-600 font-bold text-center py-6 bg-slate-50 rounded-lg">
                      لا توجد أصناف بعد — أضف صنفك الأول من الحقل أعلاه 🏷
                    </p>
                  ) : (
                    allCategories.map(cat => (
                      <div key={cat} className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5">
                        {editingCat === cat ? (
                          <>
                            <input
                              type="text"
                              value={editingCatText}
                              onChange={(e) => setEditingCatText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); handleRenameCategory(cat); }
                                if (e.key === 'Escape') { setEditingCat(null); setEditingCatText(''); }
                              }}
                              autoFocus
                              className="w-full px-2 py-1 border border-blue-300 bg-white rounded-md text-xs text-right outline-none focus:border-blue-500"
                            />
                            <button
                              type="button"
                              onClick={() => handleRenameCategory(cat)}
                              title="حفظ الاسم الجديد"
                              className="flex-shrink-0 w-7 h-7 rounded-md bg-emerald-500 hover:bg-emerald-800 text-white flex items-center justify-center active:scale-90 cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => { setEditingCat(null); setEditingCatText(''); }}
                              title="إلغاء"
                              className="flex-shrink-0 w-7 h-7 rounded-md bg-slate-200 hover:bg-slate-300 text-slate-600 flex items-center justify-center active:scale-90 cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="flex-1 min-w-0 text-xs font-bold text-[#0B1F4D] truncate">
                              {getCategoryEmoji(cat)} {cat}
                            </span>
                            <button
                              type="button"
                              onClick={() => { setEditingCat(cat); setEditingCatText(cat); }}
                              title="تعديل الاسم"
                              className="flex-shrink-0 w-7 h-7 rounded-md bg-blue-50 hover:bg-blue-100 text-blue-700 flex items-center justify-center active:scale-90 cursor-pointer"
                            >
                              <Edit className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteCategory(cat)}
                              title="حذف الصنف"
                              className="flex-shrink-0 w-7 h-7 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-700 flex items-center justify-center active:scale-90 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* ---- UNITS PANEL ---- */}
              <div className="space-y-3">
                <h4 className="font-extrabold text-xs text-[#0B1F4D] flex items-center gap-1.5 border-b border-dashed border-slate-200 pb-2">
                  <Ruler className="w-4 h-4 text-blue-700" />
                  قائمة وحدات القياس
                  <span className="text-[11px] text-slate-500 font-bold">({toArabicDigits(allUnits.length)})</span>
                </h4>

                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={manageUnitInput}
                    onChange={(e) => setManageUnitInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleManageAddUnit(); } }}
                    placeholder="اسم وحدة جديدة..."
                    className="w-full px-2.5 py-2 border border-slate-200 rounded-lg text-xs text-right outline-none focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={handleManageAddUnit}
                    title="إضافة وحدة"
                    className="flex-shrink-0 w-8 h-8 rounded-lg bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center transition active:scale-90 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-1.5 max-h-[45vh] overflow-y-auto pr-0.5">
                  {allUnits.length === 0 ? (
                    <p className="text-[10px] text-slate-600 font-bold text-center py-6 bg-slate-50 rounded-lg">
                      لا توجد وحدات بعد — أضف وحدتك الأولى من الحقل أعلاه 📐
                    </p>
                  ) : (
                    allUnits.map(u => (
                      <div key={u} className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5">
                        {editingUnit === u ? (
                          <>
                            <input
                              type="text"
                              value={editingUnitText}
                              onChange={(e) => setEditingUnitText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); handleRenameUnit(u); }
                                if (e.key === 'Escape') { setEditingUnit(null); setEditingUnitText(''); }
                              }}
                              autoFocus
                              className="w-full px-2 py-1 border border-blue-300 bg-white rounded-md text-xs text-right outline-none focus:border-blue-500"
                            />
                            <button
                              type="button"
                              onClick={() => handleRenameUnit(u)}
                              title="حفظ الاسم الجديد"
                              className="flex-shrink-0 w-7 h-7 rounded-md bg-emerald-500 hover:bg-emerald-800 text-white flex items-center justify-center active:scale-90 cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => { setEditingUnit(null); setEditingUnitText(''); }}
                              title="إلغاء"
                              className="flex-shrink-0 w-7 h-7 rounded-md bg-slate-200 hover:bg-slate-300 text-slate-600 flex items-center justify-center active:scale-90 cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </>
                        ) : (
                          <>
                            <span title={u} className="flex-1 min-w-0 text-xs font-bold text-[#0B1F4D] truncate">{u}</span>
                            <button
                              type="button"
                              onClick={() => { setEditingUnit(u); setEditingUnitText(u); }}
                              title="تعديل الاسم"
                              className="flex-shrink-0 w-7 h-7 rounded-md bg-blue-50 hover:bg-blue-100 text-blue-700 flex items-center justify-center active:scale-90 cursor-pointer"
                            >
                              <Edit className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteUnit(u)}
                              title="حذف الوحدة"
                              className="flex-shrink-0 w-7 h-7 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-700 flex items-center justify-center active:scale-90 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

            </div>

            <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-3">
              <p className="text-[11px] text-slate-500 font-bold leading-relaxed">
                التعديل والحذف يؤثران على القائمة المركزية فقط. المنتجات المسجّلة سابقاً تحتفظ بالنص الذي خُزّن وقت إضافتها.
              </p>
              <button
                type="button"
                onClick={() => setShowManageModal(false)}
                className="flex-shrink-0 px-4 py-2 text-white rounded-xl text-xs font-extrabold transition cursor-pointer"
                style={{ background: '#1E3A8A' }}
              >
                تم
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ملصقات الباركود — توليد الأكواد الداخلية وطباعة الملصقات */}
      {showLabels && (
        <BarcodeLabelsModal
          products={products}
          storeName={storeName}
          currency={currency}
          exchangeRate={exchangeRate}
          onSaveBarcodes={saveGeneratedBarcodes}
          onClose={() => setShowLabels(false)}
        />
      )}

      {/* استيراد جماعي للمنتجات من CSV */}
      {showImport && (
        <BulkImportModal<Product>
          title="إضافة منتجات دفعة واحدة"
          gridColumns={PRODUCT_GRID}
          templateHeaders={PRODUCT_HEADERS}
          templateSample={PRODUCT_SAMPLE_ROW}
          templateName="قالب_المنتجات"
          parseRows={(rowObjects) => parseProductRows(rowObjects, products)}
          onCommit={commitProductImport}
          onClose={() => setShowImport(false)}
        />
      )}

      {/* REORDER / PURCHASE-PREP MODAL — قائمة تجهيز النواقص */}
      {showReorderModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl border border-slate-200 overflow-hidden transform transition-all animate-scale-up text-right flex flex-col max-h-[90vh]">

            <div className="p-5 bg-gradient-to-r from-amber-600 to-amber-500 text-white flex justify-between items-center flex-shrink-0">
              <div>
                <h3 className="font-black text-sm md:text-base font-cairo flex items-center gap-1.5">
                  <ClipboardList className="w-5 h-5 text-amber-50" />
                  <span>قائمة تجهيز النواقص 📋</span>
                </h3>
                <p className="text-[11px] text-amber-50/90 mt-0.5">
                  مواد تحت حد الأمان — عدّل الكميات ثم اطبع القائمة للمجهّز
                </p>
              </div>
              <button
                onClick={() => setShowReorderModal(false)}
                className="p-1.5 hover:bg-white/10 rounded-lg text-white font-black text-xs cursor-pointer flex-shrink-0"
              >
                إغلاق ✕
              </button>
            </div>

            {reorderLines.length === 0 ? (
              <div className="p-10 text-center">
                <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
                <p className="font-extrabold text-sm text-[#0B1F4D]">لا توجد مواد ناقصة 🎉</p>
                <p className="text-xs text-slate-500 mt-1 font-bold">كل المخزون فوق حد الأمان</p>
              </div>
            ) : (
              <>
                <div className="p-4 overflow-y-auto flex-1 space-y-2">
                  {reorderLines.map((l) => {
                    const base = reorderBase.find(b => b.id === l.id)!;
                    return (
                      <div key={l.id} className="border border-slate-200 rounded-xl p-3 flex items-center gap-3 flex-wrap sm:flex-nowrap">
                        {/* Product info */}
                        <div className="min-w-0 flex-1">
                          <span title={l.name} className="text-xs font-extrabold text-[#0B1F4D] block truncate">{l.name}</span>
                          <span className="text-[10px] font-bold text-rose-700 block mt-0.5">
                            المتوفر {toArabicDigits(l.currentQty)} {l.baseUnit} · الحد {toArabicDigits(l.threshold)}
                          </span>
                        </div>

                        {/* Editable purchase qty */}
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <NumberInput inputMode="decimal"
                            min={0}
                            value={reorderQty[l.id] ?? ''}
                            onValueChange={(v) => setReorderQty(prev => ({ ...prev, [l.id]: v }))}
                            className="w-16 px-2 py-1.5 border border-slate-200 rounded-lg text-xs font-bold text-center outline-none focus:border-amber-400"
                          />
                          <span className="text-[11px] font-extrabold text-slate-600 whitespace-nowrap">{l.purchaseUnit}</span>
                        </div>

                        {/* Equivalent base units (only for wholesale/carton) */}
                        <div className="text-[10px] text-slate-600 font-bold w-20 text-center flex-shrink-0 hidden sm:block">
                          {l.purchaseUnit !== l.baseUnit
                            ? `= ${toArabicDigits(l.baseUnitsAcquired)} ${l.baseUnit}`
                            : ''}
                        </div>

                        {/* Estimated cost */}
                        <div className="text-left w-28 flex-shrink-0">
                          {l.lineCost !== undefined ? (
                            <span className="text-xs font-extrabold text-emerald-700 font-sans">
                              {formatCurrency(l.lineCost, currency, exchangeRate)}
                            </span>
                          ) : (
                            <span className="text-[10px] font-extrabold text-amber-700" title="أدخل سعر الشراء لهذه المادة">
                              غير محسوبة
                            </span>
                          )}
                          <span className="block text-[11px] text-slate-500 font-bold">
                            {base.unitCost !== undefined
                              ? `${formatCurrency(base.unitCost, currency, exchangeRate)} / ${l.purchaseUnit}`
                              : 'بلا سعر شراء'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Footer: total + print */}
                <div className="p-4 bg-slate-50 border-t border-slate-100 flex-shrink-0 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[11px] text-slate-500 font-bold block">التكلفة التقديرية الإجمالية</span>
                      {reorderUnknownCount > 0 && (
                        <span className="text-[10px] text-amber-700 font-bold block mt-0.5">
                          {toArabicDigits(reorderUnknownCount)} مادة بلا سعر شراء (غير محسوبة)
                        </span>
                      )}
                    </div>
                    <span className="font-black text-lg text-[#0B1F4D] font-sans">
                      {formatCurrency(reorderKnownTotal, currency, exchangeRate)}
                    </span>
                  </div>
                  <button
                    onClick={handlePrintReorder}
                    className="w-full py-3 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-sm shadow transition cursor-pointer flex items-center justify-center gap-2 active:scale-95"
                  >
                    <Printer className="w-4 h-4" />
                    <span>طباعة قائمة التجهيز</span>
                  </button>
                </div>
              </>
            )}

          </div>
        </div>
      )}

    </div>
  );
}
