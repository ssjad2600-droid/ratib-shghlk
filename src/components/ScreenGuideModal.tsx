import { HelpCircle, X, Lightbulb, Clock, Link2 } from 'lucide-react';
import { ScreenGuide } from '../utils/screenGuide';

interface Props {
  /** عنوان الشاشة كما يظهر في القائمة — نأخذه من مصدر القائمة نفسه فلا يتعارض اسمان */
  title: string;
  guide: ScreenGuide;
  /** اسم كل شاشة مرتبطة بمعرّفها — للعرض بالعربية */
  labelOf: (screenId: string) => string;
  /** الانتقال لشاشة مرتبطة (غيابه = عرض بلا تنقّل، كحال الموظف) */
  onGo?: (screenId: string) => void;
  onClose: () => void;
}

/**
 * مساعدة **في مكان الحيرة**: تشرح الشاشة المفتوحة الآن بلا مغادرتها.
 *
 * لماذا نافذة واحدة تقرأ الشاشة النشطة بدل زرّ في كل شاشة: تعديل ٢٢ شاشة عاملة
 * مخاطرة بلا مقابل. زر واحد في الرأس يعطي نفس النتيجة بصفر مساس بما يعمل.
 */
export default function ScreenGuideModal({ title, guide, labelOf, onGo, onClose }: Props) {
  return (
    <div
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[80] p-4"
      onClick={onClose}
      dir="rtl"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-white rounded-2xl w-full max-w-lg shadow-2xl border border-slate-150 overflow-hidden max-h-[90vh] flex flex-col font-tajawal"
      >
        <div className="p-5 bg-[#0B1F4D] text-white flex justify-between items-start gap-3 flex-shrink-0">
          <div className="min-w-0">
            <span className="text-[10px] font-bold text-slate-300 flex items-center gap-1.5">
              <HelpCircle className="w-3.5 h-3.5 text-amber-400" /> شرح الشاشة
            </span>
            <h3 className="font-extrabold text-sm font-cairo mt-1 truncate">{title}</h3>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg cursor-pointer flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {/* القيمة أولاً — هذا ما يقرؤه التاجر فعلاً */}
          <p className="text-[13px] font-bold text-[#0B1F4D] leading-relaxed bg-amber-50 border-r-4 border-amber-400 rounded-xl p-3.5">
            {guide.purpose}
          </p>

          <div className="flex items-start gap-2">
            <Clock className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
            <div>
              <span className="text-[10px] font-extrabold text-slate-400 block">متى تستعملها</span>
              <p className="text-[12px] font-bold text-slate-600 leading-relaxed mt-0.5">{guide.when}</p>
            </div>
          </div>

          {guide.tips.length > 0 && (
            <div className="flex items-start gap-2">
              <Lightbulb className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <span className="text-[10px] font-extrabold text-slate-400 block mb-1.5">نصائح عملية</span>
                <ul className="space-y-1.5">
                  {guide.tips.map((t, i) => (
                    <li key={i} className="text-[12px] font-bold text-slate-600 leading-relaxed flex gap-1.5">
                      <span className="text-emerald-500 flex-shrink-0">•</span>
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {guide.related && guide.related.length > 0 && (
            <div className="pt-3 border-t border-slate-100">
              <span className="text-[10px] font-extrabold text-slate-400 flex items-center gap-1.5 mb-2">
                <Link2 className="w-3.5 h-3.5" /> شاشات تكمل عملك هنا
              </span>
              <div className="flex flex-wrap gap-1.5">
                {guide.related.map(id => (
                  <button
                    key={id}
                    onClick={() => { if (onGo) { onGo(id); onClose(); } }}
                    disabled={!onGo}
                    className="text-[11px] font-extrabold px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-600 border border-slate-200 enabled:hover:bg-[#0B1F4D] enabled:hover:text-white enabled:cursor-pointer transition disabled:opacity-70"
                  >
                    {labelOf(id)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
