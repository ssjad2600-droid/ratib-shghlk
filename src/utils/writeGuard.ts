/**
 * قناة إبلاغ عن الكتابات التي **فشلت نهائياً** — الشيء الوحيد الذي كان البرنامج يكتمه.
 *
 * 🔴 العلّة: كل كتابة في التطبيق تنتهي بـ`.catch(err => console.error(...))`، ٣٩ موضعاً.
 * والتاجر لا يفتح طرفية المتصفح. فكل رفضٍ من القواعد، أو حقلٍ مخالف، أو تجاوز حصّة —
 * يمرّ **كنجاحٍ كامل**: تُطبَع الفاتورة، ويُغلق النموذج، ولا شيء على الخادم.
 *
 * ⚠️ ولماذا لا يُصلَح بـ`await`؟ لأن `fire-and-forget` هنا **قرار صحيح لا إهمال**:
 * مع `persistentLocalCache` لا يُحلّ وعدُ الكتابة إلا بتأكيد الخادم، فانتظاره بلا اتصال
 * يُعلّق الشاشة إلى الأبد. المحلّ يعمل بلا إنترنت وهذا شرط أساسي في البرنامج.
 *
 * 🎯 وهنا المفتاح الذي يجعل هذا الملف ممكناً أصلاً:
 *
 *   **الكتابة بلا اتصال لا تُرفَض — تبقى معلّقة في الطابور حتى تُزامَن.**
 *   فالوعد لا يُرفَض إلا لسببٍ **دائم**: صلاحيات، بيانات غير صالحة، تجاوز حصّة.
 *
 * أي أن كل رفضٍ يصل إلى هنا هو **فشلٌ لن ينجح أبداً مهما انتظرت** — وهو بالضبط ما يجب
 * أن يعرفه التاجر. فلا خطر إنذارٍ كاذب من ضعف الشبكة، ولا حاجة لتمييز حالات.
 *
 * 📌 والسلوك لم يتغيّر: الكتابة تبقى غير محجوبة، والخطأ يبقى في الطرفية، وأُضيف عليه
 * إبلاغٌ مرئي فقط. لا شاشة تنتظر، ولا عملية تُلغى.
 */

import { probeReachability, Reachability } from './connectivityProbe';

export type WriteOp = 'save' | 'remove' | 'batch' | 'update' | 'read';

export interface WriteFailure {
  id: string;
  /** المجموعة أو وصف العملية — يظهر للتاجر معرَّباً عبر {@link describeFailure} */
  scope: string;
  op: WriteOp;
  /** رمز خطأ Firestore (permission-denied…) — للتشخيص لا للعرض */
  code: string;
  /**
   * 🔧 وصف العملية كما في الطرفية ('delete invoice').
   * كان الشريط يقول «تعذّر حفظ منتج» بلا دلالة على **أي** عملية — ترحيل؟ بيع؟
   * استيراد؟ — فيبقى التاجر والمطوّر حائرَين. رسالةٌ لا تدلّ على مصدرها نصفُ رسالة.
   */
  source?: string;
  at: number;
}

/** أسماء المجموعات بالعربية — التاجر لا يعرف `financial_transactions`. */
const SCOPE_LABELS: Record<string, string> = {
  invoices: 'فاتورة بيع',
  customers: 'زبون',
  customers_public: 'اسم زبون (نسخة الموظف)',
  products: 'منتج',
  product_costs: 'تكلفة شراء',
  financial_transactions: 'حركة مالية',
  expenses: 'مصروف',
  debt_payments: 'تسديد دين',
  cash_closings: 'تقفيل صندوق',
  employees: 'موظف',
  suppliers: 'مورد',
  supplier_payments: 'تسديد مورد',
  purchase_invoices: 'فاتورة شراء',
  stock_adjustments: 'تسوية مخزون',
  stock_transfers: 'نقل بضاعة',
  expiry_batches: 'دفعة صلاحية',
  installment_plans: 'خطة أقساط',
  branches: 'فرع أو مخزن',
  warranty_index: 'فهرس الضمان',
  audit_logs: 'سجل تدقيق',
  backups: 'نسخة احتياطية',
  public_info: 'معلومات المحل المنشورة للموظف',
};

const OP_LABELS: Record<WriteOp, string> = {
  save: 'حفظ',
  remove: 'حذف',
  batch: 'حفظ',
  update: 'تعديل',
  read: 'قراءة',
};

export const scopeLabel = (scope: string): string => SCOPE_LABELS[scope] ?? scope;

/**
 * رسالة يفهمها صاحب المحل: **ماذا لم يُحفظ، ولماذا، وماذا يفعل**.
 * نقيّة وقابلة للاختبار — لا تعتمد على Firestore ولا على React.
 */
