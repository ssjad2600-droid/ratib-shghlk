import { useEffect, useRef } from 'react';
import { useSession } from '../context/SessionContext';
import { buildBackupPayload } from '../utils/exportBackup';
import { createCloudSnapshot } from '../utils/cloudBackup';
import { UserProfile, SystemSettings } from '../types';

const INTERVAL_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * النسخ الاحتياطي التلقائي المجدول — جلسة المالك فقط.
 *
 * عند فتح التطبيق (بعد تحميل الإعدادات) يفحص: هل مرّ على آخر نسخة أكثر من المدة المختارة
 * (يومي/أسبوعي/شهري)؟ فإن نعم، يصدّر نسخة ملف فعلية تلقائياً ويحدّث lastBackupAt/lastBackupDate.
 * يحترم مفتاح autoBackup و"يدوي بالكامل" (لا يفعل شيئاً حينها) — فيصبح المفتاح والجدول حقيقيين
 * بدل كونهما تفضيلاً ميتاً.
 *
 * الحراسة: ranRef يمنع تكراره خلال الجلسة الواحدة قبل أن ينعكس lastBackupAt الجديد؛ ولا يعمل
 * إلا بعد ready (اكتمال تحميل البروفايل) تفادياً لإطلاقه على قيم افتراضية عابرة.
 */
export function useAutoBackup(
  user: Pick<UserProfile, 'uid' | 'storeName' | 'ownerName' | 'businessType'>,
  settings: SystemSettings,
  ready: boolean,
  updateSettings: (s: Partial<SystemSettings>) => void,
) {
  const { role, ownerUid } = useSession();
  const ranRef = useRef(false);

  useEffect(() => {
    if (!ready) return;
    if (role !== 'owner' || !ownerUid || !user.uid) return;
    if (ranRef.current) return;
    if (!settings.autoBackup || settings.backupInterval === 'manual') return;

    const days = INTERVAL_DAYS[settings.backupInterval ?? 'daily'] ?? 1;
    const dueMs = days * DAY_MS;
    const last = settings.lastBackupAt ?? 0;
    if (Date.now() - last < dueMs) {
      ranRef.current = true; // ليست مستحقّة بعد — لا نعيد الفحص هذه الجلسة
      return;
    }

    ranRef.current = true; // حارس قبل الإطلاق — يمنع نسخة مكرّرة قبل انعكاس lastBackupAt
    // 🔴 صار يحفظ **لقطة سحابية** بدل تنزيل ملف على الجهاز بلا استئذان:
    //  · تنزيل مفاجئ في منتصف يوم عمل سلوك مزعج لا يفهمه التاجر.
    //  · وملف على نفس الجهاز لا يحمي من تلفه ولا سرقته — واللقطة تحمي.
    // زر تنزيل الملف يدوياً باقٍ كما هو لمن أراد نسخة خارج الحساب.
    buildBackupPayload({
      uid: user.uid,
      storeName: user.storeName,
      ownerName: user.ownerName,
      businessType: user.businessType,
      settings,
    })
      .then(payload => {
        /**
         * 🔴 لا نحفظ لقطةً بُنيت من الذاكرة المحلية.
         *
         * `buildBackupPayload` تُرجع `fromCache: true` حين يتعذّر الخادم (وهي إشارة
         * أُضيفت بعد أن تبيّن أن الكاش يحوي ما زُومن على **هذا الجهاز** لا كل ما في
         * الحساب). وحفظها هنا أسوأ من عدم الحفظ: تصير نسخة الأمان التلقائية ملفاً
         * ناقصاً، **ويُحدَّث `lastBackupAt`** فلا تُستحقّ نسخة أخرى ليوم كامل — فيُطمأنّ
         * التاجر إلى أمانٍ لا يملكه.
         *
         * لا نحفظ ولا نُحدّث الطابع، ونُحرّر الحارس ليُعاد المحاولة في نفس الجلسة عند
         * عودة الاتصال. والنسخة اليدوية تبقى متاحة وتقول للتاجر صراحةً إن كانت ناقصة.
         */
        if (payload.fromCache) {
          console.warn('[AutoBackup] تُخطّيت: تعذّر الوصول إلى الخادم فاللقطة قد تكون ناقصة');
          ranRef.current = false;
          return null;
        }
        return createCloudSnapshot({
          uid: user.uid,
          json: payload.json,
          counts: payload.counts,
          appVersion: 'auto',
          createdByName: user.ownerName || 'تلقائي',
        });
      })
      .then((saved) => {
        if (!saved) return;   // تُخطّيت — لا نُحدّث الطابع فتبقى مستحقّة
        updateSettings({
          lastBackupAt: Date.now(),
          lastBackupDate: new Date().toLocaleDateString('ar-IQ') + ' (تلقائي)',
        });
      })
      .catch((err) => {
        console.error('[AutoBackup] فشل النسخ التلقائي:', err);
        ranRef.current = false; // فشل — نسمح بإعادة المحاولة لاحقاً في الجلسة
      });
  }, [
    ready, role, ownerUid, user.uid, user.storeName, user.ownerName, user.businessType,
    settings.autoBackup, settings.backupInterval, settings.lastBackupAt,
    settings, updateSettings,
  ]);
}
