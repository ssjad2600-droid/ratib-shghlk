import React, { forwardRef, useLayoutEffect, useRef } from 'react';
import { groupDigits, ungroupDigits, countSignificant, caretAfterGrouping } from '../utils/groupDigits';

/**
 * خانة رقمية تعرض فواصل المراتب أثناء الكتابة.
 *
 * 🔴 لماذا مكوّنٌ لا سطرُ تنسيقٍ في كل خانة؟ بسبب **المؤشّر**.
 *
 * الخانة مضبوطة (controlled): كل ضغطة تُعيد الرسم بقيمةٍ جديدة. وحين تُدرَج
 * فاصلة يزداد طول النصّ حرفاً، بينما يُبقي المتصفّح المؤشّر عند نفس **الفهرس**
 * — فينزلق يساراً خانةً واحدة. اكتب «1234567» فترى المؤشّر يقفز إلى وسط الرقم
 * وتُكتب الخانة التالية في غير موضعها. أي أن التجميع بلا معالجة مؤشّر لا يُجمّل
 * الخانة بل يكسرها.
 *
 * العلاج: نحفظ **عدد الخانات** على يسار المؤشّر لا موضعه الحرفي، ثم نعيده بعد
 * الرسم إلى ما بعد الخانة رقم كذا. الخانات لا تتغيّر بالتجميع، الفواصل وحدها.
 *
 * 🎯 والعقد مع المستدعي بسيط عمداً: `onValueChange` يستلم القيمة **مجرّدةً من
 * الفواصل**، أي نفس ما كان يستلمه `e.target.value` حرفياً. فلا يتغيّر أي
 * تحقّقٍ ولا أي حساب في الشاشات — التغيير كلّه في ما تراه العين.
 */

type Props = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type'
> & {
  value: string | number | null | undefined;
  /** يستلم النصّ بلا فواصل — كما كان `e.target.value` تماماً. */
  onValueChange: (raw: string) => void;
};

const NumberInput = forwardRef<HTMLInputElement, Props>(function NumberInput(
  { value, onValueChange, ...rest },
  forwardedRef,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  /** عدد الأحرف ذات المعنى على يسار المؤشّر (خانات ونقطة وإشارة، لا فواصل). */
  const caretDigits = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = innerRef.current;
    const want = caretDigits.current;
    if (!el || want === null) return;
    caretDigits.current = null;

    const pos = caretAfterGrouping(el.value, want);
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      /* أنواع خانات لا تدعم التحديد — نتجاهل بدل أن نُسقط الشاشة */
    }
  });

  return (
    <input
      {...rest}
      ref={(node) => {
        innerRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      type="text"
      value={groupDigits(value)}
      onChange={(e) => {
        const el = e.target;
        const upto = el.value.slice(0, el.selectionStart ?? el.value.length);
        caretDigits.current = countSignificant(upto);
        onValueChange(ungroupDigits(el.value));
      }}
    />
  );
});

export default NumberInput;
