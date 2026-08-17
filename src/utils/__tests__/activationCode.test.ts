import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateActivationCode, pickChars, isActivationCode, normalizeCodeQuery,
  CODE_ALPHABET, CODE_RANDOM_CHARS, RandomBytes,
} from '../activationCode';

/**
 * 🔴 كود التفعيل هو **المنتج نفسه** — من كسره أخذ البرنامج بلا ثمن.
 *
 * وكان يُولَّد بـ`Math.random()` (xorshift128+ في V8): مولّد ألعابٍ لا أسرار. وسلسلة
 * الخطر تكتمل بقواعد الوصول: `allow get` مفتوحة **بالضرورة** لأي مستخدم مسجّل (معاملة
 * التفعيل تحتاجها)، و`allow update` تسمح لمن وجد كوداً غير مستعمل أن ينسبه لنفسه.
 * فالعشوائية هي الحماية الوحيدة الممكنة — ولا يُصلحها شيء في القواعد.
 */

/** مصدر بايتات محدَّد للاختبار — يجعل التوليد حتمياً بلا إضعاف الإنتاج. */
const fixedBytes = (values: number[]): RandomBytes => {
  let i = 0;
  return (n: number) => Uint8Array.from({ length: n }, () => values[i++ % values.length]);
};

describe('صيغة الكود', () => {
  it('يولّد كوداً بالصيغة المتوقّعة', () => {
    for (let i = 0; i < 50; i++) expect(isActivationCode(generateActivationCode())).toBe(true);
  });

  it('طوله ثابت: RS- ثم ٤ + ٤', () => {
    const code = generateActivationCode();
    expect(code).toHaveLength(3 + 4 + 1 + 4);
    expect(code.slice(0, 3)).toBe('RS-');
  });

  it('كل حروفه من الأبجدية المختارة — بلا I O 0 1 التي تُقرأ خطأً على الهاتف', () => {
    const body = generateActivationCode().replace(/^RS-/, '').replace('-', '');
    expect(body).toHaveLength(CODE_RANDOM_CHARS);
    for (const ch of body) expect(CODE_ALPHABET).toContain(ch);
    expect(CODE_ALPHABET).not.toMatch(/[IO01]/);
  });

  it('لا يكرّر نفسه عملياً', () => {
    const seen = new Set(Array.from({ length: 400 }, () => generateActivationCode()));
    expect(seen.size).toBe(400);
  });
});

describe('🔴 اختيار بلا تحيّز — رفض العيّنة لا قسمة الباقي', () => {
  it('البايت في الذيل غير المتوازن يُرفض ولا يُطوى', () => {
    // أبجدية من ٣ حروف ⟵ الحدّ ٢٥٥ (٨٥×٣)، فالبايت ٢٥٥ يقع خارجه ويجب أن يُرفض.
    // لو استُعمل `% 3` لأعطى 255 % 3 = 0 ⟵ الحرف 'أ' بتحيّز صامت.
    const out = pickChars('ABC', 3, fixedBytes([255, 0, 1, 2]));
    expect(out).toBe('ABC');
  });

  it('التوزيع متّزن على أبجدية غير قاسمة لـ٢٥٦', () => {
    const counts: Record<string, number> = { A: 0, B: 0, C: 0 };
    // كل البايتات ٠..٢٥٤ مرّة واحدة (٢٥٥ يُرفض) ⟵ ٨٥ لكل حرف بالضبط
    const bytes = Array.from({ length: 256 }, (_, i) => i);
    const chars = pickChars('ABC', 255, fixedBytes(bytes));
    for (const c of chars) counts[c]++;
    expect(counts).toEqual({ A: 85, B: 85, C: 85 });
  });

  it('أبجدية فارغة أو عدد صفري ⟵ نص فارغ بلا حلقة لا نهائية', () => {
    expect(pickChars('', 5)).toBe('');
    expect(pickChars('ABC', 0)).toBe('');
  });

  it('مصدر عشوائية معطوب لا يُعلّق البرنامج إلى الأبد', () => {
    // كل البايتات مرفوضة (خارج الحدّ) ⟵ يجب أن يرمي بدل أن يدور بلا نهاية
    expect(() => pickChars('ABC', 1, fixedBytes([255]))).toThrow();
  });
});

