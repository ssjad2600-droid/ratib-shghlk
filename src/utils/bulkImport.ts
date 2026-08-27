import { csvNumber } from './csv';
import { toLatinDigits } from './arabicFormatters';
import { stableId } from './stableId';
import { Product, Customer } from '../types';
import { todayISO } from './dateLocal';

/**
 * التحقق من صفوف الاستيراد الجماعي قبل كتابة أي وثيقة.
 * المبدأ: **لا يُكتب شيء حتى يوافق المالك على المعاينة**. كل صف يُصنَّف: جديد / تحديث / خطأ،
 * مع سبب واضح لكل خطأ — فلا يدخل صف فاسد بصمت ولا يُستبدل منتج قائم دون علم.
 */

export type RowAction = 'create' | 'update' | 'error';

export interface ParsedRow<T> {
  line: number;        // رقم السطر في الملف (للمستخدم)
  action: RowAction;
  errors: string[];
  data?: T;            // الوثيقة الجاهزة (عند create/update)
  existingId?: string; // معرّف الوثيقة القائمة (عند update)
  label: string;       // اسم للعرض في المعاينة
  cost?: number;       // سعر الشراء (يُكتب في product_costs — منفصل)
  wholesaleCost?: number;
}

/** يقرأ خانة بأي من الأسماء المرادفة (عربي/إنجليزي) — يتسامح مع اختلاف صياغة الترويسة. */
const pick = (row: Record<string, string>, aliases: string[]): string => {
  for (const key of Object.keys(row)) {
    const k = key.trim().toLowerCase().replace(/\s+/g, ' ');
    if (aliases.some(a => a.toLowerCase() === k)) return (row[key] ?? '').trim();
  }
  return '';
};

/**
 * هل هذا هو الصفّ النموذجي المرفق بالقالب؟
 *
 * 🔴 العلّة: القالب يُنزَّل ومعه صفٌّ نموذجي ليُري التاجر الشكل المطلوب. ومن
 * يملأ صفوفه **تحته** ولا ينتبه لحذفه كان يستورد «حليب نيدو ٩٠٠غ» منتجاً
 * حقيقياً بكمية ٥٠ وسعر ١٢٬٥٠٠ — قُيس فعلاً فصُنّف «جديد» بلا أي تنبيه.
 * ولا شيء في الشاشة كان يقول له «احذفه».
 *
 * والمطابقة على **حقلين** لا حقل: الاسم والمعرّف (باركود أو هاتف) معاً. فمحلٌّ
 * يبيع حليب نيدو فعلاً لن يُتخطّى صفّه إلا لو حمل أيضاً الباركود الوهمي نفسه.
 *
 * 🔴 وشرطٌ ثالث عند الاستدعاء: **الصفّ الأول وحده**. كشف اختبارٌ قائم أن قيم
 * نموذج الزبائن («محمد الأمير» و«٠٧٧٠١٢٣٤٥٦٧») واقعيةٌ تماماً — بخلاف باركود
 * المنتجات الوهمي — فزبونٌ حقيقي بهذا الاسم والهاتف كان سيُبتلع بصمت. والنموذج
 * يقع في أول صفٍّ من القالب دائماً، فحصرُ الفحص فيه يُغلق الباب.
 */
const isTemplateSample = (a: string, b: string, sample: readonly string[]): boolean =>
  a.trim() === sample[0].trim() && b.trim() === sample[1].trim();

/**
 * صيغة علمية — أثرُ Excel على الباركود.
 *
 * 🔴 يفتح التاجر القالب في Excel فيرى عمود الباركود رقماً لا نصّاً، ويحوّل
 * الأكواد الطويلة (١٣ خانة) إلى `6.29101E+12`. ثم يُستورَد الكود المشوَّه
 * **بصمت** (قُيس)، فيخرج منتجٌ لن يجده مسدس الباركود أبداً — والتاجر لا يعرف
 * لماذا. رفضُه هنا برسالةٍ تشرح العلاج خيرٌ من منتجٍ معطوبٍ في المخزن.
 *
 * ⚠️ ونرفض هذه الصيغة وحدها لا كل كودٍ فيه حروف: بعض المحال تستعمل أكواداً
 * داخلية مثل «A-125»، ومنعُها يمنع استيراداً مشروعاً.
 */
const looksMangledByExcel = (code: string): boolean =>
  /[eE][+-]?\d+$/.test(code) || code.includes('.');

export const BARCODE_MANGLED_ERROR =
  'الباركود مشوَّه (حوّله Excel إلى صيغة علمية) — نسّق عمود الباركود كـ«نص» في Excel ثم احفظ';

// ================= المنتجات =================

