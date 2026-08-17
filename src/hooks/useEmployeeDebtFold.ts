import { useEffect, useMemo, useRef } from 'react';
import { writeBatch, doc, increment } from 'firebase/firestore';
import { db } from '../firebase';
import { useCollection } from './useCollection';
import { useSession } from '../context/SessionContext';
import { Invoice, Customer } from '../types';
import { windowConstraints, daysAgoKey, WINDOW } from '../utils/dateWindow';

/**
 * الطي التلقائي لدين الموظف (Option C) — جلسة المالك فقط.
 *
 * الموظف لا يستطيع الكتابة على customer.balance، فدَينه يُسجَّل على الفاتورة فقط
 * (remainingAmount). هذا التأثير **تفاعلي مستمر** طوال جلسة المالك (لا "مرة واحدة"):
 * الموظف قد ينشئ فاتورة دين في أي لحظة أثناء انفتاح جلسة المالك، فيجب أن يُعاد تقييم
 * قائمة الفواتير غير المطويّة كل مرة تتغيّر فيها بيانات invoices/customers (onSnapshot حي).
 *
 * الحماية من التكرار تأتي حصراً من العلم debtSyncedToBalance لكل فاتورة (idempotent
 * بطبيعته)، وليس من بوابة "شغّل مرة واحدة" — بوابة كهذه ستمنع معالجة فواتير جديدة
 * تصل بعد أول لقطة (خصوصاً أول لقطة من الكاش المحلي التي قد تكون أقدم من آخر كتابة).
 * الزيادة+العلم ذرّيان في نفس الدفعة لكل زبون. إضافة صامتة لا تغيّر أي سلوك للمالك.
 */
export function useEmployeeDebtFold() {
  const { role, ownerUid } = useSession();
  // 🔴 أداء: هذا الخطّاف يعمل على مستوى التطبيق **دائماً** (كل جلسة، كل شاشة). كان يستمع
  // إلى الفواتير كاملةً، فمحل بعمر سنتين يُحمّل ~١٥ ألف وثيقة في كل إقلاع.
  // نافذة ١٨٠ يوماً تكفي بأمان واسع: الموظف يبيع اليوم، والمالك يفتح البرنامج فيُطوى دينه
  // خلال ساعات. (فاتورة موظف تبقى بلا طيّ ستة أشهر تعني أن المالك لم يفتح البرنامج أصلاً.)
  const foldConstraints = useMemo(() => windowConstraints(daysAgoKey(WINDOW.DEBT_FOLD)), []);
  const { items: invoices, loading: invLoading } = useCollection<Invoice>('invoices', foldConstraints);
  const { items: customers, loading: custLoading } = useCollection<Customer>('customers');
  // معرّفات فواتير أُرسلت للطي ولم يتأكّد بعد وصول علمها عبر onSnapshot — يمنع إرسال
  // batch مكرّرة لنفس الفاتورة بين لحظة القرار وانعكاس debtSyncedToBalance محلياً.
  // يُطهَّر تلقائياً أدناه لكل فاتورة تأكّد علمها؛ فهو حارس مؤقت لا بوابة "مرة واحدة".
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (role !== 'owner' || !ownerUid) return;
    if (invLoading || custLoading) return;

    const inFlight = inFlightRef.current;
    for (const inv of invoices) {
      if (inv.debtSyncedToBalance === true) inFlight.delete(inv.id);
    }

    // فواتير الموظفين غير المطويّة: منسوبة لغير المالك، عليها دين، وبلا علم طيّ، وليست قيد الإرسال حالياً
    const toFold = invoices.filter(inv =>
      inv.createdByUid &&
      inv.createdByUid !== ownerUid &&
      (inv.remainingAmount ?? 0) > 0 &&
      inv.debtSyncedToBalance !== true &&
      !inFlight.has(inv.id)
    );
    if (toFold.length === 0) return;

    const custById = new Map(customers.map(c => [c.id, c]));

    // نجمّع الدين لكل زبون + قائمة فواتيره — لتفادي تحديثين لنفس الوثيقة في batch واحدة
    // (increment لا يتراكم عبر كتابتين لنفس المستند في الدفعة). الزبون غير الموجود يُتخطّى بلا علم.
    const sumByCust = new Map<string, number>();
    const invIdsByCust = new Map<string, string[]>();
    for (const inv of toFold) {
      const cid = inv.customerId;
      if (!cid || !custById.has(cid)) continue; // تخطٍّ آمن — يُعاد لاحقاً عند توفّر الزبون
      sumByCust.set(cid, (sumByCust.get(cid) ?? 0) + (inv.remainingAmount ?? 0));
      const list = invIdsByCust.get(cid) ?? [];
      list.push(inv.id);
      invIdsByCust.set(cid, list);
    }
    if (sumByCust.size === 0) return;

    // وسم الفواتير المُرسَلة كـ"قيد التنفيذ" قبل الإرسال — يمنع اختيارها مجدداً إن أعاد
    // React تشغيل الـeffect قبل أن ينعكس علمها محلياً عبر onSnapshot
    for (const ids of invIdsByCust.values()) for (const id of ids) inFlight.add(id);

    // دفعات ≤450 عملية، مع إبقاء (زيادة الزبون + أعلام فواتيره) في نفس الدفعة لضمان الذرّية
    const MAX = 450;
    let batch = writeBatch(db);
    let ops = 0;
    const flush = () => { const b = batch; b.commit().catch(err => console.error('[Firestore] debt fold:', err)); batch = writeBatch(db); ops = 0; };
    for (const [cid, sum] of sumByCust) {
      const invIds = invIdsByCust.get(cid) ?? [];
      const needed = 1 + invIds.length;
      if (ops > 0 && ops + needed > MAX) flush();
      batch.update(doc(db, 'users', ownerUid, 'customers', cid), { balance: increment(sum) });
      for (const invId of invIds) {
        batch.update(doc(db, 'users', ownerUid, 'invoices', invId), { debtSyncedToBalance: true });
      }
      ops += needed;
    }
    if (ops > 0) flush();
  }, [role, ownerUid, invLoading, custLoading, invoices, customers]);
}
