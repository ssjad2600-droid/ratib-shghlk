import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  guardWrite, reportFirestoreError, reportWriteFailure, subscribeWriteFailures,
  clearWriteFailures, describeFailure, codeOf, scopeLabel, reportReadFailure, clearReadFailure, __resetWriteFailures,
} from '../writeGuard';

/**
 * 🔴 الفشل الصامت — النمط الذي كان يُخفي كل علّة أخرى.
 *
 * ٣٩ موضع كتابة كلها تنتهي بـ`.catch(err => console.error(...))`. والتاجر لا يفتح طرفية
 * المتصفح. فكل رفضٍ من القواعد يمرّ **كنجاحٍ كامل**: تُطبَع الفاتورة، ويُغلق النموذج،
 * ولا شيء على الخادم.
 *
 * ⚠️ والمفتاح الذي يجعل الإبلاغ آمناً: الكتابة **بلا اتصال لا تُرفَض** — تبقى معلّقة في
 * طابور `persistentLocalCache` حتى تُزامَن. فالوعد لا يُرفَض إلا لسببٍ **دائم**. أي أن كل
 * ما يصل إلى هنا فشلٌ لن ينجح أبداً — فلا إنذار كاذب من ضعف الشبكة.
 */

const err = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => { __resetWriteFailures(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('قراءة رمز الخطأ', () => {
  it('يقرأ code من خطأ Firestore', () => {
    expect(codeOf(err('permission-denied'))).toBe('permission-denied');
  });
  it('أي شكل آخر ⟵ unknown بلا انفجار', () => {
    expect(codeOf(new Error('x'))).toBe('unknown');
    expect(codeOf(null)).toBe('unknown');
    expect(codeOf('نص')).toBe('unknown');
    expect(codeOf({ code: 5 })).toBe('unknown');
  });
});

describe('🔴 الرسالة يفهمها صاحب المحل', () => {
  it('تُعرّب اسم المجموعة — التاجر لا يعرف financial_transactions', () => {
    expect(scopeLabel('financial_transactions')).toBe('حركة مالية');
    expect(scopeLabel('purchase_invoices')).toBe('فاتورة شراء');
  });

  it('مجموعة غير معروفة تظهر كما هي بدل أن تختفي', () => {
    expect(scopeLabel('something_new')).toBe('something_new');
  });

  it('🔴 كل رسالة تقول صراحةً إن شيئاً لم يُحفظ', () => {
    for (const code of ['permission-denied', 'not-found', 'resource-exhausted', 'invalid-argument', 'unknown']) {
      const m = describeFailure({ scope: 'invoices', op: 'save', code });
      expect(m, `الرمز ${code}`).toMatch(/لم يُحفظ/);
    }
  });

  it('الصلاحيات ⟵ تُنسب للخادم لا لضعف الإنترنت', () => {
    const m = describeFailure({ scope: 'invoices', op: 'save', code: 'permission-denied' });
    expect(m).toMatch(/الخادم رفض/);
    expect(m).toMatch(/فاتورة بيع/);
  });

  it('تجاوز الحصّة يُقال بلغة التاجر', () => {
    expect(describeFailure({ scope: 'products', op: 'save', code: 'resource-exhausted' })).toMatch(/حصّة/);
  });

  it('نوع العملية يظهر: حفظ / حذف / تعديل', () => {
    expect(describeFailure({ scope: 'customers', op: 'remove', code: 'x' })).toMatch(/حذف زبون/);
    expect(describeFailure({ scope: 'customers', op: 'update', code: 'x' })).toMatch(/تعديل زبون/);
    expect(describeFailure({ scope: 'customers', op: 'batch', code: 'x' })).toMatch(/حفظ زبون/);
  });
});

describe('قناة الإبلاغ', () => {
  it('المشترك يُستدعى فوراً ثم عند كل فشل', () => {
    const seen: number[] = [];
    subscribeWriteFailures(f => seen.push(f.length));
    expect(seen).toEqual([0]);
    reportWriteFailure('invoices', 'save', err('permission-denied'));
    expect(seen).toEqual([0, 1]);
  });

  it('الأحدث أولاً', () => {
    reportWriteFailure('invoices', 'save', err('a'));
    reportWriteFailure('products', 'remove', err('b'));
    let list: Array<{ scope: string }> = [];
    subscribeWriteFailures(f => { list = f; });
    expect(list[0].scope).toBe('products');
  });

  it('🔴 سقفٌ يمنع تضخّم الذاكرة لو انهار الاتصال بالصلاحيات', () => {
    for (let i = 0; i < 100; i++) reportWriteFailure('invoices', 'save', err('permission-denied'));
    let list: unknown[] = [];
    subscribeWriteFailures(f => { list = f; });
    expect(list.length).toBeLessThanOrEqual(20);
  });

  it('الإخفاء يُفرّغ القائمة ويُبلّغ المشتركين', () => {
    const seen: number[] = [];
    subscribeWriteFailures(f => seen.push(f.length));
    reportWriteFailure('invoices', 'save', err('x'));
    clearWriteFailures();
    expect(seen[seen.length - 1]).toBe(0);
  });

  it('إلغاء الاشتراك يوقف الاستدعاء', () => {
    let calls = 0;
    const un = subscribeWriteFailures(() => { calls++; });
    un();
    reportWriteFailure('invoices', 'save', err('x'));
    expect(calls).toBe(1); // الاستدعاء الفوري وحده
  });
});

describe('🔴 الغلاف لا يغيّر سلوك الكتابة', () => {
  it('النجاح لا يُبلّغ عن شيء', async () => {
    let list: unknown[] = [];
    subscribeWriteFailures(f => { list = f; });
    await guardWrite(Promise.resolve('ok'), 'invoices', 'save');
    expect(list).toHaveLength(0);
  });

  it('🔴 الفشل لا يُعاد رميه — الشاشة لا تنهار ولا تُحجب', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(guardWrite(Promise.reject(err('permission-denied')), 'invoices', 'save'))
      .resolves.toBeUndefined();
  });

  it('والفشل يُسجَّل في الطرفية **و** في القناة معاً', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let list: Array<{ code: string }> = [];
    subscribeWriteFailures(f => { list = f; });
    await guardWrite(Promise.reject(err('permission-denied')), 'invoices', 'save');
    expect(spy, 'إسقاط الطرفية يُفقد المطوّر أداة التشخيص').toHaveBeenCalled();
    expect(list[0].code).toBe('permission-denied');
  });

  it('🔴 reportFirestoreError يحفظ نصّ الطرفية الأصلي بلا بادئة مكرّرة', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportFirestoreError('invoices', 'remove', err('not-found'), '[Firestore] delete invoice');
    expect(
      spy.mock.calls[0][0],
      'إضافة بادئة ثانية تُنتج «[Firestore] [Firestore] …» فتُفسد البحث في الطرفية',
    ).toBe('[Firestore] delete invoice:');
  });
});

