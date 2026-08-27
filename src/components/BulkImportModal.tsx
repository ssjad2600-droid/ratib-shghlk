import React, { useRef, useState } from 'react';
import { Upload, X, FileSpreadsheet, Download, CheckCircle2, AlertTriangle, RefreshCw, Plus } from 'lucide-react';
import { csvToObjects, buildCsv, downloadCsv, readTextFile } from '../utils/csv';
import { ParsedRow, GridColumn } from '../utils/bulkImport';
import { toArabicDigits } from '../utils/arabicFormatters';
import ImportGrid from './ImportGrid';

interface Props<T> {
  title: string;
  /**
   * أعمدة الجدول الذي يُملأ داخل البرنامج — المسار **الأول**.
   * غيابها يُبقي الشاشة على مسار الملف وحده (توافقٌ رجعي).
   */
  gridColumns?: GridColumn[];
  /** ترويسة القالب وصف نموذجي — لتنزيل ملف جاهز بالأعمدة الصحيحة */
  templateHeaders: string[];
  templateSample: (string | number)[];
  templateName: string;
  /** يحوّل صفوف الملف إلى صفوف مُتحقَّق منها */
  parseRows: (rows: Array<Record<string, string>>) => ParsedRow<T>[];
  /** الكتابة الفعلية — تُستدعى بعد موافقة المالك فقط */
  onCommit: (rows: ParsedRow<T>[], mode: 'skip' | 'update') => Promise<void>;
  onClose: () => void;
}

