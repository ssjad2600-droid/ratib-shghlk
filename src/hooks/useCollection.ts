import { useState, useEffect } from 'react';
import {
  collection, doc, setDoc, deleteDoc, onSnapshot, query, QueryConstraint,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useSession } from '../context/SessionContext';
import { guardWrite, reportReadFailure, clearReadFailure } from '../utils/writeGuard';

// مرجع ثابت لحالة "بلا قيود" — يضمن أن نداء المالك بلا وسيط يستخدم نفس المرجع كل رندر
// فلا يتغيّر اعتماد الـeffect ولا يُعاد الاشتراك (سلوك مطابق حرفياً لما قبل التوسيع).
const EMPTY_CONSTRAINTS: QueryConstraint[] = [];

/**
 * Generic Firestore collection hook.
 * Binds to /users/{ownerUid}/{collectionName} and exposes real-time items + CRUD helpers.
 * T must have an `id: string` field used as the Firestore document ID.
 *
 * ownerUid يأتي من SessionContext (وليس auth.currentUser.uid مباشرة):
 * للمالك هما نفس القيمة ⇒ سلوك مطابق تماماً للسابق؛ وللموظف مستقبلاً
 * تُبنى المسارات على شجرة مالكه (ضمن حدود قواعد Firestore المنشورة).
 *
 * constraints (اختياري): قيود استعلام (مثل where). المالك لا يمرّرها ⇒ استماع على المجموعة
 * كاملةً (كما كان). الموظف يمرّر [where('createdByUid','==',uid)] ليطابق شرط القاعدة
 * (الاستماع غير المفلتر يُرفض له). يجب تمرير مصفوفة **ثابتة/مُذكّرة** (useMemo) لتفادي
 * إعادة الاشتراك كل رندر.
 */
export function useCollection<T extends { id: string }>(
  collectionName: string,
  constraints: QueryConstraint[] = EMPTY_CONSTRAINTS,
) {
  const { ownerUid } = useSession();
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ownerUid) {
      setItems([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const ref = collection(db, 'users', ownerUid, collectionName);
    // بلا قيود ⇒ نستمع للمرجع مباشرة (مطابق للسلوك السابق للمالك)
    const source = constraints.length ? query(ref, ...constraints) : ref;

    /**
     * 🔴 `onSnapshot` **يقتل الاشتراك عند أول خطأ** ولا يُعيد المحاولة من نفسه.
     *
     * وأثر ذلك أن سباقاً عابراً عند الإقلاع (اشتراكٌ يسبق جاهزية رمز المصادقة، فيصل
     * `permission-denied`) يُفقد المجموعة **طوال الجلسة**: قائمة فارغة إلى أن يُغلق
     * التاجر البرنامج ويفتحه. رأيتُه حيّاً على `product_costs`.
     *
     * فنُعيد المحاولة مرّاتٍ معدودة بتباعد متزايد. محدودة العدد عمداً: الرفض الدائم
     * (صلاحيات حقيقية) يجب أن يستقرّ على بلاغٍ يراه التاجر، لا أن يدور بلا نهاية.
     */
    let unsub: () => void = () => {};
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const MAX_RETRIES = 4;

    const subscribe = () => {
      if (stopped) return;
      unsub = onSnapshot(
      source,
      (snap) => {
        // معرّف الوثيقة هو المصدر الموثوق للـ id. لكل المجموعات الحالية data.id == doc.id
        // (تُحفظ بـ setDoc(doc(coll,item.id),item)) ⇒ سلوك مطابق؛ ويوفّر id لمجموعة
        // customers_public التي بياناتها { name } فقط (بلا id لقيد قاعدة الموظف).
        setItems(snap.docs.map((d) => ({ ...d.data(), id: d.id }) as T));
        setLoading(false);
        attempt = 0;
        // نجاحٌ بعد تعثّر ⟵ يُمحى البلاغ، فلا يبقى إنذارٌ لعلّة زالت
        clearReadFailure(collectionName);
      },
      (err) => {
        unsub();
        if (attempt < MAX_RETRIES && !stopped) {
          // تباعد متزايد: ٤٠٠ﻡ ثم ٨٠٠ ثم ١٦٠٠ ثم ٣٢٠٠ — يكفي لجاهزية الرمز
          retryTimer = setTimeout(subscribe, 400 * 2 ** attempt);
          attempt++;
          return;
        }
        /**
         * 🔴 نفدت المحاولات ⟵ فشلٌ يستحقّ أن يُقال.
         *
         * كان `console.error` وحده، والقائمة تبقى فارغة. والفارغ يُقرأ «لا يوجد زبائن»
         * لا «تعذّرت القراءة» — فيظنّ التاجر أن بياناته ضاعت ويُعيد إدخالها، فتُضاعَف
         * حين يعود الوصول.
         */
        reportReadFailure(collectionName, err);
        setLoading(false);
      }
      );
    };

    subscribe();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsub();
    };
  }, [collectionName, ownerUid, constraints]);

  /**
   * Fire-and-forget: with persistentLocalCache the write lands in the local
   * cache immediately; awaiting server ack would hang forever while offline.
   *
   * 🔴 وهذا القرار صحيح، لكن `.catch(console.error)` كان يجعله **صامتاً**: أي رفضٍ
   * دائم (صلاحيات، بيانات غير صالحة، تجاوز حصّة) يمرّ كنجاح كامل — تُطبَع الفاتورة
   * ويُغلق النموذج ولا شيء على الخادم. `guardWrite` تُبقي السلوك حرفياً (غير محجوب،
   * والخطأ في الطرفية) وتُضيف إبلاغاً مرئياً في شريط «لم يُحفظ».
   *
   * ⚠️ والرفض هنا لا يقع من ضعف الشبكة: الكتابة بلا اتصال تبقى **معلّقة** في الطابور
   * ولا تُرفَض. فما يصل إلى `guardWrite` فشلٌ لن ينجح أبداً — وهو ما يجب أن يُقال.
   */
  const save = async (item: T): Promise<void> => {
    if (!ownerUid) return;
    guardWrite(
      setDoc(doc(db, 'users', ownerUid, collectionName, item.id), item),
      collectionName, 'save',
    );
  };

  const remove = async (id: string): Promise<void> => {
    if (!ownerUid) return;
    guardWrite(
      deleteDoc(doc(db, 'users', ownerUid, collectionName, id)),
      collectionName, 'remove',
    );
  };

  return { items, loading, save, remove };
}
