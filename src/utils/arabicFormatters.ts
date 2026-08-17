/**
 * Helper to convert standard English numbers (0-9) to Arabic-Indic digits (٠-٩)
 */
export function toArabicDigits(value: number | string): string {
  const str = String(value);
  const map: Record<string, string> = {
    '0': '٠', '1': '١', '2': '٢', '3': '٣', '4': '٤',
    '5': '٥', '6': '٦', '7': '٧', '8': '٨', '9': '٩'
  };
  return str.replace(/[0-9]/g, (match) => map[match]);
}

interface NounForms {
  one: string;       // e.g. "مشترك واحد" or "يوم واحد" (Grammatically correct for 1)
  two: string;       // e.g. "مشتركان" or "يومين" or "عميلين" (Grammatically correct for 2)
  plural: string;    // e.g. "مشتركين" or "أعمام" or "عملاء" or "أيام" or "أدوية" (Grammatically correct for 3-10)
  singular: string;  // e.g. "مشتركاً" or "عميلاً" or "يوماً" or "دواءً" (Grammatically correct for 11+)
}

/**
 * Reusable Arabic pluralization formatter matching grammar rules:
 * - 1 -> "one" form
 * - 2 -> "two" form
 * - 3 to 10 -> count + "plural" form
 * - 11 to 99+ -> count + "singular" form (custom suffix)
 */
export function formatArabicNoun(count: number, forms: NounForms, hideCountForOneTwo: boolean = true): string {
  const absoluteCount = Math.abs(count);
  
  let result = '';
  if (absoluteCount === 1) {
    result = hideCountForOneTwo ? forms.one : `${absoluteCount} ${forms.one}`;
  } else if (absoluteCount === 2) {
    result = hideCountForOneTwo ? forms.two : `${absoluteCount} ${forms.two}`;
  } else if (absoluteCount >= 3 && absoluteCount <= 10) {
    result = `${absoluteCount} ${forms.plural}`;
  } else {
    result = `${absoluteCount} ${forms.singular}`;
  }

  // Convert the output English digits to Arabic-Indic digits
  return toArabicDigits(result);
}

/**
 * Predefined noun configurations for common entities in the application
 */
export const ARABIC_NOUNS = {
  subscriber: {
    one: "مشترك واحد",
    two: "مشتركين اثنين",
    plural: "مشتركين",
    singular: "مشتركاً"
  },
  customer: {
    one: "عميل واحد",
    two: "عميلين اثنين",
    plural: "عملاء",
    singular: "عميلاً"
  },
  alert: {
    one: "تنبيه واحد",
    two: "تنبيهين اثنين",
    plural: "تنبيهات",
    singular: "تنبيهاً"
  },
  day: {
    one: "يوم واحد",
    two: "يومين اثنين",
    plural: "أيام",
    singular: "يوماً"
  },
  category: {
    one: "فئة واحدة",
    two: "فئتين اثنتين",
    plural: "فئات",
    singular: "فئة"
  },
  product: {
    one: "منتج واحد",
    two: "منتجين اثنين",
    plural: "منتجات",
    singular: "منتجاً"
  },
  invoice: {
    one: "فاتورة واحدة",
    two: "فاتورتين اثنتين",
    plural: "فواتير",
    singular: "فاتورةً"
  },
  debt: {
    one: "دين واحد",
    two: "دينين اثنين",
    plural: "ديون",
    singular: "ديناً"
  },
  box: {
    one: "علبة واحدة",
    two: "علبتين اثنتين",
    plural: "علب",
    singular: "علبةً"
  }
};

/** يُعرَض بدل الرقم حين تكون القيمة غير صالحة — أصدق من طباعة «NaN د.ع». */
export const INVALID_AMOUNT = '—';

/**
 * عرض مبلغ **مخزَّن بالدينار** بالعملة المختارة.
 *
 * 🔴 علّتان خطيرتان كانتا هنا، ونجتا لأن الدالة تبدو تافهة:
 *
 *  ١) **فرع الدولار لم يكن يقسم على سعر الصرف إطلاقاً.** كان يستقبل `exchangeRate`
 *     ولا يمسّه، فيضع علامة `$` على مبلغ الدينار كما هو: ٥٥٠٬٠٠٠ د.ع تُعرَض
 *     «$٥٥٠٬٠٠٠.٠٠» بدل «$٣٦٦.٦٧». وهذه الدالة تُستدعى في ١٩٣ موضعاً عبر ٢١ ملفاً.
 *     ولم يشتكِ TypeScript لأن الوسيط غير المستعمل ليس خطأً عنده.
 *
 *     وطباعة الفواتير كانت تحوّل **صحيحاً** بمنسّقها الخاص — فكانت الشاشة تقول رقماً
 *     والورقة تقول آخر لنفس الفاتورة. أما ملصقات الباركود فكانت تُخطئ مثل الشاشة.
 *
 *  ٢) `NaN` كانت تُطبع «NaN د.ع» على الشاشة وعلى الورق. أي حقل تالف من استيراد قديم
 *     أو ترحيل ناقص يظهر هكذا أمام الزبون.
 *
 * ⚠️ سعر صرف غير منطقي (صفر أو سالب أو خارج الحدود) لا يسمح بمبلغ دولاري صادق —
 *   فنعرض الدينار الذي نعرفه يقيناً بدل رقمٍ مُختلَق.
 */
