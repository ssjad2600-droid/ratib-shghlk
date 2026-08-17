import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  periodRange, isInRange, chartBuckets, parseDayLoose, daysInclusive, PeriodKey,
} from '../reportPeriod';

/**
 * 🔴 المخطط كان لا يغطّي الفترة التي تعلوه — في الأربع كلها.
 *
 * البطاقات تحسب مداها بقاعدة، والمخطط يرسم بعدد أعمدة ثابت بقاعدة أخرى، وتحتهما جملة
 * تقول «بيانات حقيقية للفترة المختارة». والسنة كانت أسوأها: بطاقات ٣٦٧ يوماً ومخطط ١٧١.
 */

const NOW = new Date(2026, 7, 17, 14, 30);   // ١٧ آب ٢٠٢٦، الثانية والنصف ظهراً
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('🔴 مدد الفترات تطابق أسماءها', () => {
  it('«اليوم» يوم واحد', () => {
    const r = periodRange('daily', NOW);
    expect(r.days).toBe(1);
    expect(key(r.from)).toBe('2026-08-17');
  });

  it('🔴 «آخر ٧ أيام» سبعة بالضبط — كانت ٩', () => {
    const r = periodRange('weekly', NOW);
    expect(r.days).toBe(7);
    expect(key(r.from)).toBe('2026-08-11');
  });

  it('🔴 «آخر ٣٠ يوماً» ثلاثون بالضبط — كانت ٣٢', () => {
    const r = periodRange('monthly', NOW);
    expect(r.days).toBe(30);
    expect(key(r.from)).toBe('2026-07-19');
  });

  it('🔴 «آخر سنة» ٣٦٥ يوماً — كانت ٣٦٧', () => {
    expect(periodRange('yearly', NOW).days).toBe(365);
  });

  it('النطاق ينتهي بنهاية اليوم لا بلحظته — فمبيعة اليوم لا تسقط بفارق ساعات', () => {
    const r = periodRange('daily', NOW);
    expect(r.to.getHours()).toBe(23);
    expect(isInRange('2026-08-17', r)).toBe(true);
  });
});

describe('🔴 دلاء المخطط تغطّي النطاق كاملاً', () => {
  const cover = (period: PeriodKey) => {
    const r = periodRange(period, NOW);
    const b = chartBuckets(period, r).filter(x => !x.outsidePeriod);
    return { range: r, first: b[0], last: b[b.length - 1], buckets: b };
  };

  it('🔴 الأسبوع: أول دلو يبدأ ببداية النطاق وآخره ينتهي بنهايته', () => {
    const { range, first, last } = cover('weekly');
    expect(key(first.from)).toBe(key(range.from));
    expect(key(last.to)).toBe(key(range.to));
  });

  it('🔴 الشهر: يغطّي ٣٠ يوماً — كان يرسم ٢٩ ويترك ٣ أيام خارج الرسم', () => {
    const { range, first, last, buckets } = cover('monthly');
    expect(key(first.from)).toBe(key(range.from));
    expect(key(last.to)).toBe(key(range.to));
    const total = buckets.reduce((s, b) => s + daysInclusive(b.from, b.to), 0);
    expect(total, 'مجموع أيام الدلاء يساوي أيام الفترة بلا زيادة ولا نقص').toBe(range.days);
  });

  it('🔴 السنة: يغطّي ٣٦٥ يوماً — كان يرسم ١٧١ فقط', () => {
    const { range, first, last, buckets } = cover('yearly');
    expect(key(first.from)).toBe(key(range.from));
    expect(key(last.to)).toBe(key(range.to));
    const total = buckets.reduce((s, b) => s + daysInclusive(b.from, b.to), 0);
    expect(total, 'المخطط كان يغطّي أقلّ من نصف الفترة').toBe(range.days);
  });

  it('🔴 الدلاء لا تتداخل — وإلا احتُسبت مبيعة في عمودين', () => {
    for (const p of ['weekly', 'monthly', 'yearly'] as PeriodKey[]) {
      const b = chartBuckets(p, periodRange(p, NOW)).filter(x => !x.outsidePeriod);
      for (let i = 1; i < b.length; i++) {
        expect(b[i].from.getTime(), `${p}: تداخل عند ${i}`).toBeGreaterThan(b[i - 1].to.getTime());
      }
    }
  });

  it('«اليوم»: عمود البارحة يبقى للمقارنة لكنه **مُعلَّم** خارج الفترة', () => {
    const b = chartBuckets('daily', periodRange('daily', NOW));
    expect(b).toHaveLength(2);
    expect(b[0].outsidePeriod, 'كان يُعرض كأنه من الفترة وهو ليس في أي بطاقة').toBe(true);
    expect(b[1].outsidePeriod).toBeUndefined();
  });

  it('عدد الأعمدة معقول للقراءة في كل فترة', () => {
    for (const p of ['weekly', 'monthly', 'yearly'] as PeriodKey[]) {
      const n = chartBuckets(p, periodRange(p, NOW)).length;
      expect(n, `${p}: ${n} عموداً`).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(14);
    }
  });
});

