import { WriteBatch, doc } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * حالة صلاحية الموظف تسكن **وثيقتين**، وهذا الملف هو المكان الوحيد الذي يعرف أنهما تتحرّكان معاً.
 *
 * 🔴 العلّة: كانت الوثيقتان تُكتبان بنداءين **مستقلَّين fire-and-forget**:
 *
 * ```ts
 * updateDoc(doc(db,'users',ownerUid,'employees',id), { disabled: next }).catch(console.error);
 * updateDoc(doc(db,'employeeIndex',id),              { disabled: next }).catch(console.error);
 * ```
 *
 * وكلٌّ منهما مرجعٌ لجهة مختلفة:
 *   · `users/{owner}/employees/{uid}` ⟵ تقرؤه **قواعد Firestore** (`isEmployeeOf`). هو الحقيقة الأمنية.
 *   · `employeeIndex/{uid}`           ⟵ تقرؤه **جلسة الموظف** (`SessionContext`). هو ما تراه الواجهة.
 *
 * فنجاح إحداهما وفشل الأخرى يجعل الأمن شيئاً والواجهة شيئاً آخر، بلا أي إشارة:
 *   · نجح الفهرس وفشل `employees` ⟵ الشاشة تقول «مُعطَّل» و**القواعد تسمح له بالبيع فعلاً**.
 *   · نجح `employees` وفشل الفهرس ⟵ يبدو فعّالاً ويعمل يوماً كاملاً وكل كتاباته تُرفض بصمت.
 *
 * 🛡️ العلاج: `writeBatch` واحدة. وفايرستور يضمن ذرّيتها **عبر المجموعات** وعبر طابور
 * الأوفلاين معاً — فلا حاجة لانتظار الخادم (`await`) الذي يُعلّق الشاشة بلا اتصال.
 *
 * 🔧 ونقطة مقصودة: نستعمل `set(..., {merge:true})` لا `update()`.
 *   `update()` يفشل على وثيقة غير موجودة، **ويُسقط الدفعة كلها معه**. وقد تكون وثيقة الفهرس
 *   غائبة فعلاً عند موظفٍ تضرّر من العلّة نفسها قبل إصلاحها — فكان المالك سيعجز عن تعطيله
 *   إلى الأبد. و`set/merge` تُنشئها إن غابت ⇒ **الإصلاح يشفي الانفصال القائم لا يمنع الجديد فقط**.
 *
 * ⚠️ ولذلك يحمل كل تعديلٍ على الفهرس حقل `ownerUid`: قاعدة `/employeeIndex/{uid}` تشترط
 *   `request.auth.uid == request.resource.data.ownerUid` في كل كتابة — فبدونه تُرفض الوثيقة
 *   المُنشأة حديثاً، ويسقط الشفاء.
 */

export const employeeRef = (ownerUid: string, uid: string) =>
  doc(db, 'users', ownerUid, 'employees', uid);

export const employeeIndexRef = (uid: string) =>
  doc(db, 'employeeIndex', uid);

/** حمولتا العملية الواحدة — نقيّتان وقابلتان للاختبار بلا فايرستور. */
export interface EmployeePayloads {
  /** ما يُكتب في `users/{owner}/employees/{uid}` — مرجع القواعد. */
  employee: Record<string, unknown>;
  /** ما يُكتب في `employeeIndex/{uid}` — مرجع جلسة الموظف. */
  index: Record<string, unknown>;
}

export interface NewEmployeeInput {
  uid: string;
  ownerUid: string;
  name: string;
  email: string;
  addedAt: string;
  branchId: string;
  branchName: string;
  /** رقم الموظف القصير — بادئة أرقام فواتيره. انظر `nextEmployeeCode`. */
  code: number;
}

export function createPayloads(i: NewEmployeeInput): EmployeePayloads {
  return {
    employee: {
      id: i.uid, name: i.name, email: i.email,
      addedAt: i.addedAt, disabled: false, branchId: i.branchId, code: i.code,
    },
    index: {
      ownerUid: i.ownerUid, disabled: false,
      name: i.name, branchId: i.branchId, branchName: i.branchName, code: i.code,
    },
  };
}

