import { WriteBatch, doc, increment } from 'firebase/firestore';
import { db } from '../firebase';
import { Customer, Invoice } from '../types';
import { customerPublicRef } from './customersPublic';
import { addWarrantyIndexToBatch, removeWarrantyIndexFromBatch, warrantyEntriesOf } from './warrantyIndex';

/**
 * كتابة البيعة — الفاتورة ورصيد الزبون يتحرّكان **معاً أو لا يتحرّكان**.
 *
 * 🔴 العلّة: مسار البيع عند المالك كان أربع كتابات مستقلّة fire-and-forget:
 *   `applyDebtDelta` (رصيد الزبون) · `saveInvoice` · `syncInventory` · `syncWarrantyIndex`.
 * فرصيدٌ يزيد ٥٠٠ ألف بلا فاتورة تُسنده = دَينٌ لا سند له. أو فاتورةٌ بدين لا يظهر في
 * رصيد الزبون = مالٌ ضائع من الدفتر. والانحراف صامتٌ يظهر بعد أسابيع.
 *
 * ⚠️ ولماذا **لا يشمل المخزون**؟ لأن هذا الدرس مكتوبٌ في الكود بثمنه:
 *
 *   > «(fix 1) دفعتان منفصلتان … كانتا معاً؛ فلو حُذف منتج بينما الموظف أوفلاين، أفشل
 *   > `batch.update` على وثيقة محذوفة الدفعةَ كلها عند المزامنة ⇒ **اختفت الفاتورة بصمت**»
 *   > — EmployeeInvoicesView.tsx
 *
 * أي أن الذرّية الكاملة جُرِّبت وأنتجت ما هو أسوأ. والسبب أن الحقيقتين ليستا متساويتين:
 *
 *   · **الفاتورة والدين حقيقة مالية** — المال قُبض، وضياعها لا يُعوَّض.
 *   · **خصم المخزون حقيقة جردية** — تعذّره يُصلَح من شاشة «تسوية المخزون» الموجودة أصلاً.
 *
 * فتغليبُ بقاء الفاتورة على اتّساق الجرد هو الترتيب الصحيح، لا تنازلاً بل قراراً.
 * هذا الملف يجعل مسار المالك مطابقاً لمسار الموظف الذي تعلّم الدرس قبله.
 */

/** حركة رصيد واحدة: زبونٌ ومقدار التغيّر. تُطبَّق دائماً بـ`increment` لا بقيمة مطلقة. */
export interface BalanceOp {
  customerId: string;
  delta: number;
}

export interface BalanceInput {
  /** هل الزبون هو نفسه قبل التعديل؟ (الإنشاء: true دائماً) */
  isSameCustomer: boolean;
  /** الزبون المرتبط بالفاتورة بعد الحفظ. */
  newCustomerId?: string;
  /** الزبون الذي كانت الفاتورة مرتبطة به قبل التعديل. */
  oldCustomerId?: string;
  /** دَين الفاتورة القديم الذي سبق أن دخل رصيد الزبون القديم. */
  oldRemaining: number;
  /** فرق الدين على نفس الزبون (تعديل)، أو دَين الفاتورة كاملاً (إنشاء/تبديل زبون). */
  delta: number;
  /**
   * دَين فاتورة موظف لم يُطوَ بعد في رصيد الزبون.
   * الطي يضيفه لاحقاً بالقيمة النهائية، فمسّ الرصيد هنا **يُضاعفه**.
   */
  foldDeferred: boolean;
}

/**
 * حركات الرصيد لعملية حفظ واحدة — المنطق الذي تختبئ فيه أخطاء المال.
 *
 * يُرجع مصفوفة تُطبَّق **كلّها في نفس الدفعة**: عند تبديل الزبون تُعكس القيمة عن القديم
 * وتُطبَّق على الجديد، وفصلُهما كان يترك دَيناً معلّقاً على زبونٍ لم يعد صاحب الفاتورة.
 */
