import { increment } from 'firebase/firestore';

/**
 * توزيع تسديد الدَّين على فواتير الزبون — منطق نقيّ مفصول عن الواجهة.
 *
 * 🔴 علّتان وُلد منهما هذا الملف، وكلتاهما تُنتج **دفترين متعارضين**: رصيد الزبون يقول
 * شيئاً وفواتيره تقول شيئاً آخر، والتاجر لا يعلم أيّهما يصدّق.
 *
 *  ١) **الفائض كان يتبخّر.** لم يكن ثمّة ما يمنع أن يتجاوز المبلغُ متبقّي الفاتورة
 *     المختارة؛ الفحص الوحيد أنه لا يتجاوز دَين الزبون الكلي. فزبون عليه فاتورتان
 *     (٥٠٬٠٠٠ لكلٍّ) يُسدَّد له ٨٠٬٠٠٠ على الأولى ⇒ صارت «مدفوع ١٣٠٬٠٠٠» على فاتورة
 *     قيمتها ٥٠٬٠٠٠، والثلاثون ألفاً لم تصل الفاتورة الثانية ولم تُسجَّل في أي مكان.
 *     والحقل `paidAmount` يقرؤه تقفيل الصندوق وتقارير الأرباح، فتتلوّث أرقامها.
 *
 *  ٢) **الكتابة على الفواتير كانت مطلقة** بينما الرصيد بـ`increment`. فجهازان يحصّلان
 *     من الزبون نفسه: الرصيد يصير صفراً (صحيح) والفاتورة تبقى تقول «باقٍ عليه» (خطأ).
 *
 * القاعدة هنا: **كل دينار يُحصَّل يجد له مكاناً معلوماً**، والتوزيع كله بالفوارق لا
 * بالقيم المطلقة، فيتراكب بأمان مع تحصيل متزامن أو عمل بلا إنترنت.
 */

export interface AllocatableInvoice {
  id: string;
  finalAmount: number;
  remainingAmount?: number;
  paidAmount?: number;
  createdAt?: number;
}

export interface Allocation {
  invoiceId: string;
  amount: number;
}

export interface AllocationResult {
  allocations: Allocation[];
  /** ما لم يجد فاتورةً يذهب إليها — دَين قديم يدوي بلا فواتير مربوطة. يُخصم من الرصيد فقط. */
  unallocated: number;
}

/** متبقّي الفاتورة مع التوافق الرجعي: غياب الحقل = مسدَّدة بالكامل. */
export const remainingOf = (inv: AllocatableInvoice): number => Math.max(0, inv.remainingAmount ?? 0);

/** المدفوع فعلاً: الحقل إن وُجد، وإلا يُستنتج من الإجمالي ناقص المتبقي (فواتير قديمة). */
export const paidOf = (inv: AllocatableInvoice): number =>
  inv.paidAmount ?? Math.max(0, inv.finalAmount - remainingOf(inv));

/**
 * يوزّع مبلغاً على فواتير الزبون.
 *
 * الترتيب: الفاتورة التي اختارها التاجر أولاً (إن كان عليها متبقٍّ)، ثم الباقي **من
 * الأقدم للأحدث** — فالدَّين الأقدم أولى بالإطفاء، وهو ما يتوقّعه أي تاجر.
 *
 * لا تُعطى أي فاتورة أكثر من متبقّيها، فيستحيل أن يتجاوز `paidAmount` إجماليَّها.
 */
export function allocatePayment(
  invoices: AllocatableInvoice[],
  amount: number,
  preferredInvoiceId?: string,
): AllocationResult {
  const payable = invoices.filter(inv => remainingOf(inv) > 0);

  // الأقدم أولاً — createdAt، أو المعرّف الرقمي للفواتير القديمة كبديل
  const byAge = [...payable].sort((a, b) => {
    const ta = a.createdAt ?? (parseInt(a.id, 10) || 0);
    const tb = b.createdAt ?? (parseInt(b.id, 10) || 0);
    return ta - tb;
  });

  const preferred = preferredInvoiceId ? byAge.find(i => i.id === preferredInvoiceId) : undefined;
  const ordered = preferred ? [preferred, ...byAge.filter(i => i.id !== preferred.id)] : byAge;

  const allocations: Allocation[] = [];
  let rest = Math.max(0, Math.round(amount));

  for (const inv of ordered) {
    if (rest <= 0) break;
    const portion = Math.min(remainingOf(inv), rest);
    if (portion <= 0) continue;
    allocations.push({ invoiceId: inv.id, amount: portion });
    rest -= portion;
  }

  return { allocations, unallocated: rest };
}

/**
 * كائن تحديث الفاتورة عند التسديد — **بالفوارق** لا بالقيم المطلقة.
 *
 * ⚠️ الفاتورة القديمة قد لا تحمل الحقلين أصلاً، و`increment` على حقل غائب يبدأ من صفر
 * فيمحو ما دُفع سابقاً. لذا نبذر القيمة المطلقة **مرة واحدة** عند غياب الحقل — نفس نمط
 * `stockUpdateSeeded` في مخزون الفروع، ولنفس السبب حرفياً.
 */
export function invoicePaymentUpdate(inv: AllocatableInvoice, amount: number): Record<string, unknown> {
  const rem = remainingOf(inv);
  return {
    remainingAmount: inv.remainingAmount === undefined
      ? Math.max(0, rem - amount)
      : increment(-amount),
    paidAmount: inv.paidAmount === undefined
      ? paidOf(inv) + amount
      : increment(amount),
  };
}
