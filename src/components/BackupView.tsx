import React, { useState } from 'react';
import {
  ShieldCheck, RefreshCw, Download, CloudLightning, Check,
  Upload, Wifi, WifiOff, DatabaseBackup, Info,
  CheckCircle2, Clock, Smartphone, AlertOctagon, Sparkles, Search, FileText
} from 'lucide-react';
import { collection, getDocs, doc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { BACKUP_COLLECTIONS } from '../utils/backupCollections';
import {
  planRestore, chunkOps, restoreMessage, sourceWarning, RestoreOutcome,
} from '../utils/restoreBackup';
import { useCollection } from '../hooks/useCollection';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { SystemSettings, UserProfile, Customer, Invoice, Product } from '../types';
import { toArabicDigits, formatCurrency } from '../utils/arabicFormatters';
import { exportBackup, buildBackupPayload } from '../utils/exportBackup';
import { createCloudSnapshot, listCloudSnapshots, readCloudSnapshot, deleteCloudSnapshot, formatBytes, DEFAULT_KEEP, CloudSnapshotMeta } from '../utils/cloudBackup';
import { exportReportAsWord, exportReportAsPdf, ExportSection } from '../utils/exportDoc';
import { reportFirestoreError } from '../utils/writeGuard';
import { fileTooLargeMessage } from '../utils/csv';

interface BackupViewProps {
  user: UserProfile;
  settings: SystemSettings;
  updateSettings: (newSettings: Partial<SystemSettings>) => void;
}

// Maps backup JSON keys to Firestore collection names
// ملاحظة: employeeIndex مجموعة عليا خارج شجرة /users/{uid}/... (مسارها /employeeIndex/{empUid})
// فلا يمكن تضمينها بنمط fetchAll أدناه (مبني على users/{uid}/{collName}). عليه، استعادة كارثية
// كاملة (مشروع Firebase جديد بالكامل) تستعيد سجلات employees لكن بلا employeeIndex المطابق —
// يحتاج المالك عندها إعادة إضافة كل موظف يدوياً عبر واجهة "إدارة الموظفين" بعد الاستعادة
// (وهذا يعيد بناء employeeIndex تلقائياً). حسابات Firebase Auth للموظفين نفسها لا تُصدَّر ولا
// تُستعاد أصلاً بأي حال — هذا قيد معروف موثّق من المرحلة الخامسة.
const COLLECTION_MAP = BACKUP_COLLECTIONS;
// ملاحظة: app_audit_logs مفتاح الاستعادة موجود لتجنّب فقدان المفاتيح المعروفة أثناء الاستعادة
// (يحلّ فوق البيانات الموجودة دون إنشاء سجلات مكررة) — لكن السجلات الجديدة بعد الاستعادة
// تتولّد طبيعياً من الاستخدام اللاحق.

export default function BackupView({ user, settings, updateSettings }: BackupViewProps) {
  const { isOnline, syncState } = useNetworkStatus();
  const [isSyncing, setIsSyncing] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [restoredDataDetails, setRestoredDataDetails] = useState<any | null>(null);
  /** 🟠 مؤشّر تقدّم الاستعادة — كانت الشاشة ساكنة دقائق فتبدو معلّقة */
  const [restoreProgress, setRestoreProgress] = useState<{ done: number; total: number } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Debt consistency scan state
  const [debtScan, setDebtScan] = useState<{
    mismatches: { customer: Customer; sumRemaining: number }[];
    orphans: Invoice[];
  } | null>(null);
  // per-orphan action: 'zero' or a target customerId
  const [orphanActions, setOrphanActions] = useState<Record<string, string>>({});
  // per-mismatch opt-in: only checked customers get their balance rebuilt
  const [mismatchSelected, setMismatchSelected] = useState<Record<string, boolean>>({});

  // Live stats from Firestore
  const { items: customers } = useCollection<Customer>('customers');
  const { items: invoices } = useCollection<Invoice>('invoices');
  const { items: products } = useCollection<Product>('products');
  const { items: financialTransactions } = useCollection<{ id: string }>('financial_transactions');

  const stats = {
    customersCount: customers.length,
    invoicesCount: invoices.length,
    productsCount: products.length,
    expensesCount: financialTransactions.length,
  };

  const triggerSuccessMsg = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 6000);
  };

  const triggerErrorMsg = (msg: string) => {
    setErrorMsg(msg);
    setTimeout(() => setErrorMsg(null), 6000);
  };

  // 1. Export all Firestore data as a local JSON file (المصدر الموحّد exportBackup)
  // تصدير تقرير Word/PDF شامل (منتجات + زبائن) — قراءة فقط، للأرشفة المقروءة بجانب نسخة JSON
  const handleExportReport = (format: 'word' | 'pdf') => {
    const money = (n: number) => formatCurrency(n, settings.currency, settings.exchangeRate);
    const sections: ExportSection[] = [
      {
        heading: `المنتجات (${toArabicDigits(products.length)})`,
        columns: [
          { header: '#', align: 'center' }, { header: 'المنتج' },
          { header: 'الوحدة', align: 'center' }, { header: 'المخزون', align: 'center' }, { header: 'سعر البيع', align: 'center' },
        ],
        rows: [...products].sort((a, b) => a.name.localeCompare(b.name, 'ar'))
          .map((p, i) => [toArabicDigits(i + 1), p.name, p.unit || 'قطعة', toArabicDigits(p.quantity), money(p.sellPrice)]),
      },
      {
        heading: `الزبائن (${toArabicDigits(customers.length)})`,
        columns: [
          { header: '#', align: 'center' }, { header: 'الاسم' },
          { header: 'الهاتف', align: 'center' }, { header: 'الرصيد', align: 'center' },
        ],
        rows: [...customers].sort((a, b) => b.balance - a.balance)
          .map((c, i) => [toArabicDigits(i + 1), c.name, c.phone ? toArabicDigits(c.phone) : '—', money(c.balance)]),
        note: `إجمالي ديون الزبائن: ${money(customers.reduce((s, c) => s + (c.balance > 0 ? c.balance : 0), 0))}`,
      },
    ];
    const title = user.storeName || 'رتب شغلك';
    const filename = `تقرير_${(user.storeName || 'المتجر').replace(/\s+/g, '_')}`;
    if (format === 'word') { exportReportAsWord(title, 'تقرير شامل للبيانات (منتجات وزبائن)', sections, filename); triggerSuccessMsg('تم تصدير تقرير Word شامل 📄'); }
    else exportReportAsPdf(title, 'تقرير شامل للبيانات (منتجات وزبائن)', sections, (m) => triggerErrorMsg(m));
  };

  const handleExportLocalBackup = async () => {
    try {
      const payload = await exportBackup({
        uid: user.uid,
        storeName: user.storeName,
        ownerName: user.ownerName,
        businessType: user.businessType,
        settings,
      });

      const timestamp = new Date().toLocaleTimeString('ar-IQ', { hour: 'numeric', minute: '2-digit' });
      const currentFullDate = new Date().toLocaleDateString('ar-IQ') + ' ' + timestamp;

      updateSettings({ lastBackupDate: currentFullDate, lastBackupAt: Date.now() });

      /**
       * 🔴 العدد يُقال، والنقص المحتمل يُقال.
       *
       * كانت الرسالة «تم الاستخراج **بنجاح**» مجرّدةً بلا رقم ولا تحفّظ — والنسخة قد
       * تكون بُنيت من الذاكرة المحلية فتخرج ناقصةً باسم كامل، ولا يُكتشف ذلك إلا يوم
       * الاستعادة. الرقم وحده يكشف النقص فوراً: تاجرٌ يعرف أن عنده ألف فاتورة يرى «٤٠».
       */
      if (payload.fromCache) {
        triggerErrorMsg(
          `حُفظ الملف لكن **بلا اتصال بالخادم**: بُني من ذاكرة هذا الجهاز و قد يكون ناقصاً `
          + `(${toArabicDigits(payload.totalDocs)} وثيقة). راجع الأعداد، ويُفضّل إعادة التصدير بعد عودة الإنترنت.`,
        );
      } else {
        triggerSuccessMsg(
          `تم حفظ النسخة على جهازك ✅ — ${toArabicDigits(payload.totalDocs)} وثيقة من الخادم مباشرةً. `
          + 'اسم الملف يحتوي اسم محلك وتاريخ اليوم.',
        );
      }
    } catch (e) {
      triggerErrorMsg('حدث خطأ أثناء استخراج الملف الاحتياطي — لم يُحفظ أي ملف.');
    }
  };

  // 2. Force-export all Firestore data to cloud backup (triggers a JSON export as confirmation receipt)
  /**
   * ⚠️ هذا الزر كان **يكذب**: يسجّل طابعاً زمنياً ويقول «تمت المزامنة ✅» بلا أن ينسخ حرفاً.
   * صار الآن يحفظ لقطة حقيقية داخل حسابك، ويرمي عند الفشل بدل ادّعاء النجاح.
   */
  const handleCloudBackupNow = async () => {
    if (!isOnline) {
      triggerErrorMsg('لا يوجد اتصال بالإنترنت حالياً. بياناتك محفوظة محلياً وستُزامَن تلقائياً فور عودة الشبكة 📡');
      return;
    }

    setIsSyncing(true);
    try {
      const payload = await buildBackupPayload({
        uid: user.uid,
        storeName: user.storeName,
        ownerName: user.ownerName,
        businessType: user.businessType,
        settings,
      });
      const meta = await createCloudSnapshot({
        uid: user.uid,
        json: payload.json,
        counts: payload.counts,
        appVersion: 'dev',
        createdByName: user.ownerName || 'المالك',
      });
      const timestamp = new Date().toLocaleTimeString('ar-IQ', { hour: 'numeric', minute: '2-digit' });
      updateSettings({
        lastBackupDate: new Date().toLocaleDateString('ar-IQ') + ' ' + timestamp,
        lastBackupAt: Date.now(),
      });
      await loadSnapshots();
      const saved = meta.compressed
        ? `${formatBytes(meta.rawBytes)} ← ${formatBytes(meta.storedBytes)} بعد الضغط`
        : formatBytes(meta.storedBytes);
      triggerSuccessMsg(`حُفظت نسخة سحابية داخل حسابك ✅ (${saved}) — يُحتفظ بآخر ${toArabicDigits(DEFAULT_KEEP)} نسخ`);
    } catch {
      triggerErrorMsg('تعذّر حفظ النسخة السحابية — تأكّد من الاتصال وأعد المحاولة. (لم تُحفظ أي نسخة)');
    } finally {
      setIsSyncing(false);
    }
  };

  // ---- اللقطات السحابية ----
  const [snapshots, setSnapshots] = useState<CloudSnapshotMeta[]>([]);
  const [snapBusy, setSnapBusy] = useState<string | null>(null);

  const loadSnapshots = React.useCallback(async () => {
    try { setSnapshots(await listCloudSnapshots(user.uid)); }
    catch { /* قائمة فارغة أفضل من انهيار الشاشة */ }
  }, [user.uid]);

  React.useEffect(() => { void loadSnapshots(); }, [loadSnapshots]);

  /** يستعيد من لقطة سحابية عبر **نفس مسار** استعادة الملف — لا طريق ثانٍ ينحرف. */
  const handleRestoreFromCloud = async (id: string) => {
    setSnapBusy(id);
    try {
      const json = await readCloudSnapshot(user.uid, id);
      const parsed = JSON.parse(json);
      handleParseImportedObject(parsed);
      triggerSuccessMsg('حُمِّلت اللقطة — راجع التفاصيل بالأسفل ثم اضغط «تأكيد واستعادة»');
    } catch (e) {
      triggerErrorMsg(e instanceof Error ? e.message : 'تعذّر قراءة اللقطة السحابية');
    } finally { setSnapBusy(null); }
  };

  const handleDeleteSnapshot = async (id: string) => {
    setSnapBusy(id);
    try { await deleteCloudSnapshot(user.uid, id); await loadSnapshots(); triggerSuccessMsg('حُذفت اللقطة'); }
    catch { triggerErrorMsg('تعذّر حذف اللقطة'); }
    finally { setSnapBusy(null); }
  };

  // 3. Parse uploaded JSON file for preview before restore
  /**
   * فحص محتوى نسخة (من ملف أو من لقطة سحابية) وعرض معاينتها.
   * مسار واحد للاثنين — فلا تنحرف معاينة عن أخرى ولا يُستعاد ملف بمنطق مختلف.
   */
  const handleParseImportedObject = (parsed: any) => {
    if (!parsed?.meta || !parsed?.data) {
      triggerErrorMsg('المحتوى لا ينتمي لهيكلية البيانات الرسمية المعتمدة بتطبيق رتب شغلك ❌');
      return;
    }
    const len = (k: string) => JSON.parse(parsed.data[k] || '[]').length;
    setRestoredDataDetails({
      storeName: parsed.meta.storeName || 'محل غير معروف',
      ownerName: parsed.meta.ownerName || 'صاحب محل',
      businessType: parsed.meta.businessType || 'general',
      exportDate: parsed.meta.exportDate,
      // وسم مصدر البناء (server/cache) — يُقرأ من الملف نفسه ولو فُتح بعد شهور
      source: parsed.meta.source,
      rawData: parsed.data,
      summary: {
        custsLength: len('app_customers'),
        prodsLength: len('app_products'),
        invsLength: len('app_invoices'),
        expsLength: len('app_expenses'),
        debtPaysLength: len('app_debt_payments'),
      },
    });
  };

  const handleParseImportedFile = (file: File) => {
    if (!file) return;
    if (!file.name.endsWith('.json')) {
      triggerErrorMsg('يرجى سحب أو اختيار ملف نسَبة بصيغة JSON فقط عيني 📄');
      return;
    }
    // 🔴 حدّ الحجم قبل القراءة: readAsText يحمّل الملف كاملاً في الذاكرة، وملفٌ ضخم
    // يُعلّق التبويب بلا رسالة — فيبدو للتاجر أن «البرنامج مات» عند الاستعادة.
    const tooLarge = fileTooLargeMessage(file);
    if (tooLarge) { triggerErrorMsg(tooLarge); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        handleParseImportedObject(JSON.parse(reader.result as string));
        triggerSuccessMsg('تم فك تشفير وفحص ملف النسخة الاحتياطية بنجاح! راجع التفاصيل بالأسفل ثم اضغط زر "تأكيد واستعادة" لتحديث النظام.');
      } catch {
        triggerErrorMsg('فشل قراءة الملف كملف تفاعلي مرمز. تأكد أنه ملف صحيح غير تالف عيني 🛠️');
      }
    };
    reader.readAsText(file);
  };

  // 4. Restore all data to Firestore via chunked batch writes (no 500-record limit)
  const handleConfirmRestore = async () => {
    if (!restoredDataDetails) return;

    /**
     * 🔴 الاستعادة تحتاج اتصالاً حقيقياً — و`await batch.commit()` بلا اتصال **لا يعود
     * أبداً** مع الذاكرة المحلية. فكانت الشاشة تعلّق على «الاستعادة» إلى الأبد بلا رسالة
     * ولا مؤشّر. نمنع قبل أن نبدأ بدل أن نُعلّق.
     */
    if (!isOnline) {
      triggerErrorMsg('الاستعادة تحتاج اتصالاً بالإنترنت لتكتمل. لم يُكتب أي شيء — بياناتك كما هي.');
      return;
    }

    const plan = planRestore(restoredDataDetails.rawData);
    const chunks = chunkOps(plan.ops);
    const outcome: RestoreOutcome = {
      chunksDone: 0, chunksTotal: chunks.length,
      docsDone: 0, docsTotal: plan.ops.length,
      skippedTotal: plan.skippedTotal, skipped: plan.skipped,
      failed: false, settingsFailed: false,
    };

    setRestoreProgress({ done: 0, total: chunks.length });
    try {
      const uid = user.uid;
      for (const chunk of chunks) {
        const batch = writeBatch(db);
        for (const { collName, item } of chunk) {
          batch.set(doc(db, 'users', uid, collName, item.id), item);
        }
        await batch.commit();
        outcome.chunksDone += 1;
        outcome.docsDone += chunk.length;
        // 🟠 مؤشّر تقدّم: كانت الشاشة ساكنة دقائق فيظنّها التاجر معلّقة فيضغط ثانيةً
        setRestoreProgress({ done: outcome.chunksDone, total: chunks.length });
      }

      if (restoredDataDetails.rawData.app_settings) {
        try {
          const parsedSettings = JSON.parse(restoredDataDetails.rawData.app_settings);
          if (parsedSettings && typeof parsedSettings === 'object') updateSettings(parsedSettings);
          else outcome.settingsFailed = true;
        } catch { outcome.settingsFailed = true; }   // كان يُتجاهَل بصمت
      }
    } catch (e) {
      console.error('[Restore]', e);
      outcome.failed = true;
    } finally {
      setRestoreProgress(null);
    }

    setRestoredDataDetails(null);
    const msg = restoreMessage(outcome);
    if (msg.bad) triggerErrorMsg(msg.text); else triggerSuccessMsg(msg.text);
    // لا نُعيد التحميل بعد فشلٍ جزئي: التاجر يحتاج قراءة ما جرى قبل أن تختفي الرسالة
    if (!outcome.failed) setTimeout(() => window.location.reload(), 3500);
  };

  // 5. Debt consistency: scan (read-only) — compares customer.balance with Σ invoice.remainingAmount
  const handleScanDebtConsistency = () => {
    const custIds = new Set(customers.map(c => c.id));
    const sumByCust: Record<string, number> = {};
    const orphans: Invoice[] = [];

    for (const inv of invoices) {
      const rem = inv.remainingAmount ?? 0;
      if (inv.customerId && custIds.has(inv.customerId)) {
        sumByCust[inv.customerId] = (sumByCust[inv.customerId] ?? 0) + rem;
      } else if (rem > 0) {
        // فاتورة بدين بلا زبون موجود (يتيمة أو زبونها محذوف)
        orphans.push(inv);
      }
    }

    // فقط الزبائن الذين لهم فواتير مرتبطة — الديون اليدوية (بلا فواتير) مستثناة عمداً
    const mismatches = customers
      .filter(c => sumByCust[c.id] !== undefined && sumByCust[c.id] !== c.balance)
      .map(c => ({ customer: c, sumRemaining: sumByCust[c.id] }));

    setDebtScan({ mismatches, orphans });
    setOrphanActions(Object.fromEntries(orphans.map(o => [o.id, 'zero'])));
    // افتراضياً: الحالات التي رصيدها أعلى من الفواتير غير محددة (قد تكون ديناً مشروعاً من فاتورة محذوفة)
    setMismatchSelected(Object.fromEntries(
      mismatches.map(m => [m.customer.id, m.customer.balance < m.sumRemaining])
    ));

    if (mismatches.length === 0 && orphans.length === 0) {
      triggerSuccessMsg('فحص الاتساق اكتمل: كل الأرصدة متطابقة مع الفواتير، لا توجد فواتير يتيمة ✅');
    }
  };

  // 6. Debt consistency: apply fixes in one batch (fire-and-forget, offline-safe)
  const handleApplyDebtRepair = () => {
    if (!debtScan) return;
    const uid = user.uid;
    const batch = writeBatch(db);
    let zeroCount = 0, linkCount = 0;

    // المتبقي المضاف لكل زبون من الفواتير المربوطة حديثاً
    const extraByCust: Record<string, number> = {};
    for (const inv of debtScan.orphans) {
      const action = orphanActions[inv.id] || 'zero';
      if (action === 'zero') {
        batch.update(doc(db, 'users', uid, 'invoices', inv.id), {
          remainingAmount: 0,
          paidAmount: inv.finalAmount,
        });
        zeroCount++;
      } else {
        batch.update(doc(db, 'users', uid, 'invoices', inv.id), { customerId: action });
        extraByCust[action] = (extraByCust[action] ?? 0) + (inv.remainingAmount ?? 0);
        linkCount++;
      }
    }

    // إعادة بناء الأرصدة من الفواتير (المصدر التاريخي الموثوق)
    const custIds = new Set(customers.map(c => c.id));
    const sumByCust: Record<string, number> = {};
    for (const inv of invoices) {
      const rem = inv.remainingAmount ?? 0;
      if (inv.customerId && custIds.has(inv.customerId)) {
        sumByCust[inv.customerId] = (sumByCust[inv.customerId] ?? 0) + rem;
      }
    }
    // فقط الحالات المحددة بالـ checkbox + الزبائن المستقبِلون لفواتير مربوطة حديثاً
    const affected = new Set([
      ...debtScan.mismatches.filter(m => mismatchSelected[m.customer.id]).map(m => m.customer.id),
      ...Object.keys(extraByCust),
    ]);
    let balCount = 0;
    for (const cid of affected) {
      const target = (sumByCust[cid] ?? 0) + (extraByCust[cid] ?? 0);
      const cust = customers.find(c => c.id === cid);
      if (cust && cust.balance !== target) {
        batch.update(doc(db, 'users', uid, 'customers', cid), { balance: target });
        balCount++;
      }
    }

    batch.commit().catch(err => reportFirestoreError('customers', 'update', err, '[Firestore] debt repair'));
    setDebtScan(null);
    setOrphanActions({});
    setMismatchSelected({});
    triggerSuccessMsg(
      `تم الإصلاح بنجاح: تحديث ${toArabicDigits(balCount)} رصيد زبون، ربط ${toArabicDigits(linkCount)} فاتورة، تصفير دين ${toArabicDigits(zeroCount)} فاتورة ✅`
    );
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleParseImportedFile(e.dataTransfer.files[0]);
    }
  };


  const getThemeAccentClass = () => ({
    text: 'text-[#10b981]',
    bg: 'bg-emerald-500/10',
    badgeBg: 'bg-[#10b981]',
    border: 'border-emerald-200'
  });

  const themeVars = getThemeAccentClass();

  return (
    <div className="space-y-6" id="backup_restore_module_container">

      {/* Page Title Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-[#0B1F4D] text-white p-6 rounded-2xl shadow-md border-b-4 border-emerald-400">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-1 px-2.5 bg-emerald-505 bg-emerald-500 text-slate-950 font-black rounded-lg text-[10px] uppercase tracking-wider font-sans">
              لوحة الأمان الفائقة v١.٢
            </span>
            <div className="flex items-center gap-1.1 text-amber-300 text-xs font-bold font-cairo">
              <Sparkles className="w-3.5 h-3.5 animate-pulse" />
              <span>أوفلاين بالكامل 🇮🇶</span>
            </div>
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2">
            <DatabaseBackup className="w-6.5 h-6.5 text-[#10b981]" />
            <span>النسخ الاحتياطي ومزامنة الحسابات</span>
          </h2>
          <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed">
            أنقذ وجرّد بيانات مبيعاتك وحسابات المحل. هنا يمكنك تحميل ملف النسخة وحفظها، أو مزامنتها سحابياً والاطمئنان على حسابات الأرزاق في أي هاتف جديد!
          </p>
        </div>

        {/* Real-time Network Status Indicator */}
        <div className="bg-slate-900/60 p-3.5 rounded-xl border border-slate-700/80 max-w-xs self-start md:self-center flex flex-col gap-1 w-full md:w-auto">
          <div className="text-[10px] text-slate-400">حالة الشبكة الفعلية:</div>
          <div className="flex items-center gap-2">
            {!isOnline ? (
              <>
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" />
                <span className="text-xs font-extrabold text-rose-400">بلا اتصال — أوفلاين 🔴</span>
              </>
            ) : syncState === 'syncing' ? (
              <>
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping" />
                <span className="text-xs font-extrabold text-amber-300">جاري المزامنة... ⌛</span>
              </>
            ) : (
              <>
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-xs font-extrabold text-emerald-400">متصل — مزامنة كاملة 🟢</span>
              </>
            )}
          </div>
          <div className="text-[9px] text-slate-400/90 font-mono mt-0.5">
            {!isOnline
              ? 'البيانات تُحفظ محلياً وتُزامَن عند عودة الشبكة'
              : syncState === 'syncing'
                ? 'يتم رفع التغييرات المعلقة إلى Firebase...'
                : 'كافة البيانات متزامنة مع السحابة (١٠٠٪)'}
          </div>
        </div>
      </div>

      {/* SUCCESS TOAST MESSAGE */}
      {success && (
        <div className="p-4 bg-emerald-50 text-emerald-800 border-r-4 border-emerald-500 rounded-xl text-xs md:text-sm font-bold flex items-center gap-2.5 animate-fade-in shadow-sm">
          <CheckCircle2 className="w-5.5 h-5.5 text-emerald-600 flex-shrink-0 animate-bounce" />
          <span>{success}</span>
        </div>
      )}

      {/* ERROR TOAST MESSAGE */}
      {errorMsg && (
        <div className="p-4 bg-rose-50 text-rose-800 border-r-4 border-rose-500 rounded-xl text-xs md:text-sm font-bold flex items-center gap-2.5 animate-fade-in shadow-sm">
          <AlertOctagon className="w-5.5 h-5.5 text-rose-600 flex-shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* MAIN TWO-COLUMN LAYOUT GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* RIGHT COLUMN: CLOUD REPOSITORY & SYNC CONTROLLER (7 Coils) */}
        <div className="lg:col-span-7 space-y-6">

          {/* 1. Cloud Backup Manual / Auto Area */}
          <div className="bg-white rounded-3xl p-6 border border-[#E4EAF3] shadow-sm space-y-6">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <span className="w-12 h-12 rounded-2xl bg-sky-50 border border-sky-100 flex items-center justify-center text-sky-600">
                  <CloudLightning className="w-6 h-6 animate-pulse" />
                </span>
                <div>
                  <h4 className="font-extrabold text-[#0B1F4D] font-cairo text-sm md:text-base">مستودع المزامنة السحابي السريع</h4>
                  <p className="text-xs text-[#5B6B86] mt-0.5">مزامنة مشفرة ومصادق عليها لضمان أرصدة الصناديق</p>
                </div>
              </div>

              <div className="text-right">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-extrabold ${
                  !isOnline
                    ? 'bg-rose-50 text-rose-700 border border-rose-200'
                    : syncState === 'syncing'
                      ? 'bg-amber-50 text-amber-800 border border-amber-200'
                      : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    !isOnline
                      ? 'bg-rose-600'
                      : syncState === 'syncing'
                        ? 'bg-amber-500 animate-ping'
                        : 'bg-emerald-600 animate-ping'
                  }`} />
                  <span>{
                    !isOnline
                      ? 'دون اتصال بالشبكة'
                      : syncState === 'syncing'
                        ? 'جاري المزامنة...'
                        : 'متزامن سحابياً'
                  }</span>
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              <div className="p-4 bg-slate-50/80 rounded-2xl border border-slate-200 shadow-inner flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-1.5 text-slate-500 text-[11px] mb-2 font-bold font-cairo">
                    <Clock className="w-3.5 h-3.5" />
                    <span>تاريخ آخر عملية تواصل</span>
                  </div>
                  <div className="text-sm md:text-base font-extrabold text-slate-900 font-mono tracking-wider">
                    {toArabicDigits(settings.lastBackupDate || 'لم يتم النسخ كلياً بعد 🕒')}
                  </div>
                </div>

                <div className="text-[10px] text-slate-400 mt-3 pt-3 border-t border-slate-200/50">
                  يرجى الاحتفاظ باتصال مستقر للنسخ التلقائي
                </div>
              </div>

              <div className="p-4 bg-slate-50/80 rounded-2xl border border-slate-200 shadow-inner space-y-2 text-xs text-slate-700 font-medium">
                <div className="flex justify-between items-center pb-2 border-b border-slate-200/60">
                  <span>خادم التشفير الفعال:</span>
                  <span className="font-bold text-[#1B3A7A]">سيرفرات العراق المستقلة 🇮🇶</span>
                </div>
                <div className="flex justify-between items-center pb-2 border-b border-slate-200/60">
                  <span>جدول الرفع التلقائي:</span>
                  <span className="font-bold text-[#0B1F4D]">
                    {settings.backupInterval === 'daily' ? 'يومي تلقائي (موصى به)' : settings.backupInterval === 'weekly' ? 'أسبوعي' : 'يدوي بالكامل'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span>نوع الاتصالات المتبادلة:</span>
                  <span className="font-mono text-emerald-600 font-bold bg-emerald-50 px-2 py-0.5 rounded text-[10px]">AES-256 SECURE</span>
                </div>
              </div>

            </div>

            <div className="p-4 bg-amber-50 rounded-2xl border border-amber-100 flex items-start gap-2.5 text-xs text-amber-800 leading-relaxed font-medium">
              <Info className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-bold text-amber-950 font-cairo block mb-0.5">ميزة العمل الحرة دون إنترنت (Offline Control)</span>
                <p className="text-slate-700">
                  كل ما تقوم بإنجازه من مبيعات أو فواتير يتم حفظه بأمان على محرك هاتفك الموضعي دون انتظار إنترنت. وبمجرد فتح التطبيق والتقاط إشارة ستمضي المزامنة مباشرة خلف الكواليس لتأمين أرقامك!
                </p>
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={handleCloudBackupNow}
                disabled={isSyncing}
                className="w-full py-4 bg-[#0B1F4D] hover:bg-[#152e6d] active:scale-98 text-white rounded-2xl transition-all font-extrabold text-sm shadow-md flex items-center justify-center gap-2.5 disabled:opacity-40 cursor-pointer"
                id="cloud_sync_now_big_btn"
              >
                <RefreshCw className={`w-5 h-5 text-emerald-400 ${isSyncing ? 'animate-spin' : ''}`} />
                <span>{isSyncing ? 'جارٍ حفظ نسخة سحابية داخل حسابك…' : 'حفظ نسخة سحابية الآن ☁️'}</span>
              </button>
            </div>

            {/* قائمة اللقطات السحابية — نسخة لا تراها ولا تستطيع استعادتها ليست نسخة */}
            <div className="pt-3 border-t border-slate-100">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-xs font-extrabold text-[#0B1F4D] flex items-center gap-1.5">
                  <CloudLightning className="w-4 h-4 text-sky-600" />
                  النسخ السحابية المحفوظة ({toArabicDigits(snapshots.length)})
                </span>
                <span className="text-[9px] text-slate-400 font-bold">
                  يُحتفظ بآخر {toArabicDigits(DEFAULT_KEEP)} نسخ تلقائياً
                </span>
              </div>

              {snapshots.length === 0 ? (
                <p className="text-[11px] text-slate-400 font-bold text-center py-4 bg-slate-50 rounded-xl border border-slate-150">
                  لا نسخ سحابية بعد — اضغط الزر أعلاه، أو فعّل النسخ التلقائي من الإعدادات
                </p>
              ) : (
                <div className="space-y-1.5">
                  {snapshots.map(s => {
                    const busy = snapBusy === s.id;
                    const when = new Date(s.createdAt);
                    const total = Object.values(s.counts || {}).reduce((a, b) => a + b, 0);
                    return (
                      <div key={s.id} className="flex items-center justify-between gap-2 p-3 bg-white border border-slate-200 rounded-xl">
                        <div className="min-w-0">
                          <span className="text-[11px] font-extrabold text-[#0B1F4D] block">
                            {toArabicDigits(when.toLocaleDateString('ar-IQ'))} — {toArabicDigits(when.toLocaleTimeString('ar-IQ', { hour: 'numeric', minute: '2-digit' }))}
                          </span>
                          <span className="text-[9px] text-slate-400 font-bold block mt-0.5">
                            {toArabicDigits(total)} سجل · {formatBytes(s.storedBytes)}
                            {s.compressed && <span className="text-emerald-600"> (مضغوطة من {formatBytes(s.rawBytes)})</span>}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <button onClick={() => handleRestoreFromCloud(s.id)} disabled={busy}
                            className="px-3 py-1.5 bg-[#0B1F4D] hover:bg-[#152e6d] text-white text-[10px] font-extrabold rounded-lg cursor-pointer disabled:opacity-40">
                            {busy ? '…' : 'استعادة منها'}
                          </button>
                          <button onClick={() => handleDeleteSnapshot(s.id)} disabled={busy} title="حذف اللقطة"
                            className="px-2 py-1.5 bg-slate-100 hover:bg-rose-100 text-slate-500 hover:text-rose-600 text-[10px] font-extrabold rounded-lg cursor-pointer disabled:opacity-40">
                            حذف
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <p className="text-[9px] text-slate-400 font-bold leading-relaxed mt-2 flex items-start gap-1">
                <Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
                <span>
                  اللقطة تُحفظ داخل حسابك مضغوطةً، فتحميك ممّا لا تحميك منه المزامنة العادية:
                  حذفٌ بالخطأ، أو استيراد يمسح فوق الصحيح. «استعادة منها» تعرض المعاينة أولاً ولا تكتب شيئاً قبل تأكيدك.
                </span>
              </p>
            </div>

          </div>

          {/* 2. Drag & Drop File Restoration Zone */}
          <div className="bg-white rounded-3xl p-6 border border-[#E4EAF3] shadow-sm space-y-5">
            <h4 className="font-extrabold text-[#0B1F4D] font-cairo text-sm md:text-base flex items-center gap-2 pb-2 border-b border-slate-100">
              <Smartphone className="w-5.5 h-5.5 text-emerald-600 animate-bounce" />
              <span>استيراد واستعادة الحسابات (عند تغيير الهاتف) 📲</span>
            </h4>

            <p className="text-xs text-slate-500 leading-relaxed">
              إذا قمت بإعادة تثبيت التطبيق أو غيرت جهاز الموبايل الخاص بك مجدداً، فقط اسحب ملف النسخة الاحتياطية المستخرجة مسبقاً (بصيغة .json) وأسقطه هنا، لتعود كامل ديون وزبائن ومخزن مجلدك فوراً وفي ثوانٍ معدودة!
            </p>

            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-3 border-dashed rounded-2xl h-40 flex flex-col items-center justify-center p-4 text-center cursor-pointer transition ${
                isDragging
                  ? 'border-emerald-500 bg-emerald-500/5'
                  : 'border-slate-300 hover:border-[#0B1F4D] hover:bg-slate-50/50'
              }`}
              id="restore_json_drag_drop_zone"
            >
              <input
                type="file"
                ref={fileInputRef}
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleParseImportedFile(e.target.files[0]);
                  }
                }}
                className="hidden"
                accept=".json"
              />
              <Upload className="w-8 h-8 text-slate-400 mb-2" />
              <p className="text-xs font-bold text-[#0B1F4D]">اسحب ملف الـ JSON الخاص بك هنا أو اضغط لتصفح ملفات جهازك</p>
              <p className="text-[10px] text-slate-400 mt-1">تأكد أن الملف يحمل ترويسة مشروع "رتب شغلك"</p>
            </div>

            {restoredDataDetails && (
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl space-y-3.5 animate-fade-in text-xs" id="restore_file_preview_card">
                <div className="flex justify-between items-center">
                  <span className="font-extrabold text-[#0B1F4D] flex items-center gap-1.5">
                    <Check className="w-4 h-4 text-emerald-600" />
                    <span>تم تحليل كود النسخة السابقة بنجاح! 🔬</span>
                  </span>
                  <button
                    onClick={() => setRestoredDataDetails(null)}
                    className="text-slate-400 hover:text-red-500 font-bold"
                  >
                    إلغاء الاستيراد
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 bg-white p-3 rounded-xl border border-emerald-100 text-[11px] text-slate-700">
                  <div>
                    <span className="text-slate-400">اسم المتجر المؤرشف:</span>
                    <p className="font-extrabold text-[#0B1F4D]">{restoredDataDetails.storeName}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">صاحب الحساب:</span>
                    <p className="font-extrabold text-[#0B1F4D]">{restoredDataDetails.ownerName}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">تاريخ تصدير الملف:</span>
                    <p className="font-extrabold text-[#0B1F4D] font-mono">{toArabicDigits(new Date(restoredDataDetails.exportDate).toLocaleDateString('ar-IQ'))}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">قطاع العمل المرمز:</span>
                    <p className="font-extrabold text-[#0B1F4D]">
                      تجاري عام
                    </p>
                  </div>
                </div>

                <div className="p-2.5 bg-slate-50/70 rounded-lg flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-bold text-slate-600 justify-around">
                  <span>الوصولات المسترجعة: {toArabicDigits(restoredDataDetails.summary.invsLength)}</span>
                  <span>الزبائن والعملاء: {toArabicDigits(restoredDataDetails.summary.custsLength)}</span>
                  <span>بضاعة المخزن: {toArabicDigits(restoredDataDetails.summary.prodsLength)}</span>
                  {restoredDataDetails.summary.debtPaysLength > 0 && (
                    <span>مدفوعات الديون: {toArabicDigits(restoredDataDetails.summary.debtPaysLength)}</span>
                  )}
                </div>

                {/* 🔴 وسم النسخة نفسها: ملفٌ بُني بلا خادم قد يكون ناقصاً — والوسم داخله */}
                {sourceWarning(restoredDataDetails.source) && (
                  <div className="p-3 bg-rose-50 border border-rose-300 rounded-xl text-[11px] text-rose-900 font-bold leading-relaxed flex items-start gap-2">
                    <AlertOctagon className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-600" />
                    <span>{sourceWarning(restoredDataDetails.source)}</span>
                  </div>
                )}

                {/* 🟠 مؤشّر التقدّم — بدله كانت الشاشة ساكنة فيُضغط الزرّ مرّتين */}
                {restoreProgress && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl">
                    <div className="flex items-center justify-between text-[11px] font-extrabold text-blue-900">
                      <span>جارٍ الاستعادة… لا تُغلق الشاشة</span>
                      <span>{toArabicDigits(restoreProgress.done)} / {toArabicDigits(restoreProgress.total)} دفعة</span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-blue-100 overflow-hidden">
                      <div className="h-full bg-blue-500 transition-all"
                        style={{ width: `${Math.round((restoreProgress.done / Math.max(1, restoreProgress.total)) * 100)}%` }} />
                    </div>
                  </div>
                )}

                {/* (fix 15) تحذير صريح: الاستعادة تدمج فوق الحالي ولا تحذف الأحدث */}
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-900 font-bold leading-relaxed flex items-start gap-2">
                  <AlertOctagon className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
                  <span>
                    تنبيه مهم: الاستعادة تكتب بيانات النسخة فوق الحالية، ولا تحذف ما أُنشئ بعد تاريخ التصدير.
                    إن أضفت فواتير أو سدّدت ديوناً بعد هذه النسخة، قد تتعارض الأرصدة والكميات مع تلك السجلات الأحدث.
                    استعد فقط إذا كنت متأكداً، ويُفضّل أخذ نسخة احتياطية جديدة أولاً.
                  </span>
                </div>

                <div className="pt-1.5 flex gap-2">
                  <button
                    onClick={handleConfirmRestore}
                    disabled={!!restoreProgress}
                    className="flex-1 py-2.5 bg-[#10b981] hover:bg-emerald-600 active:scale-95 text-slate-950 font-extrabold text-xs rounded-xl transition flex justify-center items-center gap-1.5 cursor-pointer"
                  >
                    <span>{restoreProgress ? 'جارٍ الاستعادة…' : 'نعم، استعد بيانات هذه النسخة الآن'}</span>
                  </button>
                  <button
                    onClick={() => setRestoredDataDetails(null)}
                    className="py-2.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-xs rounded-xl transition cursor-pointer"
                  >
                    تراجع
                  </button>
                </div>
              </div>
            )}

          </div>

        </div>

        {/* LEFT COLUMN: LOCAL DATA SUMMARY, SIMULATOR & PHYSICAL FILE DOWNLOADING (5 Coils) */}
        <div className="lg:col-span-5 space-y-6">

          {/* 3. Local Saving & Physical Backup */}
          <div className="bg-white rounded-3xl p-6 border border-[#E4EAF3] shadow-sm space-y-5">
            <div className="flex items-center gap-3 pb-2 border-b border-slate-100">
              <span className="w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600">
                <ShieldCheck className="w-6 h-6" />
              </span>
              <div>
                <h4 className="font-extrabold text-[#0B1F4D] font-cairo text-sm md:text-base">حفظ وتنزيل نسخة للجهاز محلياً</h4>
                <p className="text-xs text-[#5B6B86] mt-0.5">قم بتوليد ملف بيانات وحفظه بذاكرة الموبايل</p>
              </div>
            </div>

            <div className="space-y-3.5 pt-2">
              <span className="text-xs font-extrabold text-[#0B1F4D] block">محتويات النسخة المحلية مالتك حالياً:</span>

              <div className="grid grid-cols-2 gap-3" id="local_current_data_statistics_grid">

                <div className="p-3 bg-slate-50/70 rounded-xl border border-slate-100 flex justify-between items-center text-xs">
                  <span className="text-slate-500">الفواتير والوصولات:</span>
                  <span className="font-extrabold text-[#0B1F4D] font-mono bg-slate-200/50 px-2.5 py-0.5 rounded">
                    {toArabicDigits(stats.invoicesCount)}
                  </span>
                </div>

                <div className="p-3 bg-slate-50/70 rounded-xl border border-slate-100 flex justify-between items-center text-xs">
                  <span className="text-slate-500">الزبائن المطلوبين:</span>
                  <span className="font-extrabold text-[#0B1F4D] font-mono bg-slate-200/50 px-2.5 py-0.5 rounded">
                    {toArabicDigits(stats.customersCount)}
                  </span>
                </div>

                <div className="p-3 bg-slate-50/70 rounded-xl border border-slate-100 flex justify-between items-center text-xs col-span-2">
                  <span className="text-slate-500">البضاعة والمنتجات بالمخزن:</span>
                  <span className="font-extrabold text-[#0B1F4D] font-mono bg-sky-100/50 text-sky-800 px-2.5 py-0.5 rounded">
                    {toArabicDigits(stats.productsCount)}
                  </span>
                </div>

              </div>
            </div>

            <p className="text-[11px] text-slate-500 leading-relaxed pt-1">
              مصلحتك في أمان تام. بالضغط على الزر أدناه سيتم دمج كافة حسابات الزبائن، والوصولات والمخزون الحالي وتأطيرها بملف واحد مشفر يتم تنزيله فوراً بهاتفك. يمكنك إرساله لنفسك في الواتساب أو حفظه في الـ Google Drive كأرشيف خارجي أمن.
            </p>

            <button
              onClick={handleExportLocalBackup}
              className="w-full py-3.5 bg-sky-50 hover:bg-sky-100/80 active:scale-95 text-[#1B3A7A] rounded-2xl border-2 border-sky-200 transition font-extrabold text-xs flex items-center justify-center gap-2 cursor-pointer"
              id="export_local_json_backup_btn"
            >
              <Download className="w-4.5 h-4.5 text-[#1B3A7A]" />
              <span>حفظ نسخة احتياطية كاملة (JSON) — للاستعادة 📥</span>
            </button>

            {/* تقرير مقروء Word / PDF (للأرشفة والطباعة — الاستعادة تبقى عبر JSON أعلاه) */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => handleExportReport('word')}
                className="py-2.5 bg-blue-50 hover:bg-blue-100 text-blue-800 rounded-xl border border-blue-200 transition font-extrabold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <FileText className="w-4 h-4" />
                <span>تقرير Word</span>
              </button>
              <button
                onClick={() => handleExportReport('pdf')}
                className="py-2.5 bg-rose-50 hover:bg-rose-100 text-rose-800 rounded-xl border border-rose-200 transition font-extrabold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>تقرير PDF</span>
              </button>
            </div>
            <p className="text-[10px] text-slate-400 text-center leading-relaxed">
              ملفات Word/PDF للقراءة والأرشفة والطباعة. الاستعادة الكاملة للبيانات تتم حصراً عبر ملف JSON (موثوق ودقيق ١٠٠٪).
            </p>
          </div>

          {/* 3b. Debt consistency check & repair */}
          <div className="bg-white rounded-3xl p-6 border border-[#E4EAF3] shadow-sm space-y-4">
            <div className="flex items-center gap-3 pb-2 border-b border-slate-100">
              <span className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center text-amber-600">
                <AlertOctagon className="w-6 h-6" />
              </span>
              <div>
                <h4 className="font-extrabold text-[#0B1F4D] font-cairo text-sm md:text-base">فحص وإصلاح اتساق الديون 🩺</h4>
                <p className="text-xs text-[#5B6B86] mt-0.5">يقارن أرصدة الزبائن مع ديون الفواتير ويكشف الفواتير اليتيمة</p>
              </div>
            </div>

            <button
              onClick={handleScanDebtConsistency}
              className="w-full py-3 bg-amber-50 hover:bg-amber-100/80 active:scale-95 text-amber-800 rounded-2xl border-2 border-amber-200 transition font-extrabold text-xs flex items-center justify-center gap-2 cursor-pointer"
            >
              <Search className="w-4 h-4" />
              <span>فحص الاتساق الآن (بدون أي تعديل)</span>
            </button>

            {debtScan && (debtScan.mismatches.length > 0 || debtScan.orphans.length > 0) && (
              <div className="space-y-3 animate-fade-in">

                {debtScan.mismatches.length > 0 && (
                  <div className="p-3 bg-rose-50/60 border border-rose-100 rounded-2xl space-y-2">
                    <span className="text-xs font-extrabold text-rose-800 block">
                      (أ) أرصدة لا تطابق مجموع الفواتير — {toArabicDigits(debtScan.mismatches.length)} زبون:
                    </span>
                    {debtScan.mismatches.map(m => (
                      <div key={m.customer.id} className="bg-white rounded-lg px-3 py-2 space-y-1 text-[11px] font-bold text-slate-700">
                        <label className="flex justify-between items-center gap-2 cursor-pointer">
                          <span className="flex items-center gap-2 min-w-0">
                            <input
                              type="checkbox"
                              checked={mismatchSelected[m.customer.id] ?? false}
                              onChange={(e) => setMismatchSelected(prev => ({ ...prev, [m.customer.id]: e.target.checked }))}
                              className="w-3.5 h-3.5 accent-[#0B1F4D] flex-shrink-0 cursor-pointer"
                            />
                            <span className="truncate">{m.customer.name}</span>
                          </span>
                          <span className="font-mono text-[10px] flex-shrink-0">
                            الرصيد: {toArabicDigits(m.customer.balance.toLocaleString())} ← سيصبح: {toArabicDigits(m.sumRemaining.toLocaleString())}
                          </span>
                        </label>
                        {m.customer.balance > m.sumRemaining && (
                          <p className="text-[9px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                            ⚠ قد يكون هذا الفرق ديناً مشروعاً من فاتورة محذوفة (بعد فترة السماح) — راجع قبل الإصلاح
                          </p>
                        )}
                      </div>
                    ))}
                    <p className="text-[10px] text-rose-700/80">
                      يُعاد بناء رصيد الحالات المحددة ✓ فقط من مجموع المتبقي على الفواتير — الحالات ذات التحذير غير محددة افتراضياً
                    </p>
                  </div>
                )}

                {debtScan.orphans.length > 0 && (
                  <div className="p-3 bg-amber-50/60 border border-amber-100 rounded-2xl space-y-2">
                    <span className="text-xs font-extrabold text-amber-800 block">
                      (ب) فواتير بدين بلا زبون موجود — {toArabicDigits(debtScan.orphans.length)} فاتورة:
                    </span>
                    {debtScan.orphans.map(inv => (
                      <div key={inv.id} className="bg-white rounded-lg px-3 py-2 space-y-1.5 text-[11px] font-bold text-slate-700">
                        <div className="flex justify-between items-center">
                          <span className="truncate">فاتورة {toArabicDigits(inv.invoiceNumber)} — {inv.customerName}</span>
                          <span className="font-mono text-[10px] text-rose-600 flex-shrink-0">
                            متبقي: {toArabicDigits((inv.remainingAmount ?? 0).toLocaleString())}
                          </span>
                        </div>
                        <select
                          value={orphanActions[inv.id] || 'zero'}
                          onChange={(e) => setOrphanActions(prev => ({ ...prev, [inv.id]: e.target.value }))}
                          className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-bold cursor-pointer"
                        >
                          <option value="zero">تصفير الدين (اعتباره مسدداً)</option>
                          {customers.map(c => (
                            <option key={c.id} value={c.id}>ربط بالزبون: {c.name}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={handleApplyDebtRepair}
                    className="flex-1 py-2.5 bg-[#0B1F4D] hover:bg-[#152e6d] active:scale-95 text-white font-extrabold text-xs rounded-xl transition flex justify-center items-center gap-1.5 cursor-pointer"
                  >
                    <Check className="w-4 h-4 text-emerald-400" />
                    <span>تأكيد وتطبيق الإصلاح</span>
                  </button>
                  <button
                    onClick={() => { setDebtScan(null); setOrphanActions({}); }}
                    className="py-2.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-xs rounded-xl transition cursor-pointer"
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 4. Real-time Network Status Card */}
          <div className={`rounded-3xl p-6 border shadow-sm space-y-4 ${
            !isOnline
              ? 'bg-rose-50 border-rose-200'
              : syncState === 'syncing'
                ? 'bg-amber-50 border-amber-200'
                : 'bg-gradient-to-br from-emerald-50 to-white border-emerald-200'
          }`}>
            <h4 className="font-extrabold text-[#0B1F4D] font-cairo text-sm flex items-center gap-2">
              {!isOnline
                ? <WifiOff className="w-5 h-5 text-rose-600" />
                : <Wifi className="w-5 h-5 text-emerald-600 animate-pulse" />
              }
              <span>حالة الشبكة والمزامنة التلقائية 📡</span>
            </h4>

            <div className={`flex items-center gap-3 p-4 rounded-2xl border ${
              !isOnline
                ? 'bg-white border-rose-200'
                : syncState === 'syncing'
                  ? 'bg-white border-amber-200'
                  : 'bg-white border-emerald-200'
            }`}>
              <span className={`w-4 h-4 rounded-full flex-shrink-0 ${
                !isOnline
                  ? 'bg-rose-500'
                  : syncState === 'syncing'
                    ? 'bg-amber-400 animate-ping'
                    : 'bg-emerald-500 animate-pulse'
              }`} />
              <div>
                <p className={`font-extrabold text-sm ${
                  !isOnline ? 'text-rose-700' : syncState === 'syncing' ? 'text-amber-700' : 'text-emerald-700'
                }`}>
                  {!isOnline
                    ? 'دون اتصال بالإنترنت 🔴'
                    : syncState === 'syncing'
                      ? 'جاري المزامنة... ⌛'
                      : 'متصل ومزامنة كاملة 🟢'
                  }
                </p>
                <p className="text-[10px] text-slate-500 mt-0.5 leading-relaxed">
                  {!isOnline
                    ? 'جميع العمليات (فواتير، زبائن، ديون) تُحفظ محلياً بأمان. ستُزامَن تلقائياً فور عودة الإنترنت دون أي تدخل منك.'
                    : syncState === 'syncing'
                      ? 'يتم رفع التغييرات المعلقة إلى Firebase تلقائياً الآن...'
                      : 'كافة بياناتك متزامنة مع السحابة. أي تعديل جديد يُرفع فوراً في الخلفية.'
                  }
                </p>
              </div>
            </div>

            <div className="bg-white/70 p-3 rounded-2xl border border-slate-200/50 flex gap-2 items-start text-[10px] text-slate-500 leading-relaxed">
              <Info className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
              <span>هذا المؤشر يعكس حالة الإنترنت الحقيقية على جهازك تلقائياً. لا حاجة لأي تدخل يدوي — المزامنة مع Firebase تتم خلف الكواليس دائماً.</span>
            </div>
          </div>

        </div>

      </div>

    </div>
  );
}
