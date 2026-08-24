import { useMemo, useState } from 'react';
import { BookOpen, Search, Clock, Lightbulb, ArrowLeft, Info } from 'lucide-react';
import { OWNER_GUIDE, GUIDE_GROUPS } from '../utils/screenGuide';
import { toArabicDigits } from '../utils/arabicFormatters';

interface Props {
  /** اسم كل شاشة كما يظهر في القائمة الجانبية — مصدر واحد فلا يتعارض اسمان */
  labelOf: (screenId: string) => string;
  onGo: (screenId: string) => void;
  /** إخفاء شاشات لا يملكها هذا المستخدم (لوحة المطوّر مثلاً) */
  isVisible: (screenId: string) => boolean;
}

/**
 * فهرس شامل لكل شاشات البرنامج.
 * يخدم مرّتين: دليلاً للمشتري الجديد، وورقة بيع تعرض كل ما يحصل عليه مقابل ماله.
 */
export default function GuideView({ labelOf, onGo, isVisible }: Props) {
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    return GUIDE_GROUPS.map(g => ({
      ...g,
      screens: g.screens.filter(id => {
        if (!isVisible(id) || !OWNER_GUIDE[id]) return false;
        if (!term) return true;
        const gd = OWNER_GUIDE[id];
        return (
          labelOf(id).toLowerCase().includes(term) ||
          gd.purpose.toLowerCase().includes(term) ||
          gd.when.toLowerCase().includes(term) ||
          gd.tips.some(t => t.toLowerCase().includes(term))
        );
      }),
    })).filter(g => g.screens.length > 0);
  }, [q, labelOf, isVisible]);

  const total = groups.reduce((s, g) => s + g.screens.length, 0);

  return (
    <div className="space-y-5 font-tajawal" dir="rtl">
      <div className="bg-[#0B1F4D] text-white p-6 rounded-2xl border-b-4 border-amber-400">
        <div className="flex items-center gap-2 text-slate-300 text-xs font-bold font-cairo">
          <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
          <span>دليل الاستخدام</span>
        </div>
        <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2">
          <BookOpen className="w-6 h-6 text-amber-400" />
          <span>دليل البرنامج 📖</span>
        </h2>
        <p className="text-xs text-slate-300 mt-1 leading-relaxed max-w-3xl">
          كل شاشة وما تكسبه لك ومتى تستعملها. وفي أي شاشة تفتحها، زر <b>«؟»</b> أعلى البرنامج
          يشرحها لك في مكانها بلا أن تعود إلى هنا.
        </p>
        <div className="relative mt-4 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="ابحث: دين، صلاحية، ربح، جرد…"
            className="w-full pr-9 pl-3 py-2.5 bg-white/10 border border-white/20 rounded-xl text-xs font-bold text-white placeholder:text-slate-400 outline-none focus:bg-white/15"
          />
        </div>
      </div>

      {total === 0 ? (
        <div className="p-10 text-center bg-white rounded-2xl border border-[#E4EAF3]">
          <Info className="w-6 h-6 text-slate-400 mx-auto mb-2" />
          <p className="text-xs font-bold text-slate-500">لا نتائج — جرّب كلمة أخرى</p>
        </div>
      ) : (
        groups.map(g => (
          <div key={g.id} className="space-y-2">
            <h3 className="text-xs font-extrabold text-slate-500 px-1">
              {g.label} <span className="text-slate-500">({toArabicDigits(g.screens.length)})</span>
            </h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {g.screens.map(id => {
                const gd = OWNER_GUIDE[id];
                return (
                  <div key={id} className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm p-4 flex flex-col">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="text-[13px] font-extrabold text-[#0B1F4D]">{labelOf(id)}</h4>
                      <button
                        onClick={() => onGo(id)}
                        className="text-[10px] font-extrabold px-2.5 py-1 rounded-lg bg-[#0B1F4D] text-white cursor-pointer flex items-center gap-1 flex-shrink-0 hover:bg-[#13295E]"
                      >
                        افتحها <ArrowLeft className="w-3 h-3" />
                      </button>
                    </div>

                    <p className="text-[12px] font-bold text-slate-700 leading-relaxed mt-2">{gd.purpose}</p>

                    <p className="text-[11px] font-bold text-slate-500 leading-relaxed mt-2 flex items-start gap-1.5">
                      <Clock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-slate-500" />
                      <span>{gd.when}</span>
                    </p>

                    {gd.tips.length > 0 && (
                      <ul className="mt-2.5 space-y-1 border-t border-slate-100 pt-2.5">
                        {gd.tips.map((t, i) => (
                          <li key={i} className="text-[11px] font-bold text-slate-600 leading-relaxed flex gap-1.5">
                            <Lightbulb className="w-3 h-3 text-emerald-700 flex-shrink-0 mt-0.5" />
                            <span>{t}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
