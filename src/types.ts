export type BusinessType = 'general';

export interface UserProfile {
  uid: string;
  storeName: string;
  ownerName: string;
  phone: string;
  email: string;
  businessType: BusinessType | null;
  plan: 'free' | 'licensed';
  activationStatus: boolean;
  licenseStatus: 'trial' | 'active';
  createdAt: string;        // ISO string, مخزّن في Firestore عند إنشاء الحساب
  activationCode?: string;  // الكود المستخدم للتفعيل
  activatedAt?: string;     // تاريخ التفعيل ISO string
  syncRenewalExpiry: string;
  address?: string;
  logoUrl?: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  address: string;
  notes: string;
  balance: number; // Positive means debt to store, negative means store owes customer
  dueDate: string;
  createdAt: string;
}

// For General Store / Inventory
export interface Product {
  id: string;
  name: string;
  barcode: string;      // empty string means no barcode
  // ⚠️ حقل موروث فقط: التكلفة انتقلت إلى مجموعة product_costs (يقرأها المالك فقط، محجوبة عن الموظف).
  // يُقرأ كـ fallback عبر buyPriceOf أثناء الانتقال، ويجرّده الترحيل التلقائي من هذه الوثيقة.
  buyPrice?: number;
  sellPrice: number;
  quantity: number;      // **إجمالي** المخزون عبر كل الفروع، بوحدة الأساس (المفرد)
  // مخزون كل فرع على حدة: { main: 30, branch_basra: 20 }. مجموعها = quantity دائماً لأن كل
  // عملية تكتب الفارق في الحقلين معاً في تحديث ذرّي واحد ⇒ يستحيل أن يتفرّقا.
  // غيابه (منتجات قبل الفروع) = كل الكمية في الفرع الرئيسي — يعالجه الترحيل التلقائي.
  branchStock?: Record<string, number>;
  lowStockThreshold: number;
  category: string;
  unit?: string;        // e.g. 'قطعة', 'كيلوغرام', 'علبة' — وحدة الأساس (المفرد)
  imageUrl?: string;
  createdAt: string;
  // ---- بيع بالجملة (اختياري) ----
  hasWholesale?: boolean;       // هل مفعّل له بيع بالجملة؟
  wholesaleUnitName?: string;   // اسم وحدة الجملة، مثل "كارتون"
  wholesaleUnitQty?: number;    // عدد وحدات الأساس في وحدة الجملة الواحدة، مثل 30
  wholesalePrice?: number;      // سعر بيع وحدة الجملة الواحدة
  // ---- الضمان والسيريال (اختياري — لمحلات الموبايل/الإلكترونيات) ----
  // مدة الضمان الافتراضية بالأشهر. وجودها يفعّل حقل السيريال لهذا المنتج في الفاتورة
  // ويملأ المدة تلقائياً. المنتجات العادية (حليب/شامبو) تتركها فارغة فلا يتغيّر شيء.
  defaultWarrantyMonths?: number;
  tracksSerial?: boolean;       // اطلب السيريال عند البيع حتى لو بلا ضمان (مثل أجهزة بلا كفالة)
  // ---- الصلاحية (اختياري — يتعلّمه البرنامج من فعل المستخدم لا باستجوابه) ----
  // يصير true تلقائياً أول مرة يُدخل المستخدم تاريخ انتهاء لهذه المادة، فيسأله عنها
  // في كل استلام قادم. المواد التي لا يفسدها الوقت (صوندة) لا تُسأل أبداً.
  tracksExpiry?: boolean;
  // تجاوز يدوي لعدد أيام التنبيه لهذه المادة وحدها. غيابه = تجاوز الفئة، ثم الحساب
  // التلقائي من عمر المادة نفسها (١٥٪ من العمر، بحدّين: يومان و١٨٠ يوماً).
  expiryAlertDays?: number;
}

