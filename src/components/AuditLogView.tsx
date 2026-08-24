import React, { useMemo, useState } from 'react';
import {
  Download, Eye, FileSearch, Filter, History, Search, ShieldCheck, UserRound, X, AlertTriangle,
} from 'lucide-react';
import { AuditAction, AuditEntity, AuditLog } from '../types';
import { useAuditLogs, AUDIT_PAGE_CAP } from '../utils/auditLog';
import { exportAsWord, exportAsPdf, ExportSpec } from '../utils/exportDoc';
import { toArabicDigits, formatCurrency } from '../utils/arabicFormatters';
import { periodRange, rangeText, PeriodKey } from '../utils/reportPeriod';

const ACTIONS: Record<AuditAction, string> = {
  create: 'إضافة', update: 'تعديل', delete: 'حذف', cancel: 'إلغاء', restore: 'استعادة',
};

const ENTITIES: Record<AuditEntity, string> = {
  invoice: 'فاتورة بيع', customer: 'زبون', product: 'منتج', product_cost: 'تكلفة شراء',
  expense: 'مصروف', debt_payment: 'تسديد زبون', cash_closing: 'إقفال صندوق', employee: 'موظف',
  supplier: 'مورد', supplier_payment: 'تسديد مورد', purchase_invoice: 'فاتورة شراء',
  stock_adjustment: 'تسوية مخزون', settings: 'إعدادات', profile: 'بيانات المحل',
  // 🟠 نوعان كانا مفقودَين فتسرّبت عملياتهما إلى «منتج» و«إعدادات»
  stock_transfer: 'نقل بضاعة', branch: 'فرع أو مخزن',
  // 🔴 مفتاحٌ يُباع — لم يكن له أثر إطلاقاً
  activation_code: 'كود تفعيل',
};

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'daily', label: 'اليوم' },
  { key: 'weekly', label: 'آخر ٧ أيام' },
  { key: 'monthly', label: 'آخر ٣٠ يوماً' },
  { key: 'yearly', label: 'آخر سنة' },
  { key: 'all', label: 'كل التاريخ' },
];