export const PRODUCT_HEADERS = [
  'اسم المنتج', 'الباركود', 'التصنيف', 'الوحدة', 'سعر الشراء', 'سعر البيع',
  'الكمية', 'حد النفاد', 'اسم وحدة الجملة', 'عدد القطع بالوحدة', 'سعر بيع الجملة', 'سعر شراء الجملة', 'ضمان بالأشهر',
];

export const PRODUCT_SAMPLE_ROW = [
  'حليب نيدو ٩٠٠غ', '1122334455', 'ألبان وأجبان', 'قطعة', '10000', '12500',
  '50', '5', 'كارتون', '12', '140000', '115000', '',
];

/**
 * أعمدة الجدول الذي يُملأ **داخل البرنامج** — لا ملف ولا تنزيل.
 *
 * 🔴 لماذا لا نعرض الثلاثة عشر عموداً كلها؟ لأن الشاشة تصير جدول Excel ثانياً،
 * وهذا نقيض المقصود. المطلوب فعلاً حقلان (الاسم وسعر البيع)، وهذه السبعة تغطّي
 * ما يكتبه صاحب المحل يومياً. أمّا أعمدة الجملة والضمان فتبقى في مسار الملف
 * لمن يحتاجها — وهي حالةٌ نادرة تستحقّ خطوةً إضافية، لا أن تُثقل الحالة الشائعة.
 *
 * ⚠️ و`header` هنا **نفس نصّ عمود القالب حرفياً**، لأنه المفتاح الذي يقرأ به
 * `parseProductRows`. مصدرٌ واحد للاسمين، فلا ينحرف الجدول عن الملف يوماً.
 */
export interface GridColumn {
  header: string;
  label: string;
  kind: 'text' | 'number';
  required?: boolean;
  hint?: string;
  /** عرض العمود — الاسم يأخذ المتبقّي والباقي ثابت */
  width: string;
}

export const PRODUCT_GRID: GridColumn[] = [
  { header: 'اسم المنتج', label: 'اسم المنتج', kind: 'text', required: true, hint: 'مثال: حليب نيدو ٩٠٠غ', width: 'min-w-[170px] flex-1' },
  { header: 'سعر الشراء', label: 'شراء', kind: 'number', hint: '١٠٠٠٠', width: 'w-[110px]' },
  { header: 'سعر البيع', label: 'بيع', kind: 'number', required: true, hint: '١٢٥٠٠', width: 'w-[110px]' },
  { header: 'الكمية', label: 'الكمية', kind: 'number', hint: '٥٠', width: 'w-[84px]' },
  { header: 'الوحدة', label: 'الوحدة', kind: 'text', hint: 'قطعة', width: 'w-[92px]' },
  { header: 'التصنيف', label: 'التصنيف', kind: 'text', hint: 'ألبان', width: 'w-[110px]' },
  { header: 'الباركود', label: 'الباركود', kind: 'text', hint: 'اختياري', width: 'w-[128px]' },
];

