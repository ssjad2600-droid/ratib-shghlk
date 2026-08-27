import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * حارس: كل خانةٍ ماليّة أو كمّية تمرّ بـ`NumberInput`.
 *
 * 🔴 لماذا حارس؟ لأن الردّة صامتة. من يُضيف شاشةً جديدة غداً سيكتب
 * `<input inputMode="decimal">` كما في كل الأمثلة القديمة، فتظهر خانةُ سعرٍ
 * بلا فواصل بين ثلاثٍ وثلاثين خانةً تحملها — ولا خطأ ولا تحذير، فقط تاجرٌ
 * يعدّ الأصفار بعينه في شاشةٍ واحدة دون غيرها.
 *
 * والحارس يعمل بالقائمة **المغلقة**: أي خانةٍ عشرية عارية غير مذكورة في
 * المستثنيات تُسقط الاختبار. فالإضافة الجديدة تُجبر صاحبها على قرارٍ واعٍ:
 * إمّا `NumberInput` وإمّا تسجيلها هنا مع سببها.
 */

const DIR = join(process.cwd(), 'src', 'components');

/**
 * خانات عشرية تبقى **بلا فواصل** عن قصد — أرقامٌ صغيرة بطبعها، والفاصل فيها
 * ضجيجٌ لا فائدة: نسبةٌ مئوية لا تبلغ الألف، وعددُ أقساطٍ أو أشهرِ ضمان،
 * وأعدادُ صفوفٍ في ورقة ملصقات.
 */
const BARE_BY_DESIGN: Record<string, string> = {
  taxRateVal: 'نسبة الضريبة (٪) — أقل من مئة دائماً',
  'form.tax': 'نسبة ضريبة فاتورة الشراء',
  formWarrantyMonths: 'أشهر الضمان — ١٢ أو ٢٤',
  count: 'عدد الأقساط',
  'layout[key]': 'أبعاد ورقة الملصقات',
  n: 'عدد الملصقات',
  skip: 'ملصقات تُتخطّى في الورقة',
};

function inputsWith(pattern: RegExp) {
  const found: Array<{ file: string; line: number; value: string }> = [];
  for (const file of readdirSync(DIR)) {
    if (!file.endsWith('.tsx')) continue;
    const src = readFileSync(join(DIR, file), 'utf8');
    const re = new RegExp(pattern.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const tag = m[0];
      if (!/inputMode="decimal"/.test(tag)) continue;
      const value = (tag.match(/value=\{([^}]*)\}/) || [])[1];
      found.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        value: (value ?? '?').trim(),
      });
    }
  }
  return found;
}

describe('حارس: فواصل المراتب في خانات المال والكميات', () => {
  const bare = inputsWith(/<input\b[\s\S]{0,1600}?\/>/);
  const grouped = inputsWith(/<NumberInput\b[\s\S]{0,1600}?\/>/);

  it('المسح يرى الملفات فعلاً', () => {
    expect(grouped.length).toBeGreaterThan(25);
  });

  it('🔴 لا خانة عشرية عارية إلا المسجَّلة هنا بسببها', () => {
    const unexpected = bare.filter((f) => !(f.value in BARE_BY_DESIGN));
    expect(
      unexpected.map((f) => `${f.file}:${f.line} — ${f.value}`),
      'خانة رقمية جديدة بلا فواصل: استعمل <NumberInput> أو سجّلها في BARE_BY_DESIGN',
    ).toEqual([]);
  });

  it('والمستثنيات المسجَّلة ما زالت موجودة فعلاً — لا قائمة ميّتة', () => {
    const present = new Set(bare.map((f) => f.value));
    for (const key of Object.keys(BARE_BY_DESIGN)) {
      expect(present.has(key), `«${key}» مسجَّل مستثنىً ولم يعد موجوداً — احذفه`).toBe(true);
    }
  });

  it('🔴 كل خانة مجمَّعة تستعمل onValueChange لا onChange', () => {
    // `onChange` على `NumberInput` لا يُترجم — القيمة تصل مفصولةً فتُقرأ خطأً
    for (const file of readdirSync(DIR)) {
      if (!file.endsWith('.tsx')) continue;
      const src = readFileSync(join(DIR, file), 'utf8');
      const re = /<NumberInput\b[\s\S]{0,1600}?\/>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        expect(m[0], `${file}: NumberInput بـ onChange`).toContain('onValueChange=');
        expect(/\sonChange=/.test(m[0]), `${file}: NumberInput يحمل onChange`).toBe(false);
      }
    }
  });

  it('🔴 والحقول التي سمّاها التاجر تحديداً مشمولة', () => {
    const has = (file: string, value: string) =>
      grouped.some((f) => f.file === file && f.value === value);
    // سعر المنتج
    expect(has('ProductsView.tsx', 'formSellPrice'), 'سعر البيع').toBe(true);
    expect(has('ProductsView.tsx', 'formBuyPrice'), 'سعر الشراء').toBe(true);
    // تسديد الديون
    expect(has('DebtView.tsx', 'payAmount'), 'تسديد دين').toBe(true);
  });
});
