import { toArabicDigits } from './arabicFormatters';

/**
 * النطاق الزمني للتقارير — **مصدر واحد** تستهلكه البطاقات والمخطط والتصدير معاً.
 *
 * 🔴 العلّة التي وُلد منها هذا الملف: كانت البطاقات تحسب مداها بقاعدة، والمخطط يرسم
 * بعدد أعمدة **ثابت** (٧ أيام · ٤ أسابيع · ٦ أشهر) بقاعدة أخرى — فافترق المقياسان،
 * وتحتهما جملة تقول «بيانات حقيقية للفترة المختارة». قِسْتُ الفارق:
 *
 *   · اليوم   ⟵ المخطط يعرض «البارحة» وهي **خارج** كل بطاقات الشاشة
 *   · الأسبوع ⟵ البطاقات ٩ أيام والمخطط ٧
 *   · الشهر   ⟵ البطاقات ٣٢ يوماً والمخطط ٢٩
 *   · السنة   ⟵ البطاقات ٣٦٧ يوماً والمخطط **١٧١** — أقلّ من نصف الفترة
 *
 * فالتاجر يرى بطاقةً تقول «مبيعات السنة ٥٠ مليوناً» ومخططاً يرسم ستة أشهر، ولو جمع
 * الأعمدة لما بلغ نصف الرقم. وهي علّة **ثقة** لا علّة حساب — وفي شاشة اسمها «التقارير»
 * الثقة هي المنتج.
 *
 * ⚖️ ومعها تصحيحان في تعريف المدد نفسها:
 *   · «الأسبوع» صار **٧ أيام** بالضبط (كان ٩ لأن الطرح من اليوم يُبقي اليوم نفسه زائداً).
 *   · «السنة» صارت **٣٦٥ يوماً** (كانت ٣٦٧ للسبب نفسه).
 *   فما يقوله الاسم هو ما يُحسب.
 */

export type PeriodKey = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'all';

export interface PeriodRange {
  /** بداية أول يوم (٠٠:٠٠) */
  from: Date;
  /** نهاية آخر يوم (٢٣:٥٩:٥٩) — فمبيعة اليوم لا تسقط بفارق ساعات */
  to: Date;
  /** عدد الأيام شاملاً الطرفين */
  days: number;
  label: string;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(d.getDate() + n); return x; };

export const daysInclusive = (from: Date, to: Date): number =>
  Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86_400_000) + 1;

/** أطول مدى تحتاجه هذه الشاشة — لضبط نافذة تحميل الفواتير. */
export const MAX_PERIOD_DAYS = 365;

export function periodRange(period: PeriodKey, now: Date = new Date()): PeriodRange {
  const today = startOfDay(now);
  const to = endOfDay(now);
  switch (period) {
    case 'daily':
      return { from: today, to, days: 1, label: 'اليوم' };
    case 'weekly':
      return { from: addDays(today, -6), to, days: 7, label: 'آخر ٧ أيام' };
    case 'monthly':
      return { from: addDays(today, -29), to, days: 30, label: 'آخر ٣٠ يوماً' };
    case 'yearly':
      return { from: addDays(today, -364), to, days: 365, label: 'آخر سنة' };
    default:
      return { from: new Date(2000, 0, 1), to, days: daysInclusive(new Date(2000, 0, 1), to), label: 'كل الفترات' };
  }
}

