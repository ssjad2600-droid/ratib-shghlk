/**
 * توليد أكواد التفعيل — مفتاحٌ يُباع، فمصدر عشوائيته خطُّ الدفاع الأول.
 *
 * 🔧 محرّك العشوائية نفسه انتقل إلى {@link ./secureRandom} بعد أن ظهرت **نفس العلّة**
 * في كلمة سر حساب الموظف. هذا الملف بقي واجهةً باسم مجاله (كما `transferNumber.ts`
 * فوق `sequenceNumber.ts`)، و`pickChars` تُعاد تصديرها هنا فتبقى واجهته العامة كما كانت.
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

import { pickChars, RandomBytes } from './secureRandom';

// إعادة تصدير: واجهة هذا الملف العامة تبقى كما كانت بعد نقل المحرّك — لا يتغيّر أي مستورد.
export { pickChars };
export type { RandomBytes };

/** حروف الكود: بلا I O 0 1 — كي لا يُخطئ التاجر قراءتها على الهاتف. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const CODE_PREFIX = 'RS-';
const SEGMENT = 4;
const SEGMENTS = 2;

/** طول الجزء العشوائي — ٨ حروف من ٣٢ ⟵ ٣٢⁸ ≈ ١٫١ تريليون احتمال. */
export const CODE_RANDOM_CHARS = SEGMENT * SEGMENTS;

/** كود بصيغة `RS-XXXX-XXXX`. */
export function generateActivationCode(randomBytes?: RandomBytes): string {
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