export function parseProductRows(
  rows: Array<Record<string, string>>,
  existing: Product[],
): ParsedRow<Product>[] {
  const byBarcode = new Map<string, Product>();
  const byName = new Map<string, Product>();
  for (const p of existing) {
    if (p.barcode?.trim()) byBarcode.set(p.barcode.trim(), p);
    byName.set(p.name.trim().toLowerCase(), p);
  }
  const seenInFile = new Set<string>();

  // 🔴 `map` ثم `filter` — لا حذفٌ قبل الترقيم. الأسطر مرقَّمة من `idx`، فإسقاط
  // الصفّ النموذجي أولاً يُزحزح الأرقام كلها فتُشير رسائل الخطأ إلى السطر الخطأ.
  const parsed = rows.map((row, idx): ParsedRow<Product> | null => {
    const line = idx + 2; // +1 للترويسة و+1 لأن الترقيم يبدأ من ١
    const errors: string[] = [];

    const name = pick(row, ['اسم المنتج', 'الاسم', 'المنتج', 'name', 'product']);
    const barcode = pick(row, ['الباركود', 'باركود', 'barcode']);

    // الصفّ النموذجي المرفق بالقالب: يُتخطّى بلا استيرادٍ وبلا خطأ — الأول وحده
    if (idx === 0 && isTemplateSample(name, barcode, PRODUCT_SAMPLE_ROW)) return null;
    const category = pick(row, ['التصنيف', 'الصنف', 'الفئة', 'category']);
    const unit = pick(row, ['الوحدة', 'وحدة القياس', 'unit']);
    const buy = csvNumber(pick(row, ['سعر الشراء', 'الشراء', 'التكلفة', 'buyprice', 'cost']));
    const sell = csvNumber(pick(row, ['سعر البيع', 'البيع', 'السعر', 'sellprice', 'price']));
    const qty = csvNumber(pick(row, ['الكمية', 'المخزون', 'quantity', 'qty', 'stock']));
    const low = csvNumber(pick(row, ['حد النفاد', 'حد الأمان', 'الحد الأدنى', 'lowstock']));
    const wsName = pick(row, ['اسم وحدة الجملة', 'وحدة الجملة', 'wholesaleunit']);
    const wsQty = csvNumber(pick(row, ['عدد القطع بالوحدة', 'عدد القطع', 'wholesaleqty']));
    const wsPrice = csvNumber(pick(row, ['سعر بيع الجملة', 'سعر الجملة', 'wholesaleprice']));
    const wsBuy = csvNumber(pick(row, ['سعر شراء الجملة', 'شراء الجملة', 'wholesalebuyprice']));
    const warranty = csvNumber(pick(row, ['ضمان بالأشهر', 'الضمان', 'warranty']));

    if (!name) errors.push('اسم المنتج مطلوب');
    if (barcode && looksMangledByExcel(barcode)) errors.push(BARCODE_MANGLED_ERROR);
    if (sell === null) errors.push('سعر البيع مطلوب');
    else if (sell < 0) errors.push('سعر البيع سالب');
    if (buy !== null && buy < 0) errors.push('سعر الشراء سالب');
    if (qty !== null && qty < 0) errors.push('الكمية سالبة');

    // تكرار داخل نفس الملف
    const fileKey = (barcode || name).toLowerCase();
    if (fileKey && seenInFile.has(fileKey)) errors.push('مكرر داخل الملف نفسه');
    if (fileKey) seenInFile.add(fileKey);

    // مطابقة القائم: بالباركود أولاً (الأدقّ) ثم بالاسم
    const match = (barcode && byBarcode.get(barcode)) || byName.get(name.trim().toLowerCase());

    if (errors.length) {
      return { line, action: 'error' as const, errors, label: name || `سطر ${line}` };
    }

    const doc: Product = {
      // معرّف مشتقّ من الباركود (أو الاسم) — فإعادة استيراد نفس الملف تصحّح ولا تُكرّر
      id: match?.id ?? stableId('prod', barcode.trim() || name.trim()),
      name: name.trim(),
      barcode: barcode.trim(),
      sellPrice: sell!,
      quantity: qty ?? match?.quantity ?? 0,
      lowStockThreshold: low ?? match?.lowStockThreshold ?? 5,
      category: category || match?.category || '',
      unit: unit || match?.unit || '',
      // 🔴 كان toISOString أي تاريخ UTC — استيرادٌ ليلاً يختم بتاريخ الأمس (utils/dateLocal)
      createdAt: match?.createdAt ?? todayISO(),
      hasWholesale: !!(wsName && wsQty && wsQty > 0),
    };
    if (doc.hasWholesale) {
      doc.wholesaleUnitName = wsName;
      doc.wholesaleUnitQty = wsQty!;
      doc.wholesalePrice = wsPrice ?? 0;
    }
    if (warranty !== null && warranty > 0) doc.defaultWarrantyMonths = warranty;

    return {
      line,
      action: match ? ('update' as const) : ('create' as const),
      errors: [],
      data: doc,
      existingId: match?.id,
      label: doc.name,
      cost: buy ?? undefined,
      wholesaleCost: wsBuy ?? undefined,
    };
  });
  return parsed.filter((r): r is ParsedRow<Product> => r !== null);
}

// ================= الزبائن =================

/**
 * 🔴 مفتاح مطابقة الهاتف — أخطر سطر في الاستيراد الجماعي.
 *
 * كان `phone.replace(/\D/g, '')`، و`\D` تعني «كل ما ليس رقماً **لاتينياً**». والبرنامج
 * يخزّن الهواتف بأرقام عربية (`toArabicDigits` عند الحفظ)، فكان هاتف «٠٧٧١٢٣٤٥٦٧٨»
 * يصير مفتاحاً **فارغاً**. فيتكدّس كل الزبائن على مفتاح واحد ولا يبقى في الخريطة إلا
 * آخرهم، ثم يُطابَق أي صف بهاتف عربي مع ذلك الزبون العشوائي فيُصنَّف «تحديث» —
 * فتُكتب بيانات صفٍّ غريب فوق سجل زبون لا علاقة له به.
 *
 * التطبيع الآن يحوّل العربية والفارسية إلى لاتينية **قبل** تجريد غير الأرقام.
 */
const phoneKey = (phone?: string): string => toLatinDigits(phone ?? '').replace(/[^0-9]/g, '');

