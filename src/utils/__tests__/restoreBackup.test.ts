import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  planRestore, chunkOps, restoreMessage, sourceWarning, CHUNK_SIZE, RestoreOutcome,
} from '../restoreBackup';

/**
 * 🔴 النسخ الاحتياطي: البناء ممتاز والتسليم كان هشّاً.
 *
 * ما يُكتب في النسخة صحيح ومحروس؛ العلل كانت في **ما يُقال عنها**: نسخةٌ تُبنى من
 * ذاكرة ناقصة وتُسلَّم كاملة، واستعادةٌ تعلّق أو تنكسر في منتصفها بلا أن تقول ما جرى.
 * وهذه أخطر شاشة يقع فيها ذلك: خطؤها لا يظهر يوم وقوعه بل **يوم الحاجة**.
 */

const outcome = (over: Partial<RestoreOutcome> = {}): RestoreOutcome => ({
  chunksDone: 0, chunksTotal: 0, docsDone: 0, docsTotal: 0,
  skippedTotal: 0, skipped: {}, failed: false, settingsFailed: false, ...over,
});

describe('تخطيط الاستعادة', () => {
  it('يجمع العمليات من كل المجموعات المعروفة', () => {
    const plan = planRestore({
      app_customers: JSON.stringify([{ id: 'c1' }, { id: 'c2' }]),
      app_products: JSON.stringify([{ id: 'p1' }]),
    });
    expect(plan.ops).toHaveLength(3);
    expect(plan.ops.map(o => o.collName)).toEqual(['customers', 'customers', 'products']);
  });

  it('🔴 الوثيقة بلا معرّف تُعدّ ولا تُتخطّى بصمت', () => {
    const plan = planRestore({ app_customers: JSON.stringify([{ id: 'c1' }, { name: 'بلا معرّف' }]) });
    expect(plan.ops).toHaveLength(1);
    expect(plan.skipped.customers).toBe(1);
    expect(plan.skippedTotal).toBe(1);
  });

  it('المعرّف الفارغ أو غير النصّي يُعدّ ناقصاً', () => {
    const plan = planRestore({ app_customers: JSON.stringify([{ id: '' }, { id: 5 }, null, 'نص']) });
    expect(plan.ops).toHaveLength(0);
    expect(plan.skippedTotal).toBe(4);
  });

  it('مفتاح تالف لا يُسقط بقيّة النسخة', () => {
    const plan = planRestore({
      app_customers: 'ليس JSON',
      app_products: JSON.stringify([{ id: 'p1' }]),
    });
    expect(plan.ops).toHaveLength(1);
  });

  it('مفتاح غير معروف يُتجاهَل بلا انفجار', () => {
    expect(planRestore({ شيء_غريب: JSON.stringify([{ id: 'x' }]) }).ops).toHaveLength(0);
  });

  it('عدد الدفعات يُحسب بحدّ Firestore', () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ id: `c${i}` }));
    const plan = planRestore({ app_customers: JSON.stringify(many) });
    expect(plan.chunks).toBe(3);
    expect(chunkOps(plan.ops)).toHaveLength(3);
    expect(chunkOps(plan.ops)[0]).toHaveLength(CHUNK_SIZE);
    expect(chunkOps(plan.ops)[2]).toHaveLength(1);
  });

  it('نسخة فارغة ⇒ خطّة فارغة نظيفة', () => {
    expect(planRestore({})).toMatchObject({ ops: [], skippedTotal: 0, chunks: 0 });
  });
});

