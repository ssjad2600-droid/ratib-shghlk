import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isViewOnly, assertWritable, ViewOnlyError, isViewOnlyError, VIEW_ONLY_MESSAGE,
} from '../viewOnly';

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
    const autoEffects: Array<[string, string]> = [
      ['src/components/CustomersView.tsx', 'mirrorMigrationRan.current'],
      ['src/components/InvoicesView.tsx', 'repairRanRef.current'],
      ['src/components/EmployeeManagement.tsx', 'backfilled.current'],
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