export const CUSTOMER_HEADERS = ['اسم الزبون', 'الهاتف', 'العنوان', 'الرصيد (دين عليه)', 'تاريخ الاستحقاق', 'ملاحظات'];
export const CUSTOMER_SAMPLE_ROW = ['محمد الأمير', '07701234567', 'بغداد - الكرادة', '0', '', 'زبون دائم'];

/** أعمدة جدول الزبائن داخل البرنامج — تاريخ الاستحقاق يبقى في مسار الملف. */
export const CUSTOMER_GRID: GridColumn[] = [
  { header: 'اسم الزبون', label: 'اسم الزبون', kind: 'text', required: true, hint: 'مثال: محمد الأمير', width: 'min-w-[160px] flex-1' },
  { header: 'الهاتف', label: 'الهاتف', kind: 'text', hint: '٠٧٧٠١٢٣٤٥٦٧', width: 'w-[140px]' },
  { header: 'العنوان', label: 'العنوان', kind: 'text', hint: 'بغداد - الكرادة', width: 'min-w-[140px] flex-1' },
  { header: 'الرصيد (دين عليه)', label: 'دين سابق', kind: 'number', hint: '٠', width: 'w-[110px]' },
  { header: 'ملاحظات', label: 'ملاحظات', kind: 'text', hint: 'اختياري', width: 'w-[130px]' },
];

export function parseCustomerRows(
  rows: Array<Record<string, string>>,
  existing: Customer[],
): ParsedRow<Customer>[] {
  const byPhone = new Map<string, Customer>();
  const byName = new Map<string, Customer>();
  for (const c of existing) {
    const key = phoneKey(c.phone);
    if (key) byPhone.set(key, c);
    byName.set(c.name.trim().toLowerCase(), c);
  }
  const seenInFile = new Set<string>();

  // نفس ترتيب المنتجات: الترقيم أولاً ثم الإسقاط، لئلا تنزلق أرقام الأسطر
  const parsed = rows.map((row, idx): ParsedRow<Customer> | null => {
    const line = idx + 2;
    const errors: string[] = [];

    const name = pick(row, ['اسم الزبون', 'الاسم', 'الزبون', 'العميل', 'name', 'customer']);
    const phone = pick(row, ['الهاتف', 'رقم الهاتف', 'الموبايل', 'phone', 'mobile']);
    const address = pick(row, ['العنوان', 'address']);
    const balance = csvNumber(pick(row, ['الرصيد (دين عليه)', 'الرصيد', 'الدين', 'balance', 'debt']));
    const dueDate = pick(row, ['تاريخ الاستحقاق', 'الاستحقاق', 'duedate']);
    const notes = pick(row, ['ملاحظات', 'ملاحظة', 'notes']);

    // الصفّ النموذجي المرفق بقالب الزبائن — الأول وحده، فقيمه واقعية
    if (idx === 0 && isTemplateSample(name, phone, CUSTOMER_SAMPLE_ROW)) return null;

    if (!name) errors.push('اسم الزبون مطلوب');
    if (balance !== null && balance < 0) errors.push('الرصيد سالب (استخدم صفراً أو موجباً)');

    const rowKey = phoneKey(phone);
    const fileKey = (rowKey || name).toLowerCase();
    if (fileKey && seenInFile.has(fileKey)) errors.push('مكرر داخل الملف نفسه');
    if (fileKey) seenInFile.add(fileKey);

    const match = (rowKey ? byPhone.get(rowKey) : undefined) || byName.get(name.trim().toLowerCase());

    if (errors.length) {
      return { line, action: 'error' as const, errors, label: name || `سطر ${line}` };
    }

    const doc: Customer = {
      // معرّف مشتقّ من الهاتف (أو الاسم) — فإعادة استيراد نفس الملف تصحّح ولا تُكرّر
      id: match?.id ?? stableId('cust', rowKey || name.trim()),
      name: name.trim(),
      phone: phone.trim() || match?.phone || '',
      address: address || match?.address || '',
      notes: notes || match?.notes || '',
      // 🔴 الرصيد لا يُلمس عند التحديث — قد تكون عليه ديون فعلية من فواتير قائمة
      balance: match ? match.balance : (balance ?? 0),
      dueDate: dueDate || match?.dueDate || '',
      // 🔴 كان toISOString أي تاريخ UTC — استيرادٌ ليلاً يختم بتاريخ الأمس (utils/dateLocal)
      createdAt: match?.createdAt ?? todayISO(),
    };

    return {
      line,
      action: match ? ('update' as const) : ('create' as const),
      errors: [],
      data: doc,
      existingId: match?.id,
      label: doc.name,
    };
  });
  return parsed.filter((r): r is ParsedRow<Customer> => r !== null);
}
