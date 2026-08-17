import { useEffect, useRef } from 'react';
import { writeBatch, doc, deleteField } from 'firebase/firestore';
import { db } from '../firebase';
import { useCollection } from './useCollection';
import { useProductCosts } from './useProductCosts';
import { useSession } from '../context/SessionContext';
import { Product } from '../types';
import { reportFirestoreError } from '../utils/writeGuard';

/**
 * ترحيل buyPrice المضمّن (الموروث) من وثيقة المنتج إلى product_costs، وتجريده من products/{id}.
 * fire-and-forget، idempotent عبر costMap (لا بوابة "مرة واحدة" دائمة — انظر التعليق أدناه).
 *
 * 🔴 حرج: يُستدعى من OwnerShell مباشرة (مستوى الجلسة، مثل useEmployeeDebtFold) — وليس من داخل
 * ProductsView. لو بقي مربوطاً بزيارة تبويب المنتجات، فأي مالك يضيف موظفاً قبل أن يفتح ذلك
 * التبويب سيترك منتجاته القديمة تحمل buyPrice مضمّناً، وقاعدة products تسمح للموظف بقراءة
 * الوثيقة كاملة ⇒ تسرّب هامش الربح رغم كل معمار الفصل. ربطه بجلسة المالك كاملة يغلق هذه الثغرة.
 */
export function useBuyPriceMigration() {
  const { role, ownerUid } = useSession();
  const { items: products, loading: productsLoading } = useCollection<Product>('products');
  const { costMap, costsLoading } = useProductCosts();
  // معرّفات منتجات أُرسلت للترحيل ولم يتأكّد بعد اختفاء buyPrice منها محلياً عبر onSnapshot —
  // يمنع إرسال دفعة مكرّرة لنفس المنتج. حارس مؤقت وليس بوابة "مرة واحدة" دائمة: بوابة كهذه
  // (كما كانت سابقاً هنا) عرضة لسباق حقيقي عند انتقال ownerUid من null إلى قيمته الحقيقية
  // لحظة بداية الجلسة — لقطة عابرة قد تُظهر loading=false مع قائمة منتجات فارغة (من فرع
  // useCollection الخاص بحالة "لا ownerUid بعد") قبل اكتمال الاشتراك الفعلي؛ لو استقرت بوابة
  // دائمة على "تم" في تلك اللحظة، لن يُعاد فحص الترحيل أبداً طوال الجلسة (تحقّق حيّ أكّد هذا).
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (role !== 'owner' || !ownerUid) return;
    if (productsLoading || costsLoading) return;

    const inFlight = inFlightRef.current;
    for (const p of products) {
      if (p.buyPrice === undefined) inFlight.delete(p.id); // تأكّد التجريد محلياً — تحرير الحارس
    }

    const toMigrate = products.filter(p => p.buyPrice !== undefined && !costMap.has(p.id) && !inFlight.has(p.id));
    if (toMigrate.length === 0) return;

    for (const p of toMigrate) inFlight.add(p.id);

    const CHUNK = 450; // عمليتان لكل منتج (set + update)
    let batch = writeBatch(db);
    let ops = 0;
    const flush = () => { const b = batch; b.commit().catch(err => reportFirestoreError('product_costs', 'batch', err, '[Firestore] product_costs migration')); batch = writeBatch(db); ops = 0; };
    for (const p of toMigrate) {
      if (ops > 0 && ops + 2 > CHUNK) flush();
      batch.set(doc(db, 'users', ownerUid, 'product_costs', p.id), { id: p.id, buyPrice: p.buyPrice });
      batch.update(doc(db, 'users', ownerUid, 'products', p.id), { buyPrice: deleteField() });
      ops += 2;
    }
    if (ops > 0) flush();
  }, [role, ownerUid, productsLoading, costsLoading, products, costMap]);
}
