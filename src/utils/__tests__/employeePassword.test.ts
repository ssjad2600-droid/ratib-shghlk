import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateEmployeePassword, PASSWORD_ALPHABET, PASSWORD_LENGTH,
} from '../employeePassword';
import { pickChars, RandomBytes } from '../secureRandom';

/**
 * 🔴 كلمة سر الموظف اعتمادٌ يفتح جلسة — وكانت تُولَّد بـ`Math.random()`.
 *
 * وهي **نفس علّة أكواد التفعيل** على ما هو أخطر: الكود قفلٌ يُشترى، وهذه مفتاحٌ يدخل به
 * أحدهم باسم موظفك فيبيع ويُسجَّل في سجل التدقيق باسمه هو — فيصير الدليلُ شهادةَ زور.
 */

/** مصدر بايتات محدَّد للاختبار — يجعل التوليد حتمياً بلا إضعاف الإنتاج. */
const fixedBytes = (values: number[]): RandomBytes => {
  let i = 0;
  return (n: number) => Uint8Array.from({ length: n }, () => values[i++ % values.length]);
};

describe('كلمة سر الموظف', () => {
  it('طولها ثابت وكل محارفها من الأبجدية المختارة', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateEmployeePassword();
      expect(pw).toHaveLength(PASSWORD_LENGTH);
      for (const ch of pw) expect(PASSWORD_ALPHABET).toContain(ch);
    }
  });

  it('بلا i l o 0 1 — تُقرأ على الورق وتُملى على الموظف', () => {
    expect(PASSWORD_ALPHABET).not.toMatch(/[ilo01]/);
    const joined = Array.from({ length: 200 }, () => generateEmployeePassword()).join('');
    expect(joined).not.toMatch(/[ilo01]/);
  });

  it('🔴 أطول من ٨ — ٣١⁸ ضعيفٌ لكلمة سرٍّ دائمة لا تنتهي صلاحيتها', () => {
    expect(PASSWORD_LENGTH).toBeGreaterThanOrEqual(10);
  });

  it('تتجاوز حدّ Firebase الأدنى (٦ محارف) بهامش واسع', () => {
    expect(generateEmployeePassword().length).toBeGreaterThanOrEqual(6);
  });

  it('لا تتكرّر عملياً', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateEmployeePassword()));
    expect(seen.size).toBe(500);
  });

  it('كل محارف الأبجدية تظهر فعلاً (لا حرف ميت)', () => {
    const joined = Array.from({ length: 600 }, () => generateEmployeePassword()).join('');
    for (const ch of PASSWORD_ALPHABET) expect(joined).toContain(ch);
  });
});

/**
 * 🔴 التحيّز هنا **حقيقي** لا نظري — بخلاف أكواد التفعيل.
 *
 * أبجدية الكود ٣٢ حرفاً و٢٥٦ = ٨×٣٢ تماماً ⟵ `byte % 32` بلا تحيّز بالمصادفة.
 * وأبجدية كلمة السر **٣١** حرفاً و٢٥٦ = ٨×٣١ + ٨ ⟵ الأحرف الثمانية الأولى (a..h)
 * تظهر ٩ مرات لكل ٢٥٦ بايت بينما البقية ٨ مرات: انحياز ١٢٫٥٪ صامت.
 */
describe('🔴 لا تحيّز مع أبجدية الـ٣١', () => {
  it('طول الأبجدية ٣١ — لا يقسم ٢٥٦', () => {
    expect(PASSWORD_ALPHABET).toHaveLength(31);
    expect(256 % PASSWORD_ALPHABET.length).not.toBe(0);
  });

  it('البايتات الثمانية في الذيل تُرفض ولا تُطوى على أوائل الحروف', () => {
    // 248..255 خارج أكبر مضاعف (٨×٣١=٢٤٨) ⟵ تُرفض جميعاً.
    // لو استُعملت القسمة لأعطى 248 % 31 = 0 ⟵ الحرف 'a' بتحيّز صامت.
    const out = pickChars(PASSWORD_ALPHABET, 3, fixedBytes([248, 255, 0, 1, 2]));
    expect(out).toBe('abc');
  });

  it('التوزيع متّزن تماماً على مدى بايت كامل', () => {
    const counts = new Map<string, number>();
    const bytes = Array.from({ length: 256 }, (_, i) => i);
    // ٢٤٨ بايتاً مقبولاً ⟵ ٨ لكل حرف بالضبط، والثمانية الباقية مرفوضة
    for (const ch of pickChars(PASSWORD_ALPHABET, 248, fixedBytes(bytes))) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(31);
    expect([...counts.values()].every(v => v === 8)).toBe(true);
  });
});

