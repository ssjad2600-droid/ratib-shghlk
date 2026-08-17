import { doc, setDoc, deleteDoc, WriteBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { Invoice } from '../types';
import { normalizeSerial } from './warranty';
import { reportFirestoreError } from './writeGuard';

/**
 * مرآة الضمان: /users/{owner}/warranty_index/{serialKey}
 *
 * إسقاط عام يقرؤه **الموظف** للبحث عن ضمان جهاز باعه أي زميل، دون كشف أي بيانات حسّاسة:
 * لا اسم زبون، ولا أسعار، ولا أرباح — فقط ما يلزم لخدمة الزبون على الكاونتر.
 * (نفس فلسفة customers_public: مجموعة منفصلة بدل محاولة إخفاء حقل داخل وثيقة يقرؤها.)
 *
 * معرّف الوثيقة = السيريال المُوحَّد، فالكتابة idempotent: إعادة حفظ نفس الفاتورة لا تكرّر
 * السجل، وإعادة بيع نفس الجهاز (مستعمل) تحدّث ضمانه للبيع الأحدث — وهو السلوك الصحيح.
 */
export interface WarrantyIndexEntry {
  id: string;             // = السيريال المُوحَّد (مفتاح البحث)
  serial: string;         // السيريال كما أُدخل (للعرض)
  productName: string;
  saleDate: string;       // 'yyyy-mm-dd'
  warrantyMonths?: number;
  invoiceNumber: string;
}

/** معرّف وثيقة صالح لـ Firestore من السيريال (يمنع '.' و'..' والفراغ). */
const serialDocId = (serial: string): string | null => {
  const key = normalizeSerial(serial);
  if (!key || key === '.' || key === '..' || key.length > 1500) return null;
  return key;
};

export const warrantyIndexRef = (ownerUid: string, serialKey: string) =>
  doc(db, 'users', ownerUid, 'warranty_index', serialKey);

/**
 * يستخرج مدخلات الضمان من فاتورة (سطورها التي تحمل سيريالات).
 * يُستخدم عند حفظ الفاتورة من شاشة المالك أو الموظف.
 */
export function warrantyEntriesOf(inv: Pick<Invoice, 'items' | 'date' | 'invoiceNumber'>): WarrantyIndexEntry[] {
  const out: WarrantyIndexEntry[] = [];
  for (const item of inv.items ?? []) {
    for (const s of item.serials ?? []) {
      const id = serialDocId(s);
      if (!id) continue;
      out.push({
        id,
        serial: s,
        productName: item.unitLabel ? `${item.name} - ${item.unitLabel}` : item.name,
        saleDate: inv.date,
        ...(item.warrantyMonths ? { warrantyMonths: item.warrantyMonths } : {}),
        invoiceNumber: inv.invoiceNumber,
      });
    }
  }
  return out;
}

/**
 * يضيف كتابات المرآة إلى دفعة قائمة (batch) — لتبقى مع الفاتورة في نفس العملية الذرّية.
 * لا يفعل شيئاً إن لم تحمل الفاتورة أي سيريال (الحالة الغالبة: بقالة/مواد عادية).
 */
export function addWarrantyIndexToBatch(
  batch: WriteBatch,
  ownerUid: string,
  inv: Pick<Invoice, 'items' | 'date' | 'invoiceNumber'>,
): number {
  const entries = warrantyEntriesOf(inv);
  for (const e of entries) batch.set(warrantyIndexRef(ownerUid, e.id), e);
  return entries.length;
}

/**
 * 🔴 يحذف مرآة السيريالات التي لم تعد في الفاتورة.
 *
 * الكتابة بلا حذف تُبقي «أشباح ضمان»: جهازٌ أُرجع أو فاتورةٌ حُذفت أو سيريالٌ صُحِّح —
 * تبقى مرآته تقول «الضمان فعّال» للموظف إلى الأبد. فيُكرم زبونٌ بضمانٍ على جهاز أعاده
 * وقبض ثمنه.
 *
 * ⚠️ كل مسار يكتب في المرآة ملزَمٌ بأن يعرف كيف يحذف منها — يفرضه حارس في الاختبارات.
 */
export function removeWarrantyIndexFromBatch(
  batch: WriteBatch,
  ownerUid: string,
  serialKeys: string[],
): number {
  for (const key of serialKeys) batch.delete(warrantyIndexRef(ownerUid, key));
  return serialKeys.length;
}

/** حذف مستقل (fire-and-forget) حين لا تتوفّر دفعة. */
export function removeWarrantyIndex(ownerUid: string, serialKeys: string[]) {
  for (const key of serialKeys) {
    deleteDoc(warrantyIndexRef(ownerUid, key))
      .catch(err => reportFirestoreError('warranty_index', 'remove', err, '[Firestore] warranty_index remove'));
  }
}

/** كتابة مستقلة (fire-and-forget) حين لا تتوفّر دفعة — مثل مسار حفظ فاتورة المالك. */
export function syncWarrantyIndex(
  ownerUid: string,
  inv: Pick<Invoice, 'items' | 'date' | 'invoiceNumber'>,
) {
  for (const e of warrantyEntriesOf(inv)) {
    setDoc(warrantyIndexRef(ownerUid, e.id), e)
      .catch(err => reportFirestoreError('warranty_index', 'save', err, '[Firestore] warranty_index sync'));
  }
}