/**
 * رقم الموظف القصير — بادئة فواتيره.
 *
 * 🔴 العلّة: كانت البادئة `uid.slice(-4)`، ومعرّفات فايربيس **حروفٌ وأرقام**. فيخرج
 * رقم الفاتورة هكذا: `E1aJ-7` — حروفٌ لاتينية في رقمٍ يقرأه صاحب محلٍّ عربي من
 * ورقة. لا يُكتب على لوحة الأرقام، ولا يُملى في الهاتف، ولا يدلّ على أحد.
 *
 * ⚠️ ولا يُعاد استعمال رقمٍ لموظفٍ حُذف: `max + 1` لا «عدد الموظفين + ١». فلو أُعيد،
 * لتقاسم شخصان مساحة ترقيمٍ واحدة وصار `٢-٧` فاتورتين لموظفين مختلفين.
 */
export function nextEmployeeCode(employees: Array<{ code?: number }>): number {
  let max = 0;
  for (const e of employees) {
    if (typeof e.code === 'number' && Number.isSafeInteger(e.code) && e.code > max) max = e.code;
  }
  return max + 1;
}

/** ترقيم موظفٍ قديم أُنشئ قبل وجود الحقل — يُكتب في الوثيقتين كغيره. */
export function codePayloads(ownerUid: string, code: number): EmployeePayloads {
  return {
    employee: { code },
    index: { ownerUid, code },
  };
}

/**
 * من يحتاج رقماً، وأيّ رقمٍ يأخذ — منطقٌ نقيّ خارج المكوّن ليُختبَر.
 *
 * 🔴 أُخرج من `EmployeeManagement` بعد أن كشفت تجربةُ زرعِ عطلٍ أن الحارس هناك
 * **نصّيّ**: يعدّ الدفعات الذرّية ولا يرى أن الحلقة عُطّلت. والحساب هنا هو ما
 * يُقرّر الأرقام المطبوعة على الوصولات، فبقاؤه في `useEffect` يجعله سلوكاً لا
 * يفحصه أحد.
 *
 * ⚠️ الترتيب بالأقدم أولاً: الموظف الأقدم يأخذ `١`. وأرقام الموجودين لا تُمسّ.
 */
export function assignMissingCodes(
  employees: Array<{ id: string; code?: number; addedAt?: string }>,
): Array<{ id: string; code: number }> {
  const missing = employees
    .filter(e => typeof e.code !== 'number')
    .sort((a, b) => (a.addedAt || '').localeCompare(b.addedAt || ''));
  let next = nextEmployeeCode(employees);
  return missing.map(e => ({ id: e.id, code: next++ }));
}

/**
 * تعطيل/تفعيل — الحقل الأمني الوحيد في البرنامج.
 * يُكتب في الوثيقتين بنفس القيمة، وإلا انفصل ما تراه الواجهة عمّا تُنفّذه القواعد.
 */
export function disabledPayloads(ownerUid: string, disabled: boolean): EmployeePayloads {
  return {
    employee: { disabled },
    index: { ownerUid, disabled },   // ownerUid لازم للقاعدة ولشفاء فهرسٍ غائب
  };
}

/** نقل الفرع — الفهرس يحمل الاسم أيضاً لأن مجموعة branches محجوبة عن الموظف. */
export function branchPayloads(ownerUid: string, branchId: string, branchName: string): EmployeePayloads {
  return {
    employee: { branchId },
    index: { ownerUid, branchId, branchName },
  };
}

/**
 * إدراج العملية في دفعة — **الوثيقتان معاً دائماً**.
 * لا تُصدَّر دالةٌ تكتب واحدةً منهما وحدها عمداً: غيابُ الطريق أقوى من التذكير به.
 */
export function stageEmployeeWrite(
  batch: WriteBatch,
  ownerUid: string,
  uid: string,
  payloads: EmployeePayloads,
): void {
  batch.set(employeeRef(ownerUid, uid), payloads.employee, { merge: true });
  batch.set(employeeIndexRef(uid), payloads.index, { merge: true });
}

/** حذف الموظف — الوثيقتان معاً، وإلا بقي أثرٌ يجعل جلسته تُحسم خطأً. */
export function stageEmployeeDelete(batch: WriteBatch, ownerUid: string, uid: string): void {
  batch.delete(employeeRef(ownerUid, uid));
  batch.delete(employeeIndexRef(uid));
}

/** رسالة موحّدة عند فشل الدفعة — الذرّية تضمن أن **لا شيء** كُتب. */
export const SYNC_FAILED = (action: string) =>
  `تعذّر ${action}. لم يُحفظ أي تغيير (العملية ذرّية) — تحقّق من الاتصال وأعد المحاولة.`;