export function describeFailure(f: Pick<WriteFailure, 'scope' | 'op' | 'code'>): string {
  /**
   * 🔴 القراءة حالةٌ مستقلّة تماماً: **لا شيء ضاع**، بل تعذّر عرضه. والقائمة الفارغة
   * تُقرأ «لا يوجد زبائن» لا «تعذّرت القراءة» — فيظنّ التاجر أن بياناته ضاعت ويُعيد
   * إدخالها، فتُضاعَف حين يعود الوصول. لذلك رسالتها تنهاه عن ذلك صراحةً.
   */
  if (f.op === 'read') {
    return `تعذّر عرض «${scopeLabel(f.scope)}» — تظهر القائمة فارغة لكن بياناتك لم تضع. `
      + `لا تُعد إدخالها؛ حدّث الصفحة، وإن تكرّر فراجع الدعم.`;
  }
  const what = `${OP_LABELS[f.op] ?? 'حفظ'} ${scopeLabel(f.scope)}`;
  switch (f.code) {
    case 'permission-denied':
      return `تعذّر ${what} — الخادم رفض العملية (صلاحيات). لم يُحفظ شيء.`;
    case 'not-found':
      return `تعذّر ${what} — السجل غير موجود على الخادم (قد يكون حُذف من جهاز آخر). لم يُحفظ شيء.`;
    case 'resource-exhausted':
      return `تعذّر ${what} — تجاوزت حصّة الاستعمال اليومية. لم يُحفظ شيء.`;
    case 'invalid-argument':
      return `تعذّر ${what} — بيانات غير صالحة. لم يُحفظ شيء.`;
    default:
      return `تعذّر ${what} — لم يُحفظ شيء. أعد المحاولة، وإن تكرّر فراجع الدعم.`;
  }
}

/** رمز الخطأ من كائن Firestore، أو 'unknown' لأي شكل آخر. */
export function codeOf(err: unknown): string {
  const e = err as { code?: unknown };
  return typeof e?.code === 'string' ? e.code : 'unknown';
}

// ---- المخزن: اشتراك بسيط بلا اعتماديات ----

const MAX_KEPT = 20;
let failures: WriteFailure[] = [];
const listeners = new Set<(f: WriteFailure[]) => void>();

/**
 * 🔴 نسخةٌ جديدة في كل إشعار — لا نفس المرجع.
 *
 * React يتخطّى إعادة الرسم حين تتطابق الحالة **مرجعياً**. وتشخيص السبب (إضافة حاجبة؟
 * شبكة؟) يصل **بعد** الفشل بثوانٍ ولا يغيّر قائمة الأخطاء — فكان يُحسب ولا يُعرض أبداً.
 * رصدتُه حيّاً: `currentDiagnosis()` تُرجع 'blocked' والشريط يعرض الرسالة العامة.
 */
const emit = () => { const snapshot = [...failures]; for (const l of listeners) l(snapshot); };

export function subscribeWriteFailures(fn: (f: WriteFailure[]) => void): () => void {
  listeners.add(fn);
  fn(failures);
  return () => { listeners.delete(fn); };
}

export function reportWriteFailure(scope: string, op: WriteOp, err: unknown, source?: string): void {
  const entry: WriteFailure = {
    id: `${Date.now().toString(36)}_${failures.length}`,
    scope, op, code: codeOf(err), at: Date.now(), source,
  };
  // الأحدث أولاً، وسقفٌ يمنع تضخّم الذاكرة لو انهار الاتصال بالصلاحيات
  failures = [entry, ...failures].slice(0, MAX_KEPT);
  emit();
  void diagnoseOnce();
}

export function clearWriteFailures(): void {
  failures = [];
  diagnosis = null;
  emit();
}

// ---- تشخيص سبب الفشل: إضافةٌ حاجبة؟ شبكة؟ ----

let diagnosis: Reachability | null = null;
let probing = false;
let lastProbeAt = 0;
const PROBE_COOLDOWN_MS = 60_000;

export const currentDiagnosis = (): Reachability | null => diagnosis;

/**
 * 🔴 يُشخّص **مرّة** عند أول فشل، ثم لا يُعاد إلا بعد دقيقة.
 *
 * لماذا التشخيص أصلاً؟ لأن «تعذّر حفظ منتج» لا تدلّ التاجر على شيء **يفعله**. أما
 * «إضافةٌ في متصفحك تحجب الاتصال» فتحوّل مكالمة دعمٍ حائرة إلى سطرٍ يقرؤه فيحلّ
 * مشكلته بنفسه. وقد رُصد `ERR_BLOCKED_BY_CLIENT` في طرفية تاجر فعلاً.
 *
 * ولماذا مرّة بمهلة تهدئة؟ لأن انهياراً في الاتصال يُنتج عشرات الأخطاء في ثانية،
 * وفحصاً لكلٍّ منها يعني عشرات الطلبات الإضافية على شبكةٍ متعثّرة أصلاً.
 */
