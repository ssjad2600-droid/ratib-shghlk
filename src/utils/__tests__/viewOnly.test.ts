import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isViewOnly, assertWritable, ViewOnlyError, isViewOnlyError, VIEW_ONLY_MESSAGE,
} from '../viewOnly';
import { MOBILE_SCREENS } from '../mobileNav';

/**
 * 🔴 نسخة الهاتف للاطّلاع فقط — لا بيع، ولا إصدار فواتير، ولا أي كتابة.
 *
 * القرار من صاحب البرنامج: الهاتف يُطالِع ما يصدر من حساب الكمبيوتر — الفواتير
 * والأرباح والتفاصيل المالية — ولا يكتب شيئاً. لا تسديد دين، ولا نسخة احتياطية.
 *
 * وهذا الملف يحرس الأمرين معاً: **السلوك** (الحارس يرمي فعلاً) و**التغطية** (لا
 * مسار كتابةٍ يتخطّى البوّابة). والثاني هو الذي يبقى نافعاً بعد سنة، حين تُضاف
 * شاشةٌ جديدة وينسى كاتبها القاعدة.
 */

const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8')
  .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('🔴 الحارس نفسه', () => {
  it('الكمبيوتر يكتب — والهاتف لا', () => {
    expect(isViewOnly(false), 'نسخة الكمبيوتر يجب ألّا تتأثّر إطلاقاً').toBe(false);
    expect(isViewOnly(true)).toBe(true);
  });

  it('🔴 `assertWritable` تمرّ على الكمبيوتر وترمي على الهاتف', () => {
    expect(() => assertWritable(false)).not.toThrow();
    expect(() => assertWritable(true)).toThrow(ViewOnlyError);
  });

  it('🔴 والرسالة تقول للتاجر أين يُنفّذها', () => {
    expect(VIEW_ONLY_MESSAGE).toMatch(/الكمبيوتر/);
    expect(VIEW_ONLY_MESSAGE, 'رسالةٌ بلا بديل تترك التاجر عالقاً').toMatch(/اطّلاع/);
  });

  it('والخطأ يُميَّز عن أخطاء الشبكة والصلاحيات', () => {
    expect(isViewOnlyError(new ViewOnlyError())).toBe(true);
    expect(isViewOnlyError(new Error('permission-denied'))).toBe(false);
    expect(isViewOnlyError(null)).toBe(false);
  });
});

