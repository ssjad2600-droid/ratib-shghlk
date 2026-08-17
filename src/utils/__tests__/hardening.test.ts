import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