export function customerBalanceOps(i: BalanceInput): BalanceOp[] {
  // دَين موظف غير مطوي: لا نمسّ الرصيد إطلاقاً — لا للقديم ولا للجديد.
  if (i.foldDeferred) return [];

  const ops: BalanceOp[] = [];

  if (i.isSameCustomer) {
    if (i.newCustomerId && i.delta !== 0) ops.push({ customerId: i.newCustomerId, delta: i.delta });
    return ops;
  }

  // تبديل الزبون: اعكس كامل الدين عن القديم، ثم طبّقه كاملاً على الجديد.
  if (i.oldCustomerId && i.oldRemaining > 0) {
    ops.push({ customerId: i.oldCustomerId, delta: -i.oldRemaining });
  }
  if (i.newCustomerId && i.delta !== 0) {
    ops.push({ customerId: i.newCustomerId, delta: i.delta });
  }
  return ops;
}

export interface SalePlan {
  invoice: Invoice;
  /** حركات الرصيد — من {@link customerBalanceOps}. */
  balanceOps: BalanceOp[];
  /** زبون جديد يُنشأ مع الفاتورة (يُكتب هو ومرآته العامة في نفس الدفعة). */
  newCustomer?: Customer;
  /** سيريالات لم تعد في الفاتورة — تُحذف مرآتها وإلا بقيت «أشباح ضمان». */
  removedSerialKeys?: string[];
}

/**
 * إدراج البيعة في دفعة واحدة: الفاتورة + الرصيد + الزبون الجديد + مرآة الضمان.
 *
 * لا يلمس المخزون عمداً — انظر رأس الملف.
 */
export function stageSale(batch: WriteBatch, ownerUid: string, plan: SalePlan): void {
  // الزبون الجديد أوّلاً: الفاتورة تشير إليه، فوجودهما معاً شرط الاتّساق
  if (plan.newCustomer) {
    batch.set(doc(db, 'users', ownerUid, 'customers', plan.newCustomer.id), plan.newCustomer);
    // المرآة العامة — يقرؤها الموظف لاختيار زبون بلا رؤية أي حقل مالي
    batch.set(customerPublicRef(ownerUid, plan.newCustomer.id), { name: plan.newCustomer.name });
  }

  // الرصيد بـ`increment` دائماً — يتراكب بأمان مع طيّ ديون الموظف ومع تسديدٍ متزامن
  for (const op of plan.balanceOps) {
    batch.update(doc(db, 'users', ownerUid, 'customers', op.customerId), {
      balance: increment(op.delta),
    });
  }

  batch.set(doc(db, 'users', ownerUid, 'invoices', plan.invoice.id), plan.invoice);

  if (plan.removedSerialKeys?.length) {
    removeWarrantyIndexFromBatch(batch, ownerUid, plan.removedSerialKeys);
  }
  addWarrantyIndexToBatch(batch, ownerUid, plan.invoice);
}

/**
 * حدّ فايرستور ٥٠٠ عملية للدفعة الواحدة.
 * فاتورة واقعية لا تقترب منه، لكن استيراداً أو فاتورةً بمئات السيريالات قد يفعل —
 * وتجاوزه يُفشل الدفعة كلها. نحسبه لنقوله صراحةً بدل أن يفشل الحفظ بلا تفسير.
 */
export const BATCH_LIMIT = 500;

export function saleOpCount(plan: SalePlan): number {
  return (plan.newCustomer ? 2 : 0)      // الزبون + مرآته العامة
    + plan.balanceOps.length             // حركات الرصيد
    + 1                                  // الفاتورة
    + (plan.removedSerialKeys?.length ?? 0)
    // نعدّ مدخلات الضمان بنفس الدالة التي تكتبها — لا بتقدير مستقلّ قد يفترق عنها
    + warrantyEntriesOf(plan.invoice).length;
}
