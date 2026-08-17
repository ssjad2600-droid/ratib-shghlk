/**
 * ترقيم فواتير المالك — منع الرقم المكرَّر بين جهازين.
 *
 * 🔴 العلّة: الرقم التالي يُحسب من **الفواتير الموجودة في ذاكرة هذا الجهاز**. فلو فتح
 * جهازان فاتورةً في اللحظة نفسها، رأى كلاهما آخر رقم ٢٠٤٣ وحجز كلاهما ٢٠٤٤ — فاتورتان
 * مختلفتان برقم واحد. وبلا إنترنت تتكرّر عشرات الأرقام دفعة واحدة.
 * والألم يأتي متأخراً: الزبون يقول «وصلي رقم ٢٠٤٤» فيجد التاجر وصلين بمبلغين مختلفين.
 *
 * الحلّ طبقتان:
 *
 *  ١) **لاحقة جهاز تلقائية.** كل جهاز يحمل رمزاً ثابتاً، ويوسم به فواتيره. ما دام في
 *     البيانات جهاز واحد، تبقى الأرقام كما هي حرفياً — والتاجر ذو الجهاز الواحد (وهو
 *     الأغلب) لا يرى أي تغيير أبداً. فإذا ظهر في البيانات جهاز ثانٍ، بدأ **كلا الجهازين**
 *     بإلحاق رمزه: ٢٠٤٤/٧٣ و ٢٠٤٤/١٦ — فلا تصادم ولو كانا مقطوعَين عن الإنترنت أسبوعاً.
 *     تشغيل ذاتي بلا إعداد؛ التاجر لا يضبط شيئاً ولا يعرف أصلاً أن هناك ما يُضبط.
 *
 *  ٢) **تسلسل حرّ بالبناء.** الرقم = أعلى تسلسل مستعمل + ١، فلا يمكن أن يكون محجوزاً
 *     على هذا الجهاز مهما تعدّدت التبويبات.
 *
 * وما لا يمكن منعه (تكرار حدث قبل هذا الإصلاح) **يُكشف** بـ `duplicateNumbers` بدل أن
 * يُترك ليتفجّر يوم الخلاف.
 *
 * ⚠️ فواتير الموظفين خارج هذا كله — لها ترقيمها الخاص `بادئة-تسلسل` المشتقّ من uid
 *   الموظف، وهو محصّن أصلاً. لا نمسّه ولا ندخله في تسلسل المالك.
 */

/** فاصل رمز الجهاز. يختلف عن `-` عمداً كي لا يلتبس بترقيم الموظفين (`٤٣٨٢-٧`). */
export const DEVICE_SEP = '/';

/** أول رقم فاتورة للمحل الجديد. يبقى كما كان — لا يُغيَّر لئلا تختلف أرقام حساب قائم. */
export const FIRST_SEQ = 1001;

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** أرقام عربية-هندية/فارسية → لاتينية (نسخة محلية: هذا الملف نقيّ بلا اعتماديات واجهة). */
const latin = (v: string | number): string =>
  String(v ?? '')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0));

const arabic = (v: string | number): string =>
  String(v ?? '').replace(/[0-9]/g, d => AR_DIGITS[Number(d)]);

/** هل هذا رقم فاتورة موظف؟ (صيغته `بادئة-تسلسل`) */
export const isEmployeeNumber = (invoiceNumber: string): boolean =>
  latin(invoiceNumber).includes('-');

/**
 * التسلسل داخل رقم فاتورة المالك — يقبل `٢٠٤٤` و `٢٠٤٤/٧٣` معاً.
 * يُرجع null لأرقام الموظفين وللمُدخلات التالفة، فلا تتسرّب إلى تسلسل المالك.
 */
