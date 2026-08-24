import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * حُرّاس الوضوح البصري.
 *
 * وُلدت من تدقيقٍ قِيس في المتصفّح على ٢٦ شاشة: ٦٩٧ موضعاً تحت ١٢px، و٤٣١ موضع
 * تباينٍ فاشل، وأصغر نصّ ٨px بتباين ٢٫١٣:١. وكلها أنماطٌ تعود بسهولة مع أول
 * مكوّنٍ جديد يُنسخ من مكوّنٍ قديم — فتُحرَس هنا بدل أن تُكتشف عند التاجر.
 */

const COMP = join(process.cwd(), 'src', 'components');
const files = readdirSync(COMP).filter(n => n.endsWith('.tsx'));

/** سطرُ أيقونة: وسمُ مكوّنٍ بحرفٍ كبير مع مقاس `w-N` — زخرفة لا نصّ يُقرأ. */
const isIconLine = (l: string) => /<[A-Z]\w*\s[^>]*className="[^"]*\bw-\d/.test(l);

/** يقرأ ملفاً مجرَّداً من التعليقات — وإلا حسب الحارسُ شرحَ العلّة مخالفةً. */
const read = (f: string) =>
  readFileSync(join(COMP, f), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');

it('المسح يرى الملفات فعلاً (حماية من فحصٍ فارغ يمرّ كذباً)', () => {
  expect(files.length).toBeGreaterThan(30);
  expect(files).toContain('InvoicesView.tsx');
});

describe('🔴 حجم الخط الأدنى', () => {
  it('🔴 لا نصّ أصغر من ١٠px في أي شاشة', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        if (parseFloat(m[1]) < 10) bad.push(`${f}: ${m[0]}`);
      }
    }
    expect(
      bad,
      'العربية عند ٩px ارتفاع حرفها ١٠px، والنقاط التي تُميّز ب/ت/ث تصير أقلّ من بكسل',
    ).toEqual([]);
  });
});

describe('🔴 تباين النصوص الثانوية', () => {
  /**
   * القيم مقيسة في المتصفّح (Tailwind v4 يكتب OKLCH، وهذه نتائجها بـsRGB):
   *   slate-300 #cad5e2 ⟵ 1.49:1   slate-400 #90a1b9 ⟵ 2.63:1
   *   slate-500 #62748e ⟵ 4.76:1   والمعيار 4.5:1
   * ولا تُمنع مطلقاً: على الترويسات الكحلية اللونُ الفاتح **هو الصحيح**.
   */
  /**
   * ما تبقّى بعد الإصلاح، وقد أُحصي وصُنّف:
   *   · ٣٩ في ترويساتٍ كحلية وشريطٍ جانبي — اللون الفاتح **هو الصحيح** هناك.
   *   · ١٨ على أيقوناتٍ زخرفية كبيرة (شاشات فارغة) — لا نصّ يُقرأ.
   * فالحدّ ليس رقماً سحرياً بل مجموعُ حالتين مشروعتين، وأي زيادة تعني عودة
   * اللون الباهت إلى نصٍّ على سطحٍ فاتح.
   */
  const LEGIT_DARK = 39;
  const LEGIT_ICONS = 18;

  const countSlateFaint = (pred: (line: string) => boolean) => {
    let n = 0;
    for (const f of files) {
      for (const line of read(f).split('\n')) {
        if (!pred(line)) continue;
        n += (line.match(/(?<![\w:-])text-slate-(?:400|300)(?![\w-])/g) ?? []).length;
      }
    }
    return n;
  };
  it('🔴 لا يعود اللون الباهت إلى نصٍّ على سطحٍ فاتح', () => {
    const onText = countSlateFaint(l => !isIconLine(l));
    expect(
      onText,
      `${onText} موضعاً — المشروع منها ${LEGIT_DARK} في ترويساتٍ كحلية. `
      + 'الزيادة تعني نصّاً بتباين 2.63:1 على أبيض، والمعيار 4.5:1',
    ).toBeLessThanOrEqual(LEGIT_DARK);
  });

  it('والأيقونات الزخرفية لا تتكاثر', () => {
    expect(countSlateFaint(isIconLine)).toBeLessThanOrEqual(LEGIT_ICONS);
  });

  it('🔴 ولا ألوان دلالية فاتحة كنصّ على أسطحٍ فاتحة', () => {
    // amber-500 ⟵ 2.13:1 · emerald-500 ⟵ 2.47:1 · rose-500 ⟵ 3.75:1 · red-500 ⟵ 3.81:1
    const RE = /(?<![\w:-])text-(?:amber|emerald|rose|red)-500(?![\w-])/g;
    const onText: string[] = [];
    let onIcons = 0;
    for (const f of files) {
      for (const line of read(f).split('\n')) {
        const hits = (line.match(RE) ?? []).length;
        if (!hits) continue;
        if (isIconLine(line)) onIcons += hits;
        else onText.push(`${f}: ${line.trim().slice(0, 58)}`);
      }
    }
    expect(
      onText,
      'نصٌّ يحمل معنى (تحذير/نجاح/خطر) بتباينٍ دون المعيار — الكهرماني 2.13:1',
    ).toEqual([]);
    expect(onIcons, 'والأيقونات الدلالية لا تتكاثر').toBeLessThanOrEqual(4);
  });
});