async function diagnoseOnce(): Promise<void> {
  if (probing || Date.now() - lastProbeAt < PROBE_COOLDOWN_MS) return;
  probing = true;
  lastProbeAt = Date.now();
  try {
    diagnosis = await probeReachability({
      fetch: (u, i) => fetch(u, i),
      online: () => navigator.onLine,
      origin: location.origin,
    });
    emit();
  } catch {
    /* الفحص نفسه ليس حرجاً — غيابه يترك الرسالة العامة كما هي */
  } finally {
    probing = false;
  }
}

/** للاختبارات فقط — يعزل الحالة بين الحالات. */
export function __resetWriteFailures(): void {
  failures = [];
  listeners.clear();
}

/**
 * غلافٌ يُبقي الكتابة كما هي تماماً (غير محجوبة، والخطأ في الطرفية) ويُضيف الإبلاغ.
 *
 * الاستعمال يستبدل السطر القائم حرفياً:
 * ```ts
 * setDoc(ref, data).catch(err => console.error('[Firestore] save x:', err));   // قبل
 * guardWrite(setDoc(ref, data), 'invoices', 'save');                            // بعد
 * ```
 */
export function guardWrite<T>(promise: Promise<T>, scope: string, op: WriteOp): Promise<void> {
  return promise.then(() => undefined).catch((err) => {
    console.error(`[Firestore] ${op} ${scope}:`, err);
    reportWriteFailure(scope, op, err, `${op} ${scope}`);
  });
}

/**
 * صيغةُ الـ`catch` المباشرة — لمواضع الكتابة التي تبني دفعتها بنفسها (`batch.commit()`،
 * `updateDoc` بـ`increment`…) ولا تمرّ من `useCollection`.
 *
 * تحفظ نصّ الطرفية الأصلي كما هو (`label`) كي لا يضيع ما اعتاده المطوّر عند التشخيص،
 * وتُضيف الإبلاغ المرئي. الاستبدال حرفيّ ولا يغيّر توقيت الكتابة ولا حجبها:
 * ```ts
 * .catch(err => console.error('[Firestore] delete invoice:', err))                 // قبل
 * .catch(err => reportFirestoreError('invoices', 'remove', err, 'delete invoice')) // بعد
 * ```
 */
export function reportFirestoreError(
  scope: string,
  op: WriteOp,
  err: unknown,
  label: string,
): void {
  // `label` يحمل القوس الأصلي كاملاً ('[Firestore] delete invoice') — لا نُضيف بادئة
  // ثانية فوقه، وإلا صار النصّ '[Firestore] [Firestore] …' وضاعت مطابقة البحث في الطرفية.
  // نُسقط القوس ('[Firestore] ') فيبقى وصف العملية وحده صالحاً للعرض
  console.error(`${label}:`, err);
  reportWriteFailure(scope, op, err, label.replace(/^\[[^\]]+\]\s*/, ''));
}

/**
 * فشل **القراءة** — صمتٌ من نوع آخر وأخطر في أثره النفسي.
 *
 * 🔴 كان `onSnapshot` يكتفي بـ`console.error` والقائمة تبقى فارغة. والفارغ يُقرأ
 * «لا يوجد زبائن» لا «تعذّر القراءة» — فيظنّ التاجر أن بياناته **ضاعت**.
 * وأسوأ ما فيه أنه يدفعه لإعادة إدخالها فتُضاعَف حين يعود الوصول.
 */
export function reportReadFailure(scope: string, err: unknown): void {
  console.error(`[Firestore] ${scope}:`, err);
  reportWriteFailure(scope, 'read', err, `قراءة ${scopeLabel(scope)}`);
}

/**
 * 🔴 نجاح قراءةٍ لاحقة يمحو بلاغَ فشلها — وهذا **شرط صحّة** لا تحسيناً.
 *
 * الفرضية التي بُني عليها هذا الملف («كل رفضٍ يصل هنا دائم») صحيحة للكتابة: الأوفلاين
 * يُطابر ولا يُرفض. لكنها **لا تصحّ للقراءة**: عند الإقلاع يشترك `onSnapshot` قبل أن
 * يجهز رمز المصادقة أحياناً، فيصل `permission-denied` عابر ثم يُعاد الاشتراك وينجح.
 *
 * ورأيتُ هذا حيّاً بعد تركيب الشريط: تبويبٌ جديد يعرض «تعذّر عرض بياناتك» ثم تظهر
 * البيانات كاملة. وشريطٌ يُنذر كذباً أسوأ من غيابه — يُدرِّب التاجر على تجاهله، فلا
 * يراه يوم يصدق.
 *
 * فالبلاغ يبقى لمن **لم تنجح قراءته أبداً**، ويُمحى عمّن نجحت بعد تعثّر.
 */
export function clearReadFailure(scope: string): void {
  const before = failures.length;
  failures = failures.filter(f => !(f.op === 'read' && f.scope === scope));
  if (failures.length !== before) emit();
}