// تكلفة شراء المنتج — مجموعة منفصلة /users/{owner}/product_costs/{productId}.
// معزولة عن وثيقة المنتج ليتمكّن الموظف من قراءة المنتجات دون رؤية هامش الربح
// (قواعد Firestore لا تدعم إخفاء حقل مفرد ضمن وثيقة يقرؤها).
export interface ProductCost {
  id: string;        // = معرّف المنتج المقابل في products
  buyPrice: number;  // تكلفة شراء القطعة المفردة (وحدة الأساس)
  // تكلفة شراء وحدة الجملة الكاملة (الكرتون) كما تُشترى فعلياً من المورد — منفصلة تماماً
  // عن buyPrice، لأن خصم الشراء بالجملة يجعلها ≠ (buyPrice × عدد القطع). اختيارية:
  // غيابها يعني "غير معروفة" فيُصنَّف ربح بيع الجملة كـ"غير محتسب" (لا تخمين إطلاقاً).
  wholesaleBuyPrice?: number;
}


export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerName: string;
  customerId?: string;
  totalAmount: number;
  discount: number;
  tax: number;
  finalAmount: number;
  paidAmount?: number;      // Amount paid at time of invoice (undefined = fully paid)
  remainingAmount?: number; // Debt recorded on customer (0 or undefined = no debt)
  // توزيع المبلغ الواصل على طرق الدفع (يدعم تقسيم الفاتورة: ٣٠٠ كاش + ٢٠٠ بطاقة).
  // مجموعها = paidAmount. غيابها (كل البيانات القديمة) ⇒ المبلغ كله كاش — صحيح تاريخياً.
  // 🔴 يعتمد عليها تقفيل الصندوق لفصل النقد في الدرج عن المحصَّل إلكترونياً.
  payments?: Array<{ method: string; amount: number }>;
  date: string;
  createdAt?: number;       // Unix timestamp ms — للتحقق من فترة السماح. الفواتير القديمة تستخدم parseInt(id) كـ fallback
  type: BusinessType;
  // ---- نسب الفاتورة لمُصدِرها (نظام حسابات الموظفين) — اختيارية ومتوافقة رجعياً ----
  createdByUid?: string;    // uid من أصدر الفاتورة (موظف أو مالك). للموظف يجب أن يساوي uid الخاص به (تفرضه القواعد)
  createdByName?: string;   // اسم المُصدِر للعرض/سجل النشاطات لاحقاً
  // رمز الجهاز الذي أصدر الفاتورة — إشارة صامتة لكشف تعدّد الأجهزة ومنع تكرار الأرقام.
  // غيابه (كل الفواتير السابقة) = جهاز واحد، فلا ترحيل ولا تغيّر في أي رقم قائم.
  deviceTag?: string;
  // الفرع الذي صدرت منه. غيابه (كل الفواتير السابقة) = الفرع الرئيسي — فلا يحتاج ترحيل بيانات.
  branchId?: string;
  debtSyncedToBalance?: boolean; // هل طُوي دين هذه الفاتورة في customer.balance؟ يُدار من جلسة المالك فقط لاحقاً
  items: Array<{
    itemId: string;
    name: string;
    quantity: number;
    price: number;
    total: number;
    productId?: string; // link to products collection for inventory sync
    // ---- بيع بالجملة (اختياري) — يوثّق وحدة البيع لحظة إصدار الفاتورة ----
    unitLabel?: string;         // اسم الوحدة المعروض، مثل "كارتون" أو undefined = مفرد
    unitConversionQty?: number; // معامل التحويل لوحدة الأساس وقت البيع (لضمان صحة الفاتورة تاريخياً)
    // ---- الضمان والسيريال (اختياري) — لقطة لحظة البيع ----
    // أرقام تسلسلية/IMEI للأجهزة المباعة في هذا السطر (قد تكون عدّة أجهزة بسطر واحد).
    serials?: string[];
    // مدة الضمان بالأشهر وقت البيع — تُخزَّن كلقطة فلا يتأثر بيع قديم بتغيير إعداد المنتج لاحقاً.
    warrantyMonths?: number;
  }>;
}

export interface Expense {
  id: string;
  title: string;
  amount: number;
  category: string;
  date: string;
  notes: string;
}

