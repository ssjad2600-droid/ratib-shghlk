import { useMemo, useState } from 'react';
import {
  Barcode, X, Printer, Wand2, AlertTriangle, Info, Search,
  CheckSquare, Square, Minus, Plus, LayoutGrid, FileStack,
} from 'lucide-react';
import { Product } from '../types';
import { toArabicDigits, isValidExchangeRate } from '../utils/arabicFormatters';
import { barcodeSvg } from '../utils/barcode128';
import {
  LABEL_PRESETS, ROLL_PRESETS, LabelLayout, LabelItem, PrintMode, computeGrid,
  generateInternalBarcode, checkLabelFit, printLabels,
} from '../utils/barcodeLabels';
import { readAmountOr, readCount } from '../utils/amountField';

interface Props {
  products: Product[];
  storeName?: string;
  currency: 'IQD' | 'USD';
  /** لازم لتحويل سعر الملصق عند اختيار الدولار — كان الملصق يطبع الدينار بعلامة $ */
  exchangeRate: number;
  /** يحفظ الباركود المولَّد في وثيقة المنتج (المالك فقط) */
  onSaveBarcodes: (updates: Array<{ product: Product; barcode: string }>) => Promise<void> | void;
  onClose: () => void;
}

const LS_KEY = 'barcodeLabelLayout';

/** رقم عشري بالأرقام العربية-الهندية مع فاصلتها (٠٫٢٥) — toArabicDigits لا يحوّل النقطة. */
const arDecimal = (n: number): string => toArabicDigits(String(n)).replace('.', '٫');

const loadLayout = (): LabelLayout => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as LabelLayout;
  } catch { /* تعذّر التخزين — غير حرج */ }
  return { ...LABEL_PRESETS[0] };
};

