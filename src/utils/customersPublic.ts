import { doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * مرآة أسماء الزبائن: /users/{owner}/customers_public/{customerId} = { name }
 * إسقاط عام يقرؤه الموظف لاختيار زبون لفاتورة دين، دون رؤية أي حقل مالي
 * (رصيد/تاريخ). القاعدة تقصر بيانات الوثيقة على المفتاح name فقط.
 *
 * المعرّف = نفس معرّف الزبون في customers، فيربط الفاتورة بالزبون الحقيقي مباشرة.
 */
export const customerPublicRef = (ownerUid: string, id: string) =>
  doc(db, 'users', ownerUid, 'customers_public', id);

// كتابة/تحديث اسم المرآة — fire-and-forget (يطابق نمط الكتابة في التطبيق)
export function syncCustomerPublic(ownerUid: string, id: string, name: string) {
  setDoc(customerPublicRef(ownerUid, id), { name })
    .catch(err => console.error('[Firestore] customers_public sync:', err));
}

// حذف المرآة — يُستدعى عند حذف الزبون
export function removeCustomerPublic(ownerUid: string, id: string) {
  deleteDoc(customerPublicRef(ownerUid, id))
    .catch(err => console.error('[Firestore] customers_public remove:', err));
}