// تقفيل الصندوق اليومي — وثيقة واحدة لكل يوم /users/{owner}/cash_closings/{yyyy-mm-dd}.
// تُخزَّن كلقطة وقت الإقفال: المدخلات (رأس المال الافتتاحي + النقد المعدود) والأرقام المحسوبة
// آنذاك، حتى يبقى سجل اليوم ثابتاً للمراجعة ولا يتبدّل إن عُدِّلت فواتيره لاحقاً. id = تاريخ اليوم.
export interface CashClosing {
  id: string;            // = تاريخ اليوم 'yyyy-mm-dd' (مفتاح فريد لليوم — إعادة الإقفال تستبدل)
  date: string;          // 'yyyy-mm-dd'
  openingCash: number;   // رأس المال النقدي في الصندوق بداية اليوم (يُرحَّل من إقفال اليوم السابق)
  countedCash: number;   // النقد المعدود فعلياً في الصندوق نهاية اليوم (إدخال المالك)
  // ---- لقطة محسوبة وقت الإقفال (للأرشيف والنسخ الاحتياطي) ----
  expectedCash: number;  // المتوقع = الافتتاحي + الداخل − الخارج
  difference: number;    // المعدود − المتوقع (سالب = عجز، موجب = فائض)
  cashSales: number;     // نقد فواتير اليوم المحصّل
  debtCollected: number; // تسديدات ديون وردت اليوم (عن فواتير سابقة)
  manualRevenue: number; // إيرادات يدوية سُجّلت اليوم
  expenses: number;      // مصاريف اليوم
  // نقد خرج للموردين اليوم = المدفوع نقداً عند استلام فواتير الشراء + تسديدات الموردين.
  // اختياري: الإقفالات المحفوظة قبل إضافة نظام الموردين لا تحمله (تُعامَل كصفر).
  supplierPaid?: number;
  supplierCredit?: number; // شراء آجل اليوم (للعرض فقط — لم يخرج نقد من الصندوق)
  debtGiven: number;     // ديون مُنحت اليوم (للعرض فقط — ليست نقداً خرج من الصندوق)
  /**
   * الجانب غير النقدي لليوم (بطاقات/محافظ/تحويل) — لا يمسّ الدرج، لكن بدونه في الأرشيف
   * تستحيل مطابقة كشف البنك مع إقفالٍ قديم. اختياريان: الإقفالات المحفوظة قبلهما تُعامَل صفراً.
   */
  electronicIn?: number;
  electronicOut?: number;
  notes: string;
  closedAt: number;      // Date.now() لحظة الحفظ
  closedByName: string;  // اسم من أقفل الصندوق (المالك)
  // الفرع صاحب هذا الإقفال. غيابه = الفرع الرئيسي (كل الإقفالات السابقة).
  // ملاحظة: معرّف الوثيقة للفرع الرئيسي يبقى التاريخ وحده حفاظاً على الإقفالات المحفوظة،
  // ولبقية الفروع يصير «فرع_تاريخ» فلا تتضارب فروع في اليوم نفسه.
  branchId?: string;
}

// ---- خطة التقسيط ----
// 🔴 مبدأ التصميم: هذه الوثيقة **جدول مواعيد فقط** وليست دفتر ديون ثانياً.
// المال الحقيقي يبقى في مكانه الوحيد: invoice.remainingAmount + customer.balance + debt_payments.
// «كم دفع» و«كم بقي» تُشتقّ من تلك المصادر لا تُخزَّن هنا — فلا يوجد مصدرا حقيقة متعارضان.
export interface InstallmentPlan {
  id: string;
  customerId: string;
  customerName: string;      // لقطة للعرض التاريخي
  invoiceId: string;         // الفاتورة المصدر (مرجع المال الحقيقي)
  invoiceNumber: string;
  productSummary: string;    // وصف مختصر للمبيع (مثال: «ثلاجة») للعرض السريع
  totalAmount: number;       // إجمالي المبلغ المقسَّط (لا يشمل المقدَّم)
  downPayment: number;       // المقدَّم المدفوع لحظة البيع
  frequency: 'monthly' | 'weekly';
  schedule: InstallmentDue[]; // جدول الاستحقاقات المولَّد
  notes: string;
  status: 'active' | 'cancelled'; // مكتملة تُشتقّ من السداد لا تُخزَّن
  createdAt: number;
  createdByName: string;
}

