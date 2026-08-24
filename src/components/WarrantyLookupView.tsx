import React, { useMemo, useState } from 'react';
import { ShieldCheck, Search, CalendarClock, User, FileText, AlertTriangle, PackageSearch, ShieldX } from 'lucide-react';
import { useCollection } from '../hooks/useCollection';
import { Invoice } from '../types';
import { toArabicDigits, formatCurrency } from '../utils/arabicFormatters';
import { findSerial, SerialHit, normalizeSerial, warrantyStatus, serialKeysOf } from '../utils/warranty';
import { WarrantyIndexEntry } from '../utils/warrantyIndex';

interface Props {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  /**
   * وضع الموظف: يقرأ من مرآة الضمان (warranty_index) بدل الفواتير — فيجد الأجهزة التي باعها
   * زملاؤه أيضاً، دون كشف اسم الزبون أو الأسعار. القواعد تمنعه أصلاً من قراءة فواتير غيره.
   */
  employeeMode?: boolean;
}

const formatDateAr = (dateStr: string): string => {
  if (!dateStr) return '—';
  const d = new Date(`${dateStr}T00:00:00`);
  return isNaN(d.getTime()) ? toArabicDigits(dateStr) : d.toLocaleDateString('ar-IQ');
};

export default function WarrantyLookupView({ currency, exchangeRate, employeeMode = false }: Props) {
  const showCustomer = !employeeMode;
  // المالك يبحث في الفواتير كاملةً؛ الموظف في المرآة العامة فقط (بلا زبائن ولا أسعار)
  const { items: invoices } = useCollection<Invoice>(employeeMode ? 'warranty_index' : 'invoices');
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState(false);

  const hits: SerialHit[] = useMemo(() => {
    if (!searched || !query.trim()) return [];
    if (!employeeMode) return findSerial(invoices, query);
    // وضع الموظف: مطابقة مباشرة على مفتاح السيريال في المرآة
    const key = normalizeSerial(query);
    return (invoices as unknown as WarrantyIndexEntry[])
      .filter(e => normalizeSerial(e.serial || e.id) === key)
      .map(e => ({
        serial: e.serial || e.id,
        invoiceId: '',
        invoiceNumber: e.invoiceNumber,
        customerName: '',
        saleDate: e.saleDate,
        productName: e.productName,
        unitPrice: 0,
        soldByName: '',
        warranty: warrantyStatus(e.saleDate, e.warrantyMonths),
      }));
  }, [invoices, query, searched, employeeMode]);

  /**
   * إجمالي **الأجهزة** المسجَّلة بسيريال — أي السيريالات المميّزة لا مرات ظهورها.
   *
   * كان المالك يعدّ مرات الظهور والموظف يعدّ وثائق المرآة (مميّزة)، فيظهر رقمان مختلفان
   * لنفس المحل تحت نفس التسمية كلما بِيع جهاز مستعمل مرتين.
   */
  const totalTracked = useMemo(() => {
    if (employeeMode) return invoices.length; // كل وثيقة مرآة = سيريال مميّز
    return serialKeysOf(invoices.flatMap(inv => inv.items ?? [])).size;
  }, [invoices, employeeMode]);

  const runSearch = (e: React.FormEvent) => { e.preventDefault(); setSearched(true); };

  return (
    <div className="space-y-6 font-tajawal" dir="rtl">

      {/* HEADER */}
      <div className="bg-[#0B1F4D] text-white p-6 rounded-2xl border-b-4 border-amber-400">
        <div className="flex items-center gap-2 text-slate-300 text-xs font-bold font-cairo">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span>خدمة ما بعد البيع</span>
        </div>
        <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2">
          <PackageSearch className="w-6 h-6 text-amber-400" />
          <span>الضمان والرقم التسلسلي 🛡️</span>
        </h2>
        <p className="text-xs text-slate-300 mt-1 leading-relaxed">
          أدخل السيريال أو IMEI لتعرف فوراً تاريخ البيع وحالة الضمان — بدل البحث بين آلاف الفواتير
        </p>
      </div>

      {/* SEARCH */}
      <form onSubmit={runSearch} className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm p-5 space-y-3">
        <label className="block text-xs font-extrabold text-[#0B1F4D]">الرقم التسلسلي / IMEI</label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            {/* يدعم مسدس الباركود: القارئ يكتب الرقم ثم Enter فيبحث فوراً (كثير من الأجهزة
                يحمل باركود للسيريال/IMEI، فقراءته أسرع وأدقّ من كتابة ١٥ رقماً يدوياً) */}
            <input
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSearched(false); }}
              placeholder="اقرأ باركود السيريال أو اكتبه — مثال: 356938035643809"
              dir="ltr"
              autoFocus
              autoComplete="off"
              className="w-full pr-3 pl-10 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono font-bold tracking-wider text-center outline-none focus:bg-white focus:border-[#0B1F4D]"
            />
          </div>
          <button type="submit"
            className="px-6 py-3 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-xs shadow transition cursor-pointer flex items-center gap-1.5 active:scale-95">
            <Search className="w-4 h-4" />
            <span>بحث</span>
          </button>
        </div>
        <p className="text-[10px] text-slate-600 font-bold">
          البحث يتجاهل المسافات والشرطات وحالة الأحرف — {toArabicDigits(totalTracked)} جهاز مسجَّل بسيريال
        </p>
      </form>

      {/* RESULTS */}
      {searched && query.trim() && (
        hits.length === 0 ? (
          <div className="bg-white rounded-2xl border border-rose-200 shadow-sm p-8 text-center">
            <ShieldX className="w-12 h-12 text-rose-400 mx-auto mb-3" />
            <h3 className="font-extrabold text-sm text-[#0B1F4D]">لا يوجد بيع مسجَّل بهذا الرقم</h3>
            <p className="text-xs text-slate-500 mt-2 font-bold leading-relaxed">
              تأكّد من الرقم، أو قد يكون الجهاز غير مُباع من هذا المحل —
              أو بِيع قبل تفعيل تسجيل السيريال.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {hits.length > 1 && (
              <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-xs font-bold flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>
                  ⚠️ هذا السيريال مسجَّل في {toArabicDigits(hits.length)} عمليات بيع — راجع الأمر
                  (قد يكون خطأ إدخال أو تكراراً غير مقصود).
                </span>
              </div>
            )}

            {hits.map((hit, idx) => {
              const w = hit.warranty;
              const tone = !w.hasWarranty
                ? { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-600', label: 'بلا ضمان مسجَّل' }
                : w.active
                  ? { bg: 'bg-emerald-50', border: 'border-emerald-300', text: 'text-emerald-800', label: 'الضمان فعّال ✅' }
                  : { bg: 'bg-rose-50', border: 'border-rose-300', text: 'text-rose-800', label: 'الضمان منتهٍ ❌' };

              return (
                <div key={`${hit.invoiceId}_${idx}`} className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
                  {/* حالة الضمان — أبرز معلومة */}
                  <div className={`${tone.bg} ${tone.border} border-b p-4 flex items-center justify-between gap-3 flex-wrap`}>
                    <div>
                      <span className={`text-sm font-black ${tone.text}`}>{tone.label}</span>
                      {w.hasWarranty && (
                        <p className="text-[11px] text-slate-600 font-bold mt-1">
                          مدة الضمان {toArabicDigits(w.monthsCovered)} شهر · ينتهي في {formatDateAr(w.expiryKey)}
                        </p>
                      )}
                    </div>
                    {w.hasWarranty && (
                      <span className={`text-xs font-extrabold px-3 py-1.5 rounded-xl bg-white/70 ${tone.text}`}>
                        {w.active
                          ? `متبقٍّ ${toArabicDigits(w.daysLeft)} يوم`
                          : `انتهى منذ ${toArabicDigits(Math.abs(w.daysLeft))} يوم`}
                      </span>
                    )}
                  </div>

                  {/* التفاصيل */}
                  <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="flex items-center gap-2">
                      <PackageSearch className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                      <div className="min-w-0">
                        <span className="text-slate-500 font-bold block text-[10px]">الجهاز</span>
                        <span title={hit.productName} className="font-extrabold text-[#0B1F4D] block truncate">{hit.productName}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <CalendarClock className="w-4 h-4 text-emerald-700 flex-shrink-0" />
                      <div>
                        <span className="text-slate-500 font-bold block text-[10px]">تاريخ البيع</span>
                        <span className="font-extrabold text-[#0B1F4D] block">{formatDateAr(hit.saleDate)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-slate-500 flex-shrink-0" />
                      <div>
                        <span className="text-slate-500 font-bold block text-[10px]">رقم الفاتورة</span>
                        <span className="font-extrabold text-[#0B1F4D] block font-mono">{toArabicDigits(hit.invoiceNumber)}</span>
                      </div>
                    </div>
                    {showCustomer ? (
                      <div className="flex items-center gap-2">
                        <User className="w-4 h-4 text-amber-700 flex-shrink-0" />
                        <div className="min-w-0">
                          <span className="text-slate-500 font-bold block text-[10px]">المشتري</span>
                          <span title={hit.customerName} className="font-extrabold text-[#0B1F4D] block truncate">{hit.customerName}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <User className="w-4 h-4 text-slate-400 flex-shrink-0" />
                        <div>
                          <span className="text-slate-500 font-bold block text-[10px]">المشتري</span>
                          <span className="font-bold text-slate-500 block">محجوب — راجع صاحب المحل</span>
                        </div>
                      </div>
                    )}
                    {showCustomer && (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="w-4 h-4 flex-shrink-0" />
                          <div>
                            <span className="text-slate-500 font-bold block text-[10px]">سعر البيع</span>
                            <span className="font-extrabold text-[#0B1F4D] block font-mono">
                              {formatCurrency(hit.unitPrice, currency, exchangeRate)}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-4 h-4 flex-shrink-0" />
                          <div>
                            <span className="text-slate-500 font-bold block text-[10px]">البائع</span>
                            <span className="font-extrabold text-[#0B1F4D] block">{hit.soldByName}</span>
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100">
                    <span className="text-[10px] text-slate-600 font-bold">السيريال المسجَّل: </span>
                    <span className="text-[11px] font-mono font-extrabold text-[#0B1F4D]" dir="ltr">{hit.serial}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
