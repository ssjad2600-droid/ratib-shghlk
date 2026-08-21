import { useState } from 'react';
import { Download, X } from 'lucide-react';
import { UpdateAvailable } from '../utils/appUpdate';
import { openExternal } from '../utils/openExternal';
import { toArabicDigits } from '../utils/arabicFormatters';

/**
 * شريط «تحديث متوفّر» — بديلُ التحديث التلقائي في توزيعٍ خارج المتاجر.
 *
 * 🎯 لا يحجب العمل ولا يفرض شيئاً: التاجر يُنزّل حين يشاء، ويُخفي الشريط إن كان
 * منشغلاً. فتحديثٌ إجباري في منتصف يوم بيعٍ أسوأ من تأجيله.
 */
export default function UpdateBanner({ update }: { update: UpdateAvailable | null }) {
  const [hidden, setHidden] = useState(false);
  if (!update || hidden) return null;

  return (
    <div className="mb-4 rounded-2xl border-2 border-emerald-300 bg-emerald-50 overflow-hidden shadow-sm" dir="rtl">
      <div className="flex items-start gap-2.5 p-3.5">
        <Download className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-extrabold text-emerald-900 leading-relaxed">
            تحديث متوفّر — النسخة {toArabicDigits(update.version)}
          </p>
          {update.notes && (
            <p className="text-[11px] font-bold text-emerald-700 mt-1 leading-relaxed">{update.notes}</p>
          )}
          <button
            onClick={() => void openExternal(update.url)}
            className="mt-2.5 px-3.5 py-2 rounded-xl bg-emerald-600 text-white text-[11px] font-extrabold flex items-center gap-1.5 cursor-pointer hover:bg-emerald-700 transition"
          >
            <Download className="w-3.5 h-3.5" />
            <span>تنزيل التحديث</span>
          </button>
        </div>
        <button
          onClick={() => setHidden(true)}
          title="إخفاء"
          aria-label="إخفاء إشعار التحديث"
          className="text-emerald-400 hover:text-emerald-700 transition cursor-pointer flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