describe('🔴 رسالة النتيجة تقول ما جرى', () => {
  it('🔴 الفشل الجزئي يذكر كم كُتب وأن البيانات صارت خليطاً', () => {
    const m = restoreMessage(outcome({
      failed: true, chunksDone: 8, chunksTotal: 20, docsDone: 4000, docsTotal: 10000,
    }));
    expect(m.bad).toBe(true);
    expect(m.text, 'كانت الرسالة «حدث خطأ» بلا ذكر أن جزءاً كُتب فعلاً').toMatch(/٤٠٠٠ من ١٠٠٠٠/);
    expect(m.text).toMatch(/٨ دفعة من ٢٠/);
    expect(m.text).toMatch(/خليط/);
    expect(m.text).toMatch(/أعد الاستعادة/);
  });

  it('🔴 الفشل قبل أي كتابة يطمئن أن البيانات كما كانت', () => {
    const m = restoreMessage(outcome({ failed: true, docsDone: 0, docsTotal: 500, chunksTotal: 1 }));
    expect(m.text).toMatch(/لم تُكتب أي وثيقة/);
    expect(m.text).toMatch(/كما كانت/);
    expect(m.text).not.toMatch(/خليط/);
  });

  it('🔴 النجاح لا يقول «بالكامل» — الاستعادة دمج لا استبدال', () => {
    const m = restoreMessage(outcome({ docsDone: 300, docsTotal: 300, chunksDone: 1, chunksTotal: 1 }));
    expect(
      /بالكامل/.test(m.text),
      'كانت «تم استعادة كافة حساباتك بالكامل» تمحو التحذير المعروض قبلها بسطرين',
    ).toBe(false);
    expect(m.text).toMatch(/٣٠٠ وثيقة/);
    expect(m.text, 'يجب أن يُذكّر أن الأحدث لم يُحذف').toMatch(/لم تُحذف/);
    expect(m.bad).toBe(false);
  });

  it('المتخطّى يُذكر بتفصيله', () => {
    const m = restoreMessage(outcome({
      docsDone: 10, docsTotal: 10, skippedTotal: 3, skipped: { customers_public: 3 },
    }));
    expect(m.text).toMatch(/تُخطّيت ٣ وثيقة/);
    expect(m.text).toMatch(/customers_public: ٣/);
    expect(m.bad).toBe(true);
  });

  it('🟡 فشل الإعدادات يُقال ولا يُبتلع', () => {
    const m = restoreMessage(outcome({ docsDone: 5, docsTotal: 5, settingsFailed: true }));
    expect(m.text, 'كان `catch { /* ignore */ }` يبتلعه').toMatch(/تعذّرت استعادة الإعدادات/);
    expect(m.bad).toBe(true);
  });
});

describe('🔴 وسم مصدر النسخة', () => {
  it('نسخة من الكاش ⟵ تحذير صريح بالنقص المحتمل', () => {
    const w = sourceWarning('cache');
    expect(w).toMatch(/الذاكرة المحلية/);
    expect(w).toMatch(/ناقصة/);
  });

  it('نسخة من الخادم ⟵ بلا تحذير', () => {
    expect(sourceWarning('server')).toBeNull();
  });

  it('نسخة قديمة بلا وسم ⟵ بلا تحذير (لا نتّهم ما لا نعرف)', () => {
    expect(sourceWarning(undefined)).toBeNull();
  });
});

/**
 * 🔴 حارس: النسخة تُبنى من الخادم، والاستعادة لا تُعلّق ولا تكذب.
 */
