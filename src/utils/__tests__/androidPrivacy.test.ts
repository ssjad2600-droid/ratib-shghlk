import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 🔴 دفترُ التاجر لا يُنسخ إلى حسابٍ لا يملكه.
 *
 * النسخ التلقائي في أندرويد يرفع مجلّد بيانات التطبيق إلى Google Drive الخاص
 * **بحامل الجهاز** — ومجلّدنا يحوي مخبأ فايرستور داخل الـWebView: أسماء
 * الزبائن، وأرصدة ديونهم، وفواتير المحل، ورموز الجلسة. فتُستعاد على أي جهازٍ
 * يدخل بذلك الحساب.
 *
 * وهذا ليس فرضاً نظرياً في محلٍّ عراقي: الهاتف قد يكون بحساب غوغل لابنٍ أو
 * بائع، والدفتر ليس لهما.
 *
 * ⚠️ ولا يُفقد شيء بإطفائه: البيانات في فايرستور، فيسجّل التاجر دخوله على
 * الجهاز الجديد فتعود كاملةً — وله فوق ذلك نسخةٌ احتياطية داخل البرنامج.
 *
 * والفحص هنا نصّي على المانيفست لأنه ملف بناءٍ لا شيفرة تُستورَد. وهو الطريق
 * الوحيد لحراسته آلياً: أي `cap sync` أو ترقية Capacitor قد تُعيد كتابته
 * بالقيمة الافتراضية `true` بلا أن ينتبه أحد.
 */

const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8');

const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const RULES = 'android/app/src/main/res/xml/data_extraction_rules.xml';

describe('🔴 النسخ التلقائي في أندرويد مُطفأ', () => {
  const manifest = read(MANIFEST);

  it('المسح يرى المانيفست', () => {
    expect(manifest).toContain('<application');
    expect(manifest).toContain('.MainActivity');
  });

  it('🔴 allowBackup = false — للأنظمة قبل أندرويد ١٢', () => {
    expect(manifest).toContain('android:allowBackup="false"');
    expect(
      /android:allowBackup="true"/.test(manifest),
      'القيمة الافتراضية ترفع دفتر التاجر إلى Drive حاملِ الجهاز',
    ).toBe(false);
  });

  it('🔴 وقواعد الاستخراج مربوطة — لما بعد أندرويد ١٢ (targetSdk ٣٦)', () => {
    expect(
      manifest,
      'بلا ربطها يبقى نقل الجهاز إلى الجهاز مفتوحاً رغم allowBackup=false',
    ).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
  });

  it('🔴 والقواعد تُغلق المسارين معاً لا واحداً', () => {
    const rules = read(RULES);
    for (const section of ['cloud-backup', 'device-transfer']) {
      const block = rules.slice(rules.indexOf(`<${section}>`), rules.indexOf(`</${section}>`));
      expect(block.length, `${section}: المسح وجد القسم`).toBeGreaterThan(20);
      // الجذر يشمل ما تحته، والبقية تصريحٌ لا يُترك للتأويل
      expect(block, `${section}: لا استثناء للجذر`).toContain('<exclude domain="root"');
      expect(block).toContain('<exclude domain="database"');
      expect(block).toContain('<exclude domain="sharedpref"');
    }
  });

  it('🔴 ولا `include` يُعيد فتح ما أُغلق', () => {
    expect(
      /<include\s/.test(read(RULES)),
      'أي include يستثني نفسه من الإغلاق — والقاعدة هنا: لا شيء يخرج',
    ).toBe(false);
  });
});

/**
 * 🔴 أزرار الطباعة تغيب حيث لا طابعة.
 *
 * `printSupport.ts` كُتب لهذا الغرض ونصّه يقول حرفياً: «زرٌّ يفشل دائماً أسوأ
 * من زرٍّ غائب» — ثم بقي `canPrint` بلا نداءٍ واحد من الواجهة. فكان التاجر
 * على هاتفه يرى «طباعة» ويضغطها فتعتذر له.
 *
 * والغلاف مستقلّ عن `DesktopOnly` عمداً: الطباعة **قراءة** لا كتابة، وسببُ
 * إخفائها غياب الطابعة لا وضع الاطّلاع. فلو صارت للهاتف طباعةٌ بالبلوتوث
 * يوماً، يتغيّر هذا وحده.
 */
describe('🔴 `canPrint` موصولة بالواجهة لا مكتوبةً وحدها', () => {
  const shell = read('src/components/DesktopOnly.tsx');

  it('الغلاف يستعمل canPrint من مصدرها', () => {
    expect(shell).toContain("from '../utils/printSupport'");
    expect(shell).toContain('canPrint()');
    expect(shell).toContain('export function PrintOnly');
  });

  it('🔴 وكل زرّ طباعة في الشاشات المتاحة على الهاتف محفوفٌ به', () => {
    for (const f of ['src/components/InvoicesView.tsx', 'src/components/CustomerHistoryModal.tsx']) {
      const src = read(f);
      const buttons = (src.match(/<Printer\b/g) ?? []).length;
      const wraps = (src.match(/<PrintOnly>/g) ?? []).length;
      expect(buttons, `${f}: المسح وجد أزرار طباعة`).toBeGreaterThan(0);
      expect(wraps, `${f}: زرّ طباعة بلا غلاف يظهر على الهاتف ثم يعتذر`).toBeGreaterThanOrEqual(2);
      expect((src.match(/<\/PrintOnly>/g) ?? []).length, `${f}: أغلفة متوازنة`).toBe(wraps);
    }
  });
});
