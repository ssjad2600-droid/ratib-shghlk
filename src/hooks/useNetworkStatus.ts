import { useState, useEffect, useRef } from 'react';
import { onSnapshotsInSync } from 'firebase/firestore';
import { db } from '../firebase';

export type SyncState = 'synced' | 'syncing' | 'offline';

export interface NetworkStatus {
  isOnline: boolean;
  syncState: SyncState;
}

/**
 * مؤشر حالة الشبكة والمزامنة.
 *
 * ملاحظة صادقة: navigator.onLine يخبرنا فقط أن هناك واجهة شبكة متصلة — قد يكون `true`
 * مع عدم وجود إنترنت فعلي (اتصال بشبكة محلية بلا نفاذ). لذلك نعامله كـ"تلميح" للحالة
 * غير المتصلة فقط، ولا نعلن "مزامنة كاملة" إلا بعد أن يؤكّد Firestore عبر
 * onSnapshotsInSync أن كل المستمعين لحقوا فعلاً. سلامة البيانات لا تعتمد على هذا
 * المؤشر إطلاقاً (persistentLocalCache يتكفّل بالأوفلاين الحقيقي والطابور).
 */
export function useNetworkStatus(): NetworkStatus {
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [syncState, setSyncState] = useState<SyncState>(
    navigator.onLine ? 'syncing' : 'offline'
  );
  // مرجع للمستمع الجاري — كان يُنشأ داخل handleOnline بلا تنظيف عند إلغاء التركيب (تسريب)
  const syncUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const clearSyncListener = () => {
      syncUnsubRef.current?.();
      syncUnsubRef.current = null;
    };

    // ننتظر تأكيد Firestore أن كل المستمعين تزامنوا قبل إعلان "synced"
    const awaitSync = () => {
      clearSyncListener();
      setSyncState('syncing');
      syncUnsubRef.current = onSnapshotsInSync(db, () => {
        setSyncState('synced');
        clearSyncListener();
      });
    };

    const handleOnline = () => {
      setIsOnline(true);
      awaitSync();
    };

    const handleOffline = () => {
      clearSyncListener();
      setIsOnline(false);
      setSyncState('offline');
    };

    // حالة الإقلاع: إن كنا متصلين، لا نعلن "synced" قبل تأكيد Firestore
    if (navigator.onLine) awaitSync();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearSyncListener(); // منع التسريب عند إلغاء التركيب
    };
  }, []);

  return { isOnline, syncState };
}
