import { useMemo } from 'react';
import { useSession } from '../context/SessionContext';
import { useProfile } from './useProfile';
import { auth } from '../firebase';

/**
 * معلومات الفاعل الحالي (المالك) — للاستخدام مع logAudit() في كل الشاشات.
 *
 * يوحّد مصدر الحقيقة:
 *   - uid: من Firebase Auth (المالك في كل الحالات، الموظف في الجلسات الموحدة)
 *   - name: من profile المالك (ownerName)، مع fallback لاسم الموظف من الجلسة، ثم للبريد الإلكتروني
 *
 * لو المالك غير مسجّل دخول (مستحيل في الشاشات المحمية لكن للحماية):
 *   - actorUid = '' ⇒ logAudit يتجاهل السجل بدلاً من تسجيله بمعرّف مجهول
 */
export function useActor(): { uid: string; name: string; ownerUid: string } {
  const session = useSession();
  const { profileData } = useProfile();
  return useMemo(() => {
    const uid = auth.currentUser?.uid ?? session.employeeUid ?? session.ownerUid ?? '';
    // ترتيب الأسبقية: اسم المالك من البروفايل > اسم الموظف من الجلسة > بريد Auth > 'مالك'
    const name =
      (session.role === 'employee' ? session.employeeName?.trim() : profileData?.ownerName?.trim()) ||
      session.employeeName?.trim() ||
      profileData?.ownerName?.trim() ||
      auth.currentUser?.email ||
      'مالك';
    // شجرة المحل التي يُكتب فيها السجل — للموظف = شجرة مالكه، لا شجرته هو.
    // بدونها كانت سجلات الموظف تُكتب في users/{employeeUid}/audit_logs فلا يراها المالك أبداً.
    const ownerUid = session.ownerUid ?? uid;
    return { uid, name, ownerUid };
  }, [
    session.employeeUid,
    session.ownerUid,
    session.employeeName,
    session.role,
    profileData?.ownerName,
  ]);
}
