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
}

export function createPayloads(i: NewEmployeeInput): EmployeePayloads {
  return {
    employee: {
      id: i.uid, name: i.name, email: i.email,
      addedAt: i.addedAt, disabled: false, branchId: i.branchId,
    },
    index: {
      ownerUid: i.ownerUid, disabled: false,
      name: i.name, branchId: i.branchId, branchName: i.branchName,
    },
  };
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
