import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  groupReports, markResolved, unmarkResolved, parseMarks, signatureOf, TriageReport,
} from '../errorTriage';

/**
 * 🟡 لوحة أخطاء الزبائن — عينك على البرنامج بعد بيعه.
 *
 * علّتان كانتا تُفقدانها فائدتها مع الوقت: نافذة عمياء (`limit(200)` بلا مدّة) تجعلها
 * ترى الأيام الأخيرة فقط مع التراكم، وغياب علامة «عولج» يجعل المُصلَحات تتصدّر القائمة
 * إلى الأبد حتى تُهمَل كلّها.
 */

const rep = (over: Partial<TriageReport> = {}): TriageReport => ({
  screen: 'المبيعات', message: 'x is not a function', uid: 'shop1', createdAt: 1000, ...over,
});

describe('تجميع التقارير بالتوقيع', () => {
  it('نفس الرسالة في نفس الشاشة = مشكلة واحدة مهما تكرّرت', () => {
    const g = groupReports([rep(), rep({ createdAt: 2000 }), rep({ createdAt: 3000 })]);
    expect(g).toHaveLength(1);
    expect(g[0].count).toBe(3);
    expect(g[0].last).toBe(3000);
  });

  it('نفس الرسالة في شاشة أخرى = مشكلة مستقلّة', () => {
    expect(groupReports([rep(), rep({ screen: 'المشتريات' })])).toHaveLength(2);
    expect(signatureOf(rep())).toBe('المبيعات|x is not a function');
  });

  it('عدد المحلات يُحسب بالمعرّفات الفريدة لا بعدد التقارير', () => {
    const g = groupReports([rep(), rep(), rep({ uid: 'shop2' })]);
    expect(g[0].count).toBe(3);
    expect(g[0].shopCount).toBe(2);
  });

  it('العيّنة المعروضة هي الأحدث لا الأولى — أثرها يعكس آخر نسخة', () => {
    const g = groupReports([
      rep({ createdAt: 1000, uid: 'قديم' }),
      rep({ createdAt: 9000, uid: 'أحدث' }),
    ]);
    expect(g[0].sample.uid).toBe('أحدث');
  });

  it('الأولوية لما يصيب أكبر عدد من المحلات ثم الأكثر تكراراً', () => {
    const g = groupReports([
      rep({ message: 'كثير التكرار' }), rep({ message: 'كثير التكرار' }), rep({ message: 'كثير التكرار' }),
      rep({ message: 'واسع الانتشار', uid: 'a' }), rep({ message: 'واسع الانتشار', uid: 'b' }),
    ]);
    expect(g[0].message).toBe('واسع الانتشار');
  });

  it('لا تقارير ⟵ لا مجموعات', () => {
    expect(groupReports([])).toEqual([]);
  });
});

describe('🔴 وسم «عولج» مؤقّت لا نهائي', () => {
  const group = { key: 'المبيعات|x is not a function', last: 5000 };

  it('الوسم يُخفي المجموعة ما دامت لم تتكرّر بعده', () => {
    const marks = markResolved({}, group);
    const g = groupReports([rep({ createdAt: 5000 })], marks);
    expect(g[0].resolved).toBe(true);
    expect(g[0].regressed).toBe(false);
  });

  it('🔴 تكرارٌ واحد بعد الوسم يُعيدها موسومةً بالانتكاسة', () => {
    const marks = markResolved({}, group);
    const g = groupReports([rep({ createdAt: 5000 }), rep({ createdAt: 5001 })], marks);
    expect(
      g[0].resolved,
      'إخفاءٌ نهائي يعني خطأ ظننته مُصلَحاً وعاد عند زبائنك ولا تراه — أخطر من غياب الوسم أصلاً',
    ).toBe(false);
    expect(g[0].regressed).toBe(true);
  });

  it('🔴 الانتكاسة تتصدّر حتى ما يصيب محلات أكثر', () => {
    const marks = markResolved({}, { key: 'المبيعات|منتكس', last: 100 });
    const g = groupReports([
      rep({ message: 'منتكس', createdAt: 200 }),
      rep({ message: 'واسع', uid: 'a' }), rep({ message: 'واسع', uid: 'b' }), rep({ message: 'واسع', uid: 'c' }),
    ], marks);
    expect(g[0].message, 'إصلاحٌ لم يصل إلى الزبون أعجل من خطأ جديد').toBe('منتكس');
    expect(g[0].regressed).toBe(true);
  });

  it('الوسم يحفظ زمن آخر ظهورٍ رأيناه لا زمن الضغط', () => {
    expect(markResolved({}, group)[group.key]).toBe(5000);
  });

  it('إلغاء الوسم يُعيدها مشكلةً مفتوحة', () => {
    const marks = markResolved({}, group);
    expect(unmarkResolved(marks, group.key)).toEqual({});
    expect(groupReports([rep({ createdAt: 5000 })], {})[0].resolved).toBe(false);
  });

  it('وسمٌ لمجموعة أخرى لا يمسّ هذه', () => {
    const g = groupReports([rep()], { 'شاشة أخرى|رسالة': 9999 });
    expect(g[0].resolved).toBe(false);
  });
});

