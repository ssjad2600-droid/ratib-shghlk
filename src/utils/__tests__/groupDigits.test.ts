import { describe, it, expect } from 'vitest';
import { groupDigits, ungroupDigits, countDigits, countSignificant, caretAfterGrouping, GROUP_SEP } from '../groupDigits';
import { parseAmount } from '../arabicFormatters';
import { readAmount, readAmountOr, readCount } from '../amountField';

describe('groupDigits — فواصل المراتب في خانات الإدخال', () => {
  it('يُجمّع من اليمين كل ثلاث خانات', () => {
    expect(groupDigits('1')).toBe('1');
    expect(groupDigits('12')).toBe('12');
    expect(groupDigits('123')).toBe('123');
    expect(groupDigits('1234')).toBe('1,234');
    expect(groupDigits('12345')).toBe('12,345');
    expect(groupDigits('123456')).toBe('123,456');
    expect(groupDigits('1234567')).toBe('1,234,567');
    expect(groupDigits('1234567890')).toBe('1,234,567,890');
  });

  it('يقبل الأرقام العربية-الهندية والفارسية كما يقبل اللاتينية', () => {
    expect(groupDigits('١٥٠٠٠٠٠')).toBe('١,٥٠٠,٠٠٠');
    expect(groupDigits('۱۲۳۴۵۶')).toBe('۱۲۳,۴۵۶');
  });

  it('🔴 لا يُجمّع الجزء العشري — تجميعه يُنتج رقماً لا معنى له', () => {
    expect(groupDigits('1500.75')).toBe('1,500.75');
    expect(groupDigits('12.3456789')).toBe('12.3456789');
    expect(groupDigits('1234567.891011')).toBe('1,234,567.891011');
  });

  it('يحفظ الفاصلة العشرية أثناء الكتابة (رقمٌ نصفُ مكتوب)', () => {
    expect(groupDigits('1500.')).toBe('1,500.');
    expect(groupDigits('1500٫')).toBe('1,500٫');
    expect(groupDigits('.5')).toBe('.5');
  });

  it('يحفظ الإشارة السالبة', () => {
    expect(groupDigits('-1234')).toBe('-1,234');
    expect(groupDigits('-1234.5')).toBe('-1,234.5');
  });

  it('عملية عديمة الأثر عند إعادة التطبيق', () => {
    expect(groupDigits('1,234')).toBe('1,234');
    expect(groupDigits(groupDigits(groupDigits('9876543')))).toBe('9,876,543');
  });

  it('يقبل الأرقام لا النصوص وحدها (حقولٌ تُخزّن رقماً)', () => {
    expect(groupDigits(1500)).toBe('1,500');
    expect(groupDigits(0)).toBe('0');
    expect(groupDigits(1234567)).toBe('1,234,567');
  });

  it('الفراغ والعدم يبقيان فراغاً — لا «0»', () => {
    expect(groupDigits('')).toBe('');
    expect(groupDigits(null)).toBe('');
    expect(groupDigits(undefined)).toBe('');
  });

  it('🔴 ما لا يُفهم يُعاد كما هو — لا يُشوَّه ولا تُبتلع منه خانة', () => {
    expect(groupDigits('abc')).toBe('abc');
    expect(groupDigits('12ab34')).toBe('12ab34');
    expect(groupDigits('--5')).toBe('--5');
  });

  it('🔴 الرقم لا يتغيّر أبداً بعد التجميع — الفحص الحاسم', () => {
    const samples = ['0', '7', '99', '1500', '550000', '1234567', '999999999',
      '1500.75', '0.5', '١٥٠٠', '٥٥٠٠٠٠', '-2500'];
    for (const s of samples) {
      expect(parseAmount(groupDigits(s))).toBe(parseAmount(s));
    }
  });
});

describe('ungroupDigits — رجوعٌ أمين', () => {
  it('يُزيل الفواصل بأشكالها الثلاثة والمسافات', () => {
    expect(ungroupDigits('1,234,567')).toBe('1234567');
    expect(ungroupDigits('١٬٥٠٠')).toBe('١٥٠٠');
    expect(ungroupDigits('55،000')).toBe('55000');
    expect(ungroupDigits('1 500')).toBe('1500');
  });

  it('🔴 لا يمسّ الفاصلة العشرية — إزالتها تضرب الرقم بمئة', () => {
    expect(ungroupDigits('1,500.75')).toBe('1500.75');
    expect(ungroupDigits('1٫5')).toBe('1٫5');
    expect(parseAmount(ungroupDigits('1,500.75'))).toBe(1500.75);
  });

  it('عكسُ groupDigits تماماً', () => {
    for (const s of ['1234567', '١٥٠٠٠٠٠', '1500.75', '-2500', '', '99']) {
      expect(ungroupDigits(groupDigits(s))).toBe(s);
    }
  });
});

