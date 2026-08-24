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

  /**
   * الدرجة ٦٠٠ أيضاً تفشل كنصّ على الأسطح الفاتحة — قِيست كلّها:
   *   emerald-600 ⟵ 3.65:1 · amber-600 ⟵ 3.20:1 · teal-600 ⟵ 3.67:1
   *   yellow-600 ⟵ 2.94:1 · rose-600 ⟵ 4.03 على سطحٍ مُلوّن · red-600 ⟵ 4.25
   * والدرجة ٧٠٠ تعبر المعيار على الأبيض وعلى الأسطح الملوّنة معاً.
   */
  it('🔴 ولا الدرجة ٦٠٠ كنصّ على سطحٍ فاتح', () => {
    const RE = /(?<![\w:-])text-(?:emerald|rose|red|amber|yellow|teal)-600(?![\w-])/g;
    const onText: string[] = [];
    for (const f of files) {
      for (const line of read(f).split('\n')) {
        if (!RE.test(line)) continue;
        RE.lastIndex = 0;
        if (isIconLine(line)) continue;
        onText.push(`${f}: ${line.trim().slice(0, 58)}`);
      }
    }
    expect(onText, 'نصٌّ دلاليّ بدرجة ٦٠٠ يفشل على الأبيض — الدرجة ٧٠٠ تعبر').toEqual([]);
  });

  it('🔴 ونصٌّ أبيض لا يقع على خلفيةٍ فاتحة الدرجة', () => {
    // أبيض على emerald-600 ⟵ 3.65:1 · على amber-500 ⟵ 2.13:1 · على amber-600 ⟵ 3.20:1
    const bad: string[] = [];
    for (const f of files) {
      for (const line of read(f).split('\n')) {
        if (!/(?<![\w:-])text-white(?![\w-])/.test(line)) continue;
        if (/(?<![\w:-])bg-(?:emerald-600|amber-500|amber-600)(?![\w-])/.test(line)) {
          bad.push(`${f}: ${line.trim().slice(0, 58)}`);
        }
      }
    }
    expect(bad, 'زرٌّ أو شارةٌ بنصٍّ أبيض على خلفيةٍ لا تحتمله').toEqual([]);
  });

  it('🔴 وتعليقات ١٠px لا تبقى على slate-500', () => {
    // 4.24:1 على خلفية الصفحة الملوّنة — والأصغر يحتاج تبايناً أكثر لا أقلّ
    let n = 0;
    for (const f of files) {
      n += (read(f).match(/text-\[10px\] text-slate-500|text-slate-500 text-\[10px\]/g) ?? []).length;
    }
    expect(n, 'كلّما صغر النصّ احتاج تبايناً أكثر — العشرة تُكتب بـslate-600').toBe(0);
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

/**
 * 🔴 ترويسة الكمبيوتر — سطرٌ واحد، ومبدّل فروعٍ لا يختفي.
 *
 * قِيس على نافذةٍ بعرض ‎1281px (شاشة ‎1920 بتكبير ‎150٪): الترويسة تحتاج ‎894px
 * ولا يتوفّر لها إلا ‎834 بعد القائمة الجانبية. فكانت شرائحها تتكسّر على ثلاثة
 * أسطر وترتفع إلى ‎90px.
 *
 * والحلّ ثلاثي، وكلّ جزءٍ منه لازم:
 *   ١) `whitespace-nowrap` يمنع التكسير.
 *   ٢) التسميات الوصفية تظهر عند `2xl` فقط — والمعلومة (الرقم) تبقى دائماً.
 *   ٣) مبدّل الفروع `md:flex-shrink-0`: بعد منع التكسير صار هو الوحيد القابل
 *      للانكماش فامتصّ الضغط كلّه ووصل عرضه إلى **صفر** — اختفى اسم الفرع الذي
 *      تُنسب إليه العمليات المالية. ويبقى `min-w-0` على الهاتف وإلا فاض ‎15px.
 */
describe('🔴 ترويسة الكمبيوتر', () => {
  const src = read('DashboardLayout.tsx');

  it('شرائح الترويسة لا تتكسّر على أسطر', () => {
    const n = (src.match(/whitespace-nowrap/g) ?? []).length;
    expect(n, 'بلا nowrap ترتفع الترويسة من ٦٨ إلى ٩٠px وتتكسّر ثلاث شرائح').toBeGreaterThanOrEqual(4);
  });

  it('🔴 التسميات الوصفية عند 2xl لا xl — قِيس أن xl لا يسع', () => {
    expect(/hidden 2xl:inline">\{EXCHANGE_RATE_LABEL\}/.test(src)).toBe(true);
    expect(/hidden 2xl:inline">للتواصل: /.test(src)).toBe(true);
    expect(
      /hidden xl:inline">\{EXCHANGE_RATE_LABEL\}/.test(src),
      'عند xl (1280) تحتاج الترويسة 894px ولا يتوفّر إلا 834',
    ).toBe(false);
  });

  it('🔴 ومبدّل الفروع لا ينكمش إلى صفر على الكمبيوتر', () => {
    expect(
      /rounded-xl px-2 md:px-2\.5 py-1\.5 shadow-sm min-w-0 md:flex-shrink-0/.test(src),
      'قِيس فعلاً: عرض قائمة الفروع ٠px — والفرع يُنسب إليه المال',
    ).toBe(true);
  });

  it('ويبقى قابلاً للانكماش على الهاتف (وإلا فاضت الترويسة ١٥px)', () => {
    const line = src.split('\n').find(l => /shadow-sm min-w-0 md:flex-shrink-0/.test(l));
    expect(line, 'لم يُعثر على مبدّل الفروع').toBeTruthy();
    expect(/(?<!md:)flex-shrink-0/.test(line!.replace(/md:flex-shrink-0/g, ''))).toBe(false);
  });

  it('والقيمة تبقى ظاهرة في كل العروض (لا تُخفى مع تسميتها)', () => {
    expect(/\{formatExchangeRateValue\(settings\.exchangeRate\)\}/.test(src)).toBe(true);
    // 🔴 العنصر **المعروض** لا مجرّد ذكر الثابت: `href={`tel:${SUPPORT_PHONE}`}`
    // يطابق أي بحثٍ فضفاض، فيمرّ الحارس ولو حُذف الرقم من الشاشة.
    expect(
      /<span dir="ltr" className="font-sans font-extrabold">\{SUPPORT_PHONE\}<\/span>/.test(src),
      'رقم الدعم يجب أن يبقى مرئياً — المُخفى هو كلمة «للتواصل» وحدها',
    ).toBe(true);
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