describe('🔴 فشل القراءة ليس فشل كتابة', () => {
  it('رسالته تنفي الضياع صراحةً وتنهى عن إعادة الإدخال', () => {
    const m = describeFailure({ scope: 'customers', op: 'read', code: 'permission-denied' });
    expect(m).toMatch(/زبون/);
    expect(m, 'القائمة الفارغة تُقرأ «لا يوجد» فيُعيد التاجر الإدخال ⟵ تكرار').toMatch(/لم تضع/);
    expect(m).toMatch(/لا تُعد إدخالها/);
    expect(m).not.toMatch(/لم يُحفظ/);
  });

  it('ويُسجَّل في القناة كباقي الأنواع', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let list: Array<{ op: string }> = [];
    subscribeWriteFailures(f => { list = f; });
    reportReadFailure('products', err('permission-denied'));
    expect(list[0].op).toBe('read');
  });

  /**
   * 🔴 عيبٌ رأيتُه حيّاً بعد تركيب الشريط: تبويبٌ جديد يعرض «تعذّر عرض بياناتك» ثم
   * تظهر البيانات كاملة — لأن `onSnapshot` يشترك أحياناً قبل جاهزية رمز المصادقة
   * فيصل `permission-denied` عابر ثم يُعاد الاشتراك وينجح.
   *
   * وشريطٌ يُنذر كذباً أسوأ من غيابه: يُدرِّب التاجر على تجاهله فلا يراه يوم يصدق.
   */
  it('🔴 نجاح قراءةٍ لاحقة يمحو بلاغها — لا إنذار كاذب عند الإقلاع', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let list: Array<{ scope: string; op: string }> = [];
    subscribeWriteFailures(f => { list = f; });
    reportReadFailure('customers', err('permission-denied'));
    expect(list).toHaveLength(1);
    clearReadFailure('customers');
    expect(list, 'بقاء البلاغ بعد نجاح القراءة يُنتج إنذاراً كاذباً كل إقلاع').toHaveLength(0);
  });

  it('🔴 ولا يمحو بلاغ مجموعة أخرى ولا بلاغ كتابة', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let list: Array<{ scope: string; op: string }> = [];
    subscribeWriteFailures(f => { list = f; });
    reportReadFailure('customers', err('permission-denied'));
    reportReadFailure('products', err('permission-denied'));
    reportWriteFailure('customers', 'save', err('permission-denied'));
    clearReadFailure('customers');
    expect(list.map(f => `${f.scope}:${f.op}`).sort()).toEqual(['customers:save', 'products:read']);
  });
});

