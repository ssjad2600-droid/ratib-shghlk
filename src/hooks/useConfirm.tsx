import React, { useState, useRef, useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * بديل داخلي لـ window.confirm — الحوار الأصلي في Electron/ويندوز يجمّد الـ renderer
 * وقد يُفقد النافذة مؤشر الكتابة نهائياً بعد إغلاقه.
 *
 * الاستخدام:
 *   const { requestConfirm, confirmDialog } = useConfirm();
 *   ...
 *   if (!(await requestConfirm('هل أنت متأكد؟'))) return;
 *   ...
 *   return (<div> ... {confirmDialog} </div>);
 */
export function useConfirm() {
  const [message, setMessage] = useState<string | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const requestConfirm = useCallback((msg: string): Promise<boolean> => {
    // 🔴 حوار جديد فوق حوار معلّق: الوعد الأول كان يُنسى بلا حلّ أبداً، فيبقى الكود
    // المنتظر (`await requestConfirm`) معلّقاً إلى الأبد — حفظٌ لا يكتمل ولا يفشل.
    // نحلّ المعلّق بـ«لا» (الرفض الآمن) قبل استبداله.
    resolverRef.current?.(false);
    setMessage(msg);
    return new Promise<boolean>(resolve => {
      resolverRef.current = resolve;
    });
  }, []);

  const close = (ok: boolean) => {
    resolverRef.current?.(ok);
    resolverRef.current = null;
    setMessage(null);
  };

  const confirmDialog = message === null ? null : (
    <div
      className="fixed inset-0 z-[9998] bg-slate-900/50 backdrop-blur-[2px] flex items-center justify-center p-4"
      dir="rtl"
      onClick={() => close(false)}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5 space-y-4 animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center text-amber-600 flex-shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </span>
          <p className="text-sm font-bold text-[#0B1F4D] leading-relaxed whitespace-pre-line text-right pt-1.5">
            {message}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => close(true)}
            className="flex-1 py-2.5 bg-[#0B1F4D] hover:bg-[#152e6d] active:scale-95 text-white font-extrabold text-xs rounded-xl transition cursor-pointer"
          >
            تأكيد
          </button>
          <button
            onClick={() => close(false)}
            autoFocus
            className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-xs rounded-xl transition cursor-pointer"
          >
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );

  return { requestConfirm, confirmDialog };
}
