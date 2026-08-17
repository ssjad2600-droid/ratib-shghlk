import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_GUIDE, EMPLOYEE_GUIDE, GUIDE_GROUPS, SCREEN_LABELS, guideFor } from '../screenGuide';

/**
 * 🔴 الحارس الذي يمنع الدليل من التقادم.
 *
 * دليل الاستخدام يموت بطريقة واحدة: تُضاف شاشة ولا يُضاف شرحها، فيبقى الدليل ناقصاً
 * أو — أسوأ — يبقى شرح لشاشة حُذفت فيُضلّل. لا اختبار وحدة عادي يكشف هذا لأن كل دالة
 * سليمة؛ العلّة في **النسيان**.
 *
 * فيفحص هذا الملف **الكود نفسه**: يستخرج شاشات القائمة الجانبية من DashboardLayout
 * ويقارنها بالدليل. نفس نمط حارس النسخة الاحتياطية الذي كشف ميزتين ساقطتين.
 */

const LAYOUT = join(process.cwd(), 'src', 'components', 'DashboardLayout.tsx');

/**
 * يستخرج { id, label } لكل **شاشة** من مصدر التخطيط.
 *
 * ⚠️ عناوين المجموعات لها نفس شكل بنود الشاشات، وبعضها يحمل المعرّف نفسه
 * (مجموعة «التقارير» ومجموعة «الإدارة»). فنميّزها بأن المجموعة يتبعها `items:`
 * — وإلا حُسبت المجموعات شاشاتٍ بلا شرح وفشل الفحص كذباً.
 */
function navItemsFromSource(): Array<{ id: string; label: string }> {
  const src = readFileSync(LAYOUT, 'utf8');
  const re = /\{\s*id:\s*'([a-z-]+)'\s*,\s*label:\s*'([^']+)'\s*,\s*icon:\s*\w+\s*\}/g;
  const out: Array<{ id: string; label: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push({ id: m[1], label: m[2] });
  return out;
}

describe('تغطية دليل الشاشات', () => {
  it('الاستخراج يرى القائمة فعلاً (حماية من فحص فارغ يمرّ كذباً)', () => {
    const items = navItemsFromSource();
    expect(items.length).toBeGreaterThan(15);
    for (const core of ['invoices', 'products', 'expiry', 'settings']) {
      expect(items.map(i => i.id), `المسح لم يجد ${core}`).toContain(core);
    }
  });

  it('🔴 كل شاشة في القائمة لها شرح — لا شاشة بلا دليل', () => {
    const missing = navItemsFromSource()
      .map(i => i.id)
      .filter(id => !OWNER_GUIDE[id])
      .sort();
    expect(missing, `شاشات بلا شرح — أضفها إلى OWNER_GUIDE: ${missing.join('، ')}`).toEqual([]);
  });

  it('🔴 لا شرح لشاشة غير موجودة — الدليل لا يضلّل', () => {
    const navIds = new Set(navItemsFromSource().map(i => i.id));
    const orphan = Object.keys(OWNER_GUIDE).filter(id => !navIds.has(id)).sort();
    expect(orphan, `شروح لشاشات محذوفة — احذفها من OWNER_GUIDE: ${orphan.join('، ')}`).toEqual([]);
  });

  it('🔴 اسم الشاشة واحد في القائمة والدليل — لا اسمان لشيء واحد', () => {
    const mismatched = navItemsFromSource()
      .filter(i => SCREEN_LABELS[i.id] && SCREEN_LABELS[i.id] !== i.label)
      .map(i => `${i.id}: القائمة «${i.label}» ≠ الدليل «${SCREEN_LABELS[i.id]}»`);
    expect(mismatched).toEqual([]);
  });

  it('كل شاشة مصنَّفة في مجموعة — لا شاشة تسقط من الفهرس', () => {
    const grouped = new Set(GUIDE_GROUPS.flatMap(g => g.screens));
    const ungrouped = Object.keys(OWNER_GUIDE).filter(id => !grouped.has(id)).sort();
    expect(ungrouped, `شاشات بلا مجموعة: ${ungrouped.join('، ')}`).toEqual([]);
  });

  it('المجموعات لا تحوي معرّفات وهمية', () => {
    const bogus = GUIDE_GROUPS.flatMap(g => g.screens).filter(id => !OWNER_GUIDE[id]);
    expect(bogus).toEqual([]);
  });
});

