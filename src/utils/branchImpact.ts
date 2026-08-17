import { Product } from '../types';
import { toArabicDigits } from './arabicFormatters';

/**
 * أثر أي فعلٍ على فرع — **مصدر واحد** يستهلكه الحذف والتحويل والتعطيل.
 *
 * 🔴 العلّة التي وُلد منها هذا الملف: أفعال هذه الشاشة لها آثار بعيدة في شاشات أخرى،
 * وكانت تُنفَّذ **بلا إعلان تلك الآثار**:
 *
 *  · **الحذف** يفحص البضاعة وحدها. أمّا الفواتير والمصاريف وإقفالات الصندوق والموظفون
 *    فتبقى في قاعدة البيانات و**لا شاشة تعرضها** بعد اليوم. فمن يحذف فرعاً بعد سنة عمل
 *    يُخفي سنةً من مبيعاته من كل تقرير، والشاشة لا تقول له كم سيُخفي.
 *
 *  · **تحويل محلٍّ إلى مخزن** يُخرجه من تقفيل الصندوق (فتصير إقفالاته غير قابلة للوصول)،
 *    ومن جدول المحلات في أداء الفروع، ومن قائمة فروع الموظفين — بضغطة على قائمة منسدلة.
 *
 *  · **التعطيل** يُخفي الفرع من `activeBranches`، ومنها قائمتا «من/إلى» في نقل البضاعة —
 *    فتصير بضاعته غير قابلة للنقل. والشاشة تقدّم التعطيل كبديلٍ آمن عن الحذف، وهو يسدّ
 *    الطريق الوحيد لإفراغه.
 *
 * القاعدة هنا: **لا فعل بلا إعلان أثره**. الحماية للبيانات موجودة أصلاً؛ الناقص حماية
 * **قرار التاجر** بالمعلومة.
 */

export interface StrandedItem {
  productId: string;
  name: string;
  qty: number;
}

/** بضاعة ما زالت مسجّلة في هذا الموقع — حذفه يجعلها «معلّقة»: محسوبة في الإجمالي بلا مكان. */
export function strandedStock(products: Product[], branchId: string): StrandedItem[] {
  return products
    .filter(p => (p.branchStock?.[branchId] ?? 0) !== 0)
    .map(p => ({ productId: p.id, name: p.name, qty: p.branchStock?.[branchId] ?? 0 }))
    .sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty));
}

export interface LinkedCounts {
  invoices: number;
  transactions: number;
  closings: number;
  employees: number;
  transfers: number;
}

export const EMPTY_COUNTS: LinkedCounts = {
  invoices: 0, transactions: 0, closings: 0, employees: 0, transfers: 0,
};

export const totalLinked = (c: LinkedCounts): number =>
  c.invoices + c.transactions + c.closings + c.employees + c.transfers;

