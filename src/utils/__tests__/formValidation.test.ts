import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validationMessage } from '../formValidation';

/**
 * 🟡 رسائل تحقّق النماذج — أثرها يوميّ لا نادر.
 *
 * ٢٦ حقلاً بـ`required` في تسع شاشات، وكلّها كانت تعرض رسالة المتصفح الإنجليزية
 * («Please fill out this field») في برنامجٍ عربي RTL يستعمله تاجر عراقي. وتظهر في
 * الفواتير والزبائن والديون والمصاريف والمنتجات وتسجيل الدخول — أكثر ما يُستعمل.
 */

/** حالة صلاحية مزيّفة: كل شيء صالح إلا ما يُذكر. */
const validity = (over: Partial<ValidityState> = {}): ValidityState => ({
  badInput: false, customError: false, patternMismatch: false, rangeOverflow: false,
  rangeUnderflow: false, stepMismatch: false, tooLong: false, tooShort: false,
  typeMismatch: false, valid: false, valueMissing: false, ...over,
} as ValidityState);

describe('الحقل المطلوب', () => {
  it('نصّ فارغ ⟵ رسالة عربية واضحة', () => {
    expect(validationMessage({ validity: validity({ valueMissing: true }), type: 'text' }))
      .toBe('هذا الحقل مطلوب');
  });

  /**
   * ⚠️ الشرط يمنع **النثر الإنجليزي** لا كل حرف لاتيني: مثالُ البريد
   * (`name@example.com`) يجب أن يبقى لاتينياً وإلا صار المثال بلا معنى.
   * كانت أول صياغة تمنع كل لاتيني فأسقطت رسالة البريد الصحيحة.
   */
  it('🔴 ولا نثر إنجليزي في أي رسالة', () => {
    const cases = [
      { validity: validity({ valueMissing: true }), type: 'text' },
      { validity: validity({ typeMismatch: true }), type: 'email' },
      { validity: validity({ typeMismatch: true }), type: 'url' },
      { validity: validity({ tooShort: true }), minLength: 6 },
      { validity: validity({ rangeUnderflow: true }), min: '1' },
      { validity: validity({ badInput: true }) },
      { validity: validity({ stepMismatch: true }) },
      { validity: validity({}) },
    ];
    for (const c of cases) {
      const m = validationMessage(c);
      // نُسقط عناوين البريد النموذجية ثم نمنع أي كلمة لاتينية باقية
      const prose = m.replace(/\S+@\S+\.\S+/g, '');
      expect(prose, `النوع ${c.type ?? '—'}`).not.toMatch(/[A-Za-z]{3,}/);
      expect(m.length).toBeGreaterThan(5);
    }
  });

  it('يميّز الاختيار والملف عن النصّ', () => {
    expect(validationMessage({ validity: validity({ valueMissing: true }), type: 'checkbox' })).toMatch(/اختيار/);
    expect(validationMessage({ validity: validity({ valueMissing: true }), type: 'file' })).toMatch(/ملف/);
  });
});

describe('بقيّة الحالات', () => {
  it('البريد الإلكتروني يُشرَح بمثال', () => {
    const m = validationMessage({ validity: validity({ typeMismatch: true }), type: 'email' });
    expect(m).toMatch(/البريد الإلكتروني/);
    expect(m, 'المثال يُغني عن شرح إضافي').toMatch(/@/);
  });

  it('🔴 الأرقام في الرسائل بالعربية — كباقي البرنامج', () => {
    expect(validationMessage({ validity: validity({ tooShort: true }), minLength: 6 })).toMatch(/٦/);
    expect(validationMessage({ validity: validity({ rangeUnderflow: true }), min: '10' })).toMatch(/١٠/);
    expect(validationMessage({ validity: validity({ rangeOverflow: true }), max: '99' })).toMatch(/٩٩/);
  });

  it('🔴 نمطٌ مخالف ⟵ يُقدَّم شرح المطوّر (title) على أي رسالة عامة', () => {
    expect(validationMessage({
      validity: validity({ patternMismatch: true }),
      title: 'الرقم يبدأ بـ٠٧ ويتكوّن من ١١ خانة',
    })).toBe('الرقم يبدأ بـ٠٧ ويتكوّن من ١١ خانة');
  });

  it('وبلا title تبقى رسالة مفهومة', () => {
    expect(validationMessage({ validity: validity({ patternMismatch: true }) })).toMatch(/الصيغة/);
  });

  it('حالة غير متوقّعة لا تُنتج رسالة فارغة', () => {
    expect(validationMessage({ validity: validity({}) }).length).toBeGreaterThan(5);
  });
});