/** يحوّل نصّ تاريخ (بأي صيغة يخزّنها البرنامج) إلى `Date` عند منتصف الليل، أو null. */
export function parseDayLoose(dateStr: string): Date | null {
  if (!dateStr) return null;
  const s = String(dateStr)
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[‎‏]/g, '')
    .replace(/\//g, '-')
    .trim();

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);

  const parts = s.split('-');
  if (parts.length === 3) {
    /**
     * 🔴 ترتيب الفحص مهمّ — والأصل كان يقلبه: كان يرفع `١٧` إلى `٢٠١٧` **قبل** أن يفحص
     * صيغة «يوم-شهر-سنة»، فيصير الشرط `y < 1000` مستحيلاً بعد الرفع، ولا يُصحَّح أبداً.
     * فتُقرأ `17-08-2026` سنةَ **٢٠١٧** — تاريخٌ يسقط خارج كل نطاق بصمت.
     */
    const p0 = parseInt(parts[0], 10);
    const p1 = parseInt(parts[1], 10);
    const p2 = parseInt(parts[2], 10);
    let y: number, mo: number, da: number;
    if (p0 > 1000) { y = p0; mo = p1 - 1; da = p2; }            // سنة-شهر-يوم
    else if (p2 > 1000) { y = p2; mo = p1 - 1; da = p0; }       // يوم-شهر-سنة
    else { y = p0 < 100 ? p0 + 2000 : p0; mo = p1 - 1; da = p2; }
    const d = new Date(y, mo, da);
    if (!isNaN(d.getTime())) return startOfDay(d);
  }
  const fallback = new Date(s);
  return isNaN(fallback.getTime()) ? null : startOfDay(fallback);
}

export function isInRange(dateStr: string, range: PeriodRange): boolean {
  const d = parseDayLoose(dateStr);
  if (!d) return false;
  return d >= range.from && d <= range.to;
}

/* ------------------------------------------------------------------ */

export interface ChartBucket {
  name: string;
  from: Date;
  to: Date;
  /** عمودٌ للمقارنة خارج الفترة (يوم أمس في عرض «اليوم») — يُعلَّم كي لا يُخلط بها */
  outsidePeriod?: boolean;
}

const AR_MONTHS = [
  'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
  'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول',
];
const AR_DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

/**
 * دلاء المخطط — **مشتقّة من النطاق** لا من أعداد ثابتة، فتغطّيه كاملاً بلا زيادة ولا نقص.
 *
 * والحالة اليومية استثناء مُعلَن: عمود «البارحة» يبقى لأن المقارنة أنفع من عمودٍ وحيد،
 * لكنه يُعلَّم `outsidePeriod` كي تقوله الواجهة صراحةً بدل أن تُوهم أنه من الفترة.
 */
export function chartBuckets(period: PeriodKey, range: PeriodRange): ChartBucket[] {
  if (period === 'daily') {
    const yesterday = addDays(range.from, -1);
    return [
      { name: 'البارحة', from: yesterday, to: endOfDay(yesterday), outsidePeriod: true },
      { name: 'اليوم', from: range.from, to: range.to },
    ];
  }

  // مدى قصير ⟵ عمود لكل يوم
  if (range.days <= 14) {
    return Array.from({ length: range.days }, (_, i) => {
      const day = addDays(range.from, i);
      return { name: AR_DAYS[day.getDay()], from: day, to: endOfDay(day) };
    });
  }

  // مدى متوسط ⟵ دلاء من ٧ أيام تُبنى من **النهاية** فيكون الأحدث أسبوعاً كاملاً
  if (range.days <= 92) {
    const buckets: ChartBucket[] = [];
    let end = startOfDay(range.to);
    while (end >= range.from) {
      const start = addDays(end, -6);
      const from = start < range.from ? range.from : start;
      buckets.unshift({
        name: `${toArabicDigits(from.getDate())}–${toArabicDigits(end.getDate())} ${AR_MONTHS[end.getMonth()]}`,
        from,
        to: endOfDay(end),
      });
      end = addDays(from, -1);
    }
    return buckets;
  }

  // مدى طويل ⟵ دلاء بالأشهر التقويمية، مقصوصة عند طرفَي النطاق
  const buckets: ChartBucket[] = [];
  let cursor = new Date(range.from.getFullYear(), range.from.getMonth(), 1);
  while (cursor <= range.to) {
    const monthStart = cursor < range.from ? range.from : cursor;
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const to = monthEnd > range.to ? range.to : endOfDay(monthEnd);
    buckets.push({ name: AR_MONTHS[cursor.getMonth()], from: monthStart, to });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return buckets;
}

/** وصف نصّي للنطاق — يُطبع في التصدير وتحت المخطط، فما يُعرض يقول مداه بنفسه. */
export const rangeText = (range: PeriodRange): string =>
  `${toArabicDigits(range.from.toLocaleDateString('ar-IQ'))} — ${toArabicDigits(range.to.toLocaleDateString('ar-IQ'))}`;