export interface InstallmentDue {
  seq: number;       // رقم القسط (١، ٢، ٣...)
  dueDate: string;   // 'yyyy-mm-dd'
  amount: number;
}

// ---- الفروع (المرحلة ١: الأساس) ----
// معرّف الفرع الرئيسي ثابت ومعروف مسبقاً: كل البيانات القائمة (بلا branchId) تُعامل على أنها
// تخصّه، فلا يحتاج المستخدم الحالي أي ترحيل ولا يتغيّر عنده شيء إطلاقاً.
export const MAIN_BRANCH_ID = 'main';

/**
 * نوع الموقع:
 *  · 'shop'      محل يبيع — له صندوق نقد وفواتير وموظفون
 *  · 'warehouse' مخزن يخزّن فقط — لا صندوق ولا بيع مباشر منه (مخزن الطابق الثاني مثلاً)
 * غياب الحقل = 'shop' (توافق رجعي مع كل الفروع المُنشأة قبل هذا التمييز).
 */
export type BranchKind = 'shop' | 'warehouse';

export interface Branch {
  id: string;
  name: string;        // بغداد، البصرة، مخزن الطابق الثاني...
  address: string;
  phone: string;
  isMain: boolean;     // الفرع الرئيسي — لا يُحذف
  active: boolean;     // فرع مغلق يبقى في السجلات التاريخية لكنه لا يُختار للعمليات الجديدة
  createdAt: string;
  notes: string;
  kind?: BranchKind;   // غيابه = محل (السلوك القديم حرفياً)
}

/**
 * حركة نقل بضاعة بين موقعين (محل ⇄ مخزن، أو مخزن ⇄ مخزن).
 *
 * 🔴 المبدأ المحاسبي: البضاعة **لم تدخل ولم تخرج من الملك**، بل تحرّكت داخله.
 * لذلك ينقص رصيد الموقع المصدر ويزيد رصيد الوجهة بنفس المقدار، و**الإجمالي لا يُمَسّ إطلاقاً**
 * ⇒ قيمة المخزون والأرباح والتقارير لا تتأثّر بأي نقل داخلي.
 */
export interface StockTransferItem {
  productId: string;
  name: string;
  unit: string;
  quantity: number;     // بوحدة الأساس
  fromBefore: number;   // رصيد المصدر لحظة النقل (توثيق للمراجعة)
  toBefore: number;     // رصيد الوجهة لحظة النقل
}

export interface StockTransfer {
  id: string;
  transferNumber: string;
  fromBranchId: string;
  fromBranchName: string;
  toBranchId: string;
  toBranchName: string;
  items: StockTransferItem[];
  totalQuantity: number;
  date: string;         // YYYY-MM-DD محلي
  createdAt: string;    // ISO
  createdByUid: string;
  createdByName: string;
  notes: string;
  /**
   * رمز الجهاز الذي أنشأ النقل — حقل صامت لا يُعرض. هو إشارة تعدّد الأجهزة التي
   * يبدأ عندها وسم الأرقام، فلا يتصادم رقمان من جهازين مقطوعَين. (انظر transferNumber.ts)
   */
  deviceTag?: string;
  /** طرفا التراجع — النقل الخاطئ يُلغى بنقلٍ معاكس مربوط، لا بحذف. (utils/reversal.ts) */
  reversedById?: string;
  reversalOfId?: string;
}

export interface SystemSettings {
  currency: 'IQD' | 'USD';
  exchangeRate: number; // e.g. 1500 IQD per 1$
  lastBackupDate: string;
  // طابع زمني رقمي (ms) لآخر نسخة احتياطية — يستخدمه جدول النسخ التلقائي للمقارنة بدقّة
  // (lastBackupDate نصّي معرّب لا يصلح للحساب). غيابه = لم تؤخذ نسخة بعد.
  lastBackupAt?: number;
  /** صيغة طباعة الفاتورة المفردة: A4 أو إيصال حراري. غيابها = 'a4' (السلوك السابق حرفياً) */
  printFormat?: 'a4' | 'thermal80' | 'thermal58';
  /** تجاوز أيام تنبيه الصلاحية لكل فئة: { 'الأدوية': 180 }. ضبط واحد يخدم مئات المواد. */
  categoryExpiryAlertDays?: Record<string, number>;
  enabledModules: string[];
  notifyOnExpiry?: boolean;
  notifyOnLowStock?: boolean;
  notifyOnUnpaidDebts?: boolean;
  backupInterval?: 'daily' | 'weekly' | 'monthly' | 'manual';
  autoBackup?: boolean;
  // أصناف/وحدات مخصّصة يضيفها المستخدم — مصدر مركزي واحد تُحمَّل منه القوائم في كل مكان
  customCategories?: string[];
  customUnits?: string[];
  // طرق دفع إضافية يضيفها المالك (محفظة جديدة مثلاً) فوق القائمة الافتراضية
  customPaymentMethods?: string[];
}