describe('التصفية بالنطاق', () => {
  const r = periodRange('weekly', NOW);   // ١١ – ١٧ آب

  it('يشمل الطرفين', () => {
    expect(isInRange('2026-08-11', r)).toBe(true);
    expect(isInRange('2026-08-17', r)).toBe(true);
  });

  it('يستبعد ما قبل وما بعد', () => {
    expect(isInRange('2026-08-10', r)).toBe(false);
    expect(isInRange('2026-08-18', r)).toBe(false);
  });

  it('التالف والفارغ يُستبعدان بلا انفجار', () => {
    for (const bad of ['', 'أبجد', '  ']) expect(isInRange(bad, r)).toBe(false);
  });
});

describe('قراءة التاريخ', () => {
  it('ISO والأرقام العربية والفارسية', () => {
    expect(key(parseDayLoose('2026-08-17')!)).toBe('2026-08-17');
    expect(key(parseDayLoose('٢٠٢٦-٠٨-١٧')!)).toBe('2026-08-17');
    expect(key(parseDayLoose('۲۰۲۶-۰۸-۱۷')!)).toBe('2026-08-17');
  });

  it('الشرطة المائلة وصيغة يوم-شهر-سنة', () => {
    expect(key(parseDayLoose('2026/08/17')!)).toBe('2026-08-17');
    expect(key(parseDayLoose('17-08-2026')!)).toBe('2026-08-17');
  });

  it('التالف يُرجع null لا تاريخاً وهمياً', () => {
    expect(parseDayLoose('أبجد')).toBeNull();
    expect(parseDayLoose('')).toBeNull();
  });
});

/**
 * 🔴 حارس: البطاقات والمخطط من مصدر نطاقٍ واحد.
 */
describe('حارس: شاشة التقارير', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'components', 'ReportsView.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import .*$/gm, '');

  it('المسح يرى الملف فعلاً', () => {
    expect(src).toContain('netEarnings');
    expect(src).toContain('chartData');
  });

  it('🔴 النطاق من المصدر الموحّد', () => {
    expect(/periodRange\(/.test(src)).toBe(true);
    expect(/chartBuckets\(/.test(src)).toBe(true);
  });

  it('🔴 لا أعداد أعمدة ثابتة تُخالف الفترة', () => {
    expect(
      /Array\.from\(\{\s*length:\s*(?:7|4|6)\s*\}/.test(src),
      'المخطط يرسم عدداً ثابتاً من الأعمدة بقاعدة تخالف قاعدة البطاقات',
    ).toBe(false);
  });

  it('🔴 التصفية بالنطاق نفسه لا بدالة محلية موازية', () => {
    expect(/isInRange\(/.test(src)).toBe(true);
    expect(/const isDateInPeriod\s*=/.test(src), 'عادت دالة تصفية محلية موازية').toBe(false);
  });

  it('🟠 المصاريف ضمن نافذة زمنية', () => {
    expect(/useCollection<FinancialTransaction>\('financial_transactions',\s*\w+\)/.test(src)).toBe(true);
  });

  it('🟡 التصدير متاح من شاشة التقارير', () => {
    expect(/exportAsWord\(|exportAsPdf\(/.test(src)).toBe(true);
  });
});
