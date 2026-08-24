import { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, orderBy, limit, where } from 'firebase/firestore';
import { db } from '../firebase';
import { AlertTriangle, RefreshCw, Bug, Users, Info, CheckCircle2, RotateCcw, Undo2 } from 'lucide-react';
import { toArabicDigits } from '../utils/arabicFormatters';
import { ErrorReport } from '../utils/errorReporter';
import { periodRange, PeriodKey } from '../utils/reportPeriod';
import {
  groupReports, markResolved, unmarkResolved, parseMarks,
  ResolvedMarks, RESOLVED_STORAGE_KEY,
} from '../utils/errorTriage';

/**
 * تقارير أخطاء الزبائن — للمطوّر وحده (تفرضه قواعد Firestore).
 *
 * الفكرة التي تجعلها مفيدة فعلاً: **التجميع حسب توقيع الخطأ** لا سرد زمني.
 * مئة تقرير من خطأ واحد عند عشرين محلاً ليست مئة مشكلة، بل مشكلة واحدة عاجلة.
 * فنعرض: كم مرة، وعند كم حساباً، وفي أي شاشة، ومتى آخر مرة — بهذا الترتيب تُصلح
 * الأهمّ أولاً بدل أن تلاحق آخر ما وصل.
 *
 * والفرز نفسه في `utils/errorTriage.ts` — بما فيه قاعدة «عولج» التي تعيد الخطأ إن
 * تكرّر بعد وسمه.
 */

const REPORTS_LIMIT = 200;

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'weekly', label: 'آخر ٧ أيام' },
  { key: 'monthly', label: 'آخر ٣٠ يوماً' },
  { key: 'yearly', label: 'آخر سنة' },
  { key: 'all', label: 'كل التاريخ' },
];