// ============================================================
// الموردين — مصدر الشراء الخارجي للبضاعة
// ============================================================
export interface Supplier {
  id: string;
  name: string;
  phone: string;
  address: string;
  notes: string;
  // رصيد الدين الموجب: ما زِلت أدين له (للمحل). يُحدَّث آلياً من فواتير الشراء الآجلة
  // والتسديدات عبر increment آمن (بدون إعادة قراءة + كتابة). رصيد سالب = دفعت زيادة عن المستحق.
  balance: number;
  createdAt: string;
}

// دفعة مسددة لمورّد. تفصل عن دفعات الزبائن حتى لا تختلط الذمم.
export interface SupplierPayment {
  id: string;
  supplierId: string;
  supplierName: string;
  amount: number;
  date: string;
  notes: string;
  allocations: Array<{ invoiceId: string; amount: number }>;
  createdAt: number;
  createdByUid?: string;
  createdByName?: string;
  /**
   * 🔴 طريقة الدفع — كانت غائبة، وتقفيل الصندوق يعدّ **كل** تسديد نقداً خرج من الدرج
   * (تعليقه الحرفي: «نقد خرج فعلاً»). فالتحويل المصرفي يُخصم من الدرج وهو لم يمسّه،
   * فيظهر في التقفيل **فائضٌ وهمي** بقيمته. وجانب الزبائن يحمل الحقل ويُفصل به منذ زمن.
   * غيابه في البيانات القديمة = كاش، وهو الصحيح تاريخياً (لم يكن البرنامج يقبل غيره).
   */
  method?: string;
  /** الفرع الذي خرج منه المال — بدونه يُخصم تسديد المحل من صندوق المخزن أيضاً. */
  branchId?: string;
  /** طرفا التراجع — التسديد حدثٌ وقع، فيُختم ولا يُحذف. (utils/reversal.ts) */
  reversedById?: string;
  reversalOfId?: string;
}

// حالة فاتورة الشراء — للمالك فقط
export type PurchaseInvoiceStatus = 'draft' | 'received' | 'cancelled';

// فاتورة شراء (استلام بضاعة من مورد) — منفصلة عن فاتورة البيع تماماً.
// عند الحفظ بحالة received: يُضاف المخزون (increment) + تُحدَّث تكلفة المنتج (wholesaleBuyPrice إن وُجد
// + buyPrice) + يُسجَّل الرصيد على المورد إن كانت آجلة. كل العمليات في batch ذرّية واحدة.
export interface PurchaseInvoice {
  id: string;
  invoiceNumber: string;   // رقم متسلسل خاص بالشراء (مستقل عن أرقام البيع)
  supplierId: string;
  supplierName: string;    // نسخة نصية للعرض التاريخي (لو المورد انحذف)
  date: string;
  // إجمالي قبل الخصم/الضريبة
  subtotal: number;
  discount: number;        // خصم الفاتورة (مبلغ مطلق)
  tax: number;             // ضريبة الفاتورة (مبلغ مطلق)
  total: number;           // الصافي = subtotal - discount + tax
  paidAmount: number;      // المدفوع نقداً لحظة الاستلام
  remainingAmount: number; // الباقي على المورد (آجل). total - paidAmount
  // نوع الدفع اللحظي: cash = مدفوع كاملاً؛ credit = آجل بالكامل؛ partial = مزيج
  paymentType: 'cash' | 'credit' | 'partial';
  notes: string;
  status: PurchaseInvoiceStatus; // draft لم تُخصم من المخزون بعد؛ received نُفذت؛ cancelled مُلغاة (عُكس كل شيء)
  items: PurchaseInvoiceItem[];
  createdAt: number;       // Date.now()
  createdByUid?: string;   // مَن أنشأها (للسجل + audit)
  createdByName?: string;
  branchId?: string;       // الفرع المستلِم. غيابه = الفرع الرئيسي
  /** رمز الجهاز المُصدِر — حقل صامت، هو إشارة تعدّد الأجهزة التي يبدأ عندها وسم الأرقام. */
  deviceTag?: string;
}

