import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAmount, readAmountOr, readCount, AMOUNT_ERROR } from '../amountField';

/**
 * قراءة المبالغ المكتوبة بيد التاجر.
 *
 * العلّة الأصلية: كل خانات المبالغ كانت `type="number"`، والمتصفح يرفض الأرقام العربية
 * فيها ويجعل قيمتها فارغة — والبرنامج يعرض كل شيء بالعربي، أي أنه يدرّب التاجر على
 * كتابةٍ ثم يرفضها. ثم تُقرأ الخانة الفارغة بـ`|| 0` فتصير صفراً صامتاً، ولكل خانة
 * معنى كارثي مختلف عند الصفر.
 */

describe('readAmount — ثلاث حالات لا حالتان', () => {
  it('الفراغ حالة قائمة بذاتها — ليس صفراً', () => {
    for (const empty of ['', '   ', null, undefined]) {
      expect(readAmount(empty as string), `«${empty}»`).toEqual({ state: 'empty' });
    }
  });

  it('🔴 النص غير المفهوم ليس صفراً — يجب أن يُرفض', () => {
    for (const bad of ['خمسون', 'أ٥٠', '12ب', '--', '..']) {
      expect(readAmount(bad).state, `«${bad}» مرّ كأنه رقم`).toBe('invalid');
    }
  });

  it('الأرقام العربية تُقرأ (وهي ما كان الحقل يرفضه)', () => {
    expect(readAmount('٢٠٠٠٠')).toEqual({ state: 'ok', value: 20000 });
  });

  it('الأرقام الفارسية تُقرأ (تصل من النسخ واللصق)', () => {
    expect(readAmount('۲۰۰۰۰')).toEqual({ state: 'ok', value: 20000 });
  });

  it('اللاتينية والفواصل والمسافات', () => {
    expect(readAmount('20000')).toEqual({ state: 'ok', value: 20000 });
    expect(readAmount('20,000')).toEqual({ state: 'ok', value: 20000 });
    expect(readAmount('٢٠،٠٠٠')).toEqual({ state: 'ok', value: 20000 });
    expect(readAmount(' ٢٠ ٠٠٠ ')).toEqual({ state: 'ok', value: 20000 });
  });

  it('الصفر المكتوب صراحةً رقمٌ صحيح — لا يُخلط بالفراغ', () => {
    expect(readAmount('0')).toEqual({ state: 'ok', value: 0 });
    expect(readAmount('٠')).toEqual({ state: 'ok', value: 0 });
  });

  it('السالب والكسور', () => {
    expect(readAmount('-5000')).toEqual({ state: 'ok', value: -5000 });
    expect(readAmount('12.5')).toEqual({ state: 'ok', value: 12.5 });
  });

  it('الأرقام تُقبل كما هي', () => {
    expect(readAmount(20000)).toEqual({ state: 'ok', value: 20000 });
  });
});

describe('readAmountOr — الخانات الاختيارية', () => {
  it('الفراغ يأخذ الافتراضي', () => {
    expect(readAmountOr('', 0)).toBe(0);
    expect(readAmountOr('  ', 7)).toBe(7);
  });

  it('🔴 غير المفهوم يُرجع null لا الافتراضي — كي يرفضه المستدعي', () => {
    expect(readAmountOr('خمسون', 0), 'مرّ كأنه صفر').toBeNull();
  });

  it('الرقم المكتوب يفوز على الافتراضي', () => {
    expect(readAmountOr('٥٠٠', 0)).toBe(500);
    expect(readAmountOr('0', 99)).toBe(0);
  });
});

describe('readCount — الكميات الصحيحة', () => {
  it('يقصّ الكسر ولا يقبل السالب', () => {
    expect(readCount('3.9')).toBe(3);
    expect(readCount('-1')).toBeNull();
  });

  it('الفراغ يأخذ ما يحدّده المستدعي', () => {
    expect(readCount('')).toBeNull();
    expect(readCount('', { whenEmpty: 5 })).toBe(5);
  });

  it('غير المفهوم يُرجع null', () => {
    expect(readCount('كثير', { whenEmpty: 5 })).toBeNull();
  });

  it('الصفر يُقبل أو يُرفض حسب الطلب', () => {
    expect(readCount('0')).toBe(0);
    expect(readCount('0', { allowZero: false })).toBeNull();
  });

  it('الأرقام العربية', () => {
    expect(readCount('١٢')).toBe(12);
  });
});

describe('🔴 السيناريوهات التي كانت تُضيّع مالاً', () => {
  it('المبلغ الواصل: «٢٠٠٠٠» لم يعد يُقرأ فراغاً ⇒ لا تُسجَّل الفاتورة مدفوعة بالكامل', () => {
    const r = readAmount('٢٠٠٠٠');
    expect(r.state).toBe('ok');
    // المنطق في الشاشة: empty ⇒ مدفوع بالكامل. الأهم أن العربية لا تُنتج empty.
    expect(r.state === 'empty', 'رجعت فارغة ⇒ يختفي الدَّين كله').toBe(false);
  });

  it('الجرد الفعلي: الفراغ لم يعد صفراً ⇒ لا يُمحى المخزون', () => {
    expect(readAmount('').state).toBe('empty');
    expect(readAmount('').state === 'ok', 'الفراغ مرّ كرقم ⇒ رصيد صفر').toBe(false);
  });

  it('التسديد: نصٌّ لا يُقرأ يُرفض ولا يمرّ صفراً', () => {
    expect(readAmountOr('ألفين', 0)).toBeNull();
  });

  it('الخصم: الفراغ صفرٌ مشروع، والنص الغريب ليس كذلك', () => {
    expect(readAmountOr('', 0)).toBe(0);
    expect(readAmountOr('؟؟', 0)).toBeNull();
  });
});

/**
 * 🔴 الحارس: `type="number"` لا يعود إلى أي خانة.
 *
 * لا اختبار وحدة يكشف رجوعه — كل الدوال تبقى سليمة، والعلّة في **نوع الحقل** لا في
 * منطقه. فنفحص المصدر نفسه، كما فعلنا مع حارس النسخة الاحتياطية ودليل الشاشات.
 */
describe('حارس: لا حقل رقمي يرفض الأرقام العربية', () => {
  const dir = join(process.cwd(), 'src', 'components');
  const files = readdirSync(dir).filter(n => n.endsWith('.tsx'));

  it('المسح يرى الملفات فعلاً (حماية من فحص فارغ يمرّ كذباً)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('InvoicesView.tsx');
  });

  /** يزيل التعليقات قبل الفحص — وإلا حسب الحارسُ شرحَ العلّة نفسه مخالفةً. */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('🔴 لا `type="number"` في أي شاشة', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(join(dir, f), 'utf8'));
      const n = (src.match(/type="number"/g) || []).length;
      if (n) offenders.push(`${f} (${n})`);
    }
    expect(
      offenders,
      'حقل type="number" يرفض الأرقام العربية ويجعل قيمته فارغة — استعمل '
      + 'type="text" inputMode="decimal" مع readAmount: ' + offenders.join('، '),
    ).toEqual([]);
  });

  it('الرسالة الموحّدة موجودة ومفهومة', () => {
    expect(AMOUNT_ERROR).toContain('رقم');
    expect(AMOUNT_ERROR.length).toBeGreaterThan(20);
  });
});
