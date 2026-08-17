/**
 * قراءة مبلغ كتبه التاجر بيده — بثلاث نتائج صريحة لا نتيجتين.
 *
 * 🔴 العلّة التي وُلد منها هذا الملف:
 *
 * كانت خانات المبالغ كلها `<input type="number">`، والمتصفح **يرفض الأرقام العربية فيها
 * ويجعل قيمتها نصاً فارغاً**. والبرنامج يعرض كل شيء بالأرقام العربية، أي أنه يدرّب التاجر
 * على كتابتها ثم يرفضها منه بلا كلمة. فيكتب «٢٠٠٠٠» ويرى الخانة فارغة.
 *
 * وحدها هذه لكانت إزعاجاً. لكن الشيفرة كانت تقرأ الفراغ بـ`|| 0`، فصار الفراغ **صفراً
 * صامتاً**، وصار لكل خانة معنى كارثي مختلف:
 *   • «المبلغ الواصل» في الفاتورة: الفراغ يعني «مدفوع بالكامل» ⇒ بيعٌ بالدين يُسجَّل نقداً
 *     ويختفي الدَّين كلّه.
 *   • «الجرد الفعلي» في تسوية المخزون: الفراغ صفر ⇒ رصيد المادة يُمحى إلى صفر.
 *   • «التسديد»: تسديد بصفر ⇒ دَينٌ لم يُخصم والتاجر يظنّه خُصم.
 *
 * القاعدة هنا: **الفراغ ليس صفراً، والنص غير المفهوم ليس صفراً**. كلٌّ حالةٌ قائمة بذاتها
 * يقرّر المستدعي ما يفعل بها — ولا يجوز أن يمرّ مبلغٌ غير مفهوم كأنه رقم صحيح.
 */

import { parseAmount } from './arabicFormatters';

export type TypedAmount =
  /** الخانة فارغة — قد يكون لها معنى افتراضي عند المستدعي (لا صفر بالضرورة). */
  | { state: 'empty' }
  /** كُتب شيء لا يُقرأ رقماً — يجب أن يُرفض الحفظ برسالة، لا أن يصير صفراً. */
  | { state: 'invalid' }
  /** رقم مفهوم. */
  | { state: 'ok'; value: number };

/** يقرأ ما في الخانة. يقبل العربية والفارسية واللاتينية والفواصل والمسافات. */
export function readAmount(raw: string | number | null | undefined): TypedAmount {
  if (raw === null || raw === undefined) return { state: 'empty' };
  const text = String(raw).trim();
  if (text === '') return { state: 'empty' };
  const n = parseAmount(text);
  return Number.isFinite(n) ? { state: 'ok', value: n } : { state: 'invalid' };
}

/**
 * قراءة مع قيمة افتراضية للفراغ — للخانات الاختيارية (الخصم، الضريبة، حدّ التنبيه).
 * يُرجع `null` **فقط** للنص غير المفهوم، ليرفضه المستدعي صراحةً.
 */
export function readAmountOr(raw: string | number | null | undefined, whenEmpty: number): number | null {
  const r = readAmount(raw);
  if (r.state === 'empty') return whenEmpty;
  if (r.state === 'invalid') return null;
  return r.value;
}

/**
 * قراءة كمية صحيحة غير سالبة (قطع، أقساط، أشهر ضمان).
 * يُرجع `null` للنص غير المفهوم أو السالب أو الكسري المرفوض.
 */
export function readCount(
  raw: string | number | null | undefined,
  { whenEmpty = null as number | null, allowZero = true } = {},
): number | null {
  const r = readAmount(raw);
  if (r.state === 'empty') return whenEmpty;
  if (r.state === 'invalid') return null;
  const n = Math.floor(r.value);
  if (n < 0) return null;
  if (!allowZero && n === 0) return null;
  return n;
}

/** رسالة موحّدة تُعرض للتاجر عند تعذّر قراءة مبلغ — نفس النص في كل الشاشات. */
export const AMOUNT_ERROR = 'قيمة غير مفهومة — اكتب رقماً فقط (بالعربي أو بالإنكليزي)';