export interface PurchaseInvoiceItem {
  productId?: string;      // إن وُجد يحدَّث المخزون/التكلفة. عدم وجوده = بند حر (مادة بلا منتج بعد)
  productName: string;     // snapshot للاسم لحظة الشراء (لو المنتج انحذف/تغيّر اسمه)
  quantity: number;        // بوحدة الأساس دائماً
  buyPrice: number;        // سعر شراء الوحدة (وحدة الأساس) — يُحدِّث buyPrice في product_costs
  wholesaleQty?: number;   // إذا وُجد: الشراء تم بوحدة الجملة بهذه الكمية (مثلاً 3 كراتين × 30)
  // تاريخ انتهاء هذه الشحنة (اختياري). يُسأل عنه فقط للمواد التي تعلّم البرنامج أنها
  // ذات صلاحية (tracksExpiry) — فلا يُستجوَب بائع الصوند عن تواريخ لا معنى لها.
  expiryDate?: string;
  wholesaleUnitPrice?: number; // سعر شراء وحدة الجملة (يُحدِّث wholesaleBuyPrice)
  total: number;           // quantity * buyPrice
  unitName?: string;       // اسم وحدة الأساس (مثال: "قطعة")
}

// تسوية المخزون — لأي تعديل غير بيع/شراء (تالف، انتهاء صلاحية، سرقة، جرد فعلي، هدية، إرجاع لمورّد)
// كل تسوية تخصم أو تضيف الكمية من المخزون الفعلي مع تبرير إلزامي.
export type StockAdjustmentType = 'damage' | 'expiry' | 'theft' | 'recount' | 'gift' | 'return_to_supplier' | 'other';
// damage = تالف، expiry = منتهي الصلاحية، theft = سرقة/فقدان، recount = جرد فعلي (الفرق بين الرقمي والفعلي)
// gift = هبة/عينة، return_to_supplier = مرتجع للمورّد، other = أسباب أخرى

export interface StockAdjustment {
  id: string;
  productId: string;
  productName: string;     // snapshot
  // الفارق الموقَّع: موجب = إضافة للمخزون (اكتُشف زيادة في الجرد)، سالب = خصم (نقص/تالف/سرقة)
  quantityDelta: number;
  quantityBefore: number;  // المخزون قبل التسوية (للمراجعة)
  quantityAfter: number;   // المخزون بعد التسوية (للمراجعة)
  type: StockAdjustmentType;
  reason: string;          // توضيح نصي إلزامي (لماذا تمت التسوية)
  date: string;            // yyyy-mm-dd
  createdAt: number;       // Date.now()
  createdByUid?: string;
  createdByName?: string;
  branchId?: string;       // الفرع الذي جرت فيه التسوية. غيابه = الرئيسي
  /**
   * طرفا التراجع — القيد لا يُحذف بل يُختم. (انظر utils/reversal.ts)
   * `reversedById`: القيد المضادّ الذي ألغى هذا. `reversalOfId`: القيد الذي جاء هذا ليُلغيه.
   * كلاهما يُستثنى من الإحصاءات ويبقى ظاهراً في السجل.
   */
  reversedById?: string;
  reversalOfId?: string;
}

