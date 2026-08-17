/**
 * ترقيم متسلسل ببادئة — محرّك واحد لأرقام النقل (`TR-`) وفواتير الشراء (`P-`).
 *
 * 🔴 العلّتان اللتان يُغلقهما:
 *
 *  ١) **التجريد بـ`\d` يمحو الأرقام العربية.** فواتير الشراء تُخزَّن `P-١٠٠١`، والكود كان
 *     يقرأها `String(n).replace(/[^\d]/g,'')` — و`\d` في JavaScript لا تطابق إلا `0-9`
 *     اللاتينية. فالنتيجة نصٌّ فارغ ⟵ `parseInt('') = NaN` ⟵ صفر ⟵ `Math.max(0,…,1000)+1`
 *     يساوي **١٠٠١ أبداً**. قِسْتُها: فتحتُ النموذج مرّتين فأعطى `P-١٠٠١` في المرّتين.
 *     فلا تسلسل، ولا تمييز بين فواتير المورد الواحد، ولا مراجعة بالرقم.
 *
 *  ٢) **العدّ من قائمة الجهاز يتصادم.** جهازان يُصدران الرقم نفسه للحظة نفسها. العلاج
 *     نفسه المثبت في أرقام البيع والنقل: تسلسلٌ من **أعلى رقم مستعمل** (حرٌّ بالبناء،
 *     والحذف لا يُعيد رقماً)، ورمز جهاز يُلحق حين تُظهر البيانات جهازاً ثانياً.
 *
 * ووسم الجهاز يُقرأ من **حقل `deviceTag`** لا من شكل الرقم: لو انتظر كلٌّ أن يرى وسماً
 * لما وسم أحدٌ أولاً فاصطدما. (الدرس نفسه من ترقيم الفواتير.)
 */

import { DEVICE_SEP } from './invoiceNumber';

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** أرقام عربية-هندية/فارسية → لاتينية. هذا الملف نقيّ بلا اعتماديات واجهة. */
const latin = (v: string | number): string =>
  String(v ?? '')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0));

const arabic = (v: string | number): string =>
  String(v ?? '').replace(/[0-9]/g, d => AR_DIGITS[Number(d)]);

export interface NumberedDoc {
  /** الرقم كما هو مخزَّن (بأرقام عربية غالباً) */
  number?: string;
  /** رمز الجهاز المُصدِر — حقل صامت لا يُعرض */
  deviceTag?: string;
}

/** التسلسل داخل رقمٍ مبدوءٍ بالبادئة — يقبل `P-٧` و`P-٧/٧٣` واللاتيني، ويرفض التالف. */
export function seqOf(prefix: string, value?: string): number | null {
  const raw = latin(value ?? '').trim();
  if (!raw.startsWith(prefix)) return null;
  const seqPart = raw.slice(prefix.length).split(DEVICE_SEP)[0];
  if (!/^\d+$/.test(seqPart)) return null;
  const n = parseInt(seqPart, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** رمز الجهاز داخل الرقم، أو '' إن لم يكن موسوماً. */
export function deviceTagOf(prefix: string, value?: string): string {
  const raw = latin(value ?? '').trim();
  if (!raw.startsWith(prefix)) return '';
  const parts = raw.slice(prefix.length).split(DEVICE_SEP);
  return parts.length > 1 ? parts[1] : '';
}

/** هل يوسم هذا الجهاز أرقامه؟ الإشارة الحقل، ثم الوسم المضمَّن في بياناتٍ قديمة. */
export function shouldTag(prefix: string, docs: NumberedDoc[], myTag: string): boolean {
  if (!myTag) return false;
  for (const d of docs) {
    if (d.deviceTag && d.deviceTag !== myTag) return true;
    const embedded = deviceTagOf(prefix, d.number);
    if (embedded && embedded !== myTag) return true;
  }
  return false;
}

/**
 * أعلى تسلسل مستعمل + ١.
 * @param floor أرضية التسلسل (فواتير الشراء تبدأ من ١٠٠١ حفاظاً على السلوك القديم)
 */
export function nextSeq(prefix: string, docs: NumberedDoc[], floor = 0): number {
  let max = floor;
  for (const d of docs) {
    const seq = seqOf(prefix, d.number);
    if (seq !== null && seq > max) max = seq;
  }
  return max + 1;
}

export const formatNumber = (prefix: string, seq: number, tag = ''): string =>
  tag ? `${prefix}${arabic(seq)}${DEVICE_SEP}${arabic(tag)}` : `${prefix}${arabic(seq)}`;

/** الرقم التالي — حرٌّ بالبناء على هذا الجهاز، ومفصول عن بقية الأجهزة برمزها. */
export function allocateNumber(
  prefix: string, docs: NumberedDoc[], myTag = '', floor = 0,
): string {
  const tag = shouldTag(prefix, docs, myTag) ? myTag : '';
  return formatNumber(prefix, nextSeq(prefix, docs, floor), tag);
}

/** الأرقام المكرَّرة الموجودة فعلاً — ما وقع قبل الإصلاح يُكشف بدل أن يُسكت عنه. */
export function duplicateNumbersOf(docs: NumberedDoc[]): Array<{ number: string; count: number }> {
  const counts = new Map<string, { display: string; count: number }>();
  for (const d of docs) {
    const raw = latin(d.number ?? '').trim();
    if (!raw) continue;
    const entry = counts.get(raw);
    if (entry) entry.count++;
    else counts.set(raw, { display: d.number ?? raw, count: 1 });
  }
  return [...counts.values()]
    .filter(e => e.count > 1)
    .map(e => ({ number: e.display, count: e.count }))
    .sort((a, b) => b.count - a.count);
}