export default function ErrorReportsPanel() {
  const [reports, setReports] = useState<ErrorReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey>('monthly');
  const [showResolved, setShowResolved] = useState(false);
  const [marks, setMarks] = useState<ResolvedMarks>(() => {
    try { return parseMarks(localStorage.getItem(RESOLVED_STORAGE_KEY)); } catch { return {}; }
  });

  const saveMarks = (next: ResolvedMarks) => {
    setMarks(next);
    try { localStorage.setItem(RESOLVED_STORAGE_KEY, JSON.stringify(next)); } catch { /* تخزين ممتلئ — الوسم يبقى في الجلسة */ }
  };

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      /**
       * 🟡 نافذة زمنية بدل «الأحدث ٢٠٠ مطلقاً».
       *
       * `limit(200)` وحدها تعمي عن الماضي: مع تراكم التقارير تصير الـ٢٠٠ كلّها من أيام
       * قليلة، فلا تصل إلى شهرٍ مضى ولا إلى خطأ نادر. النافذة تجعل السقف حدّاً للأداء
       * داخل مدّة مختارة، لا ستاراً على التاريخ.
       */
      const base = collection(db, 'errorReports');
      const range = periodRange(period);
      const sinceMs = period === 'all' ? 0 : range.from.getTime();
      const q = sinceMs > 0
        ? query(base, where('createdAt', '>=', sinceMs), orderBy('createdAt', 'desc'), limit(REPORTS_LIMIT))
        : query(base, orderBy('createdAt', 'desc'), limit(REPORTS_LIMIT));
      const snap = await getDocs(q);
      setReports(snap.docs.map(d => d.data() as ErrorReport));
    } catch {
      setError('تعذّر جلب التقارير — تأكّد من نشر قاعدة errorReports في Firestore');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { void fetchReports(); }, [fetchReports]);

  const allGroups = useMemo(() => groupReports(reports, marks), [reports, marks]);
  const groups = showResolved ? allGroups : allGroups.filter(g => !g.resolved);
  const resolvedCount = allGroups.filter(g => g.resolved).length;
  const reachedCap = reports.length >= REPORTS_LIMIT;

  const when = (ms: number) => {
    const d = new Date(ms);
    return isNaN(d.getTime()) ? '—' : toArabicDigits(d.toLocaleString('ar-IQ'));
  };

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-xl bg-rose-600 flex items-center justify-center shadow">
            <Bug className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-sm font-extrabold text-[#0B1F4D] font-cairo">أخطاء البرنامج عند الزبائن</h3>
            <p className="text-[11px] text-slate-500 font-bold">
              {toArabicDigits(groups.length)} مشكلة مميّزة · {toArabicDigits(reports.length)} تقريراً
              {resolvedCount > 0 && <> · {toArabicDigits(resolvedCount)} موسومة كمُعالَجة</>}
            </p>
          </div>
        </div>
        <button onClick={() => void fetchReports()} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl text-xs font-bold text-slate-600 transition cursor-pointer disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>تحديث</span>
        </button>
      </div>

      {/* 🟡 النافذة الزمنية — بدونها كانت اللوحة ترى الأسبوع الأخير فقط مع التراكم */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 bg-slate-100 p-1 rounded-xl">
          {PERIODS.map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                period === p.key ? 'bg-white text-[#0B1F4D] shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}>
              {p.label}
            </button>
          ))}
        </div>
        {resolvedCount > 0 && (
          <button onClick={() => setShowResolved(v => !v)}
            className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer flex items-center gap-1.5">
            <CheckCircle2 className="w-3 h-3" />
            {showResolved ? 'إخفاء المُعالَجة' : `إظهار المُعالَجة (${toArabicDigits(resolvedCount)})`}
          </button>
        )}
      </div>

      {reachedCap && (
        <div className="px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-[11px] font-bold text-amber-800 leading-relaxed">
          بلغت السقف ({toArabicDigits(REPORTS_LIMIT)} تقرير) داخل هذه الفترة — قد توجد تقارير أقدم لم تُحمَّل.
          اختر فترة أضيق لرؤيتها كاملة.
        </div>
      )}

      {error && (
        <div className="px-4 py-3 rounded-xl bg-rose-50 border border-rose-200 text-[11px] font-bold text-rose-700 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {!error && groups.length === 0 && !loading && (
        <div className="p-8 text-center bg-emerald-50/60 border border-emerald-200 rounded-2xl">
          <p className="text-xs font-extrabold text-emerald-800">
            {resolvedCount > 0 && !showResolved
              ? 'لا مشكلة مفتوحة في هذه الفترة — الباقي موسوم كمُعالَج 👏'
              : 'لا أخطاء مسجّلة — البرنامج يعمل نظيفاً عند زبائنك 👏'}
          </p>
        </div>
      )}

      <div className="space-y-2">
        {groups.map(g => {
          const isOpen = expanded === g.key;
          const widespread = g.shopCount > 1;
          const border = g.regressed ? 'border-amber-400 bg-amber-50/50'
            : g.resolved ? 'border-slate-200 bg-slate-50 opacity-70'
            : widespread ? 'border-rose-300 bg-rose-50/40'
            : 'border-slate-200 bg-white';
          return (
            <div key={g.key} className={`rounded-2xl border-2 overflow-hidden ${border}`}>
              <button onClick={() => setExpanded(isOpen ? null : g.key)}
                className="w-full p-4 text-right cursor-pointer">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-[#0B1F4D] text-white">{g.screen}</span>
                  {/* 🔴 الانتكاسة أخطر من الجديد: إصلاحك لم يصل إلى الزبون أو لم ينجح */}
                  {g.regressed && (
                    <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-700 text-white flex items-center gap-1">
                      <RotateCcw className="w-2.5 h-2.5" /> عاد بعد وسمه معالَجاً
                    </span>
                  )}
                  {g.resolved && (
                    <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-700 text-white flex items-center gap-1">
                      <CheckCircle2 className="w-2.5 h-2.5" /> معالَج
                    </span>
                  )}
                  {widespread && (
                    <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-rose-600 text-white flex items-center gap-1">
                      <Users className="w-2.5 h-2.5" /> {toArabicDigits(g.shopCount)} محلات
                    </span>
                  )}
                  <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                    ×{toArabicDigits(g.count)}
                  </span>
                  <span className="text-[11px] text-slate-500 font-bold mr-auto">{when(g.last)}</span>
                </div>
                <p className="text-[11px] font-bold text-[#0B1F4D] mt-2 leading-relaxed break-words" dir="ltr">{g.message}</p>
              </button>

              {isOpen && (
                <div className="px-4 pb-4 space-y-2">
                  <div className="flex flex-wrap gap-1.5 text-[11px] font-bold text-slate-500">
                    <span className="px-2 py-1 bg-white rounded-lg border border-slate-200">المصدر: {g.sample.source}</span>
                    <span className="px-2 py-1 bg-white rounded-lg border border-slate-200">النسخة: {g.sample.appVersion}</span>
                    <span className="px-2 py-1 bg-white rounded-lg border border-slate-200">
                      {g.sample.online ? 'متصل' : 'غير متصل'}
                    </span>
                  </div>
                  <pre className="p-3 bg-slate-900 text-slate-200 rounded-xl text-[11px] leading-relaxed overflow-x-auto max-h-64" dir="ltr">
{g.sample.stack || '(بلا أثر تنفيذ)'}
                  </pre>
                  {g.resolved || g.regressed ? (
                    <button onClick={() => saveMarks(unmarkResolved(marks, g.key))}
                      className="w-full py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-[11px] font-extrabold text-slate-700 transition cursor-pointer flex items-center justify-center gap-1.5">
                      <Undo2 className="w-3 h-3" /> إلغاء وسم المعالجة
                    </button>
                  ) : (
                    <button onClick={() => saveMarks(markResolved(marks, g))}
                      className="w-full py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-[11px] font-extrabold text-white transition cursor-pointer flex items-center justify-center gap-1.5">
                      <CheckCircle2 className="w-3 h-3" /> علّمها كمُعالَجة
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-slate-600 font-bold leading-relaxed flex items-start gap-1.5">
        <Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
        <span>
          التقارير مرتّبة: ما عاد بعد وسمه معالَجاً أولاً، ثم ما يصيب أكبر عدد من المحلات.
          لا تحوي أي بيان تجاري (أسماء زبائن، مبالغ، أصناف): نصّها يُنقّى قبل الإرسال، وقواعد Firestore
          تحصر حقولها وتمنع تعديلها أو حذفها. ولهذا وسم «معالَج» محفوظ على <span className="font-extrabold">جهازك
          وحده</span> لا على الخادم — ولا يُخفي الخطأ نهائياً: إن تكرّر بعد وسمه عاد إلى القائمة موسوماً بالانتكاسة.
        </span>
      </p>
    </div>
  );
}
