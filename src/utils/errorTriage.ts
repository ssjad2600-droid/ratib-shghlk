/**
 * فرز تقارير الأخطاء — تحويل كومة تقارير إلى قائمة عملٍ مرتّبة.
 *
 * 🟡 علّتان في لوحة الأخطاء كانتا تُفقدانها فائدتها مع الوقت:
 *
 *  ١. `limit(200)` بلا نافذة زمنية: مع تراكم التقارير تصير الـ٢٠٠ الأحدث كلّها من
 *     الأسبوع الأخير — فلا تستطيع أن تسأل «ماذا كان يحدث الشهر الماضي؟» ولا أن ترى
 *     خطأً نادراً لكنه قاتل. (نفس عمى النافذة الذي أُصلح في سجل التدقيق.)
 *
 *  ٢. لا علامة «عولج»: تُصلح الخطأ في نسخةٍ جديدة، ويبقى تقريره القديم متصدّراً
 *     القائمة إلى الأبد لأن ترتيبها بعدد المحلات — فتتراكم المُصلَحات فوق الجديد
 *     حتى تُهمَل اللوحة كلّها.
 *
 * 🔴 وقاعدة «عولج» هنا مقصودة: **الوسم مؤقّت لا نهائي.**
 * `errorReports` تمنع `update` من القواعد (التقرير أثر لا يُطمس) — فالوسم محليّ على
 * جهازك. ولو أخفى المجموعة إلى الأبد لصار أخطر من المشكلة: خطأ ظننته مُصلَحاً وعاد
 * يظهر عند زبائنك، ولا تراه. لذلك نحفظ **زمن آخر ظهور وقت الوسم**، والمجموعة تُخفى
 * ما دامت لم تتكرّر بعده؛ فإن وقعت مرّة واحدة جديدة عادت إلى القائمة موسومةً بالعودة.
 */

export interface TriageReport {
  screen: string;
  message: string;
  uid: string;
  createdAt: number;
}

export interface ErrorGroup<R extends TriageReport = TriageReport> {
  key: string;
  screen: string;
  message: string;
  count: number;
  shopCount: number;
  last: number;
  sample: R;
  /** وُسِم كمُعالَج ولم يتكرّر بعد الوسم ⟵ يُخفى افتراضياً. */
  resolved: boolean;
  /** وُسِم كمُعالَج ثم **عاد** ⟵ يُعرض بتنبيه: إصلاحك لم ينجح أو انتكس. */
  regressed: boolean;
}

/** توقيع الخطأ: نفس الرسالة في نفس الشاشة = مشكلة واحدة مهما تكرّرت. */
export const signatureOf = (r: TriageReport): string => `${r.screen}|${r.message}`;

/** خريطة الوسم: توقيع ⟵ زمن آخر ظهور لحظة الوسم. */
export type ResolvedMarks = Record<string, number>;

export function groupReports<R extends TriageReport>(
  reports: R[],
  marks: ResolvedMarks = {},
): Array<ErrorGroup<R>> {
  const m = new Map<string, { key: string; screen: string; message: string; count: number; shops: Set<string>; last: number; sample: R }>();
  for (const r of reports) {
    const key = signatureOf(r);
    const g = m.get(key) ?? { key, screen: r.screen, message: r.message, count: 0, shops: new Set<string>(), last: 0, sample: r };
    g.count += 1;
    g.shops.add(r.uid);
    if (r.createdAt > g.last) { g.last = r.createdAt; g.sample = r; }
    m.set(key, g);
  }

  const out: Array<ErrorGroup<R>> = [...m.values()].map(g => {
    const markedAt = marks[g.key];
    const wasMarked = typeof markedAt === 'number';
    // عاد بعد الوسم ⟵ انتكاسة تُعرض، لا إخفاء
    const regressed = wasMarked && g.last > markedAt;
    return {
      key: g.key, screen: g.screen, message: g.message,
      count: g.count, shopCount: g.shops.size, last: g.last, sample: g.sample,
      resolved: wasMarked && !regressed,
      regressed,
    };
  });

  /**
   * الترتيب: الانتكاسة أولاً (خطأ ظننته مُصلَحاً وعاد أخطر من خطأ جديد — يعني أن
   * إصلاحك لم يعمل عند الزبون)، ثم ما يصيب أكبر عدد من المحلات، ثم الأكثر تكراراً.
   */
  return out.sort((a, b) =>
    Number(b.regressed) - Number(a.regressed) ||
    b.shopCount - a.shopCount ||
    b.count - a.count ||
    b.last - a.last
  );
}

/** وسم مجموعة كمُعالَجة — نحفظ زمن آخر ظهورٍ رأيناه، لا زمن الضغط. */
export function markResolved(marks: ResolvedMarks, group: { key: string; last: number }): ResolvedMarks {
  return { ...marks, [group.key]: group.last };
}

export function unmarkResolved(marks: ResolvedMarks, key: string): ResolvedMarks {
  const next = { ...marks };
  delete next[key];
  return next;
}

export const RESOLVED_STORAGE_KEY = 'rs_error_resolved_v1';

/** قراءة الوسوم من التخزين المحلي — أي تلفٍ يُعامَل كغياب، لا ينكسر به شيء. */
export function parseMarks(raw: string | null): ResolvedMarks {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ResolvedMarks = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
