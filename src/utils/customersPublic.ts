import { doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { reportFirestoreError } from './writeGuard';

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
    .catch(err => reportFirestoreError('customers_public', 'save', err, '[Firestore] customers_public sync'));
}

// حذف المرآة — يُستدعى عند حذف الزبون
export function removeCustomerPublic(ownerUid: string, id: string) {
  deleteDoc(customerPublicRef(ownerUid, id))
    .catch(err => reportFirestoreError('customers_public', 'remove', err, '[Firestore] customers_public remove'));
}
