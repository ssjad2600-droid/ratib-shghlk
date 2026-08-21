import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Users, Search, UserPlus, MapPin, MessageSquare,
  Check, Trash2, Edit, X, AlertCircle,
  Share2, ClipboardList, Clock, History, Download, FileText, Upload
} from 'lucide-react';
import { Customer } from '../types';
import { toArabicDigits, toLatinDigits, formatArabicNoun, formatCurrency, parseAmount } from '../utils/arabicFormatters';
import { exportAsWord, exportAsPdf, ExportSpec } from '../utils/exportDoc';
import { useActor } from '../hooks/useActor';
import { logAudit } from '../utils/auditLog';
import BulkImportModal from './BulkImportModal';
import { parseCustomerRows, CUSTOMER_HEADERS, CUSTOMER_SAMPLE_ROW, ParsedRow } from '../utils/bulkImport';
import { buildStatementText, buildStatementUrl } from '../utils/whatsapp';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { useCollection } from '../hooks/useCollection';
import { useConfirm } from '../hooks/useConfirm';
import CustomerHistoryModal from './CustomerHistoryModal';
import { writeBatch, doc, collection, query, where, getDocs, deleteField, updateDoc, increment } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { customerPublicRef, syncCustomerPublic } from '../utils/customersPublic';
import { decideBalanceWrite } from '../utils/customerBalance';
import { reportFirestoreError } from '../utils/writeGuard';
import { onExternalLink } from '../utils/openExternal';

// Specific noun forms for "Customer" to fit: (زبون واحد/زبونين/٣ زبائن/١٢ زبوناً)
const CUSTOMER_ARABIC_NOUNS = {
  one: "زبون واحد",
  two: "زبونين اثنين",
  plural: "زبائن",
  singular: "زبوناً"
};

interface CustomersViewProps {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  storeName?: string;
  // ترويسة المحل للورقة المطبوعة من السجل الكامل — كشف حساب يُقدَّم لزبون
  storeAddress?: string;
  storePhone?: string;
}

