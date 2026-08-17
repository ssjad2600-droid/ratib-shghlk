/**
 * توليد أكواد التفعيل — مفتاحٌ يُباع، فمصدر عشوائيته خطُّ الدفاع الأول.
 *
 * 🔴 العلّة: كان `Math.random()`، وهو في V8 مولّد **xorshift128+** — سريعٌ مصمَّم للألعاب
 * والرسوم لا للأسرار، وحالته الداخلية قابلة للاستنتاج من مخرجاته (بحث منشور).
 *
 * وسلسلة الخطر تكتمل بقواعد الوصول نفسها، ولا يمكن سدّها هناك:
 *   · `allow get: if request.auth != null` — أي مستخدم مسجّل يفحص أي كود بمعرّفه.
 *     وهي مفتوحة **بالضرورة** لأن معاملة التفعيل تحتاج قراءة الكود.
 *   · `allow update` تسمح لمن وجد كوداً غير مستعمل أن ينسبه لنفسه.
 * فمن يملك بضعة أكواد مشتراة يستطيع نظرياً استنتاج المولّد ⟵ توقّع أكواد ⟵ فحصها ⟵
 * تفعيلها مجاناً. العشوائية إذن هي الحماية الوحيدة الممكنة، وكانت أضعف حلقة.
 *
 * ⚖️ ولستُ أدّعي استغلالاً بضغطة: استنتاج الحالة من مخرجات مقتطعة (٥ بتّات لكل نداء)
 * عملٌ غير يسير. لكنه **الأداة الخاطئة** لهذا الغرض، والبديل متاح في كل متصفح.
 */

/** حروف الكود: بلا I O 0 1 — كي لا يُخطئ التاجر قراءتها على الهاتف. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const CODE_PREFIX = 'RS-';
const SEGMENT = 4;
const SEGMENTS = 2;

/** طول الجزء العشوائي — ٨ حروف من ٣٢ ⟵ ٣٢⁸ ≈ ١٫١ تريليون احتمال. */
export const CODE_RANDOM_CHARS = SEGMENT * SEGMENTS;

/**
 * بايتات عشوائية من مصدر التشفير.
 * تُمرَّر كمُعامل ليكون التوليد قابلاً للاختبار حتمياً — لا لتخفيف الحماية.
 */
export type RandomBytes = (n: number) => Uint8Array;

const cryptoBytes: RandomBytes = (n) => {
  const out = new Uint8Array(n);
  // `crypto` متاح في كل متصفح حديث وفي Electron — ولا بديل صامت له عمداً:
  // الفشل الصريح أسلم من العودة إلى Math.random بلا علم أحد.
  globalThis.crypto.getRandomValues(out);
  return out;
};

/**
 * اختيار حرفٍ بلا تحيّز — **رفضُ العيّنة** لا قسمة الباقي.
 *
 * ⚠️ مع ٣٢ حرفاً بالذات لا تحيّز في `byte % 32` أصلاً (٢٥٦ = ٨ × ٣٢ تماماً). لكننا لا
 * نبني على مصادفةٍ في طول الأبجدية: من يُضيف حرفاً يوماً يُدخل تحيّزاً صامتاً لا يكشفه
 * اختبار. الرفض يبقى صحيحاً مهما تغيّر الطول.
 */
export function pickChars(alphabet: string, count: number, randomBytes: RandomBytes = cryptoBytes): string {
  const n = alphabet.length;
  if (n === 0 || count <= 0) return '';
  const limit = Math.floor(256 / n) * n;   // أكبر مضاعف للطول ضمن البايت
  const out: string[] = [];
  let guard = 0;
  while (out.length < count) {
    if (++guard > 64) throw new Error('تعذّر توليد عشوائية كافية');
    const batch = randomBytes(count - out.length + 8);
    for (const b of batch) {
      if (out.length >= count) break;
      if (b >= limit) continue;            // بايت في الذيل غير المتوازن ⟵ يُرفض
      out.push(alphabet[b % n]);
    }
  }
  return out.join('');
}

/** كود بصيغة `RS-XXXX-XXXX`. */
export function generateActivationCode(randomBytes: RandomBytes = cryptoBytes): string {
  const chars = pickChars(CODE_ALPHABET, CODE_RANDOM_CHARS, randomBytes);
  const parts: string[] = [];
  for (let i = 0; i < SEGMENTS; i++) parts.push(chars.slice(i * SEGMENT, (i + 1) * SEGMENT));
  return CODE_PREFIX + parts.join('-');
}

/** هل هذا النصّ كودٌ بصيغتنا؟ — للبحث والتحقّق قبل أي استعلام. */
export const isActivationCode = (v: string): boolean =>
  new RegExp(`^${CODE_PREFIX}[${CODE_ALPHABET}]{${SEGMENT}}-[${CODE_ALPHABET}]{${SEGMENT}}$`).test((v ?? '').trim().toUpperCase());

/** تطبيع ما يكتبه المزوّد في البحث: حروف كبيرة، بلا مسافات. */
export const normalizeCodeQuery = (v: string): string =>
  (v ?? '').trim().toUpperCase().replace(/\s+/g, '');