describe('🔴 أصناف Tailwind الساقطة صامتةً', () => {
  it('لا درجة لونٍ خارج اللوحة', () => {
    const bad = new Set<string>();
    for (const f of files) {
      for (const m of read(f).matchAll(
        /(?<![\w-])(?:text|bg|border|divide|ring)-(?:slate|gray|zinc|red|rose|amber|emerald|blue|indigo|violet|teal)-(?:150|250|350|450|550|650|750|850)(?![\w-])/g,
      )) bad.add(m[0]);
    }
    expect(
      [...bad],
      'الدرجات ١٥٠/٢٥٠/٣٥٠… لا وجود لها في Tailwind. وأخطرها حدٌّ: لون الحدّ '
      + 'الافتراضي في v4 هو currentColor، فيُرسم كحولياً داكناً بدل الرمادي المقصود',
    ).toEqual([]);
  });
});

describe('🔴 أهداف اللمس في مسار البيع', () => {
  it('مربّعات اختيار الفواتير ليست ١٤px', () => {
    const src = read('InvoicesView.tsx');
    expect(
      /type="checkbox"[\s\S]{0,220}w-3\.5 h-3\.5/.test(src),
      'إصبعٌ لا يُصيب مربّعاً بـ١٤px — والتحديد بوابة الطباعة',
    ).toBe(false);
    expect(/w-5 h-5 accent-\[#0B1F4D\]/.test(src), 'لم يُعثر على المقاس المُصلَح').toBe(true);
  });

  it('أزرار الكمية في المخزون ≥ ٣٦px', () => {
    const src = read('ProductsView.tsx');
    expect(
      /w-[67] h-[67] rounded-lg bg-(?:blue|rose)-50/.test(src),
      'أزرار ‎+/− بـ٢٤ أو ٢٨px في يد الكاشير يومياً',
    ).toBe(false);
    expect(/w-9 h-9 rounded-lg bg-blue-50/.test(src)).toBe(true);
  });
});

describe('🔴 صفّ الدين لا يبتلع اسم الزبون', () => {
  const src = read('DebtView.tsx');

  it('🔴 يتكدّس على الهاتف — الجانب الأيسر flex-shrink-0 كان يترك ٠px للاسم', () => {
    // الصفّان معاً (الديون النشطة والمسدَّدة) — إصلاح أحدهما يترك الآخر مكسوراً
    expect(
      (src.match(/flex flex-col sm:flex-row sm:items-center justify-between px-4 py-4/g) ?? []).length,
      'قِيس فعلاً: عرض اسم الزبون ٠px على ٣٧٥px — دَينٌ بلا صاحب',
    ).toBe(2);
    expect(
      /flex items-center justify-between px-4 py-4 gap-3"/.test(src),
      'بقي صفٌّ أفقيّ بلا تكدّس على الهاتف',
    ).toBe(false);
  });

  it('ويبقى أفقياً على الكمبيوتر', () => {
    expect(/sm:flex-row/.test(src)).toBe(true);
  });

  it('واسم الزبون المقصوص يُكشف بـtitle', () => {
    expect(
      (src.match(/title=\{customer\.name\}[^>]{0,120}truncate/g) ?? []).length,
      'الاسم يظهر في صفّين — كشفُ أحدهما لا يكفي',
    ).toBe(2);
  });
});

describe('النصوص المقصوصة تُكشف عند التحويم', () => {
  it('نسبةٌ معتبرة من مواضع truncate تحمل title', () => {
    let withTitle = 0, total = 0;
    for (const f of files) {
      const lines = read(f).split('\n');
      lines.forEach((l, i) => {
        if (!/\btruncate\b/.test(l)) return;
        total++;
        const ctx = [lines[i - 1] ?? '', l, lines[i + 1] ?? ''].join(' ');
        if (/title=/.test(ctx)) withTitle++;
      });
    }
    expect(total).toBeGreaterThan(20);
    expect(
      withTitle,
      'اسمان يبدآن بنفس الكلمات يظهران متطابقين بعد القصّ — فيختار التاجر الخطأ',
    ).toBeGreaterThanOrEqual(20);
  });
});
