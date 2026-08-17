import { useState, useEffect } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * عدد فواتير الموظف التي لم تصل الخادم بعد (كتابات معلّقة في طابور الأوفلاين).
 *
 * الإشارة المصدر: metadata.hasPendingWrites لكل وثيقة — يجعلها Firestore true طالما الكتابة
 * محليّة لم يؤكّدها الخادم، ويقلبها false فور المزامنة. نمرّر includeMetadataChanges:true حتى
 * يُطلَق المستمع عند تغيّر البيانات الوصفية وحدها (لحظة تأكيد المزامنة) فينزل العدّاد فوراً.
 *
 * الاستعلام مفلتر بـ createdByUid ليطابق قاعدة Firestore (استماع الموظف غير المفلتر مرفوض).
 * يُستخدم لتحذير الموظف قبل تسجيل الخروج أوفلاين مع وجود فواتير غير مزامَنة (خطر فقدانها).
 */
export function usePendingWrites(ownerUid: string | null, employeeUid: string | null) {
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!ownerUid || !employeeUid) {
      setPendingCount(0);
      return;
    }
    const q = query(
      collection(db, 'users', ownerUid, 'invoices'),
      where('createdByUid', '==', employeeUid),
    );
    const unsub = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        setPendingCount(snap.docs.reduce((n, d) => n + (d.metadata.hasPendingWrites ? 1 : 0), 0));
      },
      (err) => console.error('[Firestore] pending writes:', err),
    );
    return () => unsub();
  }, [ownerUid, employeeUid]);

  return { pendingCount };
}