export default function CustomersView({ currency, exchangeRate, storeName, storeAddress, storePhone }: CustomersViewProps) {
  const actor = useActor(); // لسجل التدقيق — توثيق حذف الزبائن
  // ---- 1. FIRESTORE DATA LAYER ----
  const { items: customers, save: saveCustomer, remove: removeCustomer, loading: customersLoading } = useCollection<Customer>('customers');
  // مرآة الأسماء (خاصة بالموظف — لا تُعرض في أي شاشة مالك). تُحمَّل هنا للترحيل الأحادي فقط.
  const { items: customersPublic, loading: publicLoading } = useCollection<{ id: string; name: string }>('customers_public');

  // ---- ترحيل أحادي: عكس كل زبون بلا مرآة إلى customers_public (نمط repairRanRef) ----
  // مالك حصراً (CustomersView شاشة مالك). idempotent، fire-and-forget، مقسّم 450.
  const mirrorMigrationRan = useRef(false);
  useEffect(() => {
    if (mirrorMigrationRan.current) return;
    if (customersLoading || publicLoading) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const mirroredIds = new Set(customersPublic.map(c => c.id));
    const missing = customers.filter(c => !mirroredIds.has(c.id));
    mirrorMigrationRan.current = true;
    if (missing.length === 0) return;
    const CHUNK = 450;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const batch = writeBatch(db);
      for (const c of missing.slice(i, i + CHUNK)) {
        batch.set(customerPublicRef(uid, c.id), { name: c.name });
      }
      batch.commit().catch(err => reportFirestoreError('customers_public', 'batch', err, '[Firestore] customers_public migration'));
    }
  }, [customersLoading, publicLoading, customers, customersPublic]);

  // ---- 2. UI CONTROL & FORM STATES ----
  const [search, setSearch] = useState('');
  const [selectedCustId, setSelectedCustId] = useState<string | null>(null);
  const [historyCustId, setHistoryCustId] = useState<string | null>(null);

  // Create / Edit Form states
  const [showForm, setShowForm] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editCustomerId, setEditCustomerId] = useState<string | null>(null);

  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formBalance, setFormBalance] = useState('');
  const [formDueDate, setFormDueDate] = useState('');
  /**
   * 🔴 الرصيد لحظة فتح النموذج — أساس حساب الفرق.
   *
   * كان الحفظ يكتب الرصيد **قيمةً مطلقة** من هذه اللقطة. فمن يفتح ملف زبون ليصحّح عنوانه،
   * ويبيع الكاشير لنفس الزبون بالدين في تلك الدقائق، يمسح بحفظه ما أضافه البيع — دينٌ
   * يتبخّر بلا رسالة ولا أثر، والتاجر لم يلمس خانة الرصيد أصلاً.
   *
   * الآن: إن لم يتغيّر ما كُتب في الخانة، **لا يُمسّ الرصيد إطلاقاً**. وإن تغيّر، يُطبَّق
   * الفرق بـ`increment` فيتراكب بأمان مع تسديدات الديون وطيّ ديون الموظفين.
   */
  const [loadedBalance, setLoadedBalance] = useState(0);

  const { requestConfirm, confirmDialog } = useConfirm();

  // Notifications
  const [alertMsg, setAlertMsg] = useState<{ text: string; type: 'success' | 'danger' } | null>(null);
  const [whatsappResult, setWhatsappResult] = useState<string | null>(null);
  const [whatsappUrl, setWhatsappUrl] = useState<string | null>(null);

  const triggerAlert = (text: string, type: 'success' | 'danger' = 'success') => {
    setAlertMsg({ text, type });
    setTimeout(() => setAlertMsg(null), 5000);
  };

  // ---- الاستيراد الجماعي (CSV) ----
  const [showImport, setShowImport] = useState(false);
  const commitCustomerImport = async (parsed: ParsedRow<Customer>[]) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const CHUNK = 200; // زبون + مرآة الاسم = عمليتان لكل صف
    for (let i = 0; i < parsed.length; i += CHUNK) {
      const batch = writeBatch(db);
      for (const row of parsed.slice(i, i + CHUNK)) {
        if (!row.data) continue;
        batch.set(doc(db, 'users', uid, 'customers', row.data.id), row.data);
        batch.set(customerPublicRef(uid, row.data.id), { name: row.data.name }); // مرآة الموظف
      }
      /**
       * 🔴 بلا `await`: مع `persistentLocalCache` لا يُحَلّ وعد `commit()` إلا بإقرار
       * الخادم، فبلا إنترنت لا يُحَلّ أبداً — وكان التاجر يبقى على «جارٍ الاستيراد…» إلى
       * الأبد **مع أن الصفوف كُتبت محلياً فعلاً**، فيغلق ويعيد المحاولة.
       *
       * الكتابة تُطبَّق محلياً فوراً وتُزامَن تلقائياً عند عودة الاتصال — وهو نمط كل
       * كتابات البرنامج. ومعرّفات الصفوف صارت مشتقّة من المحتوى (stableId)، فلو أعاد
       * الاستيراد فالنتيجة تصحيح لا تكرار.
       */
      batch.commit().catch(err => reportFirestoreError('customers', 'batch', err, '[Firestore] customers bulk import'));
    }
    void logAudit({
      action: 'create', entity: 'customer', entityId: 'bulk_import',
      summary: `استيراد جماعي للزبائن — ${toArabicDigits(parsed.length)} سجلاً`,
      actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
    });
    triggerAlert(`تم استيراد ${toArabicDigits(parsed.length)} زبوناً بنجاح ✅`);
  };

  // تصدير سجل الزبائن وذممهم إلى Word/PDF (قراءة فقط — لا يمسّ البيانات)
  const handleExportCustomers = (format: 'word' | 'pdf') => {
    if (customers.length === 0) { triggerAlert('لا يوجد زبائن للتصدير', 'danger'); return; }
    const money = (n: number) => formatCurrency(Math.abs(n), currency, exchangeRate);
    const sorted = [...customers].sort((a, b) => b.balance - a.balance);
    const totalDebt = customers.reduce((s, c) => s + (c.balance > 0 ? c.balance : 0), 0);
    const spec: ExportSpec = {
      title: storeName || 'رتب شغلك',
      subtitle: `سجل الزبائن — ${toArabicDigits(customers.length)} زبون`,
      columns: [
        { header: '#', align: 'center' },
        { header: 'الاسم' },
        { header: 'الهاتف', align: 'center' },
        { header: 'العنوان' },
        { header: 'الرصيد', align: 'center' },
        { header: 'الحالة', align: 'center' },
        { header: 'تاريخ الاستحقاق', align: 'center' },
        { header: 'ملاحظات' },
      ],
      rows: sorted.map((c, i) => [
        toArabicDigits(i + 1),
        c.name,
        c.phone ? toArabicDigits(c.phone) : '—',
        c.address || '—',
        money(c.balance),
        c.balance > 0 ? 'عليه' : c.balance < 0 ? 'له' : 'مصفّى',
        c.dueDate ? toArabicDigits(c.dueDate) : '—',
        c.notes || '—',
      ]),
      note: `إجمالي الديون المستحقة على الزبائن: ${formatCurrency(totalDebt, currency, exchangeRate)}`,
    };
    const filename = `زبائن_${(storeName || 'المتجر').replace(/\s+/g, '_')}`;
    if (format === 'word') { exportAsWord(spec, filename); triggerAlert('تم تصدير ملف Word 📄'); }
    else exportAsPdf(spec, (m) => triggerAlert(m, 'danger'));
  };

  // ---- 3. CRUD HANDLERS ----
  const handleOpenAdd = () => {
    setIsEditing(false);
    setEditCustomerId(null);
    setFormName('');
    setFormPhone('');
    setFormAddress('');
    setFormNotes('');
    setFormBalance('0');
    setLoadedBalance(0);
    setFormDueDate(''); // (fix 14) لا تاريخ استحقاق ثابت مضلّل — اختياري يملؤه المالك
    setShowForm(true);
  };

  const handleOpenEdit = (cust: Customer) => {
    setIsEditing(true);
    setEditCustomerId(cust.id);
    setFormName(cust.name);
    setFormPhone(cust.phone);
    setFormAddress(cust.address);
    setFormNotes(cust.notes);
    setFormBalance(String(cust.balance));
    setLoadedBalance(cust.balance);
    setFormDueDate(cust.dueDate);
    setShowForm(true);
  };

  const handleDeleteCustomer = async (id: string, name: string) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    // فحص الدين قبل السماح بالحذف — من الرصيد ومن الفواتير المرتبطة معاً
    const invSnap = await getDocs(
      query(collection(db, 'users', uid, 'invoices'), where('customerId', '==', id))
    );
    const invoiceDebt = invSnap.docs.reduce(
      (s, d) => s + ((d.data().remainingAmount as number | undefined) ?? 0), 0
    );
    const balance = customers.find(c => c.id === id)?.balance ?? 0;
    const totalDebt = Math.max(balance, invoiceDebt);

    if (totalDebt > 0) {
      triggerAlert(
        `لا يمكن حذف الزبون [${name}] وعليه دين (${formatCurrency(totalDebt, currency, exchangeRate)}). سدّد الدين أو صفّره أولاً ثم احذف.`,
        'danger'
      );
      return;
    }

    // الرصيد السالب = أمانة **له** عندك. كان يمرّ بلا اعتراض لأن الفحص أعلاه يأخذ الأكبر،
    // فتُمحى من دفترك أمانةٌ يذكرها الزبون جيداً. لا نمنع الحذف، لكن لا ندع المبلغ يمرّ صامتاً.
    const confirmText = balance < 0
      ? `للزبون (${name}) أمانة عندك مقدارها ${formatCurrency(Math.abs(balance), currency, exchangeRate)}.\n`
        + `حذفه يمحو هذه الأمانة من سجلاتك نهائياً — وهو سيتذكّرها.\n\nهل تريد المتابعة؟`
      : `هل تريد حذف الزبون (${name}) نهائياً مع سجل تسديداته؟\nفواتيره تبقى محفوظة باسمه.`;

    if (await requestConfirm(confirmText)) {
      const batch = writeBatch(db);
      batch.delete(doc(db, 'users', uid, 'customers', id));
      batch.delete(customerPublicRef(uid, id)); // حذف المرآة معاً

      const paymentsSnap = await getDocs(
        query(collection(db, 'users', uid, 'debt_payments'), where('customerId', '==', id))
      );
      paymentsSnap.forEach(d => batch.delete(d.ref));

      // فك ربط الفواتير المسددة القديمة — تبقى سجلاً تاريخياً مجمَّعاً بالاسم
      invSnap.forEach(d => batch.update(d.ref, { customerId: deleteField() }));

      // Fire-and-forget: local cache applies instantly; awaiting server ack hangs offline
      batch.commit().catch(err => reportFirestoreError('customers', 'remove', err, '[Firestore] delete customer'));

      // سجل التدقيق — حذف زبون يمحو سجل دفعاته ويفكّ ربط فواتيره، فيُوثَّق بلقطة كاملة
      void logAudit({
        action: 'delete', entity: 'customer', entityId: id,
        summary: `حذف الزبون «${name}» (رصيده كان ${formatCurrency(balance, currency, exchangeRate)})`,
        before: customers.find(c => c.id === id) as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
      });

      if (selectedCustId === id) setSelectedCustId(null);
      triggerAlert(`تم حذف الزبون [${name}] وسجل تسديداته`, 'danger');
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // الاسم وحده إلزامي. الهاتف اختياري: الفاتورة تسمح بالبيع بالدين بلا هاتف وتُنشئ الزبون
    // بهاتف فارغ — فإلزامه هنا كان يقفل ملفات أنشأها البرنامج نفسه، فيخترع التاجر رقماً
    // وهمياً ويُفسد قاعدة الأرقام التي يعتمد عليها الواتساب.
    if (!formName.trim()) {
      triggerAlert('اكتب اسم الزبون لإكمال الحفظ', 'danger');
      return;
    }

    const cleanPhone = formPhone.trim() ? toArabicDigits(formPhone) : '';

    // 🔴 parseAmount لا Number: «٥٥٠٠٠» و«55,000» صيغتان يكتبهما التاجر يومياً،
    // وNumber يُرجع NaN فيهما، ثم `|| 0` كان يحوّل الدين كله إلى صفر بصمت.
    const typedBalance = parseAmount(formBalance);
    if (!Number.isFinite(typedBalance)) {
      triggerAlert('قيمة الرصيد غير مفهومة — اكتب رقماً فقط (بالعربي أو بالإنكليزي)', 'danger');
      return;
    }
    const balanceNum = Math.round(typedBalance);

    if (isEditing && editCustomerId) {
      const existing = customers.find(c => c.id === editCustomerId);
      if (existing) {
        const uidNow = auth.currentUser?.uid;
        const liveBalance = Math.round(existing.balance);
        const decision = decideBalanceWrite({
          loaded: loadedBalance, live: existing.balance, typed: balanceNum,
        });

        let balanceWrite: number | null = null; // الفرق الذي سيُطبَّق، أو null = لا نمسّ الرصيد
        if (decision.kind === 'apply') {
          balanceWrite = decision.delta;
        } else if (decision.kind === 'conflict') {
          // تغيّر الرصيد من مكان آخر أثناء التعديل (بيع بالدين، تسديد، طيّ دين موظف).
          // لا نكتب فوقه بصمت ولا نتجاهل ما كتبه التاجر — نعرض الحقيقة ونسأل.
          const ok = await requestConfirm(
            `تنبيه: تغيّر رصيد «${existing.name}» أثناء تعديلك.\n\n` +
            `عند فتح الملف: ${formatCurrency(decision.loaded, currency, exchangeRate)}\n` +
            `الآن: ${formatCurrency(decision.live, currency, exchangeRate)}\n` +
            `وأنت كتبت: ${formatCurrency(decision.typed, currency, exchangeRate)}\n\n` +
            `هل تثبّت ما كتبته وتلغي التغيير الذي حدث؟`
          );
          if (!ok) { setShowForm(false); setIsEditing(false); setEditCustomerId(null); return; }
          balanceWrite = decision.deltaIfForced;
        }

        // updateDoc بحقول صريحة — لا setDoc: الأخير يستبدل الوثيقة كاملةً فيكتب الرصيد
        // حتماً، وهو بالضبط ما كنا نتفاداه.
        if (uidNow) {
          await updateDoc(doc(db, 'users', uidNow, 'customers', editCustomerId), {
            name: formName,
            phone: cleanPhone,
            address: formAddress,
            notes: formNotes,
            dueDate: formDueDate || '',
            ...(balanceWrite !== null ? { balance: increment(balanceWrite) } : {}),
          });
        }

        // سجل التدقيق — تعديل دَين زبون يدوياً أخطر عملية بعد الحذف، وكان يمرّ بلا أثر
        if (balanceWrite !== null) {
          void logAudit({
            action: 'update', entity: 'customer', entityId: editCustomerId,
            summary: `تعديل يدوي لرصيد «${formName}»: من ${formatCurrency(liveBalance, currency, exchangeRate)}`
              + ` إلى ${formatCurrency(liveBalance + balanceWrite, currency, exchangeRate)}`,
            before: { balance: liveBalance },
            after: { balance: liveBalance + balanceWrite },
            actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
          });
        }

        // مزامنة اسم المرآة (idempotent — الاسم فقط)
        { const uid = auth.currentUser?.uid; if (uid) syncCustomerPublic(uid, editCustomerId, formName); }

        // تحديث customerName في الفواتير المرتبطة — فقط عند تغيّر الاسم فعلياً
        if (existing.name !== formName) {
          const uid = auth.currentUser?.uid;
          if (uid) {
            const invSnap = await getDocs(
              query(collection(db, 'users', uid, 'invoices'), where('customerId', '==', editCustomerId))
            );
            if (!invSnap.empty) {
              const invBatch = writeBatch(db);
              invSnap.forEach(d => invBatch.update(d.ref, { customerName: formName }));
              invBatch.commit().catch(err => reportFirestoreError('invoices', 'update', err, '[Firestore] rename in invoices'));
            }
          }
        }
      }
      triggerAlert(`تم حفظ تعديلات ملف الزبون [${formName}]`);
    } else {
      const newId = genId(); // (fix 10) لاحقة عشوائية تمنع تصادم معرّفَي زبون في نفس الملّي ثانية
      const newCust: Customer = {
        id: newId,
        name: formName,
        phone: cleanPhone,
        address: formAddress || 'بغداد، العراق',
        notes: formNotes || 'زبون جديد بالنظام',
        balance: balanceNum,
        dueDate: formDueDate || '', // (fix 14) بلا تاريخ ثابت
        createdAt: todayISO(),      // (fix 14) ISO محلي موحّد بدل ar-IQ
      };
      await saveCustomer(newCust);
      { const uid = auth.currentUser?.uid; if (uid) syncCustomerPublic(uid, newId, formName); }
      setSelectedCustId(newId);
      triggerAlert(`تمت إضافة الزبون [${formName}]`);
    }

    setShowForm(false);
    setIsEditing(false);
    setEditCustomerId(null);
  };

  // ---- 4. WHATSAPP GENERATOR ----
  const handleSendWhatsApp = (cust: Customer) => {
    // النصّ يُبنى في whatsapp.ts وحده — نفس النبرة التي تستعملها شاشتا الديون والأقساط،
    // فلا يستلم الزبون صياغتين مختلفتين حسب الشاشة التي ضغط منها التاجر.
    const text = buildStatementText({
      customerName: cust.name, balance: cust.balance,
      storeName, currency, exchangeRate, dueDate: cust.dueDate,
    });

    // (fix 4) الهاتف مخزّن بأرقام عربية؛ الكود القديم كان يجرّدها كلها ثم يستخدم رقماً ثابتاً
    // خاطئاً '07700000000'. نُطبّع الآن لصيغة wa.me الدولية، وإن كان الرقم غير صالح نُنبّه ولا نفتح
    // محادثة مع رقم عشوائي.
    const waUrl = buildStatementUrl(cust.phone, {
      customerName: cust.name, balance: cust.balance,
      storeName, currency, exchangeRate, dueDate: cust.dueDate,
    });
    if (!waUrl) {
      triggerAlert(`رقم هاتف الزبون [${cust.name}] غير صالح لإرسال رسالة واتساب — حدّث الرقم أولاً`, 'danger');
      return;
    }

    setWhatsappResult(`📱 تم توليد رابط مراسلة الواتساب للرقم: ${toArabicDigits(cust.phone)}\n\nرسالة الإشعار:\n----------------------------------------\n${text}\n----------------------------------------\n\n🔗 [انقر هنا لإرسال الرسالة الحقيقية للعميل مباشرة](${waUrl})`);
    setWhatsappUrl(waUrl);
  };

  /**
   * البحث — يشمل الملاحظات (كان الحقل يَعِد بها ولا يبحث فيها)، ويطبّع الأرقام.
   *
   * 🔴 الهاتف يُخزَّن بأرقام عربية («٠٧٧١…») والتاجر يكتبه على لوحة الأرقام فيخرج
   * لاتينياً («0771…»)، فلا تتطابق المقارنة النصّية ويظنّ أن الزبون غير مسجّل وهو أمامه.
   * التطبيع على الطرفين يجعل الكتابتين تجدان الشيء نفسه.
   */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    const qDigits = toLatinDigits(q);
    return customers.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.address.toLowerCase().includes(q) ||
      (c.notes ?? '').toLowerCase().includes(q) ||
      toLatinDigits(c.phone).includes(qDigits)
    );
  }, [customers, search]);

  // عرض تدريجي — نفس علّة شاشة المنتجات: رسم آلاف الصفوف يجمّد كل حرف بحث.
  // القياس أثبت أن الفلترة ذاتها لا تكلّف شيئاً؛ الكلفة كلها في عناصر DOM.
  const CUST_PAGE = 60;
  const [visibleCount, setVisibleCount] = useState(CUST_PAGE);
  useEffect(() => { setVisibleCount(CUST_PAGE); }, [search]);
  const visibleCustomers = filtered.slice(0, visibleCount);

  const activeCustomer = customers.find(c => c.id === selectedCustId);

  return (
    <div className="space-y-6">
      {confirmDialog}

      {/* Page Title */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-xl font-extrabold font-cairo text-[#0B1F4D] flex items-center gap-2">
            <Users className="w-6 h-6 text-indigo-700" />
            <span>الزبائن والديون 👥</span>
          </h2>
          <p className="text-xs text-[#5B6B86] mt-1 font-tajawal">
            تابع أرصدة الزبائن وديونهم، وأرسل لهم كشف الحساب عبر واتساب
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* تصدير الزبائن Word / PDF */}
          <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl px-1.5 py-1 shadow-sm">
            <span className="text-[10px] text-slate-400 font-bold px-1 select-none">تصدير:</span>
            <button onClick={() => handleExportCustomers('word')} title="تصدير Word"
              className="px-2 py-1 rounded-lg text-[11px] font-extrabold text-blue-700 hover:bg-blue-50 flex items-center gap-1 cursor-pointer transition">
              <FileText className="w-3.5 h-3.5" /> Word
            </button>
            <button onClick={() => handleExportCustomers('pdf')} title="تصدير PDF"
              className="px-2 py-1 rounded-lg text-[11px] font-extrabold text-rose-700 hover:bg-rose-50 flex items-center gap-1 cursor-pointer transition">
              <Download className="w-3.5 h-3.5" /> PDF
            </button>
          </div>

          <button
            onClick={() => setShowImport(true)}
            title="استيراد زبائن من ملف Excel/CSV"
            className="px-5 py-2.5 bg-white border-2 border-emerald-300 text-emerald-700 hover:bg-emerald-50 font-extrabold rounded-xl text-xs flex items-center gap-1.5 shadow-sm transition active:scale-95 cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            <span>استيراد جماعي</span>
          </button>

          <button
            onClick={handleOpenAdd}
            className="px-5 py-2.5 bg-[#0B1F4D] hover:bg-[#1B3A7A] text-white font-extrabold rounded-xl text-xs transition flex items-center gap-2 cursor-pointer shadow-sm"
          >
            <UserPlus className="w-4.5 h-4.5 text-emerald-450" />
            <span>إضافة زبون جديد</span>
          </button>
        </div>
      </div>

      {/* Alert Banner */}
      {alertMsg && (
        <div className={`p-4 rounded-xl border text-xs font-bold font-tajawal flex items-center gap-2.5 transition animate-fade-in ${
          alertMsg.type === 'success'
            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : 'bg-rose-50 border-rose-200 text-rose-800'
        }`}>
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span>{alertMsg.text}</span>
        </div>
      )}

      {/* Dynamic Whatsapp Simulation Popup Screen */}
      {whatsappResult && (
        <div className="p-5 bg-gradient-to-r from-emerald-50 to-teal-50 text-emerald-950 border-2 border-emerald-200 rounded-2xl text-xs md:text-sm font-medium leading-relaxed relative">
          <button
            onClick={() => { setWhatsappResult(null); setWhatsappUrl(null); }}
            className="absolute top-3 left-3 p-1 text-emerald-700 hover:bg-emerald-100 rounded-full cursor-pointer"
          >
            <X className="w-4.5 h-4.5" />
          </button>

          <h4 className="font-extrabold text-sm text-emerald-800 flex items-center gap-1.5 mb-2.5">
            <MessageSquare className="w-5 h-5 text-emerald-600" />
            <span>كشف الحساب — جاهز للإرسال 📱</span>
          </h4>

          <p className="font-bold text-xs text-slate-500 mb-3 select-all bg-white p-3 rounded-xl border border-emerald-100 whitespace-pre-wrap font-sans">
            {whatsappResult.split('\n\nرسالة الإشعار:\n----------------------------------------\n')[1]?.split('\n----------------------------------------')[0]}
          </p>

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <a
              href={whatsappUrl || '#'}
              target="_blank"
              onClick={onExternalLink}
              rel="noopener noreferrer"
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold rounded-xl transition inline-flex items-center justify-center gap-1.5 shadow-sm text-center"
            >
              <Share2 className="w-4 h-4" />
              <span>إرسال عبر واتساب</span>
            </a>
            <button
              onClick={() => {
                const textOnly = whatsappResult.split('\n\nرسالة الإشعار:\n----------------------------------------\n')[1]?.split('\n----------------------------------------')[0] || '';
                navigator.clipboard.writeText(textOnly);
                triggerAlert('تم نسخ نص كشف الحساب');
              }}
              className="px-4 py-2 bg-white hover:bg-slate-50 text-slate-800 border border-slate-200 text-xs font-bold rounded-xl transition inline-flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <span>نسخ النص</span>
            </button>
          </div>
        </div>
      )}

      {/* MODAL / DIALOG FORM FOR ADDING / EDITING CUSTOMERS */}
      {showForm && (
        <div className="bg-gradient-to-br from-white to-[#F8FAFC] p-6 rounded-2xl border-2 border-[#1B3A7A]/20 shadow-xl space-y-4 relative animate-fade-in">
          <button
            onClick={() => setShowForm(false)}
            className="absolute top-4 left-4 p-2 text-slate-450 hover:bg-slate-100 rounded-full cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>

          <h3 className="text-sm md:text-base font-extrabold text-[#0B1F4D] font-cairo flex items-center gap-2">
            <Users className="w-5 h-5 text-indigo-700" />
            <span>{isEditing ? `تعديل ملف الزبون: ${formName}` : 'إضافة زبون جديد'}</span>
          </h3>

          <form onSubmit={handleFormSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div>
              <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5">اسم الزبون</label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="مثال: علي عماد"
                className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-xs text-right font-bold focus:ring-1 focus:ring-blue-500 outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5">
                رقم الهاتف
                <span className="text-[9px] font-bold text-slate-400 mr-1">(اختياري)</span>
              </label>
              {/* inputMode="tel": لوحة أرقام على الهاتف، مع بقاء type="text"
                  ليقبل الأرقام العربية (والقالب نفسه مكتوبٌ بها). */}
              <input
                type="text"
                inputMode="tel"
                value={formPhone}
                onChange={(e) => setFormPhone(e.target.value)}
                placeholder="مثال: ٠٧٧١٢٣٤٥٦٧٨"
                className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-xs text-right font-bold font-mono focus:ring-1 focus:ring-blue-500 outline-none"
              />
              {!formPhone.trim() && (
                <p className="text-[10px] text-amber-700 mt-1 font-tajawal">
                  بلا رقم لن تستطيع إرسال كشف الحساب عبر واتساب
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5">
                {isEditing ? 'الرصيد الحالي (د.ع)' : 'رصيد سابق عليه (د.ع)'}
              </label>
              {/* 🔴 نص لا رقم (type="text"): حقل `number` **يرفض الأرقام العربية** فيجعل
                  قيمته فارغة، والتاجر يرى ما كتبه ثم يجده اختفى. وهذا كان المسار الحقيقي
                  لمحو الدين: خانة فارغة ⇒ `Number('') || 0` ⇒ صفر. الآن يقبلها
                  `parseAmount`، و`inputMode` يُظهر لوحة الأرقام على الجوال. */}
              <input
                type="text"
                inputMode="decimal"
                value={formBalance}
                onChange={(e) => setFormBalance(e.target.value)}
                placeholder="مثال: ٥٥٠٠٠"
                className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-xs text-right font-bold focus:ring-1 focus:ring-blue-500 outline-none text-rose-750"
              />
              <p className="text-[10px] text-slate-400 mt-1 select-none text-left font-sans">
                * الموجب: مبلغ عليه لك. السالب: أمانة له عندك.
              </p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5">العنوان</label>
              <input
                type="text"
                value={formAddress}
                onChange={(e) => setFormAddress(e.target.value)}
                placeholder="مثال: بغداد — الكرادة"
                className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-xs text-right font-bold focus:ring-1 focus:ring-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5">موعد الاستحقاق</label>
              <input
                type="text"
                value={formDueDate}
                onChange={(e) => setFormDueDate(e.target.value)}
                placeholder="مثال: نهاية كل شهر"
                className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-xs text-right font-bold focus:ring-1 focus:ring-blue-500 outline-none"
              />
            </div>
            <div className="md:col-span-3">
              <label className="block text-xs font-extrabold text-[#0B1F4D] mb-1.5">ملاحظات</label>
              <textarea
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="كفلاء، ضمانات، أو أي ملاحظة تخصّ هذا الزبون..."
                rows={2}
                className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-xs text-right font-medium focus:ring-1 focus:ring-blue-500 outline-none"
              />
            </div>

            <div className="md:col-span-3 flex justify-end gap-3.5 pt-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-bold transition cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="submit"
                className="px-6 py-2.5 bg-indigo-700 hover:bg-indigo-800 text-white rounded-xl text-xs font-extrabold transition cursor-pointer shadow-md inline-flex items-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                <span>{isEditing ? 'حفظ التعديلات' : 'إضافة الزبون'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Main Grid: Left side Customer list & Right side complete details profile folder */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* LEFT COLUMN: CUSTOMERS CATALOG (7 Columns) */}
        <div className="lg:col-span-7 bg-white rounded-2xl p-5 border border-[#E4EAF3] shadow-sm space-y-4">

          <div className="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3">
            <h3 className="font-extrabold text-xs md:text-sm text-[#0B1F4D] font-cairo flex items-center gap-1.5">
              <ClipboardList className="w-4.5 h-4.5 text-blue-600" />
              <span>قائمة الزبائن</span>
            </h3>
            <span className="text-[10px] md:text-xs bg-slate-100 text-[#0B1F4D] font-extrabold px-3 py-1 rounded-full border border-slate-200 select-none">
              المعروض: {formatArabicNoun(filtered.length, CUSTOMER_ARABIC_NOUNS)}
            </span>
          </div>

          {/* Search container */}
          <div className="relative">
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
              <Search className="w-4 h-4" />
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث بالاسم، الهاتف، العنوان، أو الملاحظات..."
              className="w-full pr-10 pl-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-right font-medium focus:bg-white focus:ring-1 focus:ring-blue-100 outline-none"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-red-500 font-bold"
              >
                مسح
              </button>
            )}
          </div>

          {/* Table Container */}
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-[#EEF2F8] text-[#0B1F4D] font-cairo">
                <tr>
                  <th className="p-3.5 rounded-r-xl">الزبون</th>
                  <th className="p-3.5">العنوان</th>
                  <th className="p-3.5">الرصيد</th>
                  <th className="p-3.5 rounded-l-xl text-left">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.length > 0 ? (
                  visibleCustomers.map(cust => {
                    const isDuePlus = cust.balance > 0;
                    const isDueMinus = cust.balance < 0;
                    const isZero = cust.balance === 0;

                    return (
                      <tr
                        key={cust.id}
                        className={`hover:bg-slate-50/80 cursor-pointer transition ${
                          selectedCustId === cust.id ? 'bg-slate-50 border-r-4 border-indigo-700' : ''
                        }`}
                        onClick={() => setSelectedCustId(cust.id)}
                      >
                        <td className="p-3.5">
                          <span className="font-extrabold text-[#0B1F4D] block text-xs md:text-sm">{cust.name}</span>
                          <span className="text-[10px] text-slate-400 font-mono block mt-1">{cust.phone}</span>
                        </td>
                        <td className="p-3.5">
                          <span className="text-slate-600 font-medium text-xs block">{cust.address || '—'}</span>
                          {cust.notes && (
                            <span className="text-[10px] text-slate-400 block truncate max-w-40 mt-0.5">{cust.notes}</span>
                          )}
                        </td>
                        <td className="p-3.5 font-sans">
                          {isDuePlus && (
                            <span className="text-red-650 bg-red-50 px-2.5 py-1 rounded-full border border-red-100 font-extrabold text-[11px] block text-center min-w-[70px] max-w-[120px]">
                              {formatCurrency(cust.balance, currency, exchangeRate)} عليه
                            </span>
                          )}
                          {isDueMinus && (
                            <span className="text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-100 font-extrabold text-[11px] block text-center min-w-[70px] max-w-[120px]">
                              {formatCurrency(Math.abs(cust.balance), currency, exchangeRate)} له
                            </span>
                          )}
                          {isZero && (
                            <span className="text-slate-450 bg-slate-50 px-2.5 py-1 rounded-full border border-slate-200 font-extrabold text-[11px] block text-center min-w-[70px] max-w-[120px]">
                              حساب مصفّى
                            </span>
                          )}
                        </td>
                        <td className="p-3.5 text-left flex gap-1.5 justify-end" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => handleOpenEdit(cust)}
                            className="p-2 border border-slate-200 text-slate-500 hover:text-indigo-650 hover:bg-slate-50 rounded-xl transition duration-150"
                            title="تعديل"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteCustomer(cust.id, cust.name)}
                            className="p-2 border border-rose-100 text-rose-500 hover:text-red-700 hover:bg-rose-50 rounded-xl transition duration-150"
                            title="حذف"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={4} className="p-8 text-center text-slate-400 font-bold select-none text-xs">
                      لا يوجد زبون مطابق لبحثك.
                    </td>
                  </tr>
                )}
                {/* عرض المزيد — لا يظهر لمحل بمئة زبون */}
                {filtered.length > visibleCustomers.length && (
                  <tr>
                    <td colSpan={4} className="p-2">
                      <button
                        type="button"
                        onClick={() => setVisibleCount(c => c + CUST_PAGE)}
                        className="w-full py-2.5 rounded-xl border-2 border-dashed border-slate-200 text-slate-500 hover:border-[#0B1F4D] hover:text-[#0B1F4D] text-xs font-extrabold cursor-pointer transition"
                      >
                        عرض المزيد — ظاهر {toArabicDigits(visibleCustomers.length)} من {toArabicDigits(filtered.length)}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* RIGHT COLUMN: ACTIVE SELECTED CUSTOMER DOSSIER (5 Columns) */}
        <div className="lg:col-span-5 space-y-6">
          {activeCustomer ? (
            <div className="space-y-6" id="customer_active_profile">

              {/* Profile Card Header */}
              <div className="bg-[#0B1F4D] text-white rounded-2xl p-6 border border-[#0B1F4D] shadow-md relative overflow-hidden">
                <div className="absolute right-0 bottom-0 translate-y-6 translate-x-6 opacity-5 select-none pointer-events-none">
                  <Users className="w-40 h-40" />
                </div>

                <div className="flex justify-between items-start mb-4 relative z-10">
                  <div className="w-14 h-14 bg-white/10 backdrop-blur text-white rounded-2xl flex items-center justify-center text-lg font-black font-cairo shadow-inner">
                    {activeCustomer.name.trim().split(' ').map(n => n[0]).join('').slice(0, 2)}
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => handleOpenEdit(activeCustomer)}
                      className="p-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition text-xs font-bold flex items-center gap-1.5 border border-white/5 cursor-pointer"
                      title="تحرير"
                    >
                      <Edit className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">تعديل</span>
                    </button>
                    <button
                      onClick={() => handleSendWhatsApp(activeCustomer)}
                      className="p-2 bg-emerald-650 hover:bg-emerald-700 text-white rounded-lg transition text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-sm"
                      title="توليد كشف الحساب"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                      <span>كشف الحساب</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-1 relative z-10">
                  <h3 className="font-extrabold font-cairo text-base md:text-lg text-white block truncate leading-tight">
                    {activeCustomer.name}
                  </h3>
                  <p className="text-white/60 font-mono text-[11px] block">{activeCustomer.phone}</p>
                </div>

                <div className="mt-4 pt-3 border-t border-white/10 flex items-center gap-1.5 text-xs text-white/80 relative z-10 leading-relaxed font-tajawal">
                  <MapPin className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  <span className="font-medium truncate">{activeCustomer.address || 'العنوان غير مسجّل'}</span>
                </div>
              </div>

              {/* Full customer history launcher */}
              <button
                onClick={() => setHistoryCustId(activeCustomer.id)}
                className="w-full py-3 bg-gradient-to-l from-[#1B3A7A] to-indigo-700 hover:from-[#13295E] hover:to-indigo-800 text-white rounded-2xl text-xs font-extrabold flex items-center justify-center gap-2 transition cursor-pointer shadow-md active:scale-[0.99]"
              >
                <History className="w-4.5 h-4.5 text-emerald-300" />
                <span>السجل الكامل — الفواتير والتسديدات 📜</span>
              </button>

              {/* Dynamic overall debt metrics */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm flex flex-col justify-between">
                  <span className="text-[10px] text-slate-400 font-extrabold uppercase block select-none">الرصيد</span>
                  <div className="mt-2 text-right">
                    <span className={`text-sm md:text-base font-black font-sans block ${
                      activeCustomer.balance > 0 ? 'text-red-700' : activeCustomer.balance < 0 ? 'text-emerald-700' : 'text-slate-700'
                    }`}>
                      {activeCustomer.balance > 0
                        ? `${formatCurrency(activeCustomer.balance, currency, exchangeRate)} عليه`
                        : activeCustomer.balance < 0
                        ? `${formatCurrency(Math.abs(activeCustomer.balance), currency, exchangeRate)} له`
                        : 'الحساب مصفّى'
                      }
                    </span>
                    <span className="text-[9px] text-slate-400 block mt-1 font-tajawal">
                      {activeCustomer.balance > 0
                        ? 'مبلغ مستحق عليه 🔴'
                        : activeCustomer.balance < 0
                        ? 'أمانة له عندك 🟢'
                        : 'لا يوجد أي مبلغ مستحق ✨'
                      }
                    </span>
                  </div>
                </div>

                <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm flex flex-col justify-between">
                  <span className="text-[10px] text-slate-400 font-extrabold uppercase block select-none">موعد الاستحقاق</span>
                  <div className="mt-2 text-right">
                    <div className="flex items-center gap-1 text-slate-700 font-black text-xs md:text-sm">
                      <Clock className="w-4 h-4 text-indigo-700 flex-shrink-0" />
                      <span className="truncate">{toArabicDigits(activeCustomer.dueDate)}</span>
                    </div>
                    <span className="text-[9px] text-slate-400 block mt-1 font-tajawal">الموعد المتّفق عليه للسداد</span>
                  </div>
                </div>
              </div>

              {/* Cust Notes Card */}
              {activeCustomer.notes && (
                <div className="p-3.5 bg-amber-50/70 text-amber-900 border border-amber-150 rounded-2xl text-xs space-y-1 relative">
                  <span className="text-[10px] text-amber-700 font-extrabold block">ملاحظات:</span>
                  <p className="font-medium leading-relaxed">{activeCustomer.notes}</p>
                </div>
              )}

            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center p-8 text-center text-slate-400 bg-white rounded-2xl border border-slate-100 shadow-sm select-none min-h-60 justify-center">
              <Users className="w-14 h-14 mb-3 text-slate-300 animate-pulse" />
              <p className="text-xs font-black text-[#0B1F4D]">اختر زبوناً من القائمة</p>
              <p className="text-[11px] text-slate-400 mt-1 max-w-[280px]">
                اضغط على اسم الزبون لعرض ملفه وكشف حسابه
              </p>
            </div>
          )}
        </div>

      </div>

      {/* Full customer history modal */}
      {historyCustId && (() => {
        const histCust = customers.find(c => c.id === historyCustId);
        return histCust ? (
          <CustomerHistoryModal
            customer={histCust}
            currency={currency}
            exchangeRate={exchangeRate}
            store={{ name: storeName, address: storeAddress, phone: storePhone }}
            onPrintError={(m) => triggerAlert(m, 'danger')}
            onClose={() => setHistoryCustId(null)}
          />
        ) : null;
      })()}

      {/* استيراد جماعي للزبائن من CSV */}
      {showImport && (
        <BulkImportModal<Customer>
          title="استيراد الزبائن من Excel"
          templateHeaders={CUSTOMER_HEADERS}
          templateSample={CUSTOMER_SAMPLE_ROW}
          templateName="قالب_الزبائن"
          parseRows={(rowObjects) => parseCustomerRows(rowObjects, customers)}
          onCommit={commitCustomerImport}
          onClose={() => setShowImport(false)}
        />
      )}

    </div>
  );
}
