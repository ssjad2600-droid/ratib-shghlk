import { useState, useMemo } from 'react';
import { PrintOnly } from './DesktopOnly';
import { where } from 'firebase/firestore';
import {
  X, Printer, FileText, Receipt, Clock, TrendingUp,
  Wallet, ChevronDown, ChevronUp, ShoppingBag, CreditCard, Phone
} from 'lucide-react';
import { Customer, Invoice } from '../types';
import { useCollection } from '../hooks/useCollection';
import { auth } from '../firebase';
import { toArabicDigits, formatCurrency } from '../utils/arabicFormatters';
import { printInvoices } from '../utils/printInvoices';

// فاتورة موظف = createdByUid يختلف عن uid المالك الحالي (المودال يُعرض للمالك فقط)
const isEmployeeInvoice = (inv: Invoice): boolean => !!inv.createdByUid && inv.createdByUid !== auth.currentUser?.uid;

// نفس بنية دفعات الديون المستخدمة في DebtView (debt_payments)
interface DebtPayment {
  id: string;
  customerId: string;
  customerName: string;
  amount: number;
  date: string;
  notes: string;
  invoiceId?: string;
}

interface CustomerHistoryModalProps {
  customer: Customer;
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  onClose: () => void;
  /** ترويسة المحل للورقة المطبوعة — كشف الحساب يُقدَّم لزبون، فلا يخرج بلا هوية المحل. */
  store?: { name?: string; address?: string; phone?: string };
  /** يُبلَّغ عند تعذّر فتح نافذة الطباعة — بدونه يبدو الزر معطّلاً. */
  onPrintError?: (msg: string) => void;
}

// نفس منطق عرض التاريخ في قسم الفواتير — يدعم ISO والنص العربي
const formatDate = (dateStr: string): string => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (!isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return d.toLocaleDateString('ar-IQ');
  }
  return toArabicDigits(dateStr);
};

// عرض اسم المادة مع وحدة البيع إن وُجدت (متوافق مع الجملة/المفرد الجديد)
const itemDisplayName = (it: { name: string; unitLabel?: string }): string =>
  it.unitLabel ? `${it.name} - ${it.unitLabel}` : it.name;

type InvStatus = 'paid' | 'partial' | 'debt';
const getInvoiceStatus = (inv: Invoice): InvStatus => {
  const paid = inv.paidAmount ?? inv.finalAmount;
  const remaining = inv.remainingAmount ?? 0;
  if (remaining <= 0) return 'paid';
  return paid > 0 ? 'partial' : 'debt';
};

