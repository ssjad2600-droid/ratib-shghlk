import { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { ADMIN_UID } from '../config/adminConfig';

/**
 * حالة الترخيص مشتقّة من **وثيقة كود التفعيل** لا من حقل في وثيقة المستخدم (Fix A).
 *
 * 🔴 لماذا: قاعدة /users/{uid} تسمح للمالك بكتابة أي حقل في وثيقته، فحقل licenseStatus كان
 * قابلاً للتزوير ذاتياً (سطر واحد يمنح ترخيصاً مجانياً). هنا نتحقق بدل ذلك من
 * /activationCodes/{code} أن used==true و usedBy==uid — وهذه لا يمكن للمستخدم تزويرها لأنه
 * لا يستطيع ضبط usedBy=self إلا على كود يعرفه فعلاً (الأكواد بترميز ٨٥٢ مليار احتمال، وسردها
 * محجوب). فتزوير licenseStatus يصبح بلا أثر.
 *
 * أوفلاين: كود المستخدم الحقيقي مُخزَّن في الكاش منذ لحظة التفعيل (transaction.get)، فالتحقق
 * فوري بلا اتصال. مهلة أمان ٦ ثوانٍ: لو لم تصل أي لقطة (مثل مؤشّر كود مزوّر لم يُقرأ قط أوفلاين)
 * نحسم "غير مرخّص" فتُطبّق بوابة الترخيص — يمنع تجاوزاً أوفلاين بمؤشّر وهمي.
 */
export function useLicense(uid: string | null, activationCode: string | undefined) {
  const [licensed, setLicensed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) { setLicensed(false); setLoading(false); return; }
    // الأدمن (مطوّر النظام) مرخّص دائماً — استثناء آمن بمعرّفه وحده
    if (uid === ADMIN_UID) { setLicensed(true); setLoading(false); return; }
    // لا كود مخزَّن ⇒ غير مرخّص فوراً (تجربة مجانية)
    if (!activationCode) { setLicensed(false); setLoading(false); return; }

    setLoading(true);
    let settled = false;
    const ref = doc(db, 'activationCodes', activationCode);

    const timer = setTimeout(() => {
      if (!settled) { settled = true; setLicensed(false); setLoading(false); }
    }, 6000);

    const unsub = onSnapshot(
      ref,
      (snap) => {
        settled = true;
        clearTimeout(timer);
        const d = snap.exists() ? snap.data() : null;
        setLicensed(!!d && d.used === true && d.usedBy === uid);
        setLoading(false);
      },
      (err) => {
        settled = true;
        clearTimeout(timer);
        console.error('[License] code check:', err);
        setLicensed(false);
        setLoading(false);
      },
    );

    return () => { unsub(); clearTimeout(timer); };
  }, [uid, activationCode]);

  return { licensed, loading };
}