describe('countDigits — أساس إعادة المؤشّر إلى مكانه', () => {
  it('يعدّ الخانات لا الأحرف', () => {
    expect(countDigits('')).toBe(0);
    expect(countDigits('1,234')).toBe(4);
    expect(countDigits('1,234.56')).toBe(6);
    expect(countDigits('١٬٥٠٠')).toBe(4);
    expect(countDigits('-1,500')).toBe(4);
  });
});

/**
 * 🔴 الفحص الذي يهمّ فعلاً: طبقة القراءة تبتلع الفواصل بلا أثر.
 * لو كسر هذا يوماً، لصار كل مبلغٍ فيه فاصلة **صفراً أو رفضاً** — وهو ما
 * يحدث لو استُعملت `Number()` بدل `readAmount`.
 */
describe('🔴 المبلغ المفصول يُقرأ كما يُقرأ المجرّد — في كل مسارات القراءة', () => {
  const cases: Array<[string, number]> = [
    ['1,500', 1500],
    ['550,000', 550000],
    ['1,234,567', 1234567],
    ['1,500.75', 1500.75],
    ['١,٥٠٠', 1500],
    ['٥٥٠,٠٠٠', 550000],
  ];

  for (const [typed, expected] of cases) {
    it(`«${typed}» ⟶ ${expected}`, () => {
      expect(parseAmount(typed)).toBe(expected);
      expect(readAmount(typed)).toEqual({ state: 'ok', value: expected });
      expect(readAmountOr(typed, 0)).toBe(expected);
    });
  }

  it('والكميات كذلك عبر readCount', () => {
    expect(readCount('1,500')).toBe(1500);
    expect(readCount('١,٢٠٠')).toBe(1200);
  });

  it('🔴 وللمقارنة: Number() تفشل على نفس المدخلات — لذا لا تُستعمل', () => {
    expect(Number('1,500')).toBeNaN();
    expect(Number('١٥٠٠')).toBeNaN();
  });

  it('الفاصل المعروض هو نفسه الذي تُخرجه بقية الشاشات', () => {
    expect(GROUP_SEP).toBe(',');
    expect((1234567).toLocaleString('en-US')).toContain(GROUP_SEP);
  });
});

/**
 * 🔴 محاكاة الكتابة الحقيقية.
 *
 * هذه هي التي تكشف العطل الذي لا تكشفه اختبارات التنسيق: التجميع صحيح
 * والمؤشّر خاطئ. اكتب «1234567» فيقفز المؤشّر إلى وسط الرقم عند إدراج أول
 * فاصلة، وتُكتب الخانة التالية في غير موضعها — فيصير الرقم رقماً آخر.
 *
 * نُحاكي ما يفعله المتصفّح حرفياً: يُدرج الحرف في **النصّ المعروض** عند موضع
 * المؤشّر، ثم يمرّ المدخل بمسار `NumberInput` نفسه.
 */
describe('🔴 المؤشّر أثناء الكتابة — محاكاة المتصفّح', () => {
  /** ضغطةٌ واحدة: إدراج `ch` عند `caret` في النصّ المعروض. */
  function press(shown: string, caret: number, ch: string) {
    const typed = shown.slice(0, caret) + ch + shown.slice(caret);
    const digitsBefore = countSignificant(typed.slice(0, caret + ch.length));
    const next = groupDigits(ungroupDigits(typed));
    return { shown: next, caret: caretAfterGrouping(next, digitsBefore) };
  }

  it('كتابة «1234567» من الصفر — الرقم والمؤشّر سليمان بعد كل ضغطة', () => {
    let s = { shown: '', caret: 0 };
    const seen: string[] = [];
    for (const ch of '1234567') {
      s = press(s.shown, s.caret, ch);
      seen.push(s.shown);
      // المؤشّر في النهاية دائماً — وإلا كُتبت الخانة التالية في الوسط
      expect(s.caret).toBe(s.shown.length);
    }
    expect(seen).toEqual(['1', '12', '123', '1,234', '12,345', '123,456', '1,234,567']);
    expect(parseAmount(s.shown)).toBe(1234567);
  });

  it('🔴 لولا حساب المؤشّر لانزلق يساراً عند أول فاصلة', () => {
    // «123» ثم «4»: المعروض يصير «1,234» بطول ٥ بينما الفهرس الساذج ٤
    const after = press('123', 3, '4');
    expect(after.shown).toBe('1,234');
    expect(after.caret).toBe(5);
    // الفهرس الساذج (طول ما كُتب) كان سيقع قبل «4» فتُكتب الخانة التالية في وسطه
    expect(after.caret).not.toBe(4);
  });

  it('الإدراج في وسط رقمٍ قائم يبقى في موضعه', () => {
    // «1,234» والمؤشّر بعد «2» (فهرس ٣) ثم نكتب «9» ⟶ «12,934»
    const after = press('1,234', 3, '9');
    expect(after.shown).toBe('12,934');
    expect(ungroupDigits(after.shown)).toBe('12934');
    // ثلاث خانات على اليسار: «1»، «2»، «9»
    expect(countDigits(after.shown.slice(0, after.caret))).toBe(3);
  });

  it('الكتابة بالأرقام العربية تسلك نفس السلوك', () => {
    let s = { shown: '', caret: 0 };
    for (const ch of '١٥٠٠٠٠٠') s = press(s.shown, s.caret, ch);
    expect(s.shown).toBe('١,٥٠٠,٠٠٠');
    expect(s.caret).toBe(s.shown.length);
    expect(parseAmount(s.shown)).toBe(1500000);
  });

  it('العشريّ يُكتب كاملاً بلا أن يبتلع التجميع الكسر', () => {
    let s = { shown: '', caret: 0 };
    for (const ch of '12500.75') s = press(s.shown, s.caret, ch);
    expect(s.shown).toBe('12,500.75');
    expect(parseAmount(s.shown)).toBe(12500.75);
  });

  it('caretAfterGrouping: البداية والنهاية وما بعدهما', () => {
    expect(caretAfterGrouping('1,234', 0)).toBe(0);
    expect(caretAfterGrouping('1,234', 1)).toBe(1);
    expect(caretAfterGrouping('1,234', 2)).toBe(3); // يتخطّى الفاصلة
    expect(caretAfterGrouping('1,234', 4)).toBe(5);
    expect(caretAfterGrouping('1,234', 99)).toBe(5); // لا يتجاوز الطول
  });
});