export default function BarcodeLabelsModal({ products, storeName, currency, exchangeRate, onSaveBarcodes, onClose }: Props) {
  const [mode, setMode] = useState<PrintMode>(() => {
    try { return localStorage.getItem('barcodeLabelMode') === 'roll' ? 'roll' : 'sheet'; } catch { return 'sheet'; }
  });
  const [layout, setLayout] = useState<LabelLayout>(loadLayout);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [skip, setSkip] = useState(0);
  const [showStore, setShowStore] = useState(true);
  const [showName, setShowName] = useState(true);
  const [showPrice, setShowPrice] = useState(true);
  const [showCode, setShowCode] = useState(true);
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<{ text: string; bad?: boolean } | null>(null);
  const notify = (text: string, bad = false) => { setAlert({ text, bad }); setTimeout(() => setAlert(null), 6000); };

  const setLayoutSaved = (next: LabelLayout) => {
    // نخزّن الأبعاد وحدها: تمرير مقاس جاهز يجرّ معه id/name يصيران مضلّلين بعد أي تعديل يدوي
    const clean: LabelLayout = {
      labelW: next.labelW, labelH: next.labelH,
      marginX: next.marginX, marginY: next.marginY,
      gapX: next.gapX, gapY: next.gapY,
    };
    setLayout(clean);
    try { localStorage.setItem(LS_KEY, JSON.stringify(clean)); } catch { /* تجاهل */ }
  };

  /**
   * 🔴 سعر الملصق يُحوَّل فعلاً عند اختيار الدولار.
   * كان يُطبع رقم الدينار كما هو وتُوضع عليه علامة $ — وملصق السعر يُلصق على البضاعة
   * ويبقى على الرف، فالخطأ فيه يعيش أطول من أي خطأ على الشاشة.
   * الأرقام تبقى لاتينية عمداً: الملصق يُقرأ سريعاً وقد يُمسح آلياً.
   */
  const formatPrice = (n: number) => (currency === 'USD' && isValidExchangeRate(exchangeRate))
    ? (n / exchangeRate).toFixed(2) + ' $'
    : n.toLocaleString('en-US') + ' د.ع';
  const grid = useMemo(() => computeGrid(layout), [layout]);
  const isRoll = mode === 'roll';

  const switchMode = (m: PrintMode) => {
    setMode(m);
    try { localStorage.setItem('barcodeLabelMode', m); } catch { /* تجاهل */ }
    // البكرة: بلا هوامش ولا مسافات — الطابعة تدير حوافها، وحجم الصفحة = حجم الملصق
    if (m === 'roll') setLayoutSaved({ ...layout, marginX: 0, marginY: 0, gapX: 0, gapY: 0 });
    else setLayoutSaved({ ...LABEL_PRESETS[0] });
  };

  const noCode = useMemo(() => products.filter(p => !p.barcode?.trim()), [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter(p => !q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q));
  }, [products, search]);

  const selected = useMemo(
    () => products.filter(p => (qty[p.id] ?? 0) > 0 && p.barcode?.trim()),
    [products, qty],
  );

  const items: LabelItem[] = useMemo(() => {
    const out: LabelItem[] = [];
    for (const p of selected) {
      const n = qty[p.id] ?? 0;
      for (let i = 0; i < n; i++) {
        out.push({ barcode: p.barcode.trim(), name: p.name, price: p.sellPrice || 0, unit: p.unit });
      }
    }
    return out;
  }, [selected, qty]);

  // فحص القراءة: كل كود ضمن عرض الملصق — تحذير **قبل** هدر الورقة
  const unreadable = useMemo(
    () => checkLabelFit(
      selected.map(p => ({ barcode: p.barcode.trim(), name: p.name, price: p.sellPrice || 0 })),
      layout.labelW,
    ),
    [selected, layout.labelW],
  );

  const totalLabels = items.length;
  const pages = isRoll ? totalLabels : (grid.perPage > 0 ? Math.ceil((totalLabels + skip) / grid.perPage) : 0);

  const bump = (id: string, delta: number) =>
    setQty(prev => ({ ...prev, [id]: Math.max(0, (prev[id] ?? 0) + delta) }));

  const selectAllVisible = () => {
    setQty(prev => {
      const next = { ...prev };
      for (const p of filtered) if (p.barcode?.trim()) next[p.id] = next[p.id] || 1;
      return next;
    });
  };
  const clearAll = () => setQty({});

  /** يولّد كوداً داخلياً فريداً لكل منتج بلا باركود، ويحفظه — الحلقة التي بلا معنى للطباعة بدونها. */
  const generateMissing = async () => {
    if (busy || noCode.length === 0) return;
    setBusy(true);
    try {
      const taken = new Set(products.map(p => (p.barcode || '').trim()).filter(Boolean));
      const updates = noCode.map(product => {
        const barcode = generateInternalBarcode(taken);
        taken.add(barcode); // منع التصادم داخل نفس الدفعة
        return { product, barcode };
      });
      await onSaveBarcodes(updates);
      // نُدرجها مباشرة في الطباعة بنسخة واحدة — الخطوة التالية الطبيعية
      setQty(prev => {
        const next = { ...prev };
        for (const u of updates) next[u.product.id] = next[u.product.id] || 1;
        return next;
      });
      notify(`تم توليد ${toArabicDigits(updates.length)} كوداً داخلياً وحفظها ✅ وأُضيفت للطباعة`);
    } catch {
      notify('تعذّر حفظ الأكواد المولَّدة', true);
    } finally { setBusy(false); }
  };

  const doPrint = () => {
    if (totalLabels === 0) { notify('اختر مادة واحدة على الأقل', true); return; }
    printLabels({
      items, layout, mode, skip: isRoll ? 0 : skip,
      content: { showStore, showName, showPrice, showCode, storeName },
      formatPrice,
      onError: m => notify(m, true),
    });
  };

  // معاينة حيّة بالمقاس الحقيقي (٣٫٧٨ بكسل ≈ ١ملم على الشاشة)
  const preview = selected[0]
    ? { barcode: selected[0].barcode.trim(), name: selected[0].name, price: selected[0].sellPrice || 0 }
    : null;
  const PX = 3.7795;

  /**
   * معاينة الباركود — تُبنى بنفس معادلة الطباعة تماماً (كي لا تُظهر المعاينة شيئاً
   * ويطبع الورق شيئاً آخر)، ثم تُحوَّل أبعادها من مليمتر إلى بكسل للعرض على الشاشة.
   */
  const previewBarcodeSvg = useMemo(() => {
    if (!preview) return '';
    const fontBase = Math.max(4.5, Math.min(9, layout.labelH * 0.16));
    const codeFont = Math.max(4, fontBase * 0.8);
    const textLines = (showStore && storeName ? 1 : 0) + (showName ? 1 : 0) + (showPrice ? 1 : 0);
    const textH = textLines * fontBase * 1.25 + (showCode ? codeFont * 1.3 : 0);
    const barH = Math.max(6, layout.labelH - textH - 2.5);
    const innerW = layout.labelW - 2;
    return barcodeSvg(preview.barcode, innerW, barH)
      .replace(/width="[\d.]+mm"/, `width="${(innerW * PX).toFixed(1)}px"`)
      .replace(/height="[\d.]+mm"/, `height="${(barH * PX).toFixed(1)}px"`);
  }, [preview, layout.labelW, layout.labelH, showStore, showName, showPrice, showCode, storeName]);

  const numField = (label: string, key: keyof LabelLayout, step = 0.5) => (
    <label className="block">
      <span className="text-[10px] font-bold text-slate-500 block mb-1">{label}</span>
      <input
        type="text" inputMode="decimal" step={step} min={0} value={layout[key]}
        onChange={e => setLayoutSaved({ ...layout, [key]: readAmountOr(e.target.value, 0) ?? layout[key] })}
        className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-center outline-none focus:bg-white"
      />
    </label>
  );

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[70] p-3" onClick={() => !busy && onClose()}>
      <div onClick={e => e.stopPropagation()} className="bg-white rounded-2xl w-full max-w-5xl shadow-2xl border border-slate-150 overflow-hidden max-h-[94vh] flex flex-col" dir="rtl">

        <div className="p-4 bg-[#0B1F4D] text-white flex justify-between items-center flex-shrink-0">
          <h3 className="font-extrabold text-sm font-cairo flex items-center gap-1.5">
            <Barcode className="w-5 h-5 text-amber-400" /> ملصقات الباركود
          </h3>
          <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg cursor-pointer"><X className="w-4 h-4" /></button>
        </div>

        {alert && (
          <div className={`mx-4 mt-3 px-3 py-2.5 rounded-xl text-[11px] font-bold border ${alert.bad ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
            {alert.text}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">

          {/* ============ يمين: اختيار المواد ============ */}
          <div className="space-y-3 min-w-0">
            {noCode.length > 0 && (
              <div className="p-3 rounded-xl border-2 border-amber-200 bg-amber-50/70">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                  <span className="text-[11px] font-extrabold text-amber-800">
                    {toArabicDigits(noCode.length)} مادة بلا باركود — لا يمكن طباعة ملصق لها
                  </span>
                </div>
                <p className="text-[10px] text-slate-600 font-bold mb-2 leading-relaxed">
                  البضاعة المحلية لا رقم عالمياً لها. يولّد البرنامج كوداً داخلياً فريداً يبدأ بـ ٢٢
                  (نطاق محجوز للمتاجر لا يصطدم بباركود مصنع) ويحفظه في المادة.
                  <b> الأكواد الموجودة لا تُمسّ إطلاقاً.</b>
                </p>
                <button onClick={generateMissing} disabled={busy}
                  className="px-3 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-slate-950 text-[11px] font-extrabold rounded-lg cursor-pointer flex items-center gap-1.5">
                  <Wand2 className="w-3.5 h-3.5" /> {busy ? 'جارٍ التوليد…' : 'ولّد كوداً لمن لا كود له'}
                </button>
              </div>
            )}

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ابحث عن مادة…"
                  className="w-full pr-8 pl-2 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:bg-white" />
              </div>
              <button onClick={selectAllVisible} className="px-2.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-extrabold rounded-lg cursor-pointer flex items-center gap-1">
                <CheckSquare className="w-3.5 h-3.5" /> الكل
              </button>
              <button onClick={clearAll} className="px-2.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-extrabold rounded-lg cursor-pointer flex items-center gap-1">
                <Square className="w-3.5 h-3.5" /> إلغاء
              </button>
            </div>

            <div className="border border-slate-200 rounded-xl overflow-hidden max-h-[320px] overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="p-6 text-center text-[11px] text-slate-400 font-bold">لا توجد مواد</div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {filtered.map(p => {
                    const n = qty[p.id] ?? 0;
                    const hasCode = !!p.barcode?.trim();
                    return (
                      <div key={p.id} className={`flex items-center gap-2 px-3 py-2 ${n > 0 ? 'bg-emerald-50/50' : ''}`}>
                        <div className="min-w-0 flex-1">
                          <span className="text-[11px] font-extrabold text-[#0B1F4D] block truncate">{p.name}</span>
                          <span className="text-[9px] font-bold text-slate-400 font-mono" dir="ltr">
                            {hasCode ? p.barcode : '— بلا باركود —'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button disabled={!hasCode} onClick={() => bump(p.id, -1)}
                            className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-30 text-slate-600 flex items-center justify-center cursor-pointer">
                            <Minus className="w-3 h-3" />
                          </button>
                          <input type="text" inputMode="decimal" min={0} value={n} disabled={!hasCode}
                            onChange={e => setQty(prev => ({ ...prev, [p.id]: Math.max(0, readCount(e.target.value, { whenEmpty: 0 }) ?? 0) }))}
                            className="w-12 px-1 py-1 bg-white border border-slate-200 rounded-lg text-[11px] font-bold text-center outline-none disabled:opacity-40" />
                          <button disabled={!hasCode} onClick={() => bump(p.id, 1)}
                            className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-30 text-slate-600 flex items-center justify-center cursor-pointer">
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {unreadable.length > 0 && (
              <div className="p-3 rounded-xl border-2 border-rose-300 bg-rose-50">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <AlertTriangle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                  <span className="text-[11px] font-extrabold text-rose-800">
                    {toArabicDigits(unreadable.length)} كوداً لن يقرأه الماسح على هذا المقاس
                  </span>
                </div>
                <div className="space-y-1">
                  {unreadable.slice(0, 5).map(b => (
                    <p key={b.barcode} className="text-[10px] text-rose-800 font-bold leading-relaxed">
                      «{b.name}» — {b.reason === 'unencodable'
                        ? <>الكود يحوي محارف لا يدعمها الباركود (حروف عربية أو رموز خاصة). استخدم أرقاماً وحروفاً إنكليزية، أو ولّد كوداً داخلياً.</>
                        : <>عرض الشريط {arDecimal(b.moduleMm)}ملم (الحد الأدنى ٠٫٢٥).
                          وسّع الملصق إلى <b>{arDecimal(b.neededMm)}ملم</b> أو قصّر الكود.</>}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ============ يسار: المقاس والمعاينة ============ */}
          <div className="space-y-3">
            <div className="p-3 rounded-xl border border-slate-200 bg-slate-50 space-y-2.5">
              <span className="text-[11px] font-extrabold text-[#0B1F4D] flex items-center gap-1.5">
                <LayoutGrid className="w-4 h-4 text-indigo-600" /> نوع الطباعة والمقاس
              </span>

              {/* نمط الطباعة — القرار الأول لأنه يغيّر كل ما تحته */}
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => switchMode('sheet')}
                  className={`p-2.5 rounded-xl border-2 text-right transition cursor-pointer ${!isRoll ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                  <span className="flex items-center gap-1 font-extrabold text-[11px] text-[#0B1F4D]">
                    <FileStack className="w-3.5 h-3.5 text-slate-500" /> ورق A4
                  </span>
                  <span className="text-[9px] text-slate-500 font-bold block mt-0.5 leading-relaxed">ملصقات لاصقة بالورقة</span>
                </button>
                <button type="button" onClick={() => switchMode('roll')}
                  className={`p-2.5 rounded-xl border-2 text-right transition cursor-pointer ${isRoll ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                  <span className="flex items-center gap-1 font-extrabold text-[11px] text-[#0B1F4D]">
                    <Printer className="w-3.5 h-3.5 text-indigo-600" /> طابعة ملصقات
                  </span>
                  <span className="text-[9px] text-slate-500 font-bold block mt-0.5 leading-relaxed">بكرة — ملصق لكل صفحة</span>
                </button>
              </div>

              <select
                onChange={e => {
                  if (isRoll) {
                    const r = ROLL_PRESETS.find(x => x.id === e.target.value);
                    if (r) setLayoutSaved({ ...layout, labelW: r.labelW, labelH: r.labelH, marginX: 0, marginY: 0, gapX: 0, gapY: 0 });
                  } else {
                    const p = LABEL_PRESETS.find(x => x.id === e.target.value);
                    if (p) setLayoutSaved({ ...p });
                  }
                }}
                value=""
                className="w-full px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-[11px] font-bold cursor-pointer outline-none"
              >
                <option value="">— اختر مقاساً جاهزاً أو اكتب مقاسك —</option>
                {(isRoll ? ROLL_PRESETS : LABEL_PRESETS).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>

              <div className="grid grid-cols-2 gap-2">
                {numField('عرض الملصق (ملم)', 'labelW')}
                {numField('ارتفاعه (ملم)', 'labelH')}
                {/* الهوامش والمسافات تخصّ ورقة A4 وحدها — البكرة لا هوامش لها */}
                {!isRoll && numField('هامش جانبي', 'marginX')}
                {!isRoll && numField('هامش علوي', 'marginY')}
                {!isRoll && numField('مسافة أفقية', 'gapX')}
                {!isRoll && numField('مسافة رأسية', 'gapY')}
              </div>

              {isRoll ? (
                <div className="p-2 rounded-lg text-[10px] font-extrabold text-center bg-indigo-100 text-indigo-800">
                  ملصق واحد لكل صفحة — الطابعة تقطع بينها تلقائياً
                </div>
              ) : (
                <div className={`p-2 rounded-lg text-[10px] font-extrabold text-center ${grid.fits ? 'bg-indigo-100 text-indigo-800' : 'bg-rose-100 text-rose-800'}`}>
                  {grid.fits
                    ? `${toArabicDigits(grid.cols)} أعمدة × ${toArabicDigits(grid.rows)} صفوف = ${toArabicDigits(grid.perPage)} ملصقاً في الورقة`
                    : 'المقاس أكبر من الورقة — راجع الأبعاد'}
                </div>
              )}

              {/* «ابدأ من الملصق رقم» بلا معنى على بكرة متصلة */}
              {!isRoll && (
                <label className="block">
                  <span className="text-[10px] font-bold text-slate-500 block mb-1">
                    ابدأ من الملصق رقم (لاستكمال ورقة مستعملة)
                  </span>
                  <input type="text" inputMode="decimal" min={0} max={Math.max(0, grid.perPage - 1)} value={skip}
                    onChange={e => setSkip(Math.max(0, readCount(e.target.value, { whenEmpty: 0 }) ?? 0))}
                    className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-center outline-none" />
                  <span className="text-[9px] text-slate-400 font-bold block mt-1">
                    ٠ = من أول ملصق. اكتب عدد الملصقات المستعملة سابقاً فتُترك فارغة.
                  </span>
                </label>
              )}
            </div>

            <div className="p-3 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
              <span className="text-[11px] font-extrabold text-[#0B1F4D]">محتوى الملصق</span>
              {([
                ['اسم المحل', showStore, setShowStore],
                ['اسم المادة', showName, setShowName],
                ['السعر', showPrice, setShowPrice],
                ['الرقم تحت الباركود', showCode, setShowCode],
              ] as const).map(([label, val, set]) => (
                <label key={label} className="flex items-center justify-between cursor-pointer">
                  <span className="text-[11px] font-bold text-slate-600">{label}</span>
                  <input type="checkbox" checked={val} onChange={e => set(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 cursor-pointer" />
                </label>
              ))}
            </div>

            {/* معاينة بالمقاس الحقيقي */}
            <div className="p-3 rounded-xl border border-slate-200 bg-white">
              <span className="text-[11px] font-extrabold text-[#0B1F4D] block mb-2">المعاينة (بالحجم الحقيقي)</span>
              {preview ? (
                <div className="flex justify-center">
                  <div
                    style={{
                      width: `${layout.labelW * PX}px`, height: `${layout.labelH * PX}px`,
                      padding: `${1 * PX}px`,
                    }}
                    className="border border-dashed border-slate-300 bg-white flex flex-col items-center justify-center text-center overflow-hidden"
                  >
                    {showStore && storeName && <div style={{ fontSize: `${Math.max(4.5, Math.min(9, layout.labelH * 0.16)) * 0.85}px` }} className="font-bold w-full truncate">{storeName}</div>}
                    {showName && <div style={{ fontSize: `${Math.max(4.5, Math.min(9, layout.labelH * 0.16))}px` }} className="font-bold w-full truncate">{preview.name}</div>}
                    {showPrice && <div style={{ fontSize: `${Math.max(4.5, Math.min(9, layout.labelH * 0.16)) * 1.15}px` }} dir="ltr" className="font-extrabold">{formatPrice(preview.price)}</div>}
                    <div
                      className="leading-none mt-0.5"
                      dangerouslySetInnerHTML={{ __html: previewBarcodeSvg }}
                    />
                    {showCode && <div style={{ fontSize: `${Math.max(4, Math.max(4.5, Math.min(9, layout.labelH * 0.16)) * 0.8)}px` }} dir="ltr" className="font-mono font-bold">{preview.barcode}</div>}
                  </div>
                </div>
              ) : (
                <p className="text-[10px] text-slate-400 font-bold text-center py-4">اختر مادة لعرض معاينتها</p>
              )}
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-slate-100 flex-shrink-0 flex items-center gap-3 flex-wrap">
          <div className="text-[11px] font-extrabold text-[#0B1F4D]">
            {toArabicDigits(totalLabels)} ملصقاً
            {pages > 0 && <span className="text-slate-400 font-bold"> · {toArabicDigits(pages)} {isRoll ? 'قصاصة' : 'ورقة'}</span>}
          </div>
          <p className="text-[9px] text-slate-400 font-bold flex items-center gap-1 flex-1 min-w-[180px]">
            <Info className="w-3 h-3 flex-shrink-0" />
            {isRoll
              ? 'في نافذة الطباعة: اختر طابعة الملصقات، والمقياس ١٠٠٪. حجم الصفحة مضبوط تلقائياً على مقاس الملصق.'
              : 'في نافذة الطباعة: الهوامش «بلا» ومقياس ١٠٠٪ — أي تصغير يُفشل قراءة الماسح.'}
          </p>
          <button onClick={doPrint} disabled={totalLabels === 0 || (!isRoll && !grid.fits)}
            className="px-5 py-2.5 bg-[#0B1F4D] hover:bg-[#13295E] disabled:opacity-40 text-white font-extrabold rounded-xl text-xs cursor-pointer flex items-center gap-1.5">
            <Printer className="w-4 h-4" /> طباعة الملصقات
          </button>
        </div>
      </div>
    </div>
  );
}
