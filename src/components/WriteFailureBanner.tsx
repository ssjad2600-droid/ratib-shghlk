import { useEffect, useState } from 'react';
import { AlertTriangle, X, ChevronDown, ChevronUp } from 'lucide-react';
import {
  subscribeWriteFailures, clearWriteFailures, describeFailure, WriteFailure,
} from '../utils/writeGuard';
import { toArabicDigits } from '../utils/arabicFormatters';

/**
 * شريط «لم يُحفظ» — يجعل الفشل الدائم مرئياً بعد أن كان في الطرفية وحدها.
 *
 * 🔴 لماذا شريط عام لا رسالة في كل شاشة؟ لأن العلّة عامّة: ٣٩ موضع كتابة في ٢٠ ملفاً
 * كلها كانت تبتلع الخطأ. وإصلاحها شاشةً شاشةً يعني ٢٠ حلاً متكرراً، وأول شاشة تُنسى
 * تُعيد الصمت. القناة واحدة والشريط واحد ⇒ أي كتابة تفشل في أي شاشة تظهر هنا.
 *
 * ولا يحجب العمل: التاجر يواصل ويعرف. المحلّ لا يتوقّف لأن سطراً لم يُكتب — لكنه
 * لا يُغلق يومه ظانّاً أن كل شيء محفوظ وهو ليس كذلك.
 */
export default function WriteFailureBanner() {
  const [failures, setFailures] = useState<WriteFailure[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => subscribeWriteFailures(setFailures), []);

  if (failures.length === 0) return null;

  const newest = failures[0];
  const when = (ms: number) =>
    toArabicDigits(new Date(ms).toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' }));

  return (
    <div className="mb-4 rounded-2xl border-2 border-rose-300 bg-rose-50 overflow-hidden shadow-sm" dir="rtl">
      <div className="flex items-start gap-2.5 p-3.5">
        <AlertTriangle className="w-5 h-5 text-rose-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-extrabold text-rose-800 leading-relaxed">
            {failures.length === 1
              ? describeFailure(newest)
              : `${toArabicDigits(failures.length)} عمليات لم تُحفظ على الخادم`}
          </p>
          <p className="text-[10px] font-bold text-rose-600 mt-1 leading-relaxed">
            هذا ليس ضعف إنترنت — العمل بلا اتصال يُحفظ ويُزامَن لاحقاً. هذه العمليات
            <span className="font-extrabold"> رُفضت نهائياً</span> ولن تُحفظ مهما انتظرت.
          </p>
          {failures.length > 1 && (
            <button
              onClick={() => setOpen(v => !v)}
              className="mt-2 flex items-center gap-1 text-[11px] font-extrabold text-rose-700 hover:text-rose-900 transition cursor-pointer"
            >
              {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              <span>{open ? 'إخفاء التفاصيل' : 'عرض التفاصيل'}</span>
            </button>
          )}
        </div>
        <button
          onClick={clearWriteFailures}
          title="إخفاء التنبيه"
          className="text-rose-400 hover:text-rose-700 transition cursor-pointer flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {open && failures.length > 1 && (
        <div className="border-t border-rose-200 divide-y divide-rose-100">
          {failures.map(f => (
            <div key={f.id} className="px-4 py-2 flex items-start gap-2">
              <span className="text-[9px] font-bold text-rose-400 font-mono flex-shrink-0 mt-0.5">
                {when(f.at)}
              </span>
              <span className="text-[11px] font-bold text-rose-700 leading-relaxed">
                {describeFailure(f)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