/**
 * 🔴 هذه الكتلة وُلدت من حارسٍ أعمى.
 *
 * زرعتُ العطل الحقيقي — «المؤشّر يعدّ الخانات لا الأحرف» — فمرّ الاختبار.
 * السبب أن الكتابة في **نهاية** الحقل تنجح بالصدفة مع العدّ الخاطئ: العدّ
 * الناقص يتجاوز طول النصّ فيقف عند النهاية، وهي الإجابة الصحيحة صدفةً.
 *
 * الفرق لا يظهر إلا **داخل** رقمٍ فيه نقطة أو إشارة. فهنا نقيسه مباشرةً.
 */
describe('🔴 المؤشّر يعدّ الأحرف لا الخانات — الفرق داخل الرقم', () => {
  it('بعد النقطة العشرية يختلف الجوابان', () => {
    // «1,500.75» — سبعة أحرفٍ ذات معنى: 1 5 0 0 . 7 5
    // العدّ الصحيح (أحرف): بعد السادس «7» ⟶ الفهرس ٧
    expect(caretAfterGrouping('1,500.75', 6)).toBe(7);
    // لو عُدَّت الخانات وحدها لتجاوز النقطة وأعطى ٨ — أي مؤشّراً في غير موضعه
    expect(caretAfterGrouping('1,500.75', 6)).not.toBe(8);
  });

  it('والإشارة السالبة حرفٌ يكتبه التاجر فيُعدّ', () => {
    // «-1,500»: الأحرف ذات المعنى - 1 5 0 0
    expect(caretAfterGrouping('-1,500', 1)).toBe(1); // بعد الإشارة
    expect(caretAfterGrouping('-1,500', 2)).toBe(2); // بعد «1»
  });

  it('الإدراج داخل الكسر يبقى في موضعه', () => {
    // «1,500.75» والمؤشّر بين «7» و«5» (فهرس ٧) ثم نكتب «9» ⟶ «1,500.795»
    const shown = '1,500.75';
    const caret = 7;
    const typed = shown.slice(0, caret) + '9' + shown.slice(caret);
    const sig = countSignificant(typed.slice(0, caret + 1));
    const next = groupDigits(ungroupDigits(typed));
    expect(next).toBe('1,500.795');
    expect(caretAfterGrouping(next, sig)).toBe(8); // مباشرةً بعد «9»
    expect(parseAmount(next)).toBe(1500.795);
  });
});

/**
 * 🔴 حارسٌ على صنف الفواصل نفسه.
 *
 * كُتب يوماً `/[,،٬s]/` — بحرف «s» بدل `\s` — لأن الشرطة المائلة ابتُلعت في
 * الطريق إلى الملف. والنتيجة صنفٌ يعدّ **المسافة** حرفاً ذا معنى ويتخطّى حرف
 * «s» اللاتيني. عطلٌ نجا من ٣٢ اختباراً لأن كلّها كانت بلا مسافات.
 */
describe('صنف الفواصل: المسافة فاصل، والحرف اللاتيني ليس كذلك', () => {
  it('المسافة لا تُعدّ حرفاً ذا معنى', () => {
    expect(countSignificant('1 500')).toBe(4);
    expect(countSignificant('1,500')).toBe(4);
    expect(countSignificant('  7')).toBe(1);
  });

  it('وموضع المؤشّر يتخطّى المسافة كما يتخطّى الفاصلة', () => {
    expect(caretAfterGrouping('1 500', 4)).toBe(5);
  });

  it('وحرف «s» يُعدّ حرفاً عادياً لا فاصلاً', () => {
    expect(countSignificant('s')).toBe(1);
  });
});