/** وصفٌ عربي لما يرتبط بالفرع — يُعرض قبل أي فعل لا رجعة فيه. */
export function linkedSummary(c: LinkedCounts): string {
  const parts: string[] = [];
  if (c.invoices > 0) parts.push(`${toArabicDigits(c.invoices)} فاتورة بيع`);
  if (c.transactions > 0) parts.push(`${toArabicDigits(c.transactions)} حركة مالية`);
  if (c.closings > 0) parts.push(`${toArabicDigits(c.closings)} إقفال صندوق`);
  if (c.transfers > 0) parts.push(`${toArabicDigits(c.transfers)} حركة نقل`);
  if (c.employees > 0) parts.push(`${toArabicDigits(c.employees)} موظف`);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ */

export type ActionKind = 'delete' | 'disable' | 'toWarehouse';

export interface ImpactVerdict {
  /** هل يُمنع الفعل تماماً؟ */
  blocked: boolean;
  /** سبب المنع، أو التحذير الذي يسبق التأكيد */
  message: string;
}

/**
 * حكم موحّد على الفعل المطلوب.
 *
 * ⚖️ المنع محفوظ لما يُفسد البيانات فعلاً (بضاعة معلّقة عند الحذف). وما عداه **تحذيرٌ
 * يُعلن الأثر** ويترك القرار للتاجر — لأن منعه من تنظيم فروعه وصايةٌ لا حماية.
 */
export function impactVerdict(params: {
  action: ActionKind;
  branchName: string;
  stranded: StrandedItem[];
  counts: LinkedCounts;
  /** false = تعذّر عدّ السجلات (أوفلاين) — يُقال صراحةً بدل ادّعاء الخلوّ */
  countsChecked: boolean;
}): ImpactVerdict {
  const { action, branchName, stranded, counts, countsChecked } = params;

  if (action === 'delete' && stranded.length > 0) {
    const head = stranded.slice(0, 4).map(s => `${s.name}: ${toArabicDigits(s.qty)}`).join(' · ');
    const more = stranded.length > 4 ? ` وغيرها (${toArabicDigits(stranded.length)} مادة)` : '';
    return {
      blocked: true,
      message: `لا يمكن حذف «${branchName}» — ما زالت فيه بضاعة: ${head}${more}. `
        + 'انقل بضاعته أولاً من شاشة «نقل بضاعة»، أو استخدم «تعطيل» بدل الحذف.',
    };
  }

  const linked = totalLinked(counts);
  const linkedText = countsChecked
    ? (linked > 0 ? linkedSummary(counts) : 'لا سجلات مرتبطة')
    : '⚠️ تعذّر فحص السجلات المرتبطة (لا اتصال) — قد تكون هناك سجلات لا نراها الآن';

  switch (action) {
    case 'delete':
      return {
        blocked: false,
        message: `حذف «${branchName}»؟\n\n`
          + `المرتبط به: ${linkedText}.\n\n`
          + (linked > 0
            ? 'هذه السجلات **لن تُحذف** لكنها ستصير بلا فرع: تختفي من تقارير الفروع ومن صندوقها، '
              + 'وتظهر مجمّعةً في صفّ «سجلات بلا فرع» في شاشة أداء الفروع.\n\n'
            : '')
          + 'إن كنت تريد إيقافه عن العمل فقط، فـ«تعطيل» أسلم — يبقى كل شيء في مكانه.',
      };

    case 'toWarehouse':
      return {
        blocked: false,
        message: `تحويل «${branchName}» من محل إلى مخزن؟\n\n`
          + `المرتبط به: ${linkedText}.\n\n`
          + 'المخزن يخزّن ولا يبيع، فسيخرج من:\n'
          + '  • تقفيل الصندوق (لا صندوق نقد للمخزن)\n'
          + '  • جدول المحلات في «أداء الفروع» وسباق الأعلى ربحاً\n'
          + '  • قائمة الفروع عند إسناد الموظفين\n\n'
          + 'بياناته السابقة تبقى محفوظة، ويمكنك إعادته محلاً في أي وقت.',
      };

    default: // disable
      return {
        blocked: false,
        message: `تعطيل «${branchName}»؟\n\n`
          + `المرتبط به: ${linkedText}.\n\n`
          + 'يبقى في كل السجلات التاريخية، لكنه يختفي من مبدّل الفروع ومن إسناد الموظفين.\n'
          + (stranded.length > 0
            ? `\n⚠️ فيه ${toArabicDigits(stranded.length)} مادة برصيد. يمكنك النقل **منه** بعد التعطيل لإفراغه.`
            : ''),
      };
  }
}

/* ------------------------------------------------------------------ */

/** تطبيع اسم الموقع للمقارنة — كشف التكرار قبل أن يصير خيارين متطابقين في المبدّل. */
export const branchNameKey = (name: string): string =>
  (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function findDuplicateBranch<T extends { id: string; name: string }>(
  branches: T[],
  name: string,
  excludeId?: string,
): T | null {
  const key = branchNameKey(name);
  if (!key) return null;
  return branches.find(b => b.id !== excludeId && branchNameKey(b.name) === key) ?? null;
}