/**
 * 🔴 حارس: التركيب قائم، والمزلق الأخطر مُتفادى.
 */
describe('حارس: تحقّق النماذج', () => {
  const root = join(process.cwd(), 'src');
  const read = (p: string) => readFileSync(join(root, ...p.split('/')), 'utf8')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const util = read('utils/formValidation.ts');
  const main = read('main.tsx');

  it('المسح يرى الملفات فعلاً', () => {
    expect(util).toContain('installArabicValidation');
    expect(main).toContain('createRoot');
  });

  it('🔴 مُركَّب عند الإقلاع', () => {
    expect(/installArabicValidation\(\)/.test(main)).toBe(true);
  });

  it('🔴 يستمع في طور الالتقاط — حدث invalid لا يصعد', () => {
    expect(
      /addEventListener\('invalid', onInvalid, true\)/.test(util),
      'بلا capture لا يصل الحدث إلى المستمع العام أصلاً، فتبقى الإنجليزية',
    ).toBe(true);
  });

  it('🔴 ويمسح الرسالة عند التعديل — وإلا لا يُرسَل النموذج أبداً', () => {
    expect(
      /addEventListener\('input', onEdit, true\)/.test(util),
      'setCustomValidity تُبقي الحقل باطلاً حتى يُمسح النصّ صراحةً',
    ).toBe(true);
    expect(
      /addEventListener\('change', onEdit, true\)/.test(util),
      'select و file لا يُطلقان input دائماً',
    ).toBe(true);
    expect(/setCustomValidity\(''\)/.test(util)).toBe(true);
  });

  it('🔴 ويمسح قبل القياس — كي لا تُقاس صلاحية من رسالة عالقة', () => {
    expect(
      /el\.setCustomValidity\(''\);[\s\S]{0,60}if \(el\.validity\.valid\) return;/.test(util),
      'بلا مسحٍ أوّلاً تبقى customError مرفوعة فتُقرأ الحالة خطأً',
    ).toBe(true);
  });
});

/**
 * 🎯 حارس التغطية: أي حقل `required` جديد يُغطّى تلقائياً بالمستمع العام —
 * لكن نتأكّد أن أحداً لم يُعطّل التحقّق بـ`noValidate` فيُسقط الرسائل كلها.
 */
describe('حارس: لا تعطيل للتحقّق', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      if (e.name === '__tests__') return [];
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.tsx$/.test(e.name) ? [p] : [];
    });

  const files = walk(join(process.cwd(), 'src', 'components'));

  it('المسح يرى الشاشات', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('🔴 لا نموذج يُعطّل تحقّق المتصفح', () => {
    const offenders = files.filter(f => /noValidate/.test(readFileSync(f, 'utf8')))
      .map(f => f.split(/[\\/]/).pop());
    expect(
      offenders,
      'noValidate يُسقط التحقّق كلّه — فلا رسالة عربية ولا إنجليزية، ويُرسَل النموذج ناقصاً',
    ).toEqual([]);
  });

  it('وحقول required ما زالت موجودة (لم تُحذف بدل أن تُعرَّب)', () => {
    const count = files.reduce((s, f) => s + (readFileSync(f, 'utf8').match(/\brequired\b/g) ?? []).length, 0);
    expect(count).toBeGreaterThanOrEqual(20);
  });
});