export function ownerSeqOf(invoiceNumber: string): number | null {
  const raw = latin(invoiceNumber).trim();
  if (!raw || raw.includes('-')) return null;
  const seqPart = raw.split(DEVICE_SEP)[0];
  if (!/^\d+$/.test(seqPart)) return null;
  const n = parseInt(seqPart, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** رمز الجهاز داخل الرقم، أو '' إن لم يكن موسوماً. */
export function deviceTagOf(invoiceNumber: string): string {
  const raw = latin(invoiceNumber).trim();
  if (!raw || raw.includes('-')) return '';
  const parts = raw.split(DEVICE_SEP);
  return parts.length > 1 ? parts[1] : '';
}

/** كل فاتورة تحمل رمز الجهاز الذي أصدرها كحقل صامت — هو إشارة التعدّد، لا شكل الرقم. */
type NumberedInvoice = { invoiceNumber: string; deviceTag?: string };

/**
 * هل يجب أن يوسم هذا الجهاز أرقامه؟
 *
 * ⚠️ الإشارة **حقل `deviceTag` على الفاتورة**، لا الرمز داخل الرقم. ولهذا سبب دقيق:
 * لو انتظر كل جهاز أن يرى رقماً موسوماً، لما وسم أحدٌ أولاً — الجهاز الأول لا يوسم،
 * فيأتي الثاني ولا يرى وسماً فلا يوسم هو أيضاً، فيصطدمان. أما الحقل فيُكتب دائماً
 * وبصمت، فيعرف كل جهاز بوجود الآخر من أول فاتورة، ويبدأ الوسم كلاهما معاً.
 *
 * والنتيجة: صاحب الجهاز الواحد لا يرى تغييراً في أرقامه أبداً.
 */
export function shouldTagDevice(invoices: NumberedInvoice[], myTag: string): boolean {
  if (!myTag) return false;
  for (const inv of invoices) {
    // جهاز آخر أصدر هذه الفاتورة
    if (inv.deviceTag && inv.deviceTag !== myTag) return true;
    // أو رقمها موسوم برمز غير رمزي (بيانات وُسمت قبل إضافة الحقل)
    const embedded = deviceTagOf(inv.invoiceNumber);
    if (embedded && embedded !== myTag) return true;
  }
  return false;
}

/** كل أرقام المالك المستعملة (لاتينية، للمقارنة) — لضمان ألّا يُسلَّم رقم محجوز. */
export function takenOwnerNumbers(invoices: NumberedInvoice[]): Set<string> {
  const set = new Set<string>();
  for (const inv of invoices) {
    const raw = latin(inv.invoiceNumber).trim();
    if (raw && !raw.includes('-')) set.add(raw);
  }
  return set;
}

/** أعلى تسلسل مستعمل + ١، وأدناه `FIRST_SEQ + 1` كما كان السلوك القديم تماماً. */
export function nextOwnerSeq(invoices: NumberedInvoice[]): number {
  let max = FIRST_SEQ;
  for (const inv of invoices) {
    const seq = ownerSeqOf(inv.invoiceNumber);
    if (seq !== null && seq > max) max = seq;
  }
  return max + 1;
}

/** يبني الرقم النهائي بالأرقام العربية — كما تُخزَّن وتُطبع. */
export const formatOwnerNumber = (seq: number, tag = ''): string =>
  tag ? `${arabic(seq)}${DEVICE_SEP}${arabic(tag)}` : arabic(seq);

/**
 * الرقم التالي — حرٌّ دائماً على الجهاز الواحد، ومفصول عن بقية الأجهزة برمز الجهاز.
 *
 * حريّته على هذا الجهاز مضمونة بالبناء: `nextOwnerSeq` يُرجع **أعلى تسلسل + ١**، فلا
 * يمكن أن يكون محجوزاً. (جرّبتُ إضافة فحصٍ صريح للأرقام المحجوزة فوق ذلك، فتبيّن أنه
 * فرعٌ لا يُبلَغ أبداً — وحذفُه أصدق من إبقاء كودٍ يوهم بحماية لا تعمل.)
 *
 * أمّا الجهاز الآخر فلا يحميه هذا، لأنه لا يرى فواتير اليوم وهو مقطوع — ولذلك وُجد
 * رمز الجهاز: يفصل مساحتَي الترقيم فصلاً تامّاً مهما طال الانقطاع.
 */
export function allocateOwnerNumber(invoices: NumberedInvoice[], myTag = ''): string {
  const tag = shouldTagDevice(invoices, myTag) ? myTag : '';
  return formatOwnerNumber(nextOwnerSeq(invoices), tag);
}

/**
 * الأرقام المكرّرة الموجودة **فعلاً** في البيانات.
 *
 * التكرار الذي وقع قبل هذا الإصلاح لا يمكن منعه بأثر رجعي، لكن السكوت عنه أسوأ من
 * وجوده: التاجر يكتشفه يوم يجادله زبون. فنُظهره له وهو مطمئن ليصحّحه بنفسه.
 */
export function duplicateNumbers(
  invoices: Array<NumberedInvoice & { id?: string }>,
): Array<{ number: string; count: number }> {
  const counts = new Map<string, { display: string; count: number }>();
  for (const inv of invoices) {
    const raw = latin(inv.invoiceNumber).trim();
    if (!raw) continue;
    const entry = counts.get(raw);
    if (entry) entry.count++;
    else counts.set(raw, { display: inv.invoiceNumber, count: 1 });
  }
  return [...counts.values()]
    .filter(e => e.count > 1)
    .map(e => ({ number: e.display, count: e.count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * رمز هذا الجهاز — رقمان ثابتان محفوظان محلياً، مرتبطان بالحساب.
 *
 * محلي عمداً: هو يعرّف **الجهاز** لا المستخدم، ولا يُرسل ولا يُزامَن ولا يحمل أي بيان
 * شخصي. تعذّر التخزين (وضع خاص/متصفح مقيَّد) يُعيد '' فيعود السلوك القديم بلا كسر.
 */
export function getDeviceTag(uid?: string | null): string {
  if (!uid) return '';
  const key = `ratib_device_tag_${uid}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved && /^\d{2}$/.test(saved)) return saved;
    const fresh = String(Math.floor(Math.random() * 90) + 10); // ١٠..٩٩
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return ''; // بلا تخزين ⇒ بلا وسم — أسلم من رمز يتغيّر كل مرة
  }
}