describe('حارس: النسخ الاحتياطي', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const exp = read('src/utils/exportBackup.ts');
  const view = read('src/components/BackupView.tsx');

  it('المسح يرى الملفات فعلاً', () => {
    expect(exp).toContain('buildBackupPayload');
    expect(view).toContain('handleConfirmRestore');
  });

  it('🔴 النسخة تُبنى من الخادم أوّلاً', () => {
    expect(
      /getDocsFromServer\(/.test(exp),
      'القراءة من الكاش تُنتج نسخةً ناقصة باسم كاملة — ولا تُكتشف إلا يوم الاستعادة',
    ).toBe(true);
  });

  it('🔴 تعذّر الخادم يُوسَم في الملف وفي الواجهة', () => {
    expect(/source: fromCache \? 'cache' : 'server'/.test(exp)).toBe(true);
    expect(/payload\.fromCache/.test(view), 'الواجهة تعرض «بنجاح» بلا تحفّظ').toBe(true);
  });

  it('🔴 الجلب متسلسل لا متوازٍ', () => {
    expect(
      /Promise\.all\(entries\.map/.test(exp),
      'التوازي يجعل عدّة مجموعات تفشل معاً قبل أن يُرفع fromCache فتُقرأ من الكاش بلا وسم',
    ).toBe(false);
  });

  it('🔴 عدد الوثائق يُعرض بدل «بنجاح» مجرّدة', () => {
    expect(/totalDocs/.test(exp)).toBe(true);
    expect(/payload\.totalDocs/.test(view)).toBe(true);
  });

  it('🔴 الاستعادة تُمنع بلا اتصال بدل أن تُعلّق', () => {
    expect(
      /if \(!isOnline\) \{[\s\S]{0,200}الاستعادة تحتاج اتصالاً/.test(view),
      'await batch.commit() بلا اتصال لا يعود أبداً — شاشة معلّقة إلى الأبد',
    ).toBe(true);
  });

  it('🔴 الاستعادة تمرّ من المنطق المشترك وتُبلّغ بالنتيجة', () => {
    expect(/planRestore\(/.test(view)).toBe(true);
    expect(/restoreMessage\(/.test(view)).toBe(true);
    expect(
      /تم استعادة كافة حساباتك ومخزنك بالكامل/.test(view),
      'عادت رسالة «بالكامل» التي تناقض تحذير الدمج',
    ).toBe(false);
  });

  it('🟠 مؤشّر تقدّم والزرّ يُعطَّل أثناء العمل', () => {
    expect(/restoreProgress/.test(view)).toBe(true);
    expect(/disabled=\{!!restoreProgress\}/.test(view), 'ضغطة ثانية ⟵ استعادة موازية').toBe(true);
  });

  it('🔴 لا إعادة تحميل بعد فشلٍ جزئي', () => {
    expect(
      /if \(!outcome\.failed\) setTimeout\(\(\) => window\.location\.reload\(\)/.test(view),
      'إعادة التحميل تمحو رسالة الفشل قبل أن يقرأها',
    ).toBe(true);
  });
});

/**
 * 🔴 النسخة التلقائية لا تحفظ لقطةً ناقصة.
 *
 * علّة كشفها وسم `fromCache` نفسه: `useAutoBackup` كان يحفظ ما يُبنيه `buildBackupPayload`
 * بلا فحص. فإن تعذّر الخادم صارت **نسخة الأمان التلقائية** ملفاً ناقصاً، **ويُحدَّث
 * `lastBackupAt`** فلا تُستحقّ نسخة أخرى ليوم كامل — فيُطمأنّ التاجر إلى أمانٍ لا يملكه.
 */
describe('حارس: النسخة التلقائية', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'hooks', 'useAutoBackup.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('المسح يرى الملف فعلاً', () => {
    expect(src).toContain('createCloudSnapshot');
    expect(src).toContain('lastBackupAt');
  });

  it('🔴 تُتخطّى اللقطة المبنيّة من الكاش', () => {
    expect(
      /if \(payload\.fromCache\)/.test(src),
      'نسخة أمانٍ ناقصة تُحفظ بلا علم التاجر',
    ).toBe(true);
  });

  it('🔴 ولا يُحدَّث الطابع الزمني عند التخطّي', () => {
    expect(
      /if \(!saved\) return;/.test(src),
      'تحديث lastBackupAt بعد التخطّي يُسكت المحاولة التالية ليوم كامل',
    ).toBe(true);
  });

  it('🔴 ويُحرَّر الحارس ليُعاد المحاولة عند عودة الاتصال', () => {
    expect(/ranRef\.current = false;[\s\S]{0,80}return null;/.test(src)).toBe(true);
  });
});