describe('تطبيع البحث والتحقّق', () => {
  it('يقبل الحروف الصغيرة والمسافات الطرفية', () => {
    expect(isActivationCode(' rs-abcd-2345 ')).toBe(true);
    expect(normalizeCodeQuery('  rs-abcd-2345 ')).toBe('RS-ABCD-2345');
  });

  it('يرفض ما ليس بصيغة الكود — فلا نستعلم عن معرّف لا يمكن أن يوجد', () => {
    expect(isActivationCode('RS-ABCD')).toBe(false);
    expect(isActivationCode('ABCD-2345')).toBe(false);
    expect(isActivationCode('RS-ABCD-234')).toBe(false);
    expect(isActivationCode('RS-ABC0-2345')).toBe(false);  // صفر ليس في الأبجدية
    expect(isActivationCode('RS-ABCI-2345')).toBe(false);  // I ليست في الأبجدية
    expect(isActivationCode('')).toBe(false);
  });

  it('لا ينفجر على قيمة غائبة', () => {
    expect(isActivationCode(undefined as unknown as string)).toBe(false);
    expect(normalizeCodeQuery(undefined as unknown as string)).toBe('');
  });
});

/**
 * 🔴 حارس: لا `Math.random` في أي مسارٍ يُنتج سرّاً.
 *
 * هذا حارس ضد **النسيان** لا ضد الجهل: من يكتب مولّداً جديداً غداً قد يبدأ بـMath.random
 * لأنه أقصر، ولن يُنبّهه شيء. الاختبار يُنبّهه.
 */
describe('حارس: لوحة المالك', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import[\s\S]*?from\s+'[^']*';$/gm, '');

  const util = read('src/utils/activationCode.ts');
  const panel = read('src/components/AdminPanel.tsx');
  const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');

  it('المسح يرى الملفات فعلاً', () => {
    expect(util).toContain('pickChars');
    expect(panel).toContain('handleGenerate');
    expect(rules).toContain('activationCodes');
  });

  it('🔴 التوليد يستعمل crypto لا Math.random', () => {
    expect(/getRandomValues/.test(util)).toBe(true);
    expect(
      /Math\.random/.test(util),
      'Math.random في V8 هو xorshift128+ — حالته قابلة للاستنتاج، فلا يصلح لمفتاحٍ يُباع',
    ).toBe(false);
  });

  it('🔴 ولا بديل صامت يعود إلى Math.random عند غياب crypto', () => {
    expect(
      /Math\.random|crypto\s*\?|typeof crypto/.test(util),
      'أي fallback صامت يُعيد الثغرة بلا أن يعلم أحد — الفشل الصريح أسلم',
    ).toBe(false);
  });

  it('🔴 اللوحة لا تولّد الأكواد بنفسها', () => {
    expect(/generateActivationCode\(/.test(panel)).toBe(true);
    expect(
      /Math\.random/.test(panel),
      'عودة مولّد محلي في الشاشة تلتفّ على المنطق المحروس',
    ).toBe(false);
  });

  it('🔴 كل توليد يُسجَّل في سجل التدقيق', () => {
    expect(
      /logAudit\(\{[\s\S]{0,400}entity: 'activation_code'/.test(panel),
      'كان توليد المفتاح الذي يُباع العمليةَ الوحيدة بلا أثر — بينما يُسجَّل تعديل سعر منتج',
    ).toBe(true);
    expect(/action: 'create'/.test(panel)).toBe(true);
  });

  it('🟠 التصادم يُفحص على الخادم لا على المحمَّل فقط', () => {
    expect(
      /getDoc\(doc\(db, 'activationCodes', newCode\)\)/.test(panel),
      'الفحص على ٥٠٠ كود محمَّلة بلا ترتيب فحصٌ على عيّنة — وأثر التصادم كودٌ يُباع مرّتين',
    ).toBe(true);
  });

  it('🟠 العدّاد يقول إنه عيّنة حين يبلغ السقف', () => {
    expect(/const capped = codes\.length >= CODES_FETCH_LIMIT/.test(panel)).toBe(true);
    expect(
      /countText\(available\.length\)/.test(panel),
      'رقمٌ صريح على عيّنة اعتباطية يُقرأ كأنه حصر كل أكوادك',
    ).toBe(true);
  });

  it('🟠 البحث يقرأ من الخادم بالمعرّف — فيصل لما هو خارج المعروض', () => {
    expect(/handleSearch/.test(panel)).toBe(true);
    expect(
      /isActivationCode\(/.test(panel),
      'الاستعلام بلا تحقّق من الصيغة نداءٌ عن معرّف لا يمكن أن يوجد',
    ).toBe(true);
  });

  it('🟠 تعليق القواعد لا يناقض القواعد نفسها', () => {
    expect(
      /create \/ delete — ممنوع من الـ client/.test(rules),
      'التعليق كان يقول إن الإنشاء ممنوع بينما allow create مكتوبة تحته — تعليق خاطئ في ملف قواعد أخطر من غيابه',
    ).toBe(false);
    expect(rules).toContain('allow create: if request.auth != null');
  });
});
