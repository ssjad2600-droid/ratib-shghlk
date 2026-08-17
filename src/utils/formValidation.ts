import { toArabicDigits } from './arabicFormatters';

/**
 * رسائل تحقّق النماذج بالعربية — موضعٌ واحد لكل حقول البرنامج.
 *
 * 🟡 العلّة: ٢٦ حقلاً بـ`required` في تسع شاشات، ولا موضع واحد يضبط الرسالة. فالتاجر
 * العراقي يترك خانةً فارغة في **فاتورة أو تسديد دين** فيرى فقاعة المتصفح تقول:
 *
 *     Please fill out this field
 *
 * في برنامجٍ كلّه عربي RTL. وأثره يوميّ لا نادر: يظهر في الفواتير والزبائن والديون
 * والمصاريف والمنتجات وتسجيل الدخول — أكثر الشاشات استعمالاً.
 *
 * 🎯 ولماذا مستمعٌ واحد لا ٢٦ تعديلاً؟
 *
 * حدث `invalid` **لا يصعد** (لا يطفو كباقي الأحداث)، لكنه **يمرّ في طور الالتقاط**.
 * فمستمعٌ واحد على `document` بـ`capture: true` يلتقط كل حقول التطبيق — الحالية
 * والتي تُضاف غداً. والبديل (سطران في كل حقل) يعني ٥٢ تعديلاً، وأولُ حقلٍ يُنسى
 * يُعيد الإنجليزية.
 *
 * ⚠️ ومزلقٌ لا بدّ من تفاديه: `setCustomValidity(msg)` تجعل الحقل **باطلاً إلى الأبد**
 * حتى يُمسح النصّ صراحةً. فبلا مسحٍ عند الكتابة يصير النموذج غير قابل للإرسال أبداً
 * ولو صحّح المستخدم كل شيء. لذلك نمسحه على `input` و`change` معاً.
 */

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const isField = (el: EventTarget | null): el is Field =>
  el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;

/** رقم بالعربية داخل الرسالة — البرنامج كلّه يعرض أرقامه هكذا. */
const n = (v: string | number) => toArabicDigits(String(v));

/**
 * الرسالة المناسبة لحالة البطلان. مصدَّرة ونقيّة كي تُختبر بلا متصفّح.
 */
export function validationMessage(el: {
  validity: ValidityState;
  type?: string;
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
  title?: string;
}): string {
  const v = el.validity;

  if (v.valueMissing) {
    if (el.type === 'checkbox' || el.type === 'radio') return 'يرجى اختيار أحد الخيارات';
    if (el.type === 'file') return 'يرجى اختيار ملف';
    return 'هذا الحقل مطلوب';
  }
  if (v.typeMismatch) {
    if (el.type === 'email') return 'صيغة البريد الإلكتروني غير صحيحة — مثال: name@example.com';
    if (el.type === 'url') return 'صيغة الرابط غير صحيحة';
    return 'القيمة المُدخَلة غير صالحة';
  }
  if (v.tooShort && el.minLength) return `قصير جداً — المطلوب ${n(el.minLength)} محرفاً على الأقل`;
  if (v.tooLong && el.maxLength) return `طويل جداً — الحدّ ${n(el.maxLength)} محرفاً`;
  if (v.rangeUnderflow && el.min !== undefined) return `القيمة صغيرة جداً — الحدّ الأدنى ${n(el.min)}`;
  if (v.rangeOverflow && el.max !== undefined) return `القيمة كبيرة جداً — الحدّ الأعلى ${n(el.max)}`;
  if (v.stepMismatch) return 'القيمة غير مقبولة — راجع الخطوة المسموحة';
  // `title` هو ما يكتبه المطوّر لشرح النمط المطلوب — أدقّ من أي رسالة عامة
  if (v.patternMismatch) return el.title?.trim() || 'الصيغة غير مطابقة للمطلوب';
  if (v.badInput) return 'القيمة المُدخَلة غير مفهومة — اكتب رقماً صحيحاً';

  return 'القيمة المُدخَلة غير صالحة';
}

/**
 * يُركّب المستمعات. يُستدعى مرة واحدة عند إقلاع التطبيق، ويُرجع دالة إزالة.
 */
export function installArabicValidation(doc: Document = document): () => void {
  const onInvalid = (e: Event) => {
    const el = e.target;
    if (!isField(el)) return;
    // نمسح أولاً كي تُعاد حسبة الصلاحية من الحالة الحقيقية لا من رسالة سابقة عالقة
    el.setCustomValidity('');
    if (el.validity.valid) return;
    el.setCustomValidity(validationMessage(el));
  };

  /**
   * المسح عند أول تعديل — بدونه يبقى الحقل باطلاً إلى الأبد ولا يُرسَل النموذج.
   * ونستمع لـ`change` أيضاً من أجل `select` و`file` اللذين لا يُطلقان `input` دائماً.
   */
  const onEdit = (e: Event) => {
    const el = e.target;
    if (isField(el) && el.validationMessage) el.setCustomValidity('');
  };

  doc.addEventListener('invalid', onInvalid, true);  // ⚠️ الالتقاط: حدث invalid لا يصعد
  doc.addEventListener('input', onEdit, true);
  doc.addEventListener('change', onEdit, true);

  return () => {
    doc.removeEventListener('invalid', onInvalid, true);
    doc.removeEventListener('input', onEdit, true);
    doc.removeEventListener('change', onEdit, true);
  };
}
