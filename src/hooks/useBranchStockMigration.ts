import { useEffect, useRef } from 'react';
import { newBatch } from '../utils/firestoreWrite';
import { isViewOnly } from '../utils/viewOnly';
import { doc } from 'firebase/firestore';
import { db } from '../firebase';
import { useCollection } from './useCollection';
import { useSession } from '../context/SessionContext';
import { Product } from '../types';
import { needsBranchInit, initialBranchStock } from '../utils/branchStock';
import { reportFirestoreError } from '../utils/writeGuard';

/**
 * ترحيل مخزون المنتجات إلى خريطة الفروع — جلسة المالك فقط، idempotent، fire-and-forget.
 *
 * 🔴 لماذا هو ضروري وحرج:
 * منتج قديم بلا `branchStock` ثم بيع قطعة منه ⇒ `increment` على `branchStock.main` يبدأ من
 * **صفر** فينتج `-1` رغم أن المخزون ٥٠. هذا الترحيل يهيّئ الخريطة أولاً ({ main: الكمية الحالية })
 * فتبقى الأرقام صحيحة تماماً.
 *
 * يُستدعى من OwnerShell (مستوى الجلسة) مثل useBuyPriceMigration — لا من داخل شاشة، فيعمل فور
 * بدء الجلسة بصرف النظر عن التبويب المفتوح.
 *
 * الحماية من التكرار: من البيانات نفسها (needsBranchInit يصير false بعد الكتابة) + حارس
 * inFlightRef لكل منتج بين لحظة الإرسال وانعكاس النتيجة محلياً — لا بوابة «مرة واحدة» دائمة
 * (تلك عرضة لسباق ownerUid null→قيمة عند بداية الجلسة).
 */
export function useBranchStockMigration() {
  const { role, ownerUid } = useSession();
  const { items: products, loading } = useCollection<Product>('products');
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // 🔴 نسخة الهاتف تتخطّى الترحيل ولا ترمي — الرمي داخل useEffect يُسقط الشاشة.
    if (isViewOnly()) return;
    if (role !== 'owner' || !ownerUid || loading) return;

    const inFlight = inFlightRef.current;
    for (const p of products) {
      if (!needsBranchInit(p)) inFlight.delete(p.id); // تأكّدت التهيئة محلياً ⇒ حرّر الحارس
    }

    const toMigrate = products.filter(p => needsBranchInit(p) && !inFlight.has(p.id));
    if (toMigrate.length === 0) return;

    for (const p of toMigrate) inFlight.add(p.id);

    const CHUNK = 450;
    let batch = newBatch();
    let ops = 0;
    const flush = () => {
      const b = batch;
      b.commit().catch(err => reportFirestoreError('products', 'batch', err, '[Firestore] branchStock migration'));
      batch = newBatch();
      ops = 0;
    };
    for (const p of toMigrate) {
      if (ops >= CHUNK) flush();
      // merge حقل واحد فقط — لا نمسّ أي حقل آخر في وثيقة المنتج
      batch.update(doc(db, 'users', ownerUid, 'products', p.id), { branchStock: initialBranchStock(p) });
      ops++;
    }
    if (ops > 0) flush();
  }, [role, ownerUid, loading, products]);
}