/**
 * شحنة لها تاريخ انتهاء: /users/{owner}/expiry_batches/{id}
 *
 * 🔴 لا تحسب مخزوناً إطلاقاً. المخزون يبقى مصدره الوحيد (quantity / branchStock)،
 * وهذه الوثيقة **توثّق تاريخاً** فقط — فيستحيل ظهور رقمين متعارضين للبضاعة.
 * الكمية هنا «المستلَم في هذه الشحنة» لتقدير قيمة الخطر بالدينار ولتجهيز كمية الشطب.
 *
 * ولماذا شحنات لا تاريخ واحد للمنتج؟ لأن الواقع كذلك: حليب من شحنة آذار ينتهي في تشرين،
 * ومن شحنة أيار ينتهي في كانون. تاريخ واحد في المنتج يصير خطأً من أول استلام ثانٍ.
 */
export interface ExpiryBatch {
  id: string;
  productId: string;
  productName: string;    // لقطة للعرض التاريخي (المنتج قد يُحذف)
  expiryDate: string;     // yyyy-mm-dd
  receivedDate: string;   // yyyy-mm-dd — منه يُعرف عمر المادة فيُشتقّ حدّ التنبيه
  quantity: number;       // المستلَم في هذه الشحنة
  note: string;
  branchId?: string;      // الموقع الذي وصلت إليه. غيابه = الرئيسي
  purchaseInvoiceId?: string; // إن جاءت من فاتورة شراء
  /**
   * active = سارية · written_off = شُطبت كتالف منتهٍ · cancelled = أُلغيت فاتورة شرائها.
   * الثالثة ضرورية: بدونها تبقى الشحنة سارية بعد إلغاء الفاتورة، فتُنذر شاشة الصلاحية
   * عن بضاعة أُلغي استلامها وتعرض «شطب» لمخزونٍ غير موجود.
   */
  status: 'active' | 'written_off' | 'cancelled';
  writtenOffAdjustmentId?: string; // تسوية المخزون التي شطبتها — الأثر لا يضيع
  createdAt: number;
  createdByName?: string;
}

// سجل التدقيق — وثيقة واحدة لكل عملية مؤثرة (إنشاء/تعديل/حذف) على الكيانات الحساسة.
// نمط fire-and-forget مثل باقي الكتابات (لا يحجب الـ UI ولا يفشل العملية الأصلية).
export type AuditAction = 'create' | 'update' | 'delete' | 'cancel' | 'restore';
export type AuditEntity =
  | 'invoice' | 'customer' | 'product' | 'product_cost' | 'expense'
  | 'debt_payment' | 'cash_closing' | 'employee' | 'supplier'
  | 'supplier_payment' | 'purchase_invoice' | 'stock_adjustment' | 'settings' | 'profile'
  /**
   * 🟠 نوعان كانا ناقصين فتسرّبت عملياتهما إلى نوعين آخرين:
   * نقل البضاعة كان يُسجَّل `product` فيختلط بتعديلات المنتجات، والفروع `settings`.
   * فمرشِّح «القسم» لم يكن يستطيع عزلهما أصلاً.
   */
  | 'stock_transfer' | 'branch'
  /**
   * 🔴 توليد كود التفعيل — كان **العملية الوحيدة في البرنامج بلا أثر**، وهي أغلاها:
   * الكود مفتاحٌ يُباع. فمن وُلِّد؟ ومتى؟ ولمن سُلِّم؟ لا جواب. أُضيف الكيان ليصير للمفتاح سجلّ.
   */
  | 'activation_code';

export interface AuditLog {
  id: string;              // طابع زمني + عشوائية لتفادي التصادم
  action: AuditAction;     // نوع الإجراء
  entity: AuditEntity;     // الكيان
  entityId: string;        // معرّف الوثيقة المتأثرة
  summary: string;         // ملخص سهل القراءة (يظهر في القائمة مباشرة)
  // لقطة بيانات قبل/بعد (JSON.stringify) — اختيارية، تُملأ لعمليات update فقط لتسهيل التدقيق اللاحق
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  // مَن فعلها — المالك فقط (الموظف لا يصل لهذه المجموعة عبر القواعد)
  actorUid: string;
  actorName: string;
  createdAt: number;       // Date.now() — يُستخدم للترتيب الزمني
  // ربط اختياري بكيان أعلى (مثلاً: تعديل دفعة دين مرتبطة بالفاتورة X)
  relatedEntity?: AuditEntity;
  relatedEntityId?: string;
}
