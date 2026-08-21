import React, { useState, useMemo } from 'react';
import {
  Truck, Search, Plus, Trash2, Edit, X, AlertCircle,
  MessageSquare, Download, FileText, Phone, MapPin, StickyNote, Banknote, ShoppingCart, Check
} from 'lucide-react';
import { Supplier, PurchaseInvoice } from '../types';
import { toArabicDigits, formatArabicNoun, formatCurrency } from '../utils/arabicFormatters';
import { exportAsWord, exportAsPdf, ExportSpec } from '../utils/exportDoc';
import { toWhatsappNumber } from '../utils/whatsapp';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { useCollection } from '../hooks/useCollection';
import { useConfirm } from '../hooks/useConfirm';
import { useActor } from '../hooks/useActor';
import { logAudit } from '../utils/auditLog';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useSession } from '../context/SessionContext';
import {
  balanceLabel, balanceStatus, balanceDirection,
  supplierWhatsappText, findDuplicateSupplier,
} from '../utils/supplierBalance';
import { SupplierPayment } from '../types';
import { reportFirestoreError } from '../utils/writeGuard';
import { onExternalLink } from '../utils/openExternal';

const SUPPLIER_ARABIC_NOUNS = {
  one: 'مورد واحد',
  two: 'موردان اثنان',
  plural: 'موردين',
  singular: 'مورّداً',
};

interface SuppliersViewProps {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  /** callback لفتح شاشة فواتير الشراء لهذا المورد (يُستخدم من قائمة الموردين) */
  onCreatePurchaseFor?: (supplierId: string) => void;
}