/**
 * 🔴 حارس: لا `Math.random` في أي مسار يُنتج اعتماداً أو سرّاً.
 *
 * حارس ضد **النسيان**: من يكتب مولّداً جديداً غداً قد يبدأ بـ`Math.random` لأنه أقصر،
 * ولن يُنبّهه شيء. وقد وقع هذا مرّتين فعلاً (الأكواد، ثم كلمة السر) — فالحارس يمسح
 * **كل** المصدر لا ملفاً بعينه.
 */
describe('حارس: مسارات الاعتماد', () => {
  const root = join(process.cwd(), 'src');
  const strip = (s: string) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      if (e.name === '__tests__') return [];
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.tsx?$/.test(e.name) ? [p] : [];
    });

  const files = walk(root);

  it('المسح يرى المصدر فعلاً (حماية من فحص فارغ يمرّ كذباً)', () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files.some(f => f.endsWith('EmployeeManagement.tsx'))).toBe(true);
    expect(files.some(f => f.endsWith('secureRandom.ts'))).toBe(true);
  });

  /**
   * الاستثناءات مقصودة وموثّقة: هذه تولّد **معرّفات** لا أسرار — مطلوبها تفادي التصادم
   * لا السرّية. إبقاؤها على Math.random قرارٌ لا سهو.
   */
  const ID_ONLY = ['genId.ts', 'dateUtils.ts', 'auditLog.ts', 'errorReporter.ts', 'invoiceNumber.ts'];

  it('🔴 لا Math.random خارج مولّدات المعرّفات المعروفة', () => {
    const offenders = files.filter(f => {
      if (ID_ONLY.some(n => f.endsWith(n))) return false;
      return /Math\.random/.test(strip(readFileSync(f, 'utf8')));
    }).map(f => f.replace(root, 'src'));

    expect(
      offenders,
      'Math.random في V8 هو xorshift128+ — لا يصلح لسرّ. استعمل utils/secureRandom.ts',
    ).toEqual([]);
  });

  it('🔴 الشاشة لا تولّد كلمة السر بنفسها', () => {
    const view = strip(readFileSync(join(root, 'components', 'EmployeeManagement.tsx'), 'utf8'));
    expect(/generateEmployeePassword/.test(view)).toBe(true);
    expect(
      /const chars = '[a-z0-9]+'/.test(view),
      'عودة مولّد محلي في الشاشة تلتفّ على المنطق المحروس',
    ).toBe(false);
  });

  it('🔴 والمحرّك المشترك يستعمل crypto بلا بديل صامت', () => {
    const engine = strip(readFileSync(join(root, 'utils', 'secureRandom.ts'), 'utf8'));
    expect(/getRandomValues/.test(engine)).toBe(true);
    expect(
      /Math\.random|crypto\s*\?|typeof crypto/.test(engine),
      'أي fallback صامت يُعيد الثغرة بلا أن يعلم أحد — الفشل الصريح أسلم',
    ).toBe(false);
  });

  it('🔴 ورفض العيّنة قائم — لا قسمة باقٍ عارية', () => {
    const engine = strip(readFileSync(join(root, 'utils', 'secureRandom.ts'), 'utf8'));
    expect(
      /if \(b >= limit\) continue;/.test(engine),
      'القسمة وحدها تُحيّز أي أبجدية لا تقسم ٢٥٦ — و٣١ منها',
    ).toBe(true);
  });
});
