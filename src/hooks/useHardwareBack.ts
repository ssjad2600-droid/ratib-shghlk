import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import {
  createNavHistory, createExitGuard, decideBack, registerBackInterceptor, NavHistory,
} from '../utils/navHistory';

/**
 * وصل زرّ الرجوع بالمنصّة — أندرويد والمتصفّح بحلٍّ واحد.
 *
 * 🔴 أندرويد: زرّ الرجوع حدثٌ من النظام (`backButton`) لا انتقالٌ في السجلّ.
 *    وبلا معالج، يُغلق النظام التطبيق فوراً من أي شاشة.
 *
 * 🔴 المتصفّح/PWA: لا حدث `backButton`، بل `popstate`. ولا يقع `popstate` إلا إن
 *    كان في السجلّ ما يُرجَع إليه — لذا نضع مدخلاً وهمياً واحداً ونُعيد وضعه بعد
 *    كل رجوعٍ استهلكناه. وعند الجذر لا نُعيده، فيخرج المتصفّح من التطبيق طبيعياً.
 *
 * والمنطق نفسه في الحالتين (`decideBack`): أغلِق نافذةً، وإلا ارجع شاشةً، وإلا
 * فالجذر ⟶ ضغطتان للخروج.
 */

const HISTORY_MARK = 'ratib-nav';

export interface HardwareBackOptions {
  /** ينتقل إلى شاشة (يُمرَّر `setActiveTab` دون تسجيلٍ جديد في المكدّس). */
  onNavigate: (tab: string) => void;
  /** يُستدعى عند أول ضغطةٍ على الجذر — لعرض تلميح «اضغط مرة أخرى للخروج». */
  onExitHint: () => void;
}

/**
 * يُنشئ المكدّس ويصله بالمنصّة. يُعيد المكدّس كي يُسجّل المستدعي فيه كل انتقال.
 *
 * ⚠️ المكدّس في `useRef` لا `useState`: تغييره لا يجب أن يُعيد الرسم — فالرسم
 * يقوده `activeTab` وحده. ولو كان حالةً لأعاد رسم التطبيق كلّه عند كل انتقال مرّتين.
 */
export function useHardwareBack(opts: HardwareBackOptions): NavHistory {
  const historyRef = useRef<NavHistory | null>(null);
  if (historyRef.current === null) historyRef.current = createNavHistory('dashboard');
  const history = historyRef.current;

  // المُعالِجات في ref: نُسجّل مستمعاً واحداً لعمر التطبيق، ولا نُعيد التسجيل
  // كلما تغيّرت دالةٌ ممرّرة — وإلا فُقدت اشتراكاتٌ أو تكرّرت بلا حدّ.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const exitGuard = createExitGuard();

    const handle = (): boolean => {
      const outcome = decideBack(history, tab => optsRef.current.onNavigate(tab));
      if (outcome !== 'root') return true;
      if (exitGuard.press()) return false;      // اخرج فعلاً
      optsRef.current.onExitHint();
      return true;                               // ابقَ، واعرض التلميح
    };

    if (Capacitor.isNativePlatform()) {
      let remove: (() => void) | null = null;
      let cancelled = false;
      void CapApp.addListener('backButton', () => {
        if (!handle()) void CapApp.exitApp();
      }).then(h => {
        if (cancelled) void h.remove(); else remove = () => void h.remove();
      });
      return () => { cancelled = true; remove?.(); };
    }

    // ---- المتصفّح / PWA ----
    const arm = () => {
      try { window.history.pushState({ [HISTORY_MARK]: true }, ''); }
      catch { /* بيئةٌ بلا سجلّ (اختبار) — لا ضرر */ }
    };
    const onPop = () => {
      // `handle()` تُعيد false عند الجذر فقط: عندها لا نُعيد التسليح فيغادر المتصفّح
      if (handle()) arm();
    };
    arm();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [history]);

  return history;
}

/**
 * يجعل نافذةً منبثقة تُغلَق بزرّ الرجوع بدل أن يتبدّل ما تحتها.
 *
 * الاستعمال: `useBackClose(isOpen, close)` داخل أي مكوّن نافذة.
 */
export function useBackClose(active: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    return registerBackInterceptor(() => { closeRef.current(); return true; });
  }, [active]);
}