const STATUS_META: Record<InvStatus, { label: string; badge: string; dot: string }> = {
  paid:    { label: 'مدفوعة بالكامل', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  partial: { label: 'مسددة جزئياً',   badge: 'bg-amber-50 text-amber-700 border-amber-200',       dot: 'bg-amber-500' },
  debt:    { label: 'دين',            badge: 'bg-rose-50 text-rose-700 border-rose-200',           dot: 'bg-rose-500' },
};

const PAGE_SIZE = 20;

export default function CustomerHistoryModal({ customer, currency, exchangeRate, onClose, store, onPrintError }: CustomerHistoryModalProps) {
  /**
   * ---- بيانات حية — مُقيَّدة بهذا الزبون على **الخادم** ----
   *
   * 🔴 كانت تُحمَّل **كل** فواتير المحل وكل تسديداته ثم تُفلتر في المتصفح بـ`customerId`.
   * أي أن فتح سجلّ زبونٍ واحد كان ينزّل الدفتر كلّه: محل بخمسين ألف فاتورة ينزّلها كاملةً
   * ليعرض عشراً. وفاتورة فايرستور تُحاسَب **بعدد الوثائق المقروءة** لا بحجمها.
   *
   * والقيد بحقل **واحد** (`customerId`) بمساواة ⇒ **لا يحتاج فهرساً مركّباً** — نفس المبدأ
   * الذي بُني عليه `dateWindow.ts`. والترشيح مطابق حرفياً لما كان يفعله المتصفح، فلا
   * يتغيّر سطرٌ مما يراه التاجر.
   */
  const invoiceQuery = useMemo(() => [where('customerId', '==', customer.id)], [customer.id]);
  const { items: allInvoices } = useCollection<Invoice>('invoices', invoiceQuery);
  const { items: allPayments } = useCollection<DebtPayment>('debt_payments', invoiceQuery);

  const [expandedInvoiceId, setExpandedInvoiceId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // التسديدات تُقسَّم كالفواتير — زبون قديم قد يكون له مئات الدفعات فتُرسم كلها دفعةً واحدة
  const [visiblePayments, setVisiblePayments] = useState(PAGE_SIZE);

  // الفواتير المرتبطة بهذا الزبون فقط (الفواتير اليتيمة / زبون عام بلا customerId تُستثنى تلقائياً)، الأحدث أولاً
  const custInvoices = useMemo(
    () => allInvoices
      .filter(inv => inv.customerId === customer.id)
      .sort((a, b) => b.date.localeCompare(a.date)),
    [allInvoices, customer.id]
  );

  const custPayments = useMemo(
    () => allPayments
      .filter(p => p.customerId === customer.id)
      .sort((a, b) => b.date.localeCompare(a.date)),
    [allPayments, customer.id]
  );

  // ---- ملخص علوي ----
  const totalPurchased = custInvoices.reduce((s, inv) => s + inv.finalAmount, 0);
  const invoiceCount = custInvoices.length;

  // دَينٌ في رصيد الزبون لا تشرحه أي فاتورة معروضة (فواتير فقدت ربطها بالمعرّف).
  // نحسبه بالطرح لا بمصدر ثانٍ — الرصيد يبقى المصدر الوحيد الموثوق للدَّين.
  const listedDebt = custInvoices.reduce((s, inv) => s + (inv.remainingAmount ?? 0), 0);
  const unexplainedDebt = Math.max(0, Math.round(customer.balance - listedDebt));
  const lastTransactionDate = custInvoices[0]?.date ?? '';

  const printAll = () => printInvoices({
    label: customer.name,
    phone: customer.phone,
    invoices: custInvoices,
    currency,
    exchangeRate,
    store,
    onError: onPrintError,
  });

  const printOne = (inv: Invoice) => printInvoices({
    label: customer.name,
    phone: customer.phone,
    invoices: [inv],
    currency,
    exchangeRate,
    store,
    onError: onPrintError,
  });

  const visibleInvoices = custInvoices.slice(0, visibleCount);

  return (
    <div
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-3 md:p-6"
      onClick={onClose}
      dir="rtl"
    >
      <div
        className="bg-[#EEF2F8] rounded-2xl w-full max-w-4xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[92vh] text-right animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >

        {/* Header */}
        <div className="p-5 bg-gradient-to-l from-[#0B1F4D] to-[#1B3A7A] text-white flex justify-between items-center flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-white/10 backdrop-blur flex items-center justify-center font-black font-cairo text-base flex-shrink-0">
              {customer.name.trim().split(' ').map(n => n[0]).join('').slice(0, 2)}
            </div>
            <div className="min-w-0">
              <h3 className="font-extrabold font-cairo text-sm md:text-base truncate">السجل الشامل — {customer.name}</h3>
              {customer.phone && (
                <p className="text-[11px] text-blue-200 font-mono flex items-center gap-1 mt-0.5">
                  <Phone className="w-3 h-3" /> {customer.phone}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {custInvoices.length > 0 && (
              <PrintOnly>
              <button
                onClick={printAll}
                className="px-3 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-bold flex items-center gap-1.5 transition cursor-pointer border border-white/10"
                title="طباعة السجل الكامل"
              >
                <Printer className="w-4 h-4" />
                <span className="hidden sm:inline">طباعة الكل</span>
              </button>
              </PrintOnly>
            )}
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-lg transition cursor-pointer"
              title="إغلاق"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="p-5 space-y-5 overflow-y-auto">

          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-xs">
              <div className="flex items-center gap-1.5 text-slate-600 text-[10px] font-extrabold mb-1.5">
                <ShoppingBag className="w-3.5 h-3.5" />
                <span>إجمالي المشتريات</span>
              </div>
              <span className="text-sm md:text-base font-black font-sans text-[#0B1F4D] block">
                {formatCurrency(totalPurchased, currency, exchangeRate)}
              </span>
              <span className="text-[11px] text-slate-500 block mt-0.5">منذ أول تعامل</span>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-xs">
              <div className="flex items-center gap-1.5 text-slate-600 text-[10px] font-extrabold mb-1.5">
                <Wallet className="w-3.5 h-3.5" />
                <span>الدين الحالي</span>
              </div>
              <span className={`text-sm md:text-base font-black font-sans block ${
                customer.balance > 0 ? 'text-rose-700' : customer.balance < 0 ? 'text-emerald-700' : 'text-slate-600'
              }`}>
                {customer.balance > 0
                  ? `${formatCurrency(customer.balance, currency, exchangeRate)}`
                  : customer.balance < 0
                    ? `${formatCurrency(Math.abs(customer.balance), currency, exchangeRate)}`
                    : formatCurrency(0, currency, exchangeRate)}
              </span>
              <span className="text-[11px] text-slate-500 block mt-0.5">
                {customer.balance > 0 ? 'مستحق عليه 🔴' : customer.balance < 0 ? 'أمانة له 🟢' : 'متزن ✨'}
              </span>
              {/* الدَّين المعروض أعلاه هو رصيد الزبون كاملاً، والقائمة أدناه لا تعرض إلا
                  الفواتير **المربوطة** به. ففاتورة قديمة فقدت ربطها تُحسب في الدَّين ولا
                  تظهر — فيرى التاجر ديناً لا يجد ما يشرحه. نُبيّن الفرق بدل أن نتركه لغزاً. */}
              {unexplainedDebt > 0 && (
                <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 block mt-1.5 leading-relaxed">
                  منها {formatCurrency(unexplainedDebt, currency, exchangeRate)} من فواتير قديمة
                  غير مربوطة باسمه — افتح شاشة الفواتير مرة ليربطها البرنامج تلقائياً
                </span>
              )}
            </div>

            <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-xs">
              <div className="flex items-center gap-1.5 text-slate-600 text-[10px] font-extrabold mb-1.5">
                <FileText className="w-3.5 h-3.5" />
                <span>عدد الفواتير</span>
              </div>
              <span className="text-sm md:text-base font-black font-sans text-[#0B1F4D] block">
                {toArabicDigits(invoiceCount)}
              </span>
              <span className="text-[11px] text-slate-500 block mt-0.5">فاتورة مرتبطة</span>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-xs">
              <div className="flex items-center gap-1.5 text-slate-600 text-[10px] font-extrabold mb-1.5">
                <Clock className="w-3.5 h-3.5" />
                <span>آخر معاملة</span>
              </div>
              <span className="text-xs md:text-sm font-black text-[#0B1F4D] block">
                {lastTransactionDate ? formatDate(lastTransactionDate) : '—'}
              </span>
              <span className="text-[11px] text-slate-500 block mt-0.5">تاريخ آخر فاتورة</span>
            </div>
          </div>

          {/* Invoices list */}
          <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h4 className="font-extrabold text-xs md:text-sm text-[#0B1F4D] font-cairo flex items-center gap-1.5">
                <Receipt className="w-4.5 h-4.5 text-emerald-700" />
                <span>سجل الفواتير (الأحدث أولاً)</span>
              </h4>
              <span className="text-[10px] bg-slate-100 text-[#0B1F4D] font-extrabold px-2.5 py-1 rounded-full border border-slate-200">
                {toArabicDigits(invoiceCount)}
              </span>
            </div>

            {custInvoices.length > 0 ? (
              <div className="divide-y divide-slate-100">
                {visibleInvoices.map(inv => {
                  const status = getInvoiceStatus(inv);
                  const meta = STATUS_META[status];
                  const paid = inv.paidAmount ?? inv.finalAmount;
                  const remaining = inv.remainingAmount ?? 0;
                  const isExpanded = expandedInvoiceId === inv.id;

                  return (
                    <div key={inv.id} className="transition">
                      {/* Row */}
                      <div
                        className="p-3.5 hover:bg-slate-50/70 cursor-pointer flex items-center justify-between gap-3"
                        onClick={() => setExpandedInvoiceId(isExpanded ? null : inv.id)}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center flex-shrink-0">
                            {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-extrabold text-xs text-[#0B1F4D]">فاتورة {toArabicDigits(inv.invoiceNumber)}</span>
                              <span className={`inline-flex items-center gap-1 text-[11px] font-extrabold px-2 py-0.5 rounded-full border ${meta.badge}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                                {meta.label}
                              </span>
                              {isEmployeeInvoice(inv) && (
                                <span className="inline-flex items-center text-[11px] font-extrabold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                                  بواسطة: {inv.createdByName?.trim() || 'موظف'}
                                </span>
                              )}
                            </div>
                            <span className="text-[10px] text-slate-600 block mt-0.5">{formatDate(inv.date)}</span>
                          </div>
                        </div>

                        <div className="text-left flex-shrink-0">
                          <span className="font-black text-xs font-sans text-[#0B1F4D] block">
                            {formatCurrency(inv.finalAmount, currency, exchangeRate)}
                          </span>
                          {remaining > 0 && (
                            <span className="text-[10px] text-rose-700 font-bold block mt-0.5">
                              متبقٍّ: {formatCurrency(remaining, currency, exchangeRate)}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="px-3.5 pb-4 pt-1 bg-slate-50/50 animate-fade-in">
                          <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
                            {/* 🔴 الغلاف الخارجي `overflow-hidden` (لتدوير الحواف) كان
                                **يقصّ** الجدول على شاشة الهاتف بدل أن يُمرّره، فتختفي
                                أعمدة السعر والمجموع بلا أي أثر يدلّ عليها.
                                والطباعة هنا غير متأثّرة: تُولَّد HTML مستقلاً في نافذة. */}
                            <div className="overflow-x-auto">
                            <table className="w-full text-right text-[11px]">
                              <thead className="bg-[#EEF2F8] text-[#0B1F4D] font-cairo">
                                <tr>
                                  <th className="p-2.5">المادة</th>
                                  <th className="p-2.5 text-center">الكمية</th>
                                  <th className="p-2.5 text-center">السعر</th>
                                  <th className="p-2.5 text-left">المجموع</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {inv.items.map((it, i) => (
                                  <tr key={i}>
                                    <td className="p-2.5 font-bold text-slate-700">{itemDisplayName(it)}</td>
                                    <td className="p-2.5 text-center font-sans text-slate-600">{toArabicDigits(it.quantity)}</td>
                                    <td className="p-2.5 text-center font-sans text-slate-600">{formatCurrency(it.price, currency, exchangeRate)}</td>
                                    <td className="p-2.5 text-left font-sans font-extrabold text-[#0B1F4D]">{formatCurrency(it.total, currency, exchangeRate)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            </div>
                          </div>

                          {/* Totals */}
                          <div className="flex justify-end mt-3">
                            <div className="w-full sm:w-64 text-[11px] space-y-1">
                              <div className="flex justify-between text-slate-500">
                                <span>المجموع الفرعي:</span>
                                <span className="font-sans">{formatCurrency(inv.totalAmount, currency, exchangeRate)}</span>
                              </div>
                              {inv.discount > 0 && (
                                <div className="flex justify-between text-rose-700">
                                  <span>الخصم:</span>
                                  <span className="font-sans">-{formatCurrency(inv.discount, currency, exchangeRate)}</span>
                                </div>
                              )}
                              {inv.tax > 0 && (
                                <div className="flex justify-between text-indigo-600">
                                  <span>الضريبة:</span>
                                  <span className="font-sans">+{formatCurrency(inv.tax, currency, exchangeRate)}</span>
                                </div>
                              )}
                              <div className="flex justify-between bg-[#EEF2F8] rounded-lg px-2.5 py-1.5 font-extrabold text-[#0B1F4D]">
                                <span>المبلغ النهائي:</span>
                                <span className="font-sans">{formatCurrency(inv.finalAmount, currency, exchangeRate)}</span>
                              </div>
                              <div className="flex justify-between text-emerald-700 font-bold px-0.5">
                                <span>المدفوع:</span>
                                <span className="font-sans">{formatCurrency(paid, currency, exchangeRate)}</span>
                              </div>
                              {remaining > 0 && (
                                <div className="flex justify-between bg-rose-50 rounded-lg px-2.5 py-1.5 font-extrabold text-rose-700">
                                  <span>المتبقي (دين):</span>
                                  <span className="font-sans">{formatCurrency(remaining, currency, exchangeRate)}</span>
                                </div>
                              )}
                            </div>
                          </div>

                          <PrintOnly>
                          <div className="flex justify-end mt-3">
                            <button
                              onClick={(e) => { e.stopPropagation(); printOne(inv); }}
                              className="px-3.5 py-2 bg-[#0B1F4D] hover:bg-[#1B3A7A] text-white rounded-lg text-[11px] font-bold flex items-center gap-1.5 transition cursor-pointer"
                            >
                              <Printer className="w-3.5 h-3.5" />
                              <span>طباعة هذه الفاتورة</span>
                            </button>
                          </div>
                          </PrintOnly>
                        </div>
                      )}
                    </div>
                  );
                })}

                {visibleCount < custInvoices.length && (
                  <div className="p-3 text-center">
                    <button
                      onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
                      className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition cursor-pointer"
                    >
                      عرض المزيد ({toArabicDigits(custInvoices.length - visibleCount)} متبقٍّ)
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-10 text-center text-slate-500 font-bold text-xs select-none">
                لا توجد فواتير مرتبطة بهذا الزبون بعد 📄
              </div>
            )}
          </div>

          {/* Payments history */}
          {custPayments.length > 0 && (
            <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm">
              <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                <h4 className="font-extrabold text-xs md:text-sm text-[#0B1F4D] font-cairo flex items-center gap-1.5">
                  <CreditCard className="w-4.5 h-4.5 text-emerald-700" />
                  <span>سجل التسديدات</span>
                </h4>
                <span className="text-[10px] bg-emerald-50 text-emerald-700 font-extrabold px-2.5 py-1 rounded-full border border-emerald-200">
                  {toArabicDigits(custPayments.length)}
                </span>
              </div>
              <div className="divide-y divide-slate-100">
                {custPayments.slice(0, visiblePayments).map(p => (
                  <div key={p.id} className="p-3.5 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-100 flex items-center justify-center flex-shrink-0">
                        <TrendingUp className="w-4 h-4 text-emerald-700" />
                      </div>
                      <div className="min-w-0">
                        <span className="text-xs font-bold text-[#0B1F4D] block">{formatDate(p.date)}</span>
                        {p.notes && <span title={p.notes} className="text-[10px] text-slate-600 block truncate max-w-[220px]">{p.notes}</span>}
                      </div>
                    </div>
                    <span className="text-emerald-700 font-black text-xs font-sans flex-shrink-0">
                      +{formatCurrency(p.amount, currency, exchangeRate)}
                    </span>
                  </div>
                ))}
                {visiblePayments < custPayments.length && (
                  <div className="p-3 text-center">
                    <button
                      onClick={() => setVisiblePayments(c => c + PAGE_SIZE)}
                      className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition cursor-pointer"
                    >
                      عرض المزيد ({toArabicDigits(custPayments.length - visiblePayments)} متبقٍّ)
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
