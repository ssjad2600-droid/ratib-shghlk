import { useState, useEffect } from 'react';
import {
  collection, doc, setDoc, deleteDoc, onSnapshot, query, QueryConstraint,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useSession } from '../context/SessionContext';

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
    const unsub = onSnapshot(
      source,
      (snap) => {
        // معرّف الوثيقة هو المصدر الموثوق للـ id. لكل المجموعات الحالية data.id == doc.id
        // (تُحفظ بـ setDoc(doc(coll,item.id),item)) ⇒ سلوك مطابق؛ ويوفّر id لمجموعة
        // customers_public التي بياناتها { name } فقط (بلا id لقيد قاعدة الموظف).
        setItems(snap.docs.map((d) => ({ ...d.data(), id: d.id }) as T));
        setLoading(false);
      },
      (err) => {
        console.error(`[Firestore] ${collectionName}:`, err);
        setLoading(false);
      }
    );

    return () => unsub();
  }, [collectionName, ownerUid, constraints]);

  // Fire-and-forget: with persistentLocalCache the write lands in the local
  // cache immediately; awaiting server ack would hang forever while offline.
  const save = async (item: T): Promise<void> => {
    if (!ownerUid) return;
    setDoc(doc(db, 'users', ownerUid, collectionName, item.id), item)
      .catch((err) => console.error(`[Firestore] save ${collectionName}:`, err));
  };

  const remove = async (id: string): Promise<void> => {
    if (!ownerUid) return;
    deleteDoc(doc(db, 'users', ownerUid, collectionName, id))
      .catch((err) => console.error(`[Firestore] remove ${collectionName}:`, err));
  };

  return { items, loading, save, remove };
}