const formatTime = (time: number) =>
  new Date(time).toLocaleString('ar-IQ', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * 🟡 أسماء الحقول بالعربية في لوحة «قبل/بعد».
 *
 * كانت تُعرض JSON خاماً بمفاتيح إنجليزية — وهي أنفع ما في السجل (تُثبت **ماذا تغيّر
 * بالضبط**) وأقلّه وصولاً لصاحب المحل. نترجم المألوف ونُبقي الباقي كما هو بلا إخفاء.
 */
const FIELD_LABELS: Record<string, string> = {
  name: 'الاسم', phone: 'الهاتف', address: 'العنوان', notes: 'ملاحظات',
  balance: 'الرصيد', quantity: 'الكمية', sellPrice: 'سعر البيع', buyPrice: 'سعر الشراء',
  finalAmount: 'الإجمالي', totalAmount: 'المجموع', paidAmount: 'المدفوع',
  remainingAmount: 'المتبقّي', discount: 'الخصم', tax: 'الضريبة', amount: 'المبلغ',
  invoiceNumber: 'رقم الفاتورة', customerName: 'الزبون', supplierName: 'المورد',
  productName: 'المادة', date: 'التاريخ', method: 'طريقة الدفع', branchId: 'الفرع',
  quantityDelta: 'فرق الكمية', quantityBefore: 'الكمية قبل', quantityAfter: 'الكمية بعد',
  reason: 'السبب', status: 'الحالة', active: 'مفعّل', kind: 'النوع',
  countedCash: 'النقد المعدود', expectedCash: 'المتوقّع', difference: 'الفرق',
};

const MONEY_FIELDS = new Set([
  'balance', 'sellPrice', 'buyPrice', 'finalAmount', 'totalAmount', 'paidAmount',
  'remainingAmount', 'discount', 'tax', 'amount', 'countedCash', 'expectedCash', 'difference',
]);

/** يعرض لقطة بصورة مقروءة: الحقول المعروفة بالعربية، والباقي كما هو. */
function SnapshotTable({ data, tone }: { data: Record<string, unknown>; tone: 'before' | 'after' }) {
  const rows = Object.entries(data)
    .filter(([, v]) => v !== undefined && typeof v !== 'object')
    .slice(0, 40);
  const rest = Object.entries(data).filter(([, v]) => typeof v === 'object' && v !== null);
  const bg = tone === 'before' ? 'bg-rose-50' : 'bg-emerald-50';

  return (
    <div className={`mt-1 ${bg} rounded-xl p-2.5 space-y-1`}>
      {rows.length === 0 && <span className="text-[11px] text-slate-500 font-bold">لا حقول بسيطة</span>}
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-3 text-[11px]">
          <span className="font-bold text-slate-600">{FIELD_LABELS[k] ?? k}</span>
          <span className="font-extrabold text-[#0B1F4D] font-sans">
            {typeof v === 'boolean'
              ? (v ? 'نعم' : 'لا')
              : MONEY_FIELDS.has(k) && typeof v === 'number'
                ? formatCurrency(v, 'IQD', 1500)
                : toArabicDigits(String(v))}
          </span>
        </div>
      ))}
      {rest.length > 0 && (
        <details className="mt-1.5">
          <summary className="text-[10px] font-bold text-slate-500 cursor-pointer">
            تفاصيل إضافية ({toArabicDigits(rest.length)})
          </summary>
          <pre className="mt-1 text-[10px] overflow-auto max-h-40" dir="ltr">
            {JSON.stringify(Object.fromEntries(rest), null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

export default function AuditLogView() {
  /**
   * 🔴 النافذة الزمنية بدل الحدّ الأعمى.
   *
   * كان `useAuditLogs(500)` يُحمّل آخر ٥٠٠ عملية **بلا نافذة ولا صفحات**، وفي البرنامج
   * ٣٧ موضع تسجيل — فمحلٌّ متوسط الحركة يستهلكها في أسبوع أو اثنين، وبعدها لا سبيل
   * لرؤية عملية الشهر الماضي من البرنامج إطلاقاً. وهي بالضبط ما وُجد السجل لأجله.
   */
  const [period, setPeriod] = useState<PeriodKey>('monthly');
  const range = useMemo(() => periodRange(period), [period]);
  const sinceMs = period === 'all' ? 0 : range.from.getTime();
  const { items, loading, reachedCap } = useAuditLogs(sinceMs);

  const [search, setSearch] = useState('');
  const [action, setAction] = useState<'all' | AuditAction>('all');
  const [entity, setEntity] = useState<'all' | AuditEntity>('all');
  const [actor, setActor] = useState<'all' | string>('all');
  const [selected, setSelected] = useState<AuditLog | null>(null);

  /** 🟠 قائمة المنفّذين — أوّل سؤال مساءلةٍ مع وجود موظفين: «ماذا فعل فلان؟» */
  const actors = useMemo(
    () => [...new Set(items.map(i => i.actorName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar')),
    [items],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(item =>
      (action === 'all' || item.action === action)
      && (entity === 'all' || item.entity === entity)
      && (actor === 'all' || item.actorName === actor)
      && (!q
        || item.summary.toLowerCase().includes(q)
        || item.actorName.toLowerCase().includes(q)
        || (ENTITIES[item.entity] || '').toLowerCase().includes(q)),
    );
  }, [items, search, action, entity, actor]);

  const scopeText = period === 'all' ? 'كل التاريخ' : `${range.label} (${rangeText(range)})`;

  const exportLog = (format: 'word' | 'pdf') => {
    if (!filtered.length) return;
    const spec: ExportSpec = {
      title: 'رتب شغلك',
      subtitle: `سجل التدقيق — ${scopeText} — ${toArabicDigits(filtered.length)} عملية`,
      columns: [
        { header: 'الوقت' }, { header: 'المستخدم' }, { header: 'الإجراء' },
        { header: 'القسم' }, { header: 'التفاصيل' },
      ],
      rows: filtered.map(item => [
        formatTime(item.createdAt), item.actorName, ACTIONS[item.action],
        ENTITIES[item.entity] ?? item.entity, item.summary,
      ]),
      /**
       * 🟠 التحفّظ في الورقة نفسها: كان التصدير يحمل عنوان «سجل التدقيق — ٤٨٠ عملية»
       * بلا ذكر أنه آخر ٤٨٠ من عددٍ مجهول. والورقة تُقرأ خارج البرنامج بلا سياقه.
       */
      note: reachedCap
        ? `⚠️ بُلغ سقف التحميل (${toArabicDigits(AUDIT_PAGE_CAP)} عملية) داخل هذه الفترة — `
          + 'قد توجد عمليات أقدم لم تُدرَج. اختر فترة أضيق لتغطيتها كاملةً.'
        : `تغطّي هذه الورقة ${scopeText} كاملةً.`,
    };
    if (format === 'word') exportAsWord(spec, `سجل_التدقيق_${new Date().toISOString().slice(0, 10)}`);
    else exportAsPdf(spec, () => undefined);
  };

  return (
    <div className="space-y-5" dir="rtl">
      {/* رأس الشاشة */}
      <div className="bg-[#0B1F4D] text-white p-6 rounded-2xl border-b-4 border-emerald-400 flex flex-col md:flex-row justify-between gap-3">
        <div>
          <div className="text-xs text-emerald-300 font-bold flex gap-2 items-center">
            <ShieldCheck className="w-4 h-4" /> حماية ومساءلة المالك
          </div>
          <h2 className="text-xl font-extrabold mt-2 flex gap-2 items-center">
            <History className="w-6 h-6 text-emerald-400" /> سجل التدقيق
          </h2>
          <p className="text-xs text-slate-300 mt-2 leading-relaxed max-w-2xl">
            كل عملية حساسة تُحفظ مع اسم المنفذ والوقت والتفاصيل. السجل للقراءة فقط ولا يمكن تعديله من الواجهة،
            و<b>الموظف لا يستطيع محو أثره</b> بعد تسجيله.
          </p>
        </div>
        <div className="flex gap-2 self-start md:self-center">
          <button onClick={() => exportLog('word')} disabled={!filtered.length}
            className="px-3 py-2 bg-white/10 disabled:opacity-40 rounded-xl text-xs font-bold flex items-center gap-1 cursor-pointer">
            <Download className="w-3.5 h-3.5" /> Word
          </button>
          <button onClick={() => exportLog('pdf')} disabled={!filtered.length}
            className="px-3 py-2 bg-white/10 disabled:opacity-40 rounded-xl text-xs font-bold flex items-center gap-1 cursor-pointer">
            <Download className="w-3.5 h-3.5" /> PDF
          </button>
        </div>
      </div>

      {/* 🔴 الفترة — كان الوصول إلى الماضي مستحيلاً بلا نافذة */}
      <div className="flex flex-wrap items-center gap-1.5 bg-white border border-slate-200 rounded-xl p-1.5">
        {PERIODS.map(p => (
          <button key={p.key} onClick={() => setPeriod(p.key)}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-extrabold cursor-pointer transition ${
              period === p.key ? 'bg-[#0B1F4D] text-white' : 'text-slate-500 hover:bg-slate-100'
            }`}>
            {p.label}
          </button>
        ))}
        <span className="text-[10px] text-slate-500 font-bold mr-2">📅 {scopeText}</span>
      </div>

      {reachedCap && (
        <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-900 font-bold leading-relaxed">
            بُلغ سقف التحميل ({toArabicDigits(AUDIT_PAGE_CAP)} عملية) داخل هذه الفترة — قد توجد عمليات
            أقدم لم تُعرض. <b>اختر فترة أضيق</b> لتراها كاملةً.
          </p>
        </div>
      )}

      {/* المرشِّحات */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl px-3 flex items-center gap-2">
          <Search className="w-4 h-4 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="ابحث باسم أو عملية…" className="w-full py-3 outline-none text-sm" />
        </div>
        <select value={actor} onChange={e => setActor(e.target.value)}
          className="bg-white border border-slate-200 rounded-xl px-3 text-sm cursor-pointer">
          <option value="all">كل المنفّذين</option>
          {actors.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={action} onChange={e => setAction(e.target.value as typeof action)}
          className="bg-white border border-slate-200 rounded-xl px-3 text-sm cursor-pointer">
          <option value="all">كل الإجراءات</option>
          {Object.entries(ACTIONS).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
        </select>
        <select value={entity} onChange={e => setEntity(e.target.value as typeof entity)}
          className="bg-white border border-slate-200 rounded-xl px-3 text-sm cursor-pointer">
          <option value="all">كل الأقسام</option>
          {Object.entries(ENTITIES).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
        </select>
      </div>

      <div className="flex items-center gap-2 text-xs font-bold text-slate-500">
        <Filter className="w-4 h-4" /> عرض {toArabicDigits(filtered.length)} من {toArabicDigits(items.length)} عملية في {scopeText}
      </div>

      {/* القائمة */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        {loading ? (
          <p className="p-10 text-center text-slate-500">جارِ تحميل السجل…</p>
        ) : items.length === 0 ? (
          /* 🟡 تمييز «لا سجل بعد» عن «لا نتيجة للمرشِّح» — كان الأول يُقرأ خطأً */
          <p className="p-10 text-center text-slate-500 text-sm leading-relaxed">
            لا توجد عمليات مسجّلة في {scopeText}.
            <br />
            <span className="text-xs">جرّب فترة أوسع، أو ابدأ العمل وستُسجَّل كل عملية حساسة تلقائياً.</span>
          </p>
        ) : !filtered.length ? (
          <p className="p-10 text-center text-slate-500">لا توجد عمليات مطابقة للمرشِّحات المختارة.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {filtered.map(item => (
              <button key={item.id} onClick={() => setSelected(item)}
                className="w-full p-4 text-right hover:bg-slate-50 flex flex-col sm:flex-row sm:items-center gap-3 cursor-pointer">
                <span className={`w-2 h-2 rounded-full flex-none ${
                  item.action === 'delete' || item.action === 'cancel' ? 'bg-rose-500'
                    : item.action === 'update' ? 'bg-amber-500' : 'bg-emerald-500'
                }`} />
                <div className="flex-1 min-w-0">
                  <p title={item.summary} className="font-bold text-sm text-[#0B1F4D] truncate">{item.summary}</p>
                  <p className="text-xs text-slate-500 mt-1">{formatTime(item.createdAt)}</p>
                </div>
                <span className="text-xs font-bold text-slate-600 flex gap-1 items-center">
                  <UserRound className="w-3.5 h-3.5" /> {item.actorName}
                </span>
                <span className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded-lg">
                  {ENTITIES[item.entity] ?? item.entity}
                </span>
                <Eye className="w-4 h-4 text-slate-500" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* التفاصيل */}
      {selected && (
        <div className="fixed inset-0 z-[9998] bg-slate-900/50 p-4 flex items-center justify-center"
          onClick={() => setSelected(null)}>
          <div onClick={e => e.stopPropagation()}
            className="bg-white w-full max-w-2xl rounded-2xl p-5 shadow-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex justify-between items-center">
              <h3 className="font-extrabold text-[#0B1F4D] flex gap-2 items-center">
                <FileSearch className="w-5 h-5 text-emerald-600" /> تفاصيل العملية
              </h3>
              <button onClick={() => setSelected(null)} className="cursor-pointer">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-4 text-xs">
              <p><b>المنفذ:</b> {selected.actorName}</p>
              <p><b>الوقت:</b> {formatTime(selected.createdAt)}</p>
              <p><b>الإجراء:</b> {ACTIONS[selected.action]}</p>
              <p><b>القسم:</b> {ENTITIES[selected.entity] ?? selected.entity}</p>
            </div>
            <p className="mt-4 p-3 bg-slate-50 rounded-xl text-sm text-slate-700">{selected.summary}</p>
            {selected.before && (
              <>
                <h4 className="mt-4 text-xs font-bold text-rose-700">قبل التعديل</h4>
                <SnapshotTable data={selected.before} tone="before" />
              </>
            )}
            {selected.after && (
              <>
                <h4 className="mt-4 text-xs font-bold text-emerald-700">بعد التعديل</h4>
                <SnapshotTable data={selected.after} tone="after" />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