/**
 * 🔴 حارس: لا كتابة تبتلع خطأها.
 */
describe('حارس: لا فشل صامت', () => {
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

  const files = walk(root).filter(f => !f.endsWith('writeGuard.ts'));

  it('المسح يرى المصدر فعلاً', () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files.some(f => f.endsWith('InvoicesView.tsx'))).toBe(true);
  });

  it('🔴 لا `.catch(err => console.error(...))` عارية في أي ملف', () => {
    const offenders = files.filter(f =>
      /\.catch\(\(?err\)?\s*=>\s*console\.error\(/.test(strip(readFileSync(f, 'utf8')))
    ).map(f => f.replace(root, 'src'));

    expect(
      offenders,
      'الكتابة التي تبتلع خطأها تعرض النجاح على عملية لم تقع — استعمل guardWrite أو reportFirestoreError',
    ).toEqual([]);
  });

  /**
   * 🔴 `onSnapshot` يقتل الاشتراك عند أول خطأ ولا يُعيد المحاولة. فسباقٌ عابر عند
   * الإقلاع كان يُفقد المجموعة **طوال الجلسة** — رأيتُه حيّاً على `product_costs`.
   */
  it('🔴 القراءة تُعاد محاولتها قبل أن يُعلَن الفشل', () => {
    const src = strip(readFileSync(join(root, 'hooks', 'useCollection.ts'), 'utf8'));
    expect(
      /attempt < MAX_RETRIES/.test(src),
      'بلا إعادة محاولة يُفقد سباقٌ عابر المجموعةَ حتى يُغلق التاجر البرنامج',
    ).toBe(true);
    expect(
      /clearReadFailure\(collectionName\)/.test(src),
      'نجاحٌ لاحق يجب أن يمحو البلاغ وإلا بقي إنذارٌ لعلّة زالت',
    ).toBe(true);
    expect(
      /if \(retryTimer\) clearTimeout\(retryTimer\)/.test(src),
      'مؤقّت لا يُلغى عند التفكيك يُعيد الاشتراك بعد إزالة المكوّن',
    ).toBe(true);
  });

  it('🔴 useCollection تمرّ من الغلاف في الحفظ والحذف معاً', () => {
    const src = strip(readFileSync(join(root, 'hooks', 'useCollection.ts'), 'utf8'));
    expect((src.match(/guardWrite\(/g) ?? []).length).toBe(2);
    expect(
      /reportReadFailure\(/.test(src),
      'خطأ القراءة كان مبتلَعاً أيضاً: القائمة تبقى فارغة فتُقرأ «لا يوجد» بدل «تعذّرت القراءة»',
    ).toBe(true);
    expect(/console\.error/.test(src), 'عودة الابتلاع المباشر').toBe(false);
  });

  it('🔴 الشريط مركَّب في قشرتَي المالك والموظف معاً', () => {
    const owner = strip(readFileSync(join(root, 'components', 'DashboardLayout.tsx'), 'utf8'));
    const emp = strip(readFileSync(join(root, 'components', 'EmployeeShell.tsx'), 'utf8'));
    expect(/<WriteFailureBanner \/>/.test(owner)).toBe(true);
    expect(
      /<WriteFailureBanner \/>/.test(emp),
      'الموظف أولى الناس به: كتاباته تُرفض خادمياً عند تعطيله',
    ).toBe(true);
  });

  it('🔴 الشريط يُميّز الرفض الدائم عن ضعف الشبكة', () => {
    const banner = readFileSync(join(root, 'components', 'WriteFailureBanner.tsx'), 'utf8');
    expect(
      /رُفضت نهائياً|ليس ضعف إنترنت/.test(banner),
      'خلطُهما يجعل التاجر ينتظر مزامنةً لن تأتي',
    ).toBe(true);
  });
});
