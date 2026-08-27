import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileTooLargeMessage, MAX_IMPORT_BYTES } from '../csv';

/**
 * 🔒 بنود التحصين الصغيرة — كلٌّ منها سطرٌ أو سطران، وكلٌّ منها كان بابَ علّة.
 */

/**
 * ⚠️ مُزيل التعليقات هنا يشترط أن يبدأ التعليق **في أول السطر**.
 *
 * الصياغة الشائعة (`/\/\*[\s\S]*?\*\//g`) تنكسر على الروابط: `https://*.googleapis.com`
 * يحوي `/*`، فيظنّه المُزيل بدايةَ تعليق كتلة ويبتلع كل ما بعده حتى أول `*​/` — فيمسح
 * كوداً حقيقياً ويجعل الحارس يمرّ كذباً على ملفٍ لم يُقرأ أصلاً.
 *
 * وقعتُ فيها في أول صياغة لهذا الملف: سقط شرطا `object-src` و`frame-src` لأن سطر
 * `connect-src` قبلهما يحوي `https://*` فابتلع بقية المصفوفة. وفحصتُ باقي المشروع
 * فلم يتأثّر ملفٌ آخر — لا حارس قائم فسد بها.
 */
const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8')
  .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('🔴 ISSUE-013 — حدّ حجم الملف المستورد', () => {
  it('الملف الطبيعي يمرّ بلا رسالة', () => {
    expect(fileTooLargeMessage({ size: 2 * 1024 * 1024 })).toBeNull();
    expect(fileTooLargeMessage({ size: MAX_IMPORT_BYTES })).toBeNull();
  });

  it('🔴 والضخم يُرفض برسالة تقول الحجم والحدّ وماذا يفعل', () => {
    const m = fileTooLargeMessage({ size: 500 * 1024 * 1024 });
    expect(m).toMatch(/٥٠٠|500/);
    expect(m).toMatch(/٢٠|20/);
    expect(m, 'رسالةٌ بلا إرشاد تترك التاجر عالقاً').toMatch(/قسّمه/);
  });

  it('🔴 والمسارات كلها تفحص قبل القراءة لا بعدها', () => {
    const csv = read('src/utils/csv.ts');
    expect(
      /const tooLarge = fileTooLargeMessage\(file\);[\s\S]{0,80}reject/.test(csv),
      'الفحص بعد readAsText بلا فائدة — الذاكرة تكون قد امتلأت',
    ).toBe(true);
    expect(/fileTooLargeMessage\(file\)/.test(read('src/components/BackupView.tsx'))).toBe(true);
  });

  it('🔴 ورسالة التجاوز لا تُطمس برسالة عامة', () => {
    expect(
      /setError\(\(e as Error\)\?\.message/.test(read('src/components/BulkImportModal.tsx')),
      'كان catch يستبدلها بـ«تعذّر قراءة الملف» فيضيع سبب الرفض',
    ).toBe(true);
  });
});

describe('🔴 ISSUE-014 — التواريخ محلية لا UTC', () => {
  it('لا `toISOString().split` في مسار إنشاء سجل', () => {
    for (const f of ['src/components/ProductsView.tsx', 'src/utils/bulkImport.ts']) {
      expect(
        /createdAt:[^,\n]*toISOString\(\)\.split/.test(read(f)),
        `${f}: تاريخ UTC يختم سجلاً أُنشئ ليلاً بتاريخ الأمس (العراق UTC+3)`,
      ).toBe(false);
    }
  });

  it('وكلاهما يستعمل todayISO المحلية', () => {
    expect(/createdAt: todayISO\(\)/.test(read('src/components/ProductsView.tsx'))).toBe(true);
    expect((read('src/utils/bulkImport.ts').match(/createdAt: match\?\.createdAt \?\? todayISO\(\)/g) ?? []).length).toBe(2);
  });
});

describe('🟡 ISSUE-021 — اسم الفاعل حقيقي في سجل التدقيق', () => {
  it('لا اسم مثبّت في شاشة الموظفين', () => {
    const v = read('src/components/EmployeeManagement.tsx');
    expect(
      /actorName: 'المالك'/.test(v),
      'اسمٌ مثبّت يُضيع من السجل **من فعلها فعلاً** — وهو غرض السجل كلّه',
    ).toBe(false);
    expect((v.match(/actorName: actor\.name/g) ?? []).length).toBe(4);
  });
});

describe('🟡 ISSUE-017 — فحص المسار في خادم Electron المحلي', () => {
  const main = read('electron/main.cjs');

  it('يفكّ الترميز قبل الفحص', () => {
    expect(
      /decodeURIComponent/.test(main),
      'بلا فكّ ترميز يمرّ %2e%2e%2f نصّاً حرفياً فيُفحص مسارٌ غير الذي يُقرأ',
    ).toBe(true);
  });

  it('🔴 والمقارنة بحدّ فاصل لا بنصّ عارٍ', () => {
    expect(
      /filePath\.startsWith\(distDir\)/.test(main),
      'المقارنة النصّية تمرّ على مجلد شقيق يبدأ بنفس الحروف (dist-evil يبدأ بـdist)',
    ).toBe(false);
    expect(/rootWithSep/.test(main)).toBe(true);
  });

  it('والترميز التالف يُرفض بدل أن ينفجر', () => {
    expect(/res\.writeHead\(400\)/.test(main)).toBe(true);
  });
});

describe('🔴 ISSUE-015 — سياسة أمان المحتوى', () => {
  const cfg = read('vite.config.ts');

  it('CSP يُحقن في البناء وحده', () => {
    expect(/apply: 'build'/.test(cfg), 'حقنه في التطوير يُعطّل HMR بلا فائدة أمنية').toBe(true);
    expect(/Content-Security-Policy/.test(cfg)).toBe(true);
  });

  it('🔴 يمنع النطاقات المجهولة ويسمح بما يحتاجه فايربيس فعلاً', () => {
    expect(/default-src 'self'/.test(cfg)).toBe(true);
    expect(/object-src 'none'/.test(cfg)).toBe(true);
    // اكتُشف بالاختبار الفعلي: Firebase Analytics يُحمّل googletagmanager وكان محجوباً
    expect(
      /googletagmanager/.test(cfg),
      'حجبُه يُعطّل getAnalytics ويملأ طرفية التاجر بانتهاكات',
    ).toBe(true);
    // تسجيل الدخول بحساب غوغل يحتاجهما — وحجبهما يكسر الدخول تماماً
    expect(/apis\.google\.com/.test(cfg)).toBe(true);
    expect(/frame-src[^"]*accounts\.google\.com/.test(cfg)).toBe(true);
  });

  it('🔴 ولا يفتح script-src على مصراعيه', () => {
    const scriptSrc = (cfg.match(/"script-src[^"]*"/) ?? [''])[0];
    expect(scriptSrc).not.toMatch(/'unsafe-eval'/);
    expect(scriptSrc, "'unsafe-inline' في script-src يُبطل الحماية كلها").not.toMatch(/'unsafe-inline'/);
    expect(scriptSrc).not.toMatch(/\*[^.]/);
  });
});

/**
 * 🔴 وصلة المحاكي لا تصل الزبون أبداً.
 *
 * أُضيفت `connectFirestoreEmulator`/`connectAuthEmulator` في `firebase.ts` لفتح
 * الشاشات للفحص بحسابٍ تجريبي. وتسرّبُها إلى نسخة الإنتاج كارثة صامتة: برنامج
 * **كل زبون** يبحث عن قاعدة بيانات على جهازه هو، فلا يدخل أحدٌ ولا يُحفظ شيء —
 * ولا رسالة خطأ تقول السبب.
 *
 * والحراسة شرطان: `import.meta.env.DEV` (تستبدلها Vite بـ`false` نصّياً فتُشجَّر
 * الكتلة كاملةً) ثم متغيّر بيئةٍ صريح. وهذا الاختبار يفحص **المصدر**، ويُكمله
 * فحصُ الحزمة المبنيّة في `npm run build` (قِيس: صفر أثرٍ في خمسة ملفات).
 */
describe('🔴 محاكي فايربيس محبوسٌ في التطوير', () => {
  const fb = read('src/firebase.ts');

  it('المسح يرى الملف', () => {
    expect(fb).toContain('initializeFirestore');
  });

  it('🔴 الشرط مزدوج — DEV **و** متغيّر بيئة صريح', () => {
    expect(fb).toContain("import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === '1'");
  });

  it('🔴 ولا وصلة خارج هذا الشرط', () => {
    // كل استدعاء وصلٍ يجب أن يقع داخل كتلة `if (USE_EMULATORS)`
    const block = fb.slice(fb.indexOf('if (USE_EMULATORS)'), fb.indexOf('/** التحليلات'));
    expect(block.length, 'المسح وجد كتلة الحارس').toBeGreaterThan(50);
    for (const fn of ['connectFirestoreEmulator', 'connectAuthEmulator']) {
      // مرّتان بالضبط: سطر الاستيراد + الاستدعاء الوحيد داخل الحارس
      expect(fb.split(fn).length - 1, `${fn}: استيرادٌ واستدعاءٌ واحد لا أكثر`).toBe(2);
      expect(block, `${fn} يقع داخل كتلة الحارس`).toContain(`${fn}(`);
    }
  });

  it('🔴 والحارس ثابتٌ لا متغيّر يُبدَّل وقت التشغيل', () => {
    expect(/const USE_EMULATORS = /.test(fb), 'ثابت لا `let`').toBe(true);
    expect(/let USE_EMULATORS/.test(fb)).toBe(false);
  });

  it('والتحليلات تُعطَّل مع المحاكي', () => {
    expect(fb).toContain('!USE_EMULATORS');
  });
});

/**
 * 🔴 سجلٌّ ناقصٌ لا يُسقط شاشة.
 *
 * كُشف بالضغط الفعلي على الشاشة: حركةٌ مالية بلا `title` جعلت
 * `t.title.toLowerCase()` ترمي، فسقطت **شاشة المصاريف كلها** إلى
 * «حدث خلل في هذه الشاشة» — لا السطر التالف وحده.
 *
 * وحقلٌ ناقص ليس فرضاً: استعادةُ نسخةٍ قديمة، أو استيرادٌ من صيغةٍ سابقة، أو
 * كتابةٌ انقطعت. والمحلّ الذي لا يرى مصاريفه بسبب سطرٍ واحد أسوأ من محلٍّ يراها
 * وفيها سطرٌ بلا عنوان.
 */
/**
 * 🔴 الحارس يشمل **كل** نسخة فايربيس — لا الأصلية وحدها.
 *
 * كُشف بالدخول الفعلي بحساب موظف: إنشاء الموظف يفتح نسخةً ثانوية كي لا تنكسر جلسة
 * المالك، وتلك النسخة كانت تستدعي `getAuth` بلا وصلِ محاكٍ. فبينما الفحص يجري في
 * صندوقٍ معزول ظاهرياً، **ذهب الحساب إلى مشروع الإنتاج الحيّ** بينما كُتبت وثيقته في
 * المحاكي — موظفٌ لا يدخل محلياً، وحسابٌ يتيم في مشروع التاجر. بلا خطأ ولا تحذير.
 *
 * والحارس الأول (`hardening` أعلاه) لم يمسكها لأنه يفحص `firebase.ts` وحده. فالمسح
 * هنا يعمّ الشجرة كلّها: أي `getAuth` جديد في أي ملف يجب أن يُوصَل أو يُحرَس.
 */
describe('🔴 وصل المحاكي يعمّ كل نسخ فايربيس', () => {
  /** يمشي شجرة `src` ويُعيد كل ملفات المصدر. */
  const walk = (dir: string): string[] => readdirSync(join(process.cwd(), dir), { withFileTypes: true })
    .flatMap(e => {
      if (e.name === '__tests__' || e.name === 'node_modules') return [];
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) return walk(rel);
      return /\.tsx?$/.test(e.name) ? [rel] : [];
    });

  const files = walk('src');

  it('المسح يرى الشجرة', () => {
    expect(files.length, 'مسحٌ فارغ يجعل كل ما تحته يمرّ كذباً').toBeGreaterThan(20);
    expect(files).toContain('src/firebase.ts');
    expect(files).toContain('src/components/EmployeeManagement.tsx');
  });

  it('🔴 كل نسخة مصادقة إمّا موصولة بالمحاكي أو محروسة', () => {
    const offenders = files.filter(f => {
      const src = read(f);
      if (!/getAuth\(/.test(src)) return false;
      // يكفي أن يحوي الملف وصلاً للمحاكي — والحارس نفسه يُفحص في الاختبار التالي
      return !/connectAuthEmulator\(/.test(src);
    });
    expect(
      offenders,
      'نسخةٌ بلا وصلِ محاكٍ تكتب في الإنتاج أثناء الفحص — صامتةً',
    ).toEqual([]);
  });

  it('🔴 والنسخة الثانوية تحت الحارس نفسه لا حارسٍ مُكرَّر', () => {
    const em = read('src/components/EmployeeManagement.tsx');
    expect(em).toContain('connectAuthEmulator(secondaryAuth');
    expect(em, 'الوصل خارج الحارس يتسرّب للإنتاج').toContain('if (USE_EMULATORS)');
    expect(
      /import\s*\{[^}]*USE_EMULATORS[^}]*\}\s*from\s*'\.\.\/firebase'/.test(em),
      'الحارس يُستورد من مصدرٍ واحد — نسخةٌ ثانية منه تفترق عنه يوماً',
    ).toBe(true);
    expect(/(const|let)\s+USE_EMULATORS/.test(em), 'لا تعريف محلّي يُظلّل المُصدَّر').toBe(false);
  });
});

describe('🔴 حقلٌ ناقص يُعرَض ناقصاً ولا يُسقط الشاشة', () => {
  const src = read('src/components/ExpensesView.tsx');

  it('المسح يرى الملف', () => {
    expect(src).toContain('filteredList');
  });

  it('🔴 البحث في العنوان محروسٌ من الغياب', () => {
    expect(src).toContain("(t.title ?? '').toLowerCase()");
    expect(
      /[^?]\bt\.title\.toLowerCase\(\)/.test(src),
      'وصولٌ مباشر بلا حارس يُعيد العطل',
    ).toBe(false);
  });

  it('والسلوك نفسه: نصٌّ غائب يُعامَل فراغاً لا استثناءً', () => {
    const rows = [{ title: 'إيجار' }, { title: undefined }, {}] as Array<{ title?: string }>;
    const search = 'إي';
    // نفس تعبير الشاشة حرفياً
    const run = () => rows.filter(t => (t.title ?? '').toLowerCase().includes(search.toLowerCase()));
    expect(run).not.toThrow();
    expect(run()).toHaveLength(1);
  });
});
