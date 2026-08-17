import { InstallmentPlan, InstallmentDue } from '../types';
import { localDateKey, todayISO } from './dateLocal';

/**
 * منطق الأقساط — توليد الجدول واشتقاق الحالة.
 *
 * 🔴 المبدأ: لا نخزّن «كم دفع» إطلاقاً. كل الأرقام تُشتقّ من **الفاتورة** لحظةَ العرض:
 * ما تغطّيه الخطة = إجمالي الفاتورة − المقدَّم، والمدفوع منها = مدفوع الفاتورة − المقدَّم.
 * والخطة لا تحمل من المال إلا **المقدَّم** — وهو واقعة تاريخية لا تتغيّر.
 *
 * هكذا يستحيل أن يتعارض جدول الأقساط مع دفتر الديون، ويظهر تسديد القسط تلقائياً في
 * تقفيل الصندوق والتقارير لأنه تسديد دين عادي، **ويصحّح الحساب نفسه** مهما عُدّلت
 * الفاتورة بعد إنشاء الخطة (تفصيل ذلك عند `planStatus`).
 */

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** تحليل 'yyyy-mm-dd' إلى Date محلي بلا انزياح UTC. */
const parseLocal = (s: string): Date | null => {
  const m = String(s ?? '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/** إضافة أشهر مع تصحيح انزلاق نهاية الشهر (٣١ يناير + شهر ⇒ ٢٨/٢٩ فبراير لا ٣ مارس). */
const addMonths = (base: Date, n: number): Date => {
  const d = new Date(base.getFullYear(), base.getMonth() + n, base.getDate());
  if (d.getDate() !== base.getDate()) d.setDate(0);
  return d;
};

/**
 * يولّد جدول الأقساط. الكسور تُجمَّع في **القسط الأخير** فيبقى المجموع مطابقاً للإجمالي
 * تماماً (لا يضيع دينار ولا يزيد).
 */
export function generateSchedule(
  totalAmount: number,
  count: number,
  frequency: 'monthly' | 'weekly',
  startDate: string,
): InstallmentDue[] {
  const total = Math.max(0, Math.round(totalAmount));
  const n = Math.max(1, Math.floor(count));
  const start = parseLocal(startDate) ?? new Date();
  const base = Math.floor(total / n);
  const out: InstallmentDue[] = [];
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const amount = isLast ? total - allocated : base;
    allocated += amount;
    const due = frequency === 'monthly' ? addMonths(start, i) : new Date(start.getTime() + i * 7 * 86_400_000);
    out.push({ seq: i + 1, dueDate: localDateKey(due), amount });
  }
  return out;
}

export type DueState = 'paid' | 'partial' | 'unpaid';

export interface InstallmentRow extends InstallmentDue {
  state: DueState;
  paidOfThis: number;   // كم غطّى السداد من هذا القسط
  isOverdue: boolean;   // مستحق وفات موعده ولم يكتمل
}

export interface PlanStatus {
  paidTotal: number;        // المدفوع من الأقساط (مشتق من الفاتورة)
  remaining: number;        // المتبقي
  total: number;            // ما تغطّيه الخطة الآن (مشتقّ من الفاتورة، لا لقطة قديمة)
  isCompleted: boolean;
  rows: InstallmentRow[];
  nextDue: InstallmentRow | null;  // القسط القادم غير المكتمل
  /** مبلغ القسط القادم **مسقوفاً بالمتبقي** — للعرض والمطالبة (انظر `overdueAmount`). */
  nextDueAmount: number;
  overdueRows: InstallmentRow[];   // الأقساط المتأخرة
  overdueAmount: number;           // مجموع المتأخر (الجزء غير المسدَّد منها)
  daysLateOfOldest: number;        // كم يوماً تأخّر أقدم قسط (0 = لا تأخير)
  progressPct: number;             // نسبة الإنجاز للعرض
  /** تغيّرت الفاتورة بعد إنشاء الخطة فلم يعد الجدول مطابقاً لمبلغها. */
  scheduleStale: boolean;
  /** 'grew' زادت الفاتورة · 'shrank' نقصت (مرتجع/خصم) · 'none' لا تغيير · 'missing' فُقدت */
  staleKind: 'none' | 'grew' | 'shrank' | 'missing';
}

/** الفاتورة كما يحتاجها حساب الخطة — مصدر الحقيقة الوحيد للمال. */
export interface PlanInvoice {
  finalAmount: number;
  remainingAmount?: number;
  paidAmount?: number;
}

/** المدفوع فعلاً على الفاتورة: الحقل إن وُجد، وإلا يُستنتج (فواتير قديمة). */
const invoicePaidOf = (inv: PlanInvoice): number =>
  inv.paidAmount ?? Math.max(0, inv.finalAmount - Math.max(0, inv.remainingAmount ?? 0));

/**
 * يشتقّ حالة الخطة من **الفاتورة نفسها** — لا من لقطة مخزَّنة.
 *
 * 🔴 كان الحساب `plan.totalAmount − invoiceRemaining`، و`plan.totalAmount` لقطةٌ تُجمَّد
 * لحظة الإنشاء. فأي تغيير لاحق على الفاتورة يُنتج رقماً كاذباً في اتجاهين:
 *
 *   · **زادت الفاتورة** (أُضيفت أصناف): المتبقي يتجاوز اللقطة ⇒ المدفوع يُقصّ إلى صفر
 *     فيُعرض «لم يُدفع شيء» لزبونٍ سدّد أقساطاً فعلاً.
 *   · **نقصت الفاتورة** (مرتجع أو خصم): المتبقي ينكمش ⇒ المدفوع يتضخّم فتُوسَم أقساطٌ
 *     **«مسدَّدة» ولم تُسدَّد قط**، فيكفّ التاجر عن مطالبة زبونٍ ما زال مديناً بها.
 *     وهذا أخطر الوجهين لأنه يبدو خبراً ساراً.
 *
 * الحل: كل الأرقام من الفاتورة. الخطة لا تحمل إلا **المقدَّم** (واقعة تاريخية لا تتغيّر)
 * والجدول (مواعيد). فما تغطّيه الخطة = إجمالي الفاتورة − المقدَّم، والمدفوع منها =
 * مدفوع الفاتورة − المقدَّم. يصحّح نفسه تلقائياً مهما عُدّلت الفاتورة.
 *
 * ويبقى الجدول (المواعيد والمبالغ) قد لا يطابق الإجمالي الجديد — فنرفع `scheduleStale`
 * ليُعرض للتاجر بدل أن يُخفى.
 *
 * @param invoice الفاتورة المرتبطة، أو null إن فُقدت
 */
export function planStatus(
  plan: Pick<InstallmentPlan, 'totalAmount' | 'downPayment' | 'schedule'>,
  invoice: PlanInvoice | null,
  today: string = todayISO(),
): PlanStatus {
  const down = Math.max(0, plan.downPayment ?? 0);
  // الفاتورة عند إنشاء الخطة = المقدَّم + ما قُسِّط. مشتقّ لا مخزَّن، فيعمل مع الخطط القديمة.
  const anchorFinal = down + Math.max(0, plan.totalAmount);

  let total: number;
  let paidTotal: number;
  let staleKind: PlanStatus['staleKind'];

  if (!invoice) {
    // فُقدت الفاتورة — لا نزعم أنها سُدِّدت. نعرض اللقطة ونصرّح بأن المصدر غائب.
    total = Math.max(0, plan.totalAmount);
    paidTotal = 0;
    staleKind = 'missing';
  } else {
    total = Math.max(0, invoice.finalAmount - down);
    paidTotal = clamp(invoicePaidOf(invoice) - down, 0, total);
    staleKind = invoice.finalAmount > anchorFinal ? 'grew'
      : invoice.finalAmount < anchorFinal ? 'shrank'
      : 'none';
  }

  const remaining = total - paidTotal;

  // توزيع المدفوع على الأقساط بالترتيب (الأقدم أولاً) — يطابق منطق FIFO في تسديد الديون
  let pool = paidTotal;
  const rows: InstallmentRow[] = plan.schedule.map(d => {
    const paidOfThis = Math.min(pool, d.amount);
    pool -= paidOfThis;
    const state: DueState = paidOfThis >= d.amount ? 'paid' : paidOfThis > 0 ? 'partial' : 'unpaid';
    const isOverdue = state !== 'paid' && d.dueDate < today;
    return { ...d, paidOfThis, state, isOverdue };
  });

  const overdueRows = rows.filter(r => r.isOverdue);
  /**
   * 🔴 المتأخر لا يتجاوز المتبقي أبداً.
   *
   * الجدول قد يكون أكبر من الدَّين الحقيقي بعد مرتجع أو خصم — فمجموع الأقساط الفائتة
   * يصير أكبر مما على الزبون فعلاً. وبلا هذا السقف يطالبه التاجر بثلاثة أضعاف ما عليه
   * (رأيتها حيّاً: «المتأخر ٩٠٬٠٠٠» ودَينه ٣٠٬٠٠٠). لا أحد يتأخّر عن دفع ما لا يدين به.
   */
  const overdueAmount = Math.min(
    overdueRows.reduce((s, r) => s + (r.amount - r.paidOfThis), 0),
    remaining,
  );
  const oldest = overdueRows[0];
  const oldestDate = oldest ? parseLocal(oldest.dueDate) : null;
  const todayDate = parseLocal(today);
  const daysLateOfOldest = oldestDate && todayDate
    ? Math.max(0, Math.round((todayDate.getTime() - oldestDate.getTime()) / 86_400_000))
    : 0;

  // مجموع الجدول لم يعد يطابق ما تغطّيه الخطة ⇒ المواعيد والمبالغ قديمة وإن كان المال صحيحاً
  const scheduleSum = plan.schedule.reduce((s, d) => s + d.amount, 0);

  // نفس سقف `overdueAmount`: القسط القادم لا يُطالَب به فوق ما بقي على الزبون فعلاً.
  // بعد مرتجع يصير مبلغ الجدول أكبر من الدَّين كلّه، فيُعرض رقم يُطالَب به ظلماً.
  const nextDueRow = rows.find(r => r.state !== 'paid') ?? null;
  const nextDueAmount = nextDueRow ? Math.min(nextDueRow.amount - nextDueRow.paidOfThis, remaining) : 0;

  return {
    paidTotal,
    remaining,
    total,
    isCompleted: remaining <= 0,
    rows,
    nextDue: nextDueRow,
    nextDueAmount,
    overdueRows,
    overdueAmount,
    daysLateOfOldest,
    progressPct: total > 0 ? Math.round((paidTotal / total) * 100) : 100,
    scheduleStale: staleKind !== 'none' || scheduleSum !== total,
    staleKind,
  };
}

/** هل يستحق القسط خلال الأيام القادمة؟ (لتصفية «المستحق قريباً») */
export function isDueWithin(dueDate: string, days: number, today: string = todayISO()): boolean {
  const d = parseLocal(dueDate), t = parseLocal(today);
  if (!d || !t) return false;
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  return diff >= 0 && diff <= days;
}