export default function SuppliersView({ currency, exchangeRate, onCreatePurchaseFor }: SuppliersViewProps) {
  // ---- 1. FIRESTORE DATA LAYER ----
  const { items: suppliers, save: saveSupplier, remove: removeSupplier, loading } = useCollection<Supplier>('suppliers');
  const { items: purchaseInvoices } = useCollection<PurchaseInvoice>('purchase_invoices');
  // للكشف الفردي: حركة المورد = فواتيره + تسديداته
  const { items: supplierPayments } = useCollection<SupplierPayment>('supplier_payments');
  const { requestConfirm, confirmDialog } = useConfirm();
  const actor = useActor();
  const { ownerUid } = useSession();

  // ---- 2. UI STATE ----
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editSupplierId, setEditSupplierId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formNotes, setFormNotes] = useState('');

  // Notifications
  const [alertMsg, setAlertMsg] = useState<{ text: string; type: 'success' | 'danger' } | null>(null);
  const [whatsappResult, setWhatsappResult] = useState<string | null>(null);
  const [whatsappUrl, setWhatsappUrl] = useState<string | null>(null);

  const triggerAlert = (text: string, type: 'success' | 'danger' = 'success') => {
    setAlertMsg({ text, type });
    setTimeout(() => setAlertMsg(null), 5000);
  };

  // إحصائيات سريعة للمورد (عدد الفواتير + قيمة المشتريات)
  const statsFor = (supplierId: string) => {
    const list = purchaseInvoices.filter(p => p.supplierId === supplierId && p.status === 'received');
    const totalPurchases = list.reduce((s, p) => s + p.total, 0);
    return { invoiceCount: list.length, totalPurchases };
  };

  // ---- 3. SEARCH / FILTER ----
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.phone.toLowerCase().includes(q) ||
      s.address.toLowerCase().includes(q)
    );
  }, [suppliers, search]);

  // إجمالي المديونية للموردين
  const totalDebt = useMemo(
    () => suppliers.reduce((s, x) => s + (x.balance > 0 ? x.balance : 0), 0),
    [suppliers]
  );

  // ---- 4. EXPORT (Word/PDF) — قراءة فقط ----
  const handleExportSuppliers = (format: 'word' | 'pdf') => {
    if (suppliers.length === 0) { triggerAlert('لا يوجد موردين للتصدير', 'danger'); return; }
    const money = (n: number) => formatCurrency(Math.abs(n), currency, exchangeRate);
    const sorted = [...suppliers].sort((a, b) => b.balance - a.balance);
    const spec: ExportSpec = {
      title: 'رتب شغلك',
      subtitle: `سجل الموردين والذمم — ${toArabicDigits(suppliers.length)} مورّد`,
      columns: [
        { header: '#', align: 'center' },
        { header: 'الاسم' },
        { header: 'الهاتف', align: 'center' },
        { header: 'العنوان' },
        { header: 'إجمالي المشتريات', align: 'center' },
        { header: 'الرصيد', align: 'center' },
        { header: 'لصالح مَن', align: 'center' },
        { header: 'ملاحظات' },
      ],
      rows: sorted.map((s, i) => {
        const st = statsFor(s.id);
        return [
          toArabicDigits(i + 1),
          s.name,
          s.phone ? toWhatsappNumber(s.phone) || toArabicDigits(s.phone) : '—',
          s.address || '—',
          money(st.totalPurchases),
          money(s.balance),
          balanceStatus(s.balance),   // «دين علينا للمورد» / «رصيد لنا عند المورد» — بلا لبس
          s.notes || '—',
        ];
      }),
      note: `إجمالي ما عليك للموردين: ${formatCurrency(totalDebt, currency, exchangeRate)}`,
    };
    const filename = `موردين_${(new Date().toLocaleDateString('ar-IQ')).replace(/\//g, '-')}`;
    if (format === 'word') { exportAsWord(spec, filename); triggerAlert('تم تصدير ملف Word للموردين 📄'); }
    else exportAsPdf(spec, (m) => triggerAlert(m, 'danger'));
  };

  /**
   * 🟠 كشف حساب **مورد بعينه** — وعدَ به عنوان الشاشة («صدّر كشف حساب لأي مورد بضغطة
   * واحدة») ولم يكن موجوداً: الزرّان كانا يُصدّران قائمة كل الموردين. وهذا ما يحتاجه
   * التاجر فعلاً يوم يجلس مع مورّده للتسوية — حركةٌ مرتّبة زمنياً ورصيدٌ متراكم بعد كل سطر.
   */
  const handleExportStatement = (sup: Supplier, format: 'word' | 'pdf') => {
    const money = (n: number) => formatCurrency(n, currency, exchangeRate);
    const invoices = purchaseInvoices
      .filter(p => p.supplierId === sup.id && p.status === 'received')
      .map(p => ({
        date: p.date, kind: 'شراء' as const,
        ref: p.invoiceNumber,
        onUs: p.total - (p.paidAmount ?? 0),   // الآجل وحده يُنشئ ذمّة
        paid: 0,
        note: `إجمالي الفاتورة ${money(p.total)}`,
      }));
    const pays = supplierPayments
      .filter(p => p.supplierId === sup.id)
      .map(p => ({
        date: p.date, kind: 'تسديد' as const,
        ref: '—', onUs: 0, paid: p.amount, note: p.notes || '—',
      }));

    const moves = [...invoices, ...pays].sort((a, b) => a.date.localeCompare(b.date));
    if (moves.length === 0) {
      triggerAlert(`لا توجد حركة مسجّلة للمورد [${sup.name}] بعد`, 'danger');
      return;
    }

    let running = 0;
    const rows = moves.map((m, i) => {
      running += m.onUs - m.paid;   // الموجب = علينا له، كما في كل البرنامج
      return [
        toArabicDigits(i + 1),
        new Date(`${m.date}T00:00:00`).toLocaleDateString('ar-IQ'),
        m.kind,
        m.ref,
        m.onUs ? money(m.onUs) : '—',
        m.paid ? money(m.paid) : '—',
        money(Math.abs(running)) + (running === 0 ? '' : running > 0 ? ' (علينا)' : ' (لنا)'),
        m.note,
      ];
    });

    const spec: ExportSpec = {
      title: 'رتب شغلك',
      subtitle: `كشف حساب المورد: ${sup.name}${sup.phone ? ` — ${sup.phone}` : ''}`,
      columns: [
        { header: '#', align: 'center' },
        { header: 'التاريخ', align: 'center' },
        { header: 'الحركة', align: 'center' },
        { header: 'رقم الفاتورة', align: 'center' },
        { header: 'عليك (آجل)', align: 'center' },
        { header: 'سدّدت', align: 'center' },
        { header: 'الرصيد المتراكم', align: 'center' },
        { header: 'ملاحظات' },
      ],
      rows,
      /**
       * الرصيد المعتمد هو **رصيد الوثيقة** لا المتراكم المحسوب — فهو مصدر الحقيقة
       * (يُدار بـ`increment` من الشراء والتسديد).
       *
       * 🔴 وحين يفترقان لا نطبع رقمين متضاربين في ورقة واحدة والتاجر جالسٌ مع مورّده.
       * الافتراق وارد: فاتورة أُلغيت بعد تسديدها، أو حركة أُدخلت من خارج الشاشتين.
       * فنقولها صراحةً — ورقةٌ تعترف بالفارق أنفع من ورقةٍ تُخفيه.
       */
      note: Math.round(running) === Math.round(sup.balance)
        ? `الرصيد الحالي: ${money(Math.abs(sup.balance))} — ${balanceStatus(sup.balance)}`
        : `الرصيد الحالي المعتمد: ${money(Math.abs(sup.balance))} — ${balanceStatus(sup.balance)}`
          + ` ⚠️ ومجموع الحركة أعلاه ${money(Math.abs(running))}`
          + ` (فرق ${money(Math.abs(running - sup.balance))}) — راجِع الفواتير الملغاة أو الحركات غير المسجّلة قبل اعتماد الكشف.`,
    };
    const filename = `كشف_${sup.name.replace(/\s+/g, '_')}_${(new Date().toLocaleDateString('ar-IQ')).replace(/\//g, '-')}`;
    if (format === 'word') { exportAsWord(spec, filename); triggerAlert(`تم تصدير كشف حساب [${sup.name}] 📄`); }
    else exportAsPdf(spec, (m) => triggerAlert(m, 'danger'));
  };

  // ---- 5. WHATSAPP SHARE (إرسال فاتورة/إشعار دين) ----
  const handleWhatsappSupplier = (sup: Supplier) => {
    if (!sup.phone) {
      triggerAlert('لا يوجد رقم هاتف مسجّل لهذا المورد', 'danger');
      return;
    }
    const waNumber = toWhatsappNumber(sup.phone);
    if (!waNumber) {
      triggerAlert('رقم الهاتف غير صالح للإرسال عبر واتساب', 'danger');
      return;
    }
    /**
     * 🔴 كان الاتجاه مقلوباً في الطرفين: الموجب («المحل يدين للمورد») يُكتب
     * «متبقي عليك للمحل»، فيرسل التاجر إلى مورّده مطالبةً بما يدين به هو نفسه.
     * والنصّ يغادر البرنامج فلا يكتشفه إلا من المورد. الاتجاه الآن من مصدرٍ واحد
     * (`supplierBalance.ts`) مشتقٍّ من الكود الذي يكتب الرصيد لا من التسميات.
     */
    const text = supplierWhatsappText({
      supplierName: sup.name,
      balance: sup.balance,
      notes: sup.notes,
      dateText: new Date().toLocaleDateString('ar-IQ'),
      money: (n: number) => formatCurrency(n, currency, exchangeRate),
    });
    const encoded = encodeURIComponent(text);
    const waUrl = `https://wa.me/${waNumber}?text=${encoded}`;
    setWhatsappResult(`📱 تم توليد رابط مراسلة الواتساب:\n\n${text}\n\n🔗 [انقر للإرسال](${waUrl})`);
    setWhatsappUrl(waUrl);
  };

  // ---- 6. CRUD HANDLERS ----
  const handleOpenAdd = () => {
    setIsEditing(false);
    setEditSupplierId(null);
    setFormName('');
    setFormPhone('');
    setFormAddress('');
    setFormNotes('');
    setShowForm(true);
  };

  const handleOpenEdit = (sup: Supplier) => {
    setIsEditing(true);
    setEditSupplierId(sup.id);
    setFormName(sup.name);
    setFormPhone(sup.phone);
    setFormAddress(sup.address);
    setFormNotes(sup.notes);
    setShowForm(true);
  };

  const handleDeleteSupplier = async (id: string, name: string) => {
    // فحص المديونية قبل السماح بالحذف
    const sup = suppliers.find(s => s.id === id);
    /**
     * 🔴 المنع كان للموجب وحده — أي يحمي المورد ولا يحمي التاجر.
     * والسالب معناه **دفعنا له زيادة عن المستحق، فالمال لنا عنده**؛ وحذفه يُسقط
     * المطالبة بضغطة. المنع الآن يشمل الاتجاهين: أي ذمّة مفتوحة تُغلق قبل الحذف.
     */
    if (sup && balanceDirection(sup.balance) === 'shop_owes') {
      triggerAlert(
        `لا يمكن حذف المورد [${name}] وعليك له ${formatCurrency(sup.balance, currency, exchangeRate)}. سدّد الرصيد أو صفّره أولاً.`,
        'danger',
      );
      return;
    }
    if (sup && balanceDirection(sup.balance) === 'supplier_owes') {
      triggerAlert(
        `لا يمكن حذف المورد [${name}] ولك عنده ${formatCurrency(Math.abs(sup.balance), currency, exchangeRate)}`
        + ' (دفعتَ زيادة عن المستحق). احسم الرصيد بمشتريات قادمة أو صفّره أولاً — حذفه الآن يُسقط حقّك.',
        'danger',
      );
      return;
    }
    // فحص فواتير شراء مرتبطة (تاريخية) — لا نمنع الحذف لكن نُنبّه.
    // 🟡 كانت قراءةً شبكية بمسار `actor.uid` بينما الفواتير محمَّلة أصلاً في هذا المكوّن:
    // رحلة زائدة عند كل حذف، ومسارٌ يقرأ شجرةً فارغة لو فُتحت الشاشة لموظف يوماً.
    const linkedCount = purchaseInvoices.filter(p => p.supplierId === id).length;
    let warning = '';
    if (linkedCount > 0) {
      warning = `\n\nملاحظة: يوجد ${toArabicDigits(linkedCount)} فاتورة شراء مرتبطة — ستبقى في السجل لكن بدون اسم المورد المعرّف.`;
    }
    if (!(await requestConfirm(`هل أنت متأكد من حذف المورد (${name})؟${warning}`))) return;

    // احتفظ بنسخة للسجل قبل الحذف
    if (sup) {
      logAudit({
        action: 'delete',
        entity: 'supplier',
        entityId: sup.id,
        summary: `حذف مورد: ${sup.name}`,
        before: sup as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid,
        actorName: actor.name,
      });
    }
    removeSupplier(id);
    triggerAlert(`تم حذف المورد [${name}]`, 'danger');
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      triggerAlert('يرجى كتابة اسم المورد لإكمال العملية', 'danger');
      return;
    }
    // الهاتف إلزامي عند الإنشاء، ولا يجوز **مسحه** من مورد كان يملكه (يُفقد الواتساب
    // ويُضعف كشف المكرَّر). أمّا مورد قديم بلا رقم فيبقى كما هو — لا نكسر بيانات قائمة.
    const hadPhone = isEditing
      ? !!suppliers.find(s => s.id === editSupplierId)?.phone?.trim()
      : false;
    if ((!isEditing || hadPhone) && !formPhone.trim()) {
      triggerAlert(
        isEditing ? 'لا تمسح رقم هاتف مورد مسجَّل — هو معرّفه للتواصل ولكشف التكرار' : 'يرجى كتابة رقم هاتف المورد للتواصل',
        'danger',
      );
      return;
    }

    // 🟠 مورد مكرَّر: نفس الهاتف (أو نفس الاسم بلا هاتف) ⇒ ديونه تنقسم على سجلّين
    // فلا يرى التاجر انكشافه الحقيقي على هذا المورد. نُحذّر ونترك القرار له.
    const dup = findDuplicateSupplier(
      suppliers, { name: formName.trim(), phone: formPhone.trim() },
      isEditing ? editSupplierId ?? undefined : undefined,
    );
    if (dup) {
      const proceed = await requestConfirm(
        `يوجد مورد مسجّل بنفس ${formPhone.trim() ? 'رقم الهاتف' : 'الاسم'}: «${dup.name}»`
        + `${dup.balance !== 0 ? ` (${balanceStatus(dup.balance)}: ${formatCurrency(Math.abs(dup.balance), currency, exchangeRate)})` : ''}.\n\n`
        + 'تسجيله مرّتين يقسم ديونه على سجلّين فلا تعرف كم تدين له مجموعاً.\n\n'
        + 'أتريد المتابعة رغم ذلك؟',
      );
      if (!proceed) return;
    }

    if (isEditing && editSupplierId) {
      const before = suppliers.find(s => s.id === editSupplierId);
      /**
       * 🔴 كان الحفظ `setDoc` — **استبدالاً كاملاً للوثيقة** — يكتب معه
       * `balance: before?.balance ?? 0` من لقطةٍ محلية. فتعديل رقم هاتفٍ يمحو فاتورةً
       * آجلة سُجّلت من جهاز آخر بين فتح النموذج والحفظ، و`?? 0` يُصفّر الرصيد كلّه لو
       * لم تُحمَّل الوثيقة بعد. والنموذج لا يعرض الرصيد ولا يحرّره — فلا وجه لكتابته.
       * نكتب الحقول المحرَّرة وحدها، فيبقى الرصيد بيد `increment` وحده.
       */
      const fields = {
        name: formName.trim(),
        phone: formPhone.trim(),
        address: formAddress.trim(),
        notes: formNotes.trim(),
      };
      const updated: Supplier = { ...(before as Supplier), ...fields, id: editSupplierId };
      if (ownerUid) {
        updateDoc(doc(db, 'users', ownerUid, 'suppliers', editSupplierId), fields)
          .catch(err => reportFirestoreError('suppliers', 'update', err, '[Suppliers] update'));
      }
      logAudit({
        action: 'update',
        entity: 'supplier',
        entityId: updated.id,
        summary: `تعديل مورد: ${updated.name}`,
        before: before as unknown as Record<string, unknown>,
        after: updated as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid,
        actorName: actor.name,
      });
      triggerAlert(`تم تحديث بيانات المورد [${updated.name}] بنجاح`);
    } else {
      const newSup: Supplier = {
        id: genId(),
        name: formName.trim(),
        phone: formPhone.trim(),
        address: formAddress.trim(),
        notes: formNotes.trim(),
        balance: 0,
        createdAt: new Date().toISOString(),
      };
      saveSupplier(newSup);
      logAudit({
        action: 'create',
        entity: 'supplier',
        entityId: newSup.id,
        summary: `إضافة مورد جديد: ${newSup.name}`,
        after: newSup as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid,
        actorName: actor.name,
      });
      triggerAlert(`تم تسجيل المورد [${newSup.name}] بنجاح`);
    }
    setShowForm(false);
  };

  // ---- 7. RENDER ----
  return (
    <div className="space-y-5" dir="rtl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-[#0B1F4D] text-white p-6 rounded-2xl shadow-md border-b-4 border-amber-400">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-1 px-2.5 bg-amber-500 text-slate-950 font-black rounded-lg text-[10px] uppercase tracking-wider font-sans">
              وحدة إدارة الموردين v١٫٠
            </span>
            <span className="text-xs text-amber-300 font-bold">سجل الموردين والمشتريات 🚚</span>
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2">
            <Truck className="w-6.5 h-6.5 text-amber-400" />
            <span>إدارة الموردين وحساباتهم</span>
          </h2>
          <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed font-medium">
            تابع مصادر شرائك، راقب ديونك للموردين، وصدّر كشف حساب لأي مورد بضغطة واحدة
          </p>
        </div>
        <div className="flex gap-2 self-start md:self-center">
          <button
            onClick={() => handleExportSuppliers('word')}
            className="px-3 py-2 bg-slate-900/60 hover:bg-slate-800 text-white text-xs font-bold rounded-xl border border-slate-700 flex items-center gap-1.5 cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5" /> Word
          </button>
          <button
            onClick={() => handleExportSuppliers('pdf')}
            className="px-3 py-2 bg-slate-900/60 hover:bg-slate-800 text-white text-xs font-bold rounded-xl border border-slate-700 flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> PDF
          </button>
          <button
            onClick={handleOpenAdd}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-extrabold rounded-xl flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" /> مورد جديد
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[#5B6B86]">عدد الموردين</span>
            <span className="p-2 bg-amber-50 rounded-lg text-amber-600"><Truck className="w-4 h-4" /></span>
          </div>
          <h4 className="text-xl font-black mt-2 text-slate-900 font-cairo">
            {toArabicDigits(suppliers.length)} <span className="text-[10px] text-slate-400 font-bold">{formatArabicNoun(suppliers.length, SUPPLIER_ARABIC_NOUNS)}</span>
          </h4>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[#5B6B86]">إجمالي ما عليك لهم</span>
            <span className="p-2 bg-rose-50 rounded-lg text-rose-600"><Banknote className="w-4 h-4" /></span>
          </div>
          <h4 className="text-lg font-black mt-2 text-rose-600 font-cairo">
            {formatCurrency(totalDebt, currency, exchangeRate)}
          </h4>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm">
          <div className="flex items-center justify-between">
            {/* كانت «موردين مديونين» وهي تعدّ من **نحن** مدينون لهم — الاسم يقول العكس */}
            <span className="text-[11px] font-bold text-[#5B6B86]">موردون لهم ذمّة علينا</span>
            <span className="p-2 bg-amber-50 rounded-lg text-amber-600"><AlertCircle className="w-4 h-4" /></span>
          </div>
          <h4 className="text-xl font-black mt-2 text-slate-900 font-cairo">
            {toArabicDigits(suppliers.filter(s => s.balance > 0).length)}
          </h4>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[#5B6B86]">إجمالي المشتريات</span>
            <span className="p-2 bg-emerald-50 rounded-lg text-emerald-600"><ShoppingCart className="w-4 h-4" /></span>
          </div>
          <h4 className="text-lg font-black mt-2 text-emerald-700 font-cairo">
            {formatCurrency(
              purchaseInvoices.filter(p => p.status === 'received').reduce((s, p) => s + p.total, 0),
              currency, exchangeRate,
            )}
          </h4>
        </div>
      </div>

      {/* Search */}
      <div className="bg-white rounded-2xl p-3 border border-[#E4EAF3] shadow-sm flex items-center gap-2">
        <Search className="w-4 h-4 text-slate-400 mr-1" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ابحث بالاسم أو الهاتف أو العنوان…"
          className="flex-1 bg-transparent border-0 outline-none text-sm font-bold text-[#0B1F4D] placeholder:text-slate-400"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="text-slate-400 hover:text-slate-600 p-1 rounded cursor-pointer"
            title="مسح البحث"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* List */}
      <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-slate-400 text-sm">جاري التحميل…</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-slate-400 text-sm">
            {search ? 'لا نتائج تطابق البحث' : 'لا يوجد موردين بعد. اضغط "مورد جديد" للبدء.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-[#0B1F4D] text-xs font-extrabold border-b border-slate-200">
                  <th className="p-3.5 text-right">#</th>
                  <th className="p-3.5 text-right">الاسم</th>
                  <th className="p-3.5 text-right">الهاتف</th>
                  <th className="p-3.5 text-right">العنوان</th>
                  <th className="p-3.5 text-center">فواتير الشراء</th>
                  <th className="p-3.5 text-center">إجمالي المشتريات</th>
                  <th className="p-3.5 text-center">الرصيد</th>
                  <th className="p-3.5 rounded-l-xl text-left">التحكم</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s, idx) => {
                  const st = statsFor(s.id);
                  return (
                    <tr key={s.id} className="border-b border-slate-100 hover:bg-amber-50/30 transition">
                      <td className="p-3.5 text-slate-400 font-mono text-xs">{toArabicDigits(idx + 1)}</td>
                      <td className="p-3.5 font-extrabold text-[#0B1F4D]">{s.name}</td>
                      <td className="p-3.5 text-slate-600 font-mono text-xs" dir="ltr">
                        {s.phone ? toArabicDigits(s.phone) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="p-3.5 text-slate-500 text-xs">
                        {s.address || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="p-3.5 text-center">
                        <span className="inline-block bg-slate-100 text-slate-700 text-[10px] font-bold px-2 py-0.5 rounded">
                          {toArabicDigits(st.invoiceCount)}
                        </span>
                      </td>
                      <td className="p-3.5 text-center text-emerald-700 font-bold text-xs">
                        {formatCurrency(st.totalPurchases, currency, exchangeRate)}
                      </td>
                      <td className="p-3.5 text-center">
                        {/* الاتجاه مكتوب دائماً — «الرصيد» وحده كان يحتمل القراءتين */}
                        {s.balance !== 0 ? (
                          <span className={`font-black text-xs ${s.balance > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                            {formatCurrency(Math.abs(s.balance), currency, exchangeRate)}
                            <span className="block text-[9px] font-bold opacity-80">{balanceLabel(s.balance)}</span>
                          </span>
                        ) : (
                          <span className="text-slate-400 text-xs">متزن</span>
                        )}
                      </td>
                      <td className="p-3.5">
                        <div className="flex items-center gap-1 justify-end">
                          {onCreatePurchaseFor && (
                            <button
                              onClick={() => onCreatePurchaseFor(s.id)}
                              title="فاتورة شراء جديدة لهذا المورد"
                              className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg cursor-pointer"
                            >
                              <ShoppingCart className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => handleExportStatement(s, 'word')}
                            title="كشف حساب هذا المورد (Word) — حركته ورصيده المتراكم"
                            className="p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg cursor-pointer"
                          >
                            <FileText className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleWhatsappSupplier(s)}
                            title="إرسال إشعار واتساب"
                            className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg cursor-pointer"
                          >
                            <MessageSquare className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleOpenEdit(s)}
                            title="تعديل"
                            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg cursor-pointer"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteSupplier(s.id, s.name)}
                            title="حذف"
                            className="p-1.5 text-rose-600 hover:bg-rose-50 rounded-lg cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add/Edit form modal */}
      {showForm && (
        <div
          className="fixed inset-0 z-[9998] bg-slate-900/50 backdrop-blur-[2px] flex items-center justify-center p-4"
          onClick={() => setShowForm(false)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleFormSubmit}
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-extrabold text-[#0B1F4D] font-cairo flex items-center gap-2">
                <Truck className="w-5 h-5 text-amber-500" />
                {isEditing ? 'تعديل بيانات المورد' : 'تسجيل مورد جديد'}
              </h3>
              <button type="button" onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-700 cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5">اسم المورد *</label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="مثال: موزّع النور للمواد الغذائية"
                autoFocus
                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-[#0B1F4D] focus:outline-none focus:border-amber-400"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5 flex items-center gap-1">
                  <Phone className="w-3 h-3" /> رقم الهاتف {!isEditing && '*'}
                </label>
                <input
                  type="tel"
                  value={formPhone}
                  onChange={(e) => setFormPhone(e.target.value)}
                  placeholder="07XX XXX XXXX"
                  dir="ltr"
                  className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-[#0B1F4D] focus:outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5 flex items-center gap-1">
                  <MapPin className="w-3 h-3" /> العنوان
                </label>
                <input
                  type="text"
                  value={formAddress}
                  onChange={(e) => setFormAddress(e.target.value)}
                  placeholder="بغداد — الكرادة…"
                  className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-[#0B1F4D] focus:outline-none focus:border-amber-400"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5 flex items-center gap-1">
                <StickyNote className="w-3 h-3" /> ملاحظات
              </label>
              <textarea
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="تفاصيل التواصل، ساعات العمل، المواد المعتاد شراؤها…"
                rows={2}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-[#0B1F4D] focus:outline-none focus:border-amber-400 resize-none"
              />
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                className="flex-1 py-2.5 bg-[#0B1F4D] hover:bg-[#152e6d] active:scale-95 text-white font-extrabold text-xs rounded-xl transition cursor-pointer flex items-center justify-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                {isEditing ? 'حفظ التعديلات' : 'تسجيل المورد'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-xs rounded-xl transition cursor-pointer"
              >
                إلغاء
              </button>
            </div>
          </form>
        </div>
      )}

      {/* WhatsApp result dialog */}
      {whatsappResult && (
        <div
          className="fixed inset-0 z-[9998] bg-slate-900/50 backdrop-blur-[2px] flex items-center justify-center p-4"
          onClick={() => { setWhatsappResult(null); setWhatsappUrl(null); }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-extrabold text-[#0B1F4D] flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-emerald-600" /> رسالة واتساب جاهزة
            </h3>
            <pre className="text-xs bg-slate-50 p-3 rounded-lg whitespace-pre-wrap text-slate-700 max-h-60 overflow-y-auto" dir="rtl">
{whatsappResult}
            </pre>
            <div className="flex gap-2">
              {whatsappUrl && (
                <a
                  href={whatsappUrl}
                  target="_blank"
                  onClick={onExternalLink}
                  rel="noopener noreferrer"
                  className="flex-1 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white font-extrabold text-xs rounded-xl text-center cursor-pointer"
                >
                  فتح في واتساب
                </a>
              )}
              <button
                onClick={() => { setWhatsappResult(null); setWhatsappUrl(null); }}
                className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-xs rounded-xl cursor-pointer"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast alert */}
      {alertMsg && (
        <div
          className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-[9999] px-5 py-3 rounded-xl shadow-2xl text-sm font-bold ${
            alertMsg.type === 'danger' ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'
          }`}
        >
          {alertMsg.text}
        </div>
      )}

      {confirmDialog}
    </div>
  );
}