describe('🔴 التغطية — لا مسار كتابةٍ خارج البوّابة', () => {
  const walk = (dir: string): string[] => readdirSync(join(process.cwd(), dir), { withFileTypes: true })
    .flatMap(e => {
      if (e.name === '__tests__') return [];
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) return walk(rel);
      return /\.tsx?$/.test(e.name) ? [rel] : [];
    });

  const components = walk('src/components');

  it('المسح يرى الشاشات', () => {
    expect(components.length, 'مسحٌ فارغ يجعل كل ما تحته يمرّ كذباً').toBeGreaterThan(30);
  });

  it('🔴 لا شاشة تُنشئ دفعةً مباشرةً — كلّها من `newBatch`', () => {
    const offenders = components.filter(f => /writeBatch\s*\(\s*db\s*\)/.test(read(f)));
    expect(
      offenders,
      'إنشاءٌ مباشر يتخطّى الحارس فيكتب من الهاتف — استعمل newBatch() من utils/firestoreWrite',
    ).toEqual([]);
  });

  /**
   * 🔴 والكتابة المفردة تتخطّى البوّابة تماماً كما تتخطّاها الدفعة.
   *
   * كُشفت **بالنظر إلى الشاشة** على مقاس هاتف: عدّاد الكمية `- ٢ +` في شاشة
   * المخزون يكتب بـ`updateDoc` مباشرةً — لا دفعةً ولا `useCollection` — وهو
   * يُنقص مخزوناً حقيقياً. ومعه سبعةٌ مثله. أي أن «كل الكتابات محروسة» كانت
   * دعوى غير صحيحة، ولا اختبارٌ كان يكشفها لأن كلّها كانت تفحص الدفعات.
   *
   * ⚠️ والاستثناء الوحيد `useTrialAnchor`: يكتب أختام ترخيصٍ لا بيانات تاجر،
   * وهو تلقائيٌّ داخل `useEffect` — فمنعُه يكسر حماية التجربة، ورميُه يُسقط
   * الشاشة. مذكورٌ هنا صراحةً كي يبقى استثناءً معروفاً لا ثغرةً منسيّة.
   */
  it('🔴 لا كتابة مفردة تتخطّى البوّابة', () => {
    const EXEMPT = ['src/hooks/useTrialAnchor.ts', 'src/hooks/useCollection.ts', 'src/hooks/useProfile.ts'];
    const files = [...walk('src/components'), ...walk('src/hooks')];
    const offenders: string[] = [];
    for (const f of files) {
      if (EXEMPT.includes(f)) continue;
      const src = read(f);
      /**
       * ⚠️ `matchAll` لا `match`: الملف قد يحوي **أكثر من استيراد** من
       * `firebase/firestore`. وأول كتابةٍ فحصت الأول وحده، فمرّت الطفرة التي
       * تُضيف سطراً ثانياً — وهي أقرب صورةٍ للخطأ الحقيقي: أحدهم يحتاج
       * `updateDoc` فيكتب سطر استيرادٍ جديداً بدل أن يمسّ القائم.
       */
      /**
       * ⚠️ `[^}]*` لا `[\s\S]*?`: الكسول يعبر قوس الإغلاق فيبتلع استيراداً
       * آخر بين القوس و`from 'firebase/firestore'`، فيخرج التقاطٌ ملوّث لا
       * يطابق أي اسم. قِسْتُه: أول صياغةٍ لم تكشف الطفرة الأصلية بسببه.
       */
      for (const fsImport of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'firebase\/firestore';/g)) {
        const names = fsImport[1].split(',').map(s => s.trim());
        for (const banned of ['updateDoc', 'setDoc', 'deleteDoc', 'writeBatch']) {
          if (names.includes(banned)) offenders.push(`${f}: ${banned}`);
        }
      }
    }
    expect(
      offenders,
      'استيرادٌ مباشر من firebase/firestore يتخطّى الحارس — استورده من utils/firestoreWrite',
    ).toEqual([]);
  });

  it('🔴 والبوّابة تحرس الكتابات المفردة الثلاث', () => {
    const gate = read('src/utils/firestoreWrite.ts');
    for (const fn of ['updateDoc', 'setDoc', 'deleteDoc']) {
      expect(gate, `${fn} غير مُصدَّرة من البوّابة`).toContain(`export const ${fn}`);
    }
    // ثلاث كتاباتٍ مفردة + الدفعة = أربعة حرّاس
    expect((gate.match(/assertWritable\(\)/g) ?? []).length).toBe(4);
  });

  it('🔴 والبوّابة تحرس قبل أن تُنشئ', () => {
    const gate = read('src/utils/firestoreWrite.ts');
    expect(gate).toContain('assertWritable()');
    // الترتيب شرط: حارسٌ بعد الإنشاء يترك الدفعة مبنيّةً ثم يفشل
    expect(
      gate.indexOf('assertWritable()') < gate.indexOf('return writeBatch'),
      'الحارس يجب أن يسبق الإنشاء',
    ).toBe(true);
  });

  /**
   * 🔴 صيانةٌ تلقائية داخل `useEffect` تتخطّى ولا ترمي.
   *
   * كُشف في مراجعة العمل قبل الالتزام: ثلاثة آثارٍ تلقائية (ترحيل مرآة الزبائن،
   * ترميم روابط الفواتير، ترقيم الموظفين) تُنشئ دفعةً بلا `try`. و`newBatch()`
   * ترمي في نسخة الهاتف، والرمي داخل `useEffect` **لا يلتقطه أحد** — فتسقط
   * الشاشة كلّها إلى «حدث خلل» بمجرّد فتحها.
   *
   * وهذه صيانةٌ لا فعلَ مستخدم: تُتخطّى بصمت ويُتمّها الكمبيوتر.
   */
  it('🔴 الصيانة التلقائية تتخطّى في الهاتف ولا ترمي', () => {
    /**
     * ⚠️ الثلاثة الأخيرة خطّافات ترحيلٍ تلقائية كشفها حارس «الكتابة المفردة»
     * بعد إصلاح نمطه — وكانت تكتب من الهاتف فعلاً بـ`writeBatch` خام، أي أن
     * ضمان «لا كتابة من الهاتف» كان **مثقوباً** وأنا أظنّه تامّاً.
     */
    const autoEffects: Array<[string, string]> = [
      ['src/components/CustomersView.tsx', 'mirrorMigrationRan.current'],
      ['src/components/InvoicesView.tsx', 'repairRanRef.current'],
      ['src/components/EmployeeManagement.tsx', 'backfilled.current'],
      ['src/hooks/useBranchStockMigration.ts', "role !== 'owner'"],
      ['src/hooks/useBuyPriceMigration.ts', "role !== 'owner'"],
      ['src/hooks/useEmployeeDebtFold.ts', "role !== 'owner'"],
    ];
    for (const [file, sentinel] of autoEffects) {
      const src = read(file);
      const at = src.indexOf(`if (${sentinel}`);
      expect(at, `${file}: المسح وجد الأثر التلقائي`).toBeGreaterThan(-1);
      // الحارس يسبق حارسَ التكرار — أي في رأس الأثر تماماً
      const before = src.slice(Math.max(0, at - 200), at);
      expect(
        before.includes('isViewOnly()'),
        `${file}: أثرٌ تلقائي يُنشئ دفعةً بلا تخطٍّ — يرمي فيُسقط الشاشة على الهاتف`,
      ).toBe(true);
    }
  });

  /**
   * 🔴 كل شاشةٍ يصلها الهاتف وتكتب، أزرارها محفوفة.
   *
   * الحارس في `assertWritable` يمنع الكتابة مهما جرى — لكنّه يمنعها **بالرمي**،
   * فيرى التاجر زرّاً يضغطه ولا يحدث شيء. وهذا هو بالضبط ما تحذّر منه شيفرة
   * المشروع نفسها: «زرٌّ يفشل دائماً أسوأ من زرٍّ غائب».
   *
   * والاختبار يربط حقيقتين تعيشان في ملفّين: **ما يصله الهاتف** (`mobileNav`)
   * و**ما يكتب** (المكوّن). فإضافة شاشةٍ كاتبة إلى قائمة الهاتف بلا لفّ أزرارها
   * تُسقط هذا الاختبار — وهو الخطأ الذي يقع بسهولة، لأن الملفين لا يذكر أحدهما
   * الآخر.
   */
  /**
   * ⚠️ القائمة **تُشتقّ** من `MOBILE_SCREENS` و`App.tsx` — لا تُكتب هنا بيدٍ.
   *
   * 🔴 أول كتابةٍ لهذا الاختبار عدّدت الشاشات الثماني يدوياً. فمرّ الاختبار،
   * ثم زرعتُ الخطأ الحقيقي — إضافة `inventory-adjustments` (شاشةٌ كاتبة) إلى
   * قائمة الهاتف — **فلم يكشفه**: لأنها ليست في قائمتي فلا شيء يفحصها.
   *
   * وهذا هو عيب الحرّاس المُعدَّدة يدوياً كلّها: تحرس ما تعرفه، والخطأ يأتي
   * دائماً مما لا تعرفه. فصارت تُقرأ من مصدر الحقيقة نفسه.
   */
  const screenFiles = (() => {
    const app = read('src/App.tsx');
    const map: Record<string, string> = {};
    // case 'id': … <ComponentName …
    const re = /case '([a-z-]+)':[\s\S]{0,400}?<([A-Z][A-Za-z0-9]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(app)) !== null) {
      if (!map[m[1]]) map[m[1]] = `src/components/${m[2]}.tsx`;
    }
    return map;
  })();

  it('استخراج الشاشات من App.tsx يعمل', () => {
    expect(Object.keys(screenFiles).length, 'مسحٌ فارغ يجعل ما تحته يمرّ كذباً')
      .toBeGreaterThan(15);
    expect(screenFiles['invoices']).toBe('src/components/InvoicesView.tsx');
  });

  /**
   * 🔴 هذه القائمة تُكتب صراحةً — وهي الاستثناء المقصود.
   *
   * الاختبار السابق يشتقّ ما يجب اشتقاقه (أي شاشةٍ تكتب). أمّا **أيّ شاشاتٍ
   * يراها التاجر على هاتفه** فقرارُ صاحب البرنامج لا حقيقةٌ في الشيفرة —
   * ولا يُشتقّ من شيء. فيُكتب هنا، ويسقط الاختبار إن سُحبت إحداها بصمت.
   *
   * وهي الأربع التي أُضيفت لمّا صار الهاتف للاطّلاع: أهمّ شاشات الأرباح
   * والذمم، وكانت كلّها خارجه.
   */
  /**
   * 🔴 القشرة تُقرَّر بالمنصّة لا بعرض الشاشة.
   *
   * كُشفت على جهازٍ حقيقي: التاجر أدار هاتفه أفقياً **فظهر البرنامج كاملاً كما
   * على الكمبيوتر** — القائمة الجانبية بشاشاتها كلّها، ونموذج إصدار الفواتير،
   * وتقفيل الصندوق، وتسوية المخزون. لأن `md:` حدٌّ بعرض ٧٦٨px، وهاتفٌ أفقياً
   * يبلغ ~٨٠٠px فيُحسب كمبيوتراً.
   *
   * ولم يضع المال — `assertWritable` تمنع الكتابة مهما جرى — لكنّ التاجر كان
   * يملأ فاتورةً ويضغط «حفظ» فلا يحدث شيء. أي أن الطبقتين الأولى والثانية
   * كانتا تنهاران بإدارة المعصم.
   *
   * ⚠️ ولا يُقفَل الاتجاه رأسياً: أندرويد ١٦ (targetSdk ٣٦) يتجاهل
   * `screenOrientation` على الشاشات الكبيرة عمداً.
   */
  it('🔴 قشرة الهاتف لا تنكسر بالعرض — تُقرَّر بالمنصّة', () => {
    const layout = read('src/components/DashboardLayout.tsx');
    const invoices = read('src/components/InvoicesView.tsx');

    // القائمة الجانبية ونموذج الإصدار: مشروطان بالمنصّة لا بـmd وحدها
    expect(layout, 'القائمة الجانبية').toContain("shellClass('hidden md:flex', 'hidden')");
    expect(invoices, 'نموذج إصدار الفواتير').toContain("shellClass('hidden md:block', 'hidden')");
    // الشريط السفلي وبطاقة الشرح: يبقيان مهما اتّسع العرض
    expect((layout.match(/shellClass\('md:hidden', ''\)/g) ?? []).length,
      'الشريط السفلي وورقة «المزيد» وترويسة الهاتف').toBeGreaterThanOrEqual(3);
    expect(invoices, 'بطاقة «الإصدار من الكمبيوتر»').toContain("shellClass('md:hidden', '')");
    // والحشوة المحجوزة للقائمة تُلغى حيث لا قائمة — وإلّا انزاح المحتوى
    expect(layout, 'حشوة القائمة الجانبية').toMatch(/shellClass\(sidebarCollapsed \? 'md:pr-20' : 'md:pr-64', ''\)/);

    // ولا يبقى أيٌّ من الأربعة بصيغته العارية القديمة
    for (const [src, bare, what] of [
      [layout, 'className={`hidden md:flex flex-col bg-[#0B1F4D]', 'القائمة الجانبية'],
      [invoices, 'className="hidden md:block lg:col-span-7', 'نموذج الإصدار'],
      [invoices, 'className="md:hidden bg-white rounded-2xl p-4', 'بطاقة الشرح'],
    ] as Array<[string, string, string]>) {
      expect(src.includes(bare), `${what}: عادت إلى حدّ العرض وحده`).toBe(false);
    }
  });

  it('🔴 شاشات الاطّلاع الأربع تبقى في متناول الهاتف', () => {
    for (const id of ['decision-reports', 'expenses', 'installments', 'warranty']) {
      expect(
        MOBILE_SCREENS,
        `${id}: سُحبت من قائمة الهاتف — وهي من غرضه الأساسي`,
      ).toContain(id);
    }
  });

  it('🔴 كل شاشةٍ يصلها الهاتف: إمّا لا تكتب، أو أزرارها محفوفة', () => {
    const WRITES = /newBatch\(\)|deleteDoc\(|setDoc\(|updateDoc\(|save:\s|remove:\s/;
    const unchecked: string[] = [];
    for (const id of MOBILE_SCREENS) {
      const file = screenFiles[id];
      if (!file) { unchecked.push(`${id}: لم يُعثر على مكوّنه في App.tsx`); continue; }
      let src: string;
      try { src = read(file); } catch { unchecked.push(`${id}: ${file} غير موجود`); continue; }
      if (!WRITES.test(src)) continue;               // شاشة قراءةٍ محضة — لا شيء يُلفّ
      const open = (src.match(/<DesktopOnly>/g) ?? []).length;
      if (open === 0) {
        unchecked.push(`${id} (${file}): شاشةٌ كاتبة على الهاتف بلا غلافٍ واحد`);
        continue;
      }
      if ((src.match(/<\/DesktopOnly>/g) ?? []).length !== open) {
        unchecked.push(`${id}: أغلفة غير متوازنة`);
      }
    }
    expect(
      unchecked,
      'شاشةٌ تكتب ويصلها الهاتف بلا إخفاء أزرارها: التاجر يضغط فلا يحدث شيء',
    ).toEqual([]);
  });

  it('🔴 والخطّافان المشتركان محروسان — يخدمان أكثر الشاشات', () => {
    const coll = read('src/hooks/useCollection.ts');
    const prof = read('src/hooks/useProfile.ts');
    // `save` و`remove` في useCollection
    expect((coll.match(/assertWritable\(\)/g) ?? []).length, 'save و remove كلاهما').toBe(2);
    expect(prof).toContain('assertWritable()');
    /**
     * وقبل تعديل الحالة المحلّية، وإلّا عرضت الشاشة قيمةً لا وجود لها على الخادم.
     *
     * ⚠️ والفحص داخل جسم `saveProfile` وحده: `setDocData` يرد أيضاً في مُحمِّل
     * الوثيقة أعلى الملف، فمقارنةُ مواضعَ على الملف كلّه تقيس شيئاً آخر.
     * (وقعتُ فيها أول كتابةٍ لهذا الاختبار.)
     */
    const body = prof.slice(prof.indexOf('const saveProfile'));
    expect(body, 'المسح وجد جسم الدالّة').toContain('assertWritable()');
    expect(
      body.indexOf('assertWritable()') < body.indexOf('setDocData'),
      'الحارس يسبق تعديل الحالة المحلّية',
    ).toBe(true);
  });
});
