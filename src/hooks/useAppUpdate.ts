import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { db } from '../firebase';
import { updateFrom, releasePlatform, UpdateAvailable } from '../utils/appUpdate';
import { isElectron } from '../utils/serviceWorker';

/**
 * يفحص مرّةً عند الإقلاع هل صدر إصدارٌ أحدث.
 *
 * 🔴 لماذا؟ التطبيق يُوزَّع خارج المتاجر (ملف APK من موقع المزوّد، ومثبّت NSIS
 * لويندوز)، فلا آلية تحديثٍ تلقائي. وبلا هذا الفحص يبقى التاجر سنواتٍ على نسخةٍ
 * فيها علّةٌ أُصلحت — ولا وسيلة لإبلاغه إلا الاتصال به واحداً واحداً.
 *
 * ⚠️ `getDoc` لا `onSnapshot`: قراءةٌ واحدة عند الإقلاع تكفي تماماً، والاشتراك
 * الحيّ يكلّف اتصالاً مفتوحاً طوال الجلسة لمعلومةٍ تتغيّر مرّاتٍ في السنة.
 *
 * والفشل صامتٌ عمداً: تعذُّرُ معرفة وجود تحديث لا يجوز أن يُزعج التاجر برسالةٍ
 * لا يملك حيالها فعلاً — نسخته تعمل.
 */
export function useAppUpdate(ready: boolean): UpdateAvailable | null {
  const [update, setUpdate] = useState<UpdateAvailable | null>(null);

  useEffect(() => {
    if (!ready) return;

    const platform = releasePlatform(
      Capacitor.isNativePlatform(),
      Capacitor.getPlatform(),
      isElectron(),
    );
    // المتصفّح يُحدَّث بذاته عند كل زيارة — إشعارٌ فيه بلا معنى
    if (!platform) return;

    let cancelled = false;
    void (async () => {
      try {
        const snap = await getDoc(doc(db, 'appRelease', platform));
        if (cancelled || !snap.exists()) return;
        setUpdate(updateFrom(snap.data(), __APP_VERSION__));
      } catch { /* لا شبكة أو لا صلاحية — لا شيء يُعرض */ }
    })();

    return () => { cancelled = true; };
  }, [ready]);

  return update;
}