describe('قراءة الوسوم من التخزين المحلي', () => {
  it('تخزين سليم يُقرأ كما هو', () => {
    expect(parseMarks(JSON.stringify({ a: 5 }))).toEqual({ a: 5 });
  });

  it('التالف أو الغائب يُعامَل كغياب — لا ينكسر به شيء', () => {
    expect(parseMarks(null)).toEqual({});
    expect(parseMarks('ليس JSON')).toEqual({});
    expect(parseMarks('[1,2]')).toEqual({});
    expect(parseMarks('"نص"')).toEqual({});
  });

  it('القيم غير الرقمية تُسقَط ولا تُفسد الباقي', () => {
    expect(parseMarks(JSON.stringify({ a: 5, b: 'قديم', c: null, d: NaN }))).toEqual({ a: 5 });
  });
});

/**
 * 🟡 حارس: اللوحة تنظر عبر نافذة، والوسم لا يخفي إلى الأبد.
 */
describe('حارس: لوحة الأخطاء', () => {
  const panel = readFileSync(join(process.cwd(), 'src', 'components', 'ErrorReportsPanel.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import[\s\S]*?from\s+'[^']*';$/gm, '');

  it('المسح يرى الملف فعلاً', () => {
    expect(panel).toContain('fetchReports');
    expect(panel).toContain('errorReports');
  });

  it('🟡 الاستعلام مُقيَّد بنافذة زمنية لا بالسقف وحده', () => {
    expect(
      /where\('createdAt', '>=', sinceMs\)/.test(panel),
      'limit وحده يعمي عن الماضي: مع التراكم تصير الـ٢٠٠ كلّها من أيام قليلة',
    ).toBe(true);
    expect(/setPeriod/.test(panel)).toBe(true);
  });

  it('🟡 و«كل التاريخ» لا تُرسل نافذةً صفرية تُسقط كل شيء', () => {
    expect(/period === 'all' \? 0 : range\.from\.getTime\(\)/.test(panel)).toBe(true);
    expect(
      /sinceMs > 0[\s\S]{0,200}\?[\s\S]{0,200}where\([\s\S]{0,300}:\s*query\(base, orderBy/.test(panel),
      'لو ذهب فرعا الشرط إلى نفس الاستعلام لصارت النافذة زينةً بلا أثر',
    ).toBe(true);
  });

  it('🟡 بلوغ السقف يُقال صراحةً', () => {
    expect(/reachedCap/.test(panel)).toBe(true);
  });

  it('🔴 الفرز يمرّ من المنطق المشترك لا من نسخة محليّة', () => {
    expect(/groupReports\(reports, marks\)/.test(panel)).toBe(true);
    expect(
      /new Map<string, \{ key: string; screen: string/.test(panel),
      'نسخة تجميع محليّة تلتفّ على قاعدة الانتكاسة المحروسة',
    ).toBe(false);
  });

  it('🔴 المُعالَج يُخفى والانتكاسة تُعرض', () => {
    expect(/filter\(g => !g\.resolved\)/.test(panel)).toBe(true);
    expect(
      /g\.regressed/.test(panel),
      'إخفاء بلا استثناء الانتكاسة يُخفي خطأً عاد فعلاً عند الزبائن',
    ).toBe(true);
  });
});