describe('جودة المحتوى — لا شرح فارغ يمرّ', () => {
  const all = { ...OWNER_GUIDE, ...EMPLOYEE_GUIDE };

  it.each(Object.keys(all))('«%s» شرحه مكتمل ومفيد', (id) => {
    const g = all[id];
    expect(g.purpose.trim().length, 'الفائدة قصيرة جداً').toBeGreaterThan(25);
    expect(g.when.trim().length, 'متى تستعملها قصيرة جداً').toBeGreaterThan(10);
    expect(g.tips.length, 'بلا نصائح').toBeGreaterThan(0);
    for (const t of g.tips) expect(t.trim().length).toBeGreaterThan(10);
  });

  it('الشاشات المرتبطة تشير إلى شاشات موجودة فعلاً', () => {
    const bad: string[] = [];
    for (const [id, g] of Object.entries(OWNER_GUIDE)) {
      for (const r of g.related ?? []) if (!OWNER_GUIDE[r]) bad.push(`${id} → ${r}`);
    }
    expect(bad, `روابط لشاشات غير موجودة: ${bad.join('، ')}`).toEqual([]);
  });

  it('لا شاشة تشير إلى نفسها', () => {
    const selfRef = Object.entries(OWNER_GUIDE).filter(([id, g]) => (g.related ?? []).includes(id)).map(([id]) => id);
    expect(selfRef).toEqual([]);
  });

  it('للموظف شرح لشاشتيه', () => {
    expect(Object.keys(EMPLOYEE_GUIDE).sort()).toEqual(['emp-invoices', 'emp-warranty']);
  });

  it('guideFor يجد شروح المالك والموظف معاً', () => {
    expect(guideFor('invoices')).toBeDefined();
    expect(guideFor('emp-warranty')).toBeDefined();
    expect(guideFor('لا-وجود-له')).toBeUndefined();
  });
});

/**
 * 🔴 حارس المزاعم — الدليل يخدم مرّتين: شرحاً للتاجر و**ورقة بيع**.
 *
 * والحارس القائم يفحص التغطية والأسماء، ولا شيء كان يفحص **صدق المحتوى**. فانحرفت
 * ثلاثة بنود عن السلوك الفعلي، وأخطرها دعوى أمنية: «السجل لا يُحذف **حتى منك**» —
 * وقواعد الوصول تعطي المالك `delete` على كل مجموعاته ومنها السجل.
 *
 * هذا الحارس يمنع العبارات المطلقة التي لا سند لها، ويربط ما بقي منها بسلوكٍ مُثبَت.
 */
describe('🔴 حارس: الدليل لا يَعِد بما لا يملك', () => {
  const allText = Object.entries(OWNER_GUIDE).flatMap(([id, g]) =>
    [g.purpose, g.when, ...g.tips].map(t => ({ id, t })));

  it('المسح يرى نصوصاً فعلاً', () => {
    expect(allText.length).toBeGreaterThan(50);
  });

  it('🔴 لا دعوى بأن السجل محميّ من المالك نفسه', () => {
    const bad = allText.filter(({ t }) => /لا يُحذف حتى منك|لا يُعدَّل ولا يُحذف حتى/.test(t));
    expect(
      bad.map(b => b.id),
      'قواعد Firestore تمنح المالك delete على audit_logs — الدعوى الصحيحة تخصّ **الموظف**',
    ).toEqual([]);
  });

  it('🔴 وصف الاستعادة يذكر أنها دمج لا استبدال', () => {
    const backup = OWNER_GUIDE.backup;
    const joined = backup.tips.join(' ');
    expect(/تدمج ولا تستبدل/.test(joined), 'الإيحاء بالاستبدال يقلب اتجاه الخطر').toBe(true);
    expect(
      /الاستعادة تكتب فوق بياناتك الحالية —/.test(joined),
      'الصياغة القديمة توحي بمحو ما بعد النسخة، وهو لا يقع',
    ).toBe(false);
  });

  it('🔴 وعد الأمان في السجل يخصّ الموظف صراحةً', () => {
    const joined = [OWNER_GUIDE['audit-log'].purpose, ...OWNER_GUIDE['audit-log'].tips].join(' ');
    expect(/الموظف/.test(joined), 'الدعوى الصحيحة المُثبَتة في القواعد يجب أن تُنسب لصاحبها').toBe(true);
  });

  it('🟠 لا وعد بأن نسخة تلقائية «تنجو دائماً» بلا قيد', () => {
    // اللقطة التلقائية تُتخطّى إن تعذّر الخادم — فلا نَعِد بأمانٍ غير مشروط
    const bad = allText.filter(({ t }) => /تنجو مهما|أمان مطلق|لا تفقد بياناتك أبداً/.test(t));
    expect(bad.map(b => b.id)).toEqual([]);
  });

  it('الميزات المضافة مذكورة — الدليل ورقة بيع أيضاً', () => {
    const has = (id: string, needle: string) =>
      [OWNER_GUIDE[id].purpose, ...OWNER_GUIDE[id].tips].join(' ').includes(needle);
    expect(has('stock-transfers', 'تراجع'), 'التراجع عن النقل ميزة تُطلب ولا تُذكر').toBe(true);
    expect(has('inventory-adjustments', 'تراجع')).toBe(true);
    expect(has('expenses', 'تكلفة البضاعة المباعة')).toBe(true);
    expect(has('decision-reports', 'أ ب ج')).toBe(true);
    expect(has('branch-performance', 'رأس مالك النائم')).toBe(true);
    expect(has('branches', 'تعطيل')).toBe(true);
    expect(has('audit-log', 'الفترة')).toBe(true);
  });
});
