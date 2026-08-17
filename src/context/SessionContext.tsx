import React, { createContext, useContext, useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { MAIN_BRANCH_ID } from '../types';

export type SessionRole = 'owner' | 'employee';

/**
 * جلسة العمل: تفصل "هويتي" (uid المصادقة) عن "المحل الذي أتبع له" (ownerUid).
 * - المالك: ownerUid == uid نفسه — السلوك الحالي للتطبيق بلا أي تغيير.
 * - الموظف: ownerUid == uid مالكه — تُقرأ/تُكتب بيانات شجرة المالك (ضمن قواعد Firestore المنشورة).
 */
export interface Session {
  role: SessionRole;
  /** uid المحل الذي تُبنى منه مسارات البيانات /users/{ownerUid}/... — null = غير مسجّل دخول أو لم يُحسم بعد */
  ownerUid: string | null;
  /** uid الموظف (null للمالك) */
  employeeUid: string | null;
  employeeName: string;
  /**
   * فرع الموظف — كل بيعه يخصم من مخزون هذا الفرع وفواتيره تُنسب له (المرحلة ٣).
   * الافتراضي MAIN_BRANCH_ID: موظف قديم بلا فرع، أو محل بفرع واحد ⇒ السلوك القديم حرفياً.
   * (يُقرأ من employeeIndex لأنه الوثيقة الوحيدة التي يملك الموظف صلاحية قراءتها عن نفسه.)
   */
  branchId: string;
  /** اسم فرع الموظف — مخزَّن في employeeIndex لأن مجموعة branches غير مقروءة للموظف */
  branchName: string;
  /** موظف معطَّل من المالك — القواعد تمنعه خادمياً؛ الواجهة تعرض شاشة مناسبة (مرحلة لاحقة) */
  disabled: boolean;
  /** جارٍ حسم الدور — تُعامل كحالة تحميل في App */
  loading: boolean;
}

const LOGGED_OUT: Session = {
  role: 'owner',
  ownerUid: null,
  employeeUid: null,
  employeeName: '',
  branchId: MAIN_BRANCH_ID,
  branchName: '',
  disabled: false,
  loading: false,
};

const SessionContext = createContext<Session>(LOGGED_OUT);

export function useSession(): Session {
  return useContext(SessionContext);
}

const ownerSession = (uid: string): Session => ({
  role: 'owner',
  ownerUid: uid,
  employeeUid: null,
  employeeName: '',
  branchId: MAIN_BRANCH_ID, // المالك يبدّل فرعه من الواجهة (useBranches) لا من الجلسة
  branchName: '',
  disabled: false,
  loading: false,
});

// ---- تلميح محلي (localStorage) لآخر حسم مؤكد ----
// الغرض: إقلاع فوري دون اتصال (لا انتظار قراءة شبكة)، والمستمع يصحّح في الخلفية.
// لا يحوي بيانات حساسة: الدور + ownerUid فقط.
const hintKey = (uid: string) => `ratib_session_${uid}`;

function readHint(uid: string): Session | null {
  try {
    const raw = localStorage.getItem(hintKey(uid));
    if (!raw) return null;
    const h = JSON.parse(raw) as Partial<Session>;
    if (h.role === 'employee' && typeof h.ownerUid === 'string' && h.ownerUid) {
      return {
        role: 'employee',
        ownerUid: h.ownerUid,
        employeeUid: uid,
        employeeName: h.employeeName ?? '',
        branchId: h.branchId || MAIN_BRANCH_ID,
        branchName: h.branchName ?? '',
        disabled: h.disabled === true,
        loading: false,
      };
    }
    if (h.role === 'owner') return ownerSession(uid);
    return null;
  } catch {
    return null;
  }
}

function writeHint(uid: string, s: Session) {
  try {
    localStorage.setItem(
      hintKey(uid),
      JSON.stringify({ role: s.role, ownerUid: s.ownerUid, employeeName: s.employeeName, branchId: s.branchId, branchName: s.branchName, disabled: s.disabled })
    );
  } catch { /* تعذّر التخزين المحلي — غير حرج */ }
}

/**
 * حسم الدور عند تسجيل الدخول عبر قراءة /employeeIndex/{uid}:
 *   موجودة  ⇒ موظف (ownerUid من الفهرس)
 *   غير موجودة ⇒ مالك (ownerUid = uid) — حال كل الحسابات الحالية
 *
 * سلامة الأوفلاين (persistentLocalCache):
 *   1. تلميح محفوظ من جلسة سابقة ⇒ حسم فوري، والمستمع يحدّث في الخلفية.
 *   2. لا تلميح + متصل ⇒ يُحسم مع أول snapshot من الخادم (سريع).
 *   3. لا تلميح + غير متصل (أول إقلاع بعد التحديث دون شبكة) ⇒ مهلة أمان 8 ثوانٍ
 *      ثم افتراض "مالك" (صحيح لكل الحسابات الحالية) — لا تعليق للشاشة أبداً،
 *      والمستمع يصحّح فور عودة الاتصال. لا يُكتب تلميح للحسم غير المؤكد.
 */
export function SessionProvider({ uid, children }: { uid: string | null; children: React.ReactNode }) {
  const [session, setSession] = useState<Session>(LOGGED_OUT);

  useEffect(() => {
    if (!uid) {
      setSession(LOGGED_OUT);
      return;
    }

    const hint = readHint(uid);
    setSession(hint ?? { ...LOGGED_OUT, loading: true });

    let authoritative = false;

    const timeoutId = setTimeout(() => {
      if (!authoritative && !hint) setSession(ownerSession(uid));
    }, 8000);

    const unsub = onSnapshot(
      doc(db, 'employeeIndex', uid),
      (snap) => {
        authoritative = true;
        clearTimeout(timeoutId);
        let s: Session;
        if (snap.exists()) {
          const d = snap.data() as { ownerUid?: string; disabled?: boolean; name?: string; branchId?: string; branchName?: string };
          s = d.ownerUid
            ? {
                role: 'employee',
                ownerUid: d.ownerUid,
                employeeUid: uid,
                employeeName: d.name ?? '',
                branchId: d.branchId?.trim() || MAIN_BRANCH_ID,
                branchName: d.branchName ?? '',
                disabled: d.disabled === true,
                loading: false,
              }
            : ownerSession(uid); // وثيقة فهرس فاسدة بلا ownerUid — الحسم الأأمن
        } else {
          s = ownerSession(uid);
        }
        setSession(s);
        writeHint(uid, s);
      },
      (err) => {
        clearTimeout(timeoutId);
        console.error('[Session] employeeIndex:', err);
        // فشل القراءة (أوفلاين بلا كاش / صلاحيات) — التلميح إن وُجد، وإلا مالك
        setSession(readHint(uid) ?? ownerSession(uid));
      }
    );

    return () => {
      unsub();
      clearTimeout(timeoutId);
    };
  }, [uid]);

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
