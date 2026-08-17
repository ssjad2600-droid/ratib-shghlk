import { useEffect, useState } from 'react';
import {
  collection, doc, setDoc, query, orderBy, onSnapshot, limit, where,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useSession } from '../context/SessionContext';
import { AuditAction, AuditEntity, AuditLog } from '../types';

/**
 * سجل التدقيق — طبقة موحّدة لتسجيل كل عملية مؤثرة على الكيانات الحساسة.
 *
 * المبدأ: fire-and-forget تماماً مثل باقي كتابات التطبيق — لا تحجب الـ UI ولا تفشل
 * العملية الأصلية لو فشل التسجيل (المستخدم أهم من السجل). الخطأ يذهب للـ console فقط.
 *
 * الاستخدام النموذجي:
 *   await logAudit({
 *     action: 'delete',
 *     entity: 'invoice',
 *     entityId: inv.id,
 *     summary: `حذف فاتورة رقم ${inv.invoiceNumber} (${inv.finalAmount} د.ع)`,
 *     before: inv as unknown as Record<string, unknown>,
 *   });
 *
 * اسم الفاعل يأتي تلقائياً من:
 *   1. الـ ownerName من profile المالك (يُمرَّر صراحةً)
 *   2. بروفايل Firebase Auth (fallback عند ownerName الفارغ)
 *
 * هذا الـ util لا يعرف الـ profile — يحتاج تمرير actorName صراحة. الـ wrappers حوله
 * (التي تُستخدم داخل الشاشات) تقرأ الـ profile من useProfile().
 */

const genAuditId = (): string =>
  `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export interface LogAuditParams {
  action: AuditAction;
  entity: AuditEntity;
  entityId: string;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  actorUid: string;
  actorName: string;
  /**
   * 🔴 شجرة المحل التي يُكتب فيها السجل. حرج للموظفين:
   * بدونه كان السجل يُكتب في users/{actorUid} أي **شجرة الموظف الخاصة**، وقواعد Firestore
   * تجعلها ملكه وحده ⇒ المالك لا يرى عمليات موظفيه إطلاقاً (يُبطل الغرض من السجل كلياً).
   * يُمرَّر دائماً من useActor().ownerUid. الافتراضي actorUid للتوافق (المالك: متطابقان).
   */
  ownerUid?: string;
  relatedEntity?: AuditEntity;
  relatedEntityId?: string;
}

export async function logAudit(params: LogAuditParams): Promise<void> {
  const { actorUid, actorName, ownerUid, ...rest } = params;
  if (!actorUid) {
    // لا يوجد جلسة (logout مثلاً) — لا نسجّل بصمت. هذا متعمَّد.
    return;
  }
  const treeUid = ownerUid || actorUid; // شجرة المحل (للمالك: نفس actorUid)
  const log: AuditLog = {
    id: genAuditId(),
    actorUid,
    actorName: actorName || 'مالك',
    createdAt: Date.now(),
    ...rest,
  };
  try {
    // الكتابة مباشرة على وثيقة بمعرّف فريد — تتجنّب ازدحام الـ batch عند الفواتير المجمَّعة
    await setDoc(doc(db, 'users', treeUid, 'audit_logs', log.id), log);
  } catch (err) {
    // نسجّل الخطأ فقط — لا نرمي أبداً (لا نُفشِل العملية الأصلية بسبب فشل السجل)
    console.error('[Audit] write failed:', err);
  }
}

/** أقصى ما يُحمَّل داخل النافذة الواحدة — حدٌّ للأداء لا لإخفاء التاريخ. */
export const AUDIT_PAGE_CAP = 1000;

/**
 * اشتراك حي بسجلات التدقيق داخل **نافذة زمنية**، مرتّبة من الأحدث.
 *
 * 🔴 العلّة التي عولجت: كان الحدّ `limit(500)` **أعمى بلا نافذة** — ولا صفحات ولا سبيل
 * لما وراءه. وفي البرنامج ٣٧ موضع تسجيل، فمحلٌّ متوسط الحركة يستهلك الخمسمئة في أسبوع
 * أو اثنين. وبعدها تبقى عملية الشهر الماضي في قاعدة البيانات **ولا سبيل لرؤيتها من
 * البرنامج إطلاقاً** — والسجل موجودٌ أصلاً للسؤال المتأخّر: «مَن عدّل هذا الشهر الماضي؟».
 *
 * الآن النافذة يختارها المالك، والسقف داخلها يُعلَن (`reachedCap`) بدل أن يبتر بصمت.
 * والاستعلام `where + orderBy` على **نفس الحقل** فلا يحتاج فهرساً مركّباً.
 *
 * @param sinceMs بداية النافذة (ms). صفر = كل التاريخ.
 */
export function useAuditLogs(sinceMs: number = 0, maxItems: number = AUDIT_PAGE_CAP) {
  const { ownerUid } = useSession();
  const [items, setItems] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ownerUid) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const base = collection(db, 'users', ownerUid, 'audit_logs');
    const q = sinceMs > 0
      ? query(base, where('createdAt', '>=', sinceMs), orderBy('createdAt', 'desc'), limit(maxItems))
      : query(base, orderBy('createdAt', 'desc'), limit(maxItems));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setItems(snap.docs.map(d => ({ ...d.data(), id: d.id }) as AuditLog));
        setLoading(false);
      },
      (err) => {
        console.error('[Audit] subscribe:', err);
        setLoading(false);
      },
    );
    return () => unsub();
  }, [ownerUid, sinceMs, maxItems]);

  /** بلغ السقف ⇒ قد تكون هناك عمليات أقدم داخل النافذة لم تُحمَّل. يُقال ولا يُخفى. */
  return { items, loading, reachedCap: items.length >= maxItems };
}