export default function BulkImportModal<T>({
  title, gridColumns, templateHeaders, templateSample, templateName, parseRows, onCommit, onClose,
}: Props<T>) {
  const [rows, setRows] = useState<ParsedRow<T>[] | null>(null);
  const [gridRows, setGridRows] = useState<Array<Record<string, string>>>([]);
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState<'skip' | 'update'>('update');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: number; updated: number } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const creates = rows?.filter(r => r.action === 'create') ?? [];
  const updates = rows?.filter(r => r.action === 'update') ?? [];
  const errors = rows?.filter(r => r.action === 'error') ?? [];
  const willWrite = mode === 'update' ? creates.length + updates.length : creates.length;

  const handleFile = async (file: File) => {
    setError(null); setDone(null);
    if (!/\.csv$/i.test(file.name)) {
      setError('يرجى اختيار ملف بصيغة CSV. من Excel: ملف ← حفظ باسم ← CSV UTF-8');
      return;
    }
    try {
      const text = await readTextFile(file);
      const objects = csvToObjects(text);
      if (objects.length === 0) {
        setError('الملف فارغ أو لا يحتوي صفوفاً تحت سطر الترويسة');
        return;
      }
      setFileName(file.name);
      setRows(parseRows(objects));
    } catch (e) {
      // رسالة تجاوز الحجم تشرح نفسها وتقول ماذا يفعل — لا نطمسها برسالة عامة
      setError((e as Error)?.message || 'تعذّر قراءة الملف — تأكّد أنه ملف CSV سليم');
    }
  };

  const handleConfirm = async () => {
    if (!rows || busy) return;
    setBusy(true);
    try {
      const toWrite = rows.filter(r => r.action === 'create' || (mode === 'update' && r.action === 'update'));
      await onCommit(toWrite, mode);
      setDone({ created: creates.length, updated: mode === 'update' ? updates.length : 0 });
      setRows(null);
    } catch {
      setError('حدث خطأ أثناء الحفظ — لم تكتمل العملية');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[70] p-4" dir="rtl">
      <div className="bg-white rounded-2xl w-full max-w-3xl shadow-2xl border border-slate-200 flex flex-col max-h-[92vh]">

        <div className="p-5 bg-gradient-to-r from-emerald-700 to-emerald-600 text-white flex justify-between items-center flex-shrink-0">
          <div>
            <h3 className="font-black text-sm md:text-base font-cairo flex items-center gap-1.5">
              <FileSpreadsheet className="w-5 h-5" /> <span>{title}</span>
            </h3>
            <p className="text-[11px] text-emerald-50/90 mt-0.5">
              {gridColumns
                ? 'اكتب في الجدول أو الصق من Excel — لن يُحفظ شيء قبل مراجعتك'
                : 'ارفع ملف Excel محفوظاً بصيغة CSV — لن يُحفظ شيء قبل مراجعتك للمعاينة'}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg font-black text-xs cursor-pointer">إغلاق ✕</button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">

          {done ? (
            <div className="text-center py-10">
              <CheckCircle2 className="w-14 h-14 text-emerald-700 mx-auto mb-3" />
              <h4 className="font-extrabold text-sm text-[#0B1F4D]">تم الاستيراد بنجاح ✅</h4>
              <p className="text-xs text-slate-500 font-bold mt-2">
                أُضيف {toArabicDigits(done.created)} سجلاً جديداً
                {done.updated > 0 && ` وحُدِّث ${toArabicDigits(done.updated)} سجلاً قائماً`}
              </p>
              <button onClick={onClose} className="mt-5 px-6 py-2.5 bg-[#0B1F4D] text-white font-extrabold rounded-xl text-xs cursor-pointer">تم</button>
            </div>
          ) : !rows ? (
            <>
              {/* المسار الأول: جدولٌ يُملأ هنا — لا ملف ولا تنزيل */}
              {gridColumns && (
                <>
                  <ImportGrid columns={gridColumns} onChange={setGridRows} />
                  <button
                    type="button"
                    onClick={() => { setError(null); setFileName(''); setRows(parseRows(gridRows)); }}
                    disabled={gridRows.length === 0}
                    className="w-full py-3 bg-emerald-700 hover:bg-emerald-800 text-white font-extrabold rounded-xl text-sm shadow transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {gridRows.length === 0
                      ? 'اكتب صفاً واحداً على الأقل'
                      : `مراجعة ${toArabicDigits(gridRows.length)} صفاً قبل الحفظ`}
                  </button>
                </>
              )}

              {/*
                🔴 مسار الملف مطويٌّ لا محذوف.
                من عنده ملف من مورّد أو من برنامج قديم يحتاجه، ومن يريد أعمدة
                الجملة والضمان كذلك. لكن إبقاءه مفتوحاً كان يجعل أول ما تراه
                العين ثلاث كتل شرحٍ عن الترميز و«حفظ باسم» والباركود — وهذا
                نقيض التبسيط. الحالة الشائعة مفتوحة، والنادرة على بُعد ضغطة.
              */}
              <details className="group rounded-2xl border border-slate-200 bg-slate-50/60 overflow-hidden">
                <summary className="px-4 py-3 cursor-pointer list-none flex items-center justify-between gap-2">
                  <span className="text-xs font-extrabold text-[#0B1F4D]">
                    عندك قائمة جاهزة في ملف؟ ارفعها بدل الكتابة
                  </span>
                  <span className="text-[11px] font-extrabold text-indigo-700 group-open:hidden">عرض ▾</span>
                  <span className="text-[11px] font-extrabold text-indigo-700 hidden group-open:inline">إخفاء ▴</span>
                </summary>

                <div className="p-4 pt-0 space-y-3">
              {/* خطوة ١: القالب */}
              <div className="p-4 rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/50">
                <div className="flex items-start gap-3">
                  <span className="w-7 h-7 rounded-full bg-emerald-700 text-white font-black text-xs flex items-center justify-center flex-shrink-0">١</span>
                  <div className="flex-1 min-w-0">
                    <h4 className="font-extrabold text-xs text-[#0B1F4D]">نزّل القالب أولاً</h4>
                    <p className="text-[11px] text-slate-600 font-bold mt-1 leading-relaxed">
                      ملف جاهز بالأعمدة الصحيحة وصف نموذجي. املأه في Excel ثم احفظه بصيغة <b>CSV UTF-8</b>.
                    </p>
                    {/* الصفّ النموذجي يُتخطّى في المحلّل — نقولها هنا صراحةً لئلا
                        يحذفه التاجر ظنّاً منه أنه سيُستورَد، أو يقلق من بقائه. */}
                    <p className="text-[11px] text-emerald-800 font-bold mt-1.5 leading-relaxed">
                      ✔ الصفّ النموذجي <b>لا يُستورَد</b> — اتركه أو احذفه، كما تشاء.
                    </p>
                    {/* 🔴 تحذير الباركود يخصّ المنتجات وحدها — قالب الزبائن بلا عمود باركود */}
                    {templateHeaders.some(h => h.includes('الباركود')) && (
                      <p className="text-[11px] text-amber-800 font-bold mt-1.5 leading-relaxed bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                        ⚠️ قبل الحفظ: حدّد عمود <b>الباركود</b> في Excel واجعل تنسيقه <b>«نص»</b>.
                        وإلا حوّل Excel الأكواد الطويلة إلى صيغة علمية (مثل <span dir="ltr" className="font-mono">6.29E+12</span>)
                        وحذف الأصفار البادئة — فلا يجدها مسدس الباركود.
                      </p>
                    )}
                    <button
                      onClick={() => downloadCsv(templateName, buildCsv(templateHeaders, [templateSample]))}
                      className="mt-2 px-4 py-2 bg-white border-2 border-emerald-400 text-emerald-700 font-extrabold rounded-xl text-[11px] flex items-center gap-1.5 cursor-pointer hover:bg-emerald-50"
                    >
                      <Download className="w-3.5 h-3.5" /> تنزيل القالب
                    </button>

                    {/* 🔴 البند الوحيد الذي كان يُوقف من لم يستعمل Excel كثيراً.
                        الشاشة كانت تقول «احفظه CSV UTF-8» ولا تقول **أين** — وهي
                        ليست الخيار الأول في قائمة Excel، بل تحتها بأسطر. */}
                    <div className="mt-3 pt-2.5 border-t border-emerald-200">
                      <span className="text-[11px] font-extrabold text-[#0B1F4D] block mb-1.5">
                        بعد أن تملأه في Excel، احفظه هكذا:
                      </span>
                      {/* 🔴 كل سهمٍ مربوطٌ بشريحته في `inline-flex` واحد. لولا ذلك
                          لالتفّت السلسلة (قِيس: سطران على نافذة ٤٣٠px) فيقع سهمٌ
                          وحده في بداية السطر — يقرأه المستخدم خطأً مطبعياً. */}
                      <div className="flex items-center gap-y-1.5 flex-wrap text-[11px] font-extrabold">
                        {[
                          { text: 'ملف', key: false },
                          { text: 'حفظ باسم', key: false },
                          { text: 'CSV UTF-8', key: true },
                          { text: 'حفظ', key: false },
                        ].map((step, i, all) => (
                          <span key={step.text} className="inline-flex items-center gap-1.5">
                            <span className={`px-2 py-1 rounded-lg border ${
                              step.key
                                ? 'bg-emerald-700 border-emerald-700 text-white'
                                : 'bg-white border-slate-200 text-slate-700'
                            }`}>{step.text}</span>
                            {i < all.length - 1 && <span className="text-slate-600 px-1.5">←</span>}
                          </span>
                        ))}
                      </div>
                      <p className="text-[11px] text-slate-600 font-bold mt-2 leading-relaxed">
                        اختر <b>«CSV UTF-8»</b> من قائمة الأنواع — لا «CSV» وحدها.
                        ولو حفظته بغيرها فالبرنامج يقرأه غالباً، لكن هذا الخيار أضمن للأسماء العربية.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* خطوة ٢: الرفع */}
              <div
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]); }}
                className="p-8 rounded-2xl border-2 border-dashed border-slate-300 hover:border-[#0B1F4D] hover:bg-slate-50 text-center cursor-pointer transition"
              >
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
                  onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }} />
                <Upload className="w-10 h-10 text-slate-500 mx-auto mb-2" />
                <p className="text-xs font-extrabold text-[#0B1F4D]">اسحب ملف CSV هنا أو اضغط للاختيار</p>
                <p className="text-[10px] text-slate-600 font-bold mt-1">يدعم آلاف الصفوف دفعة واحدة</p>
              </div>
                </div>
              </details>

              {error && (
                <div className="p-3 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-xs font-bold flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> <span>{error}</span>
                </div>
              )}
            </>
          ) : (
            <>
              {/* المعاينة */}
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-extrabold text-[#0B1F4D]">📄 {fileName}</span>
                <button onClick={() => { setRows(null); setError(null); }} className="text-[11px] font-bold text-indigo-700 hover:underline cursor-pointer">
                  ← اختيار ملف آخر
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-center">
                  <span className="text-[10px] text-emerald-700 font-bold block">جديد سيُضاف</span>
                  <span className="text-lg font-black text-emerald-800">{toArabicDigits(creates.length)}</span>
                </div>
                <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-center">
                  <span className="text-[10px] text-blue-700 font-bold block">قائم سيُحدَّث</span>
                  <span className="text-lg font-black text-blue-800">{toArabicDigits(updates.length)}</span>
                </div>
                <div className={`p-3 rounded-xl border text-center ${errors.length ? 'bg-rose-50 border-rose-200' : 'bg-slate-50 border-slate-200'}`}>
                  <span className={`text-[10px] font-bold block ${errors.length ? 'text-rose-700' : 'text-slate-500'}`}>به أخطاء (يُتخطّى)</span>
                  <span className={`text-lg font-black ${errors.length ? 'text-rose-800' : 'text-slate-600'}`}>{toArabicDigits(errors.length)}</span>
                </div>
              </div>

              {/* سياسة المكرر */}
              {updates.length > 0 && (
                <div className="p-3 rounded-xl border border-blue-200 bg-blue-50/60 space-y-2">
                  <span className="text-xs font-extrabold text-blue-900 block">
                    وُجد {toArabicDigits(updates.length)} سجلاً موجوداً مسبقاً — ماذا تريد؟
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => setMode('update')}
                      className={`py-2 rounded-xl text-[11px] font-extrabold border-2 transition cursor-pointer ${mode === 'update' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'}`}>
                      <RefreshCw className="w-3.5 h-3.5 inline ml-1" /> تحديث بيانات القائم
                    </button>
                    <button onClick={() => setMode('skip')}
                      className={`py-2 rounded-xl text-[11px] font-extrabold border-2 transition cursor-pointer ${mode === 'skip' ? 'bg-slate-700 text-white border-slate-700' : 'bg-white text-slate-600 border-slate-200'}`}>
                      تخطّي القائم (إضافة الجديد فقط)
                    </button>
                  </div>
                  <p className="text-[10px] text-blue-700 font-bold">
                    ملاحظة: أرصدة الديون لا تُلمس عند التحديث إطلاقاً — تبقى كما هي.
                  </p>
                </div>
              )}

              {/* جدول المعاينة */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="max-h-64 overflow-y-auto divide-y divide-slate-50">
                  {rows.slice(0, 300).map(r => (
                    <div key={r.line} className={`flex items-center justify-between gap-2 px-3 py-2 text-[11px] ${
                      r.action === 'error' ? 'bg-rose-50' : r.action === 'update' ? 'bg-blue-50/40' : ''
                    }`}>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-slate-500 font-mono flex-shrink-0">{toArabicDigits(r.line)}</span>
                        <span title={r.label} className="font-extrabold text-[#0B1F4D] truncate">{r.label}</span>
                      </div>
                      {r.action === 'error' ? (
                        <span className="text-rose-700 font-bold flex-shrink-0">{r.errors.join(' · ')}</span>
                      ) : (
                        <span className={`font-extrabold flex-shrink-0 ${r.action === 'create' ? 'text-emerald-700' : 'text-blue-700'}`}>
                          {r.action === 'create' ? <><Plus className="w-3 h-3 inline" /> جديد</> : 'تحديث'}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                {rows.length > 300 && (
                  <div className="px-3 py-2 bg-slate-50 text-[10px] text-slate-600 font-bold text-center">
                    تُعرض أول ٣٠٠ صف فقط — وسيُستورد الكل ({toArabicDigits(rows.length)} صفاً)
                  </div>
                )}
              </div>

              {error && (
                <div className="p-3 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-xs font-bold">{error}</div>
              )}
            </>
          )}
        </div>

        {rows && !done && (
          <div className="p-4 bg-slate-50 border-t border-slate-100 flex-shrink-0">
            <button
              onClick={handleConfirm}
              disabled={busy || willWrite === 0}
              className="w-full py-3 bg-emerald-700 hover:bg-emerald-800 text-white font-extrabold rounded-xl text-sm shadow transition cursor-pointer flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{busy ? 'جارٍ الاستيراد...' : `تأكيد استيراد ${toArabicDigits(willWrite)} سجلاً`}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