export function formatCurrency(amount: number, currency: 'IQD' | 'USD', exchangeRate: number = 1500): string {
  if (!Number.isFinite(amount)) return INVALID_AMOUNT;

  if (currency === 'USD' && isValidExchangeRate(exchangeRate)) {
    return `$${toArabicDigits((amount / exchangeRate).toFixed(2))}`;
  }
  // الدينار — وكذلك الدولار بسعر صرف غير صالح (نقول ما نعرفه لا ما نخمّنه)
  return `${toArabicDigits(Math.round(amount).toLocaleString('en-US'))} د.ع`;
}

/**
 * Returns formatted exchange rate string
 */
export function formatExchangeRate(rate: number): string {
  return `سعر الصرف اليوم: ${toArabicDigits(rate.toLocaleString())} د.ع / ١$`;
}

/**
 * حدود سعر الصرف — مصدر واحد للحقيقة تستخدمه كل الشاشات (الإعدادات والمصاريف).
 * كان التحقق سابقاً في المصاريف فقط (وبرسالة خاطئة)، وغائباً كلياً من الإعدادات،
 * فكان يمكن حفظ قيمة تكسر كل تحويلات الدولار.
 */
export const EXCHANGE_RATE_MIN = 500;
export const EXCHANGE_RATE_MAX = 10000;

export function isValidExchangeRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= EXCHANGE_RATE_MIN && rate <= EXCHANGE_RATE_MAX;
}

export const EXCHANGE_RATE_ERROR = `سعر الصرف غير منطقي — أدخل رقماً بين ${toArabicDigits(EXCHANGE_RATE_MIN)} و ${toArabicDigits(EXCHANGE_RATE_MAX)} د.ع`;

/**
 * تحويل كل الأرقام في نصّ إلى لاتينية — للبحث والمقارنة لا للعرض.
 *
 * 🔴 لماذا؟ أرقام الفواتير تُخزَّن عربية-هندية («٢٠٤٣»)، والتاجر يكتب رقم الوصل على
 * لوحة الأرقام فيخرج لاتينياً («2043»). المقارنة النصّية الخام لا تطابق بينهما، فيظنّ
 * التاجر أن الفاتورة ضاعت وهي أمامه. التطبيع على الطرفين يجعل الكتابتين تجدان الشيء نفسه.
 *
 * يشمل الأرقام العربية-الهندية (٠-٩) والفارسية (۰-۹) التي تصل أحياناً من النسخ واللصق.
 */
export function toLatinDigits(value: string | number): string {
  return String(value ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * تحويل نص مبلغ إلى رقم بشكل متسق عبر التطبيق:
 * يزيل الفواصل اللاتينية والعربية والمسافات، ويحوّل الأرقام العربية-الهندية (٠-٩) إلى لاتينية.
 * يُرجع NaN عند الفشل (على المستدعي التحقق) — يمنع تحوّل قيمة ملصوقة إلى صفر أو NaN صامت.
 */
export function parseAmount(value: string | number): number {
  if (typeof value === 'number') return value;
  // toLatinDigits يغطّي العربية-الهندية **والفارسية** معاً — النسخ واللصق من الهاتف
  // أو من رسالة واتساب يأتي أحياناً بالفارسية (۲۰۰۰۰)، وكان يُرفض كأنه نص لا رقم.
  const normalized = toLatinDigits(value)
    // 🔴 الفاصلة العشرية العربية `٫` (U+066B) وفاصلة الآلاف `٬` (U+066C) تخرجان من لوحة
    // المفاتيح العربية ومن النسخ واللصق. لم تكونا مُعالَجتين، فـ«١٫٥» تُنتج NaN — والحقل
    // الذي يترجم NaN إلى صفر يبتلع نصف كيلو أو نصف دينار بصمت. تُطبَّعان قبل التجريد.
    .replace(/٬/g, '')
    .replace(/٫/g, '.')
    .replace(/[,،\s]/g, '')
    .trim();
  if (!normalized) return NaN;
  return Number(normalized);
}
