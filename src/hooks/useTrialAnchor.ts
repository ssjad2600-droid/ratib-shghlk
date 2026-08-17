import { useEffect, useRef } from 'react';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { useSession } from '../context/SessionContext';
import { toMillis } from '../utils/trialPeriod';

/**
 * ختم مرساة التجربة ونبضة وقت الخادم — جلسة المالك فقط.
 *
 * 🔴 لماذا الخادم لا الجهاز؟ لأن مُدخَلَي حساب التجربة كانا كلاهما بيد المستخدم: حقلٌ
 * يملك كتابته، وساعةُ جهازه. فالختم هنا بـ`serverTimestamp()` — **العميل لا يُرسل القيمة
 * أصلاً**، بل يطلب من الخادم أن يضعها. وهذا يغلق الاتجاهين معاً: لا يستطيع تأخيرها
 * لتمديد التجربة، ولا تُفسدها ساعةٌ مضبوطة خطأً على سنة قادمة فتُنهي تجربته ظلماً.
 *
 * حقلان اثنان:
 *  · `trialStartedAt` — يُختم **مرة واحدة** عند غيابه. مرساة البداية.
 *  · `lastSeenAt`     — يُحدَّث كل بضع ساعات. آخر لحظة خادمٍ رآها الحساب، فإرجاع ساعة
 *                       ويندوز لا ينفع: الحساب يحسب «الآن» بأكبر القيمتين.
 *
 * 🛡️ الحسابات القائمة لا تتأثّر: من له `createdAt` يبقى محسوباً عليه حتى يُختم له
 * `trialStartedAt`، ومن كان مرخّصاً لا يُحسب له شيء أصلاً. ولا تُكتب قيمة واحدة تُقصّر
 * تجربة أحد.
 */

/** لا نكتب النبضة أكثر من مرة كل ٦ ساعات — يكفي لكشف إرجاع الساعة بلا كتابات عبثية. */
const HEARTBEAT_MS = 6 * 60 * 60 * 1000;

export function useTrialAnchor(
  ready: boolean,
  licensed: boolean,
  trialStartedAt: unknown,
  lastSeenAt: unknown,
) {
  const { role, ownerUid } = useSession();
  // يمنع كتابةً ثانية قبل أن تعود اللقطة بالقيمة الجديدة (وإلا دار: كتابة ⟵ لقطة ⟵ كتابة)
  const beatRef = useRef(false);
  /**
   * 🔴 الختم يُحاوَل **مرة واحدة في الجلسة** ولا يُعاد أبداً.
   *
   * كشفَ هذا شريطُ «لم يُحفظ» نفسه بعد دقائق من تركيبه: أول لقطة للبروفايل قد تأتي من
   * الكاش المحلي بلا `trialStartedAt` (نسخة محفوظة قبل أن تُختم المرساة)، فيظنّ الخطّاف
   * أن المرساة غائبة ويحاول ختمها — والقاعدة المنشورة ترفض تغيير مرساة مختومة.
   *
   * وكانت الكتابتان في `setDoc` واحدة، فرفضُ الختم **يُسقط النبضة معه** — أي أن دفاع
   * إرجاع الساعة يتوقّف بسبب محاولةٍ لا لزوم لها. فُصلتا، والختم صار محاولةً واحدة:
   * رفضُه يعني «المرساة موجودة ومحميّة»، وهي الحالة المطلوبة أصلاً.
   */
  const stampedRef = useRef(false);

  useEffect(() => {
    if (!ready) return;
    if (role !== 'owner' || !ownerUid) return;
    const ref = doc(db, 'users', ownerUid);

    // ١) المرساة — تُختم مرة واحدة فقط، عند غيابها، وبلا إعادة محاولة.
    if (toMillis(trialStartedAt) === null && !stampedRef.current) {
      stampedRef.current = true;
      setDoc(ref, { trialStartedAt: serverTimestamp() }, { merge: true })
        .catch(() => {
          // رفضٌ هنا = المرساة مختومة ومحميّة خادمياً. ليس خطأً يُبلَّغ عنه.
        });
    }

    /**
     * ٢) النبضة — مستقلّة تماماً، وللمرخّص أيضاً.
     *
     * قد يبدو أن المرخّص لا يحتاجها، لكن الترخيص قد ينتهي أو يُلغى فيعود الحساب للتجربة،
     * فتلزمه سلسلة زمنية غير منقطعة. وكتابةٌ كل ٦ ساعات كلفتها لا تُذكر.
     */
    const seen = toMillis(lastSeenAt);
    if (!beatRef.current && (seen === null || Date.now() - seen > HEARTBEAT_MS)) {
      beatRef.current = true;
      setDoc(ref, { lastSeenAt: serverTimestamp() }, { merge: true })
        .catch(err => {
          console.error('[TrialAnchor] تعذّرت نبضة وقت الخادم:', err);
          beatRef.current = false; // نسمح بإعادة المحاولة في نفس الجلسة
        });
    }
  }, [ready, role, ownerUid, licensed, trialStartedAt, lastSeenAt]);
}
