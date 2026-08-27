import React, { useState, useMemo, useEffect, useRef } from 'react';
import DesktopOnly, { ViewOnlyNote } from './DesktopOnly';
import { useCollection } from '../hooks/useCollection';
import NumberInput from './NumberInput';
import { windowConstraints, daysAgoKey, WINDOW } from '../utils/dateWindow';
import {
  Calculator, Save, ArrowUpRight, ArrowDownRight, Wallet, AlertCircle,
  CheckCircle2, Banknote, Users, History, TrendingUp, TrendingDown, HandCoins,
} from 'lucide-react';
import { toArabicDigits, formatCurrency, parseAmount } from '../utils/arabicFormatters';
import { readAmount } from '../utils/amountField';
import { Invoice, CashClosing, PurchaseInvoice, SupplierPayment } from '../types';
import { cashPortion, isCashMethod, sumByMethod } from '../utils/paymentMethods';
import { useBranches } from '../hooks/useBranches';
import { MAIN_BRANCH_ID } from '../types';
import { useActor } from '../hooks/useActor';
import { logAudit } from '../utils/auditLog';

interface CashClosingViewProps {
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  ownerName: string;
}

// نماذج مطابقة لما تحفظه الشاشات الأخرى (بلا استيراد متبادل)
interface DebtPayment {
  id: string;
  customerId: string;
  customerName: string;
  amount: number;
  date: string;
  notes: string;
  invoiceId?: string;
  method?: string;   // طريقة الدفع — غيابها = كاش (توافق رجعي)
  branchId?: string; // الفرع الذي وصل إليه النقد. غيابه = الرئيسي
}
interface FinancialTransaction {
  id: string;
  title: string;
  amount: number;
  type: 'revenue' | 'expense';
  category: string;
  date: string;
  notes: string;
  /**
   * 🔴 كان النموذج المحلي هنا لا يُعلن `branchId` و`method` رغم أن `ExpensesView` يكتبهما —
   * فالحقلان موجودان في البيانات ومحجوبان عن هذا الحساب. وهذا هو الميكانيزم الذي جعل
   * إيجار المحل يُخصم من صندوق المخزن، والإيجار المحوَّل مصرفياً يُخصم من نقدٍ لم يمسّه.
   */
  branchId?: string;
  method?: string;
}

// ---- تطبيع التاريخ إلى مفتاح يوم 'yyyy-mm-dd' ----
// كل السجلات الحديثة تُحفظ أصلاً بهذه الصيغة (من حقول <input type="date">)، لكن قد توجد
// بيانات قديمة/مستوردة بصيغ أخرى، فنطبّعها بأمان دون انزياح المنطقة الزمنية.
const arDigitsToLatin = (s: string) =>
  s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

const toDayKey = (dateStr: string): string => {
  if (!dateStr) return '';
  let s = arDigitsToLatin(String(dateStr)).replace(/[‎‏]/g, '').trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const parts = s.replace(/\//g, '-').split('-').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 3) {
    let y: number, mo: number, da: number;
    if (parts[0].length === 4) { y = +parts[0]; mo = +parts[1]; da = +parts[2]; }
    else { da = +parts[0]; mo = +parts[1]; y = +parts[2]; }
    if (y < 100) y += 2000;
    if (y && mo && da) return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  }
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }
  return '';
};

const todayKey = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const formatDayAr = (dayKey: string): string => {
  if (!dayKey) return '';
  const d = new Date(dayKey + 'T00:00:00');
  return isNaN(d.getTime()) ? toArabicDigits(dayKey) : d.toLocaleDateString('ar-IQ');
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export default function CashClosingView({ currency, exchangeRate, ownerName }: CashClosingViewProps) {
  const actor = useActor();
  // صندوق كل فرع مستقل. معرّف الوثيقة للفرع الرئيسي يبقى التاريخ وحده (حفاظاً على إقفالاتك
  // المحفوظة)، ولبقية الفروع «فرع_تاريخ» فلا يتضارب فرعان في اليوم نفسه.
  const { stampBranchId, matchesActiveBranch, isMultiBranch, branchName, activeIsWarehouse } = useBranches();
  const closingDocId = (day: string, branch: string) =>
    branch === MAIN_BRANCH_ID ? day : `${branch}_${day}`;
  // ---- UI STATE ----
  const [selectedDay, setSelectedDay] = useState<string>(todayKey());

  // نافذة تتمدّد: افتراضياً ٩٠ يوماً، وتعود للخلف تلقائياً إن اختار المالك يوماً أقدم
  // (يقفل صندوق يوم من الشهر الماضي). فلا تُحمّل فواتير سنتين ولا يفقد يوماً أراده.
  const invWindow = useMemo(() => {
    const floor = daysAgoKey(WINDOW.CASH_CLOSING);
    return windowConstraints(selectedDay < floor ? selectedDay : floor);
  }, [selectedDay]);

  // ---- FIRESTORE ----
  /**
   * 🟡 النافذة نفسها لكل مصادر النقد — كانت الفواتير وحدها منضبطة، والأربعة الباقية
   * تُقرأ **كاملةً**: كل تاريخ المحل لحساب يومٍ واحد. وباستعمال النافذة المتمدّدة نفسها
   * يوسّعها اختيارُ يومٍ أقدم للجميع معاً، فلا يفقد الحساب مصدراً.
   */
  const { items: invoices } = useCollection<Invoice>('invoices', invWindow);
  const { items: payments } = useCollection<DebtPayment>('debt_payments', invWindow);
  const { items: transactions } = useCollection<FinancialTransaction>('financial_transactions', invWindow);
  // نقد الموردين — شراء البضاعة وتسديد ذممهم يخرجان من نفس الدرج، فبدونهما يظهر عجز وهمي
  const { items: purchaseInvoices } = useCollection<PurchaseInvoice>('purchase_invoices', invWindow);
  const { items: supplierPayments } = useCollection<SupplierPayment>('supplier_payments', invWindow);
  const { items: closings, loading: closingsLoading, save: saveClosing } =
    useCollection<CashClosing>('cash_closings');

  const [openingCash, setOpeningCash] = useState('');
  const [countedCash, setCountedCash] = useState('');
  const [notes, setNotes] = useState('');
  const [alert, setAlert] = useState<{ text: string; type: 'success' | 'danger' } | null>(null);

  const triggerAlert = (text: string, type: 'success' | 'danger' = 'success') => {
    setAlert({ text, type });
    setTimeout(() => setAlert(null), 4000);
  };

  const savedClosing = useMemo(
    () => closings.find((c) => c.id === closingDocId(selectedDay, stampBranchId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closings, selectedDay, stampBranchId],
  );

  // ---- حساب حركة نقد اليوم المختار (مباشرة من البيانات الحية) ----
  const day = useMemo(() => {
    // صندوق الفرع: فواتير هذا الفرع وحده (القديمة بلا فرع = الرئيسي)
    const dayInvoices = invoices.filter(
      (inv) => toDayKey(inv.date) === selectedDay && matchesActiveBranch(inv),
    );

    // (fix 5+6) paidAmount تراكمي: تسديد لاحق لفاتورة يرفعه. فلحساب "نقد الفاتورة يوم إصدارها"
    // نطرح من مدفوعها الحالي مجموع الدفعات المربوطة بها (تحصل كلها بعد الإصدار). ما تبقّى = الدفعة
    // المقدَّمة وقت البيع. هذا يمنع تضخّم مبيعات يوم سابق بعد تسديد ديونه، ويمنع العدّ المزدوج مع
    // debtCollected دون الاعتماد على استبعاد هشّ (التسديد العام FIFO لا يحمل invoiceId).
    const paidByInvoice = new Map<string, number>();
    for (const p of payments) {
      if (p.invoiceId) paidByInvoice.set(p.invoiceId, (paidByInvoice.get(p.invoiceId) ?? 0) + p.amount);
    }
    const initialCashOf = (inv: Invoice): number => {
      const currentPaid = clamp(inv.paidAmount ?? inv.finalAmount ?? 0, 0, inv.finalAmount ?? 0);
      return Math.max(0, currentPaid - (paidByInvoice.get(inv.id) ?? 0));
    };

    // 🔴 فصل النقد عن الإلكتروني: الدفع بالبطاقة/المحفظة **لا يدخل الدرج**، فاحتسابه كنقد
    // يُظهر عجزاً وهمياً بقيمته. نوزّع الدفعة المقدَّمة على نِسَب طرق الدفع المسجَّلة بالفاتورة.
    // الفواتير القديمة (بلا payments) تُعامل كاش ١٠٠٪ — صحيح تاريخياً فلا تتغيّر أرقام سابقة.
    const cashRatioOf = (inv: Invoice): number => {
      const paid = inv.paidAmount ?? inv.finalAmount ?? 0;
      if (!inv.payments || inv.payments.length === 0 || paid <= 0) return 1;
      return clamp(cashPortion(paid, inv.payments) / paid, 0, 1);
    };
    const cashSales = dayInvoices.reduce((s, inv) => s + initialCashOf(inv) * cashRatioOf(inv), 0);
    const electronicSales = dayInvoices.reduce((s, inv) => s + initialCashOf(inv) * (1 - cashRatioOf(inv)), 0);
    const debtGiven = dayInvoices.reduce((s, inv) => s + (inv.remainingAmount ?? 0), 0);

    // تسديدات ديون اليوم — كل الدفعات المؤرَّخة اليوم (نقد وصل فعلاً). لا استبعاد: نقد فاتورة اليوم
    // نفسها لم يعُد يُحسب مرتين لأن cashSales صار يعتمد الدفعة المقدَّمة فقط (بعد طرح الدفعات المربوطة).
    // 🔴 التصفية بالفرع هنا أيضاً — كانت غائبة فيُحتسب تحصيل فرعٍ في صندوق فرعٍ آخر
    const dayPayments = payments
      .filter((p) => toDayKey(p.date) === selectedDay)
      .filter(matchesActiveBranch);
    // تسديدات الديون تُفصل أيضاً: تسديد بتحويل بنكي لا يدخل الدرج
    const debtCollected = dayPayments.reduce((s, p) => s + (isCashMethod(p.method) ? p.amount : 0), 0);
    const debtCollectedElectronic = dayPayments.reduce((s, p) => s + (isCashMethod(p.method) ? 0 : p.amount), 0);

    /**
     * 🔴 المصاريف والإيرادات اليدوية: بالفرع **وبالطريقة**.
     *
     * كانت تُجمع كاملةً بلا تمييز أيٍّ منهما، رغم أن `ExpensesView` يكتب الفرع:
     *   · إيجار المحل كان يُخصم من صندوق المخزن أيضاً.
     *   · وإيجارٌ مدفوع بتحويل مصرفي كان يُخصم من الدرج وهو لم يمسّه ⟵ **فائض وهمي**.
     * والمصاريف عادةً أكبر بند خارج من الدرج، فالخطأ هنا أثقل من نظائره.
     */
    const dayTx = transactions
      .filter((t) => toDayKey(t.date) === selectedDay)
      .filter(matchesActiveBranch);
    const dayRevenue = dayTx.filter((t) => t.type === 'revenue');
    const dayExpense = dayTx.filter((t) => t.type === 'expense');
    const manualRevenue = dayRevenue.reduce((s, t) => s + (isCashMethod(t.method) ? t.amount : 0), 0);
    const manualRevenueElectronic = dayRevenue.reduce((s, t) => s + (isCashMethod(t.method) ? 0 : t.amount), 0);
    const expenses = dayExpense.reduce((s, t) => s + (isCashMethod(t.method) ? t.amount : 0), 0);
    const expensesElectronic = dayExpense.reduce((s, t) => s + (isCashMethod(t.method) ? 0 : t.amount), 0);

    // ---- نقد الموردين (خارج من الصندوق) ----
    // paidAmount في فاتورة الشراء تراكمي أيضاً: تسديد لاحق للمورد يرفعه عبر allocations. فلحساب
    // "النقد المدفوع لحظة الاستلام" نطرح من مدفوعها الحالي مجموع ما خُصِّص لها من تسديدات لاحقة —
    // نفس الحل المطبَّق في جانب الزبائن، فلا يُحتسب المبلغ مرتين (مرة كشراء ومرة كتسديد).
    const allocatedByPurchase = new Map<string, number>();
    for (const sp of supplierPayments) {
      for (const a of sp.allocations ?? []) {
        allocatedByPurchase.set(a.invoiceId, (allocatedByPurchase.get(a.invoiceId) ?? 0) + a.amount);
      }
    }
    // المستلمة فقط: المسودّة لم تُنفَّذ، والملغاة عُكست بالكامل.
    // 🔴 والفرع: الفاتورة تحمل فرعها المستلِم، وكان يُهمَل — فبضاعة استُلمت في المخزن
    // ودُفعت نقداً كانت تُخصم من صندوق المحل.
    const dayPurchases = purchaseInvoices.filter(
      (pi) => pi.status === 'received' && toDayKey(pi.date) === selectedDay && matchesActiveBranch(pi),
    );
    const purchaseCashPaid = dayPurchases.reduce((s, pi) => {
      const currentPaid = clamp(pi.paidAmount ?? 0, 0, pi.total ?? 0);
      return s + Math.max(0, currentPaid - (allocatedByPurchase.get(pi.id) ?? 0));
    }, 0);
    const supplierCredit = dayPurchases.reduce((s, pi) => s + (pi.remainingAmount ?? 0), 0);

    /**
     * تسديدات الموردين المؤرَّخة اليوم.
     *
     * 🔴 كانت تُجمع كلها كـ«نقد خرج فعلاً» بلا تمييز طريقة ولا فرع:
     *   · **الطريقة**: تحويلٌ مصرفي لمورّد بخمسة ملايين كان يُخصم من الدرج وهو لم يمسّه،
     *     فيرتفع `cashOut` ويهبط النقد المتوقَّع ⟵ يعدّ التاجر درجه فيجده أكثر من الحساب
     *     ⟵ **فائضٌ وهمي** بقيمة التحويل، فيظنّ أنه أخطأ العدّ أو أن أحداً عبث بالصندوق.
     *     وجانب الزبائن يفصلها بـ`isCashMethod` منذ زمن (سطر ١٦١) — الدخل مفصول والخرج لا.
     *   · **الفرع**: بقيّة هذا الحساب تُصفّى بـ`matchesActiveBranch`، وهذه وحدها لم تكن.
     *     فتسديدٌ دُفع من المحل يُخصم من صندوق المخزن أيضاً.
     * وغياب `method` في البيانات القديمة = كاش، وهو الصحيح تاريخياً.
     */
    const daySupplierPayments = supplierPayments
      .filter((sp) => toDayKey(sp.date) === selectedDay)
      .filter(matchesActiveBranch);
    const supplierSettled = daySupplierPayments
      .reduce((s, sp) => s + (isCashMethod(sp.method) ? (sp.amount ?? 0) : 0), 0);
    const supplierSettledElectronic = daySupplierPayments
      .reduce((s, sp) => s + (isCashMethod(sp.method) ? 0 : (sp.amount ?? 0)), 0);

    const supplierPaid = purchaseCashPaid + supplierSettled;

    const cashIn = cashSales + debtCollected + manualRevenue;
    const cashOut = expenses + supplierPaid;

    // تجميع حسب المُصدِر (للمساءلة عند وجود موظفين)
    const byEmployee = new Map<
      string,
      { name: string; sales: number; cash: number; debt: number; count: number }
    >();
    for (const inv of dayInvoices) {
      const name = inv.createdByName?.trim() || 'صاحب المحل';
      const e = byEmployee.get(name) ?? { name, sales: 0, cash: 0, debt: 0, count: 0 };
      e.sales += inv.finalAmount ?? 0;
      e.cash += initialCashOf(inv);
      e.debt += inv.remainingAmount ?? 0;
      e.count += 1;
      byEmployee.set(name, e);
    }
    const employees = [...byEmployee.values()].sort((a, b) => b.sales - a.sales);

    // تفصيل المحصَّل إلكترونياً حسب القناة — لمطابقته مع كشف البنك/المحفظة
    const electronicTotal = electronicSales + debtCollectedElectronic + manualRevenueElectronic;
    /**
     * 🟠 والمدفوع إلكترونياً كذلك — كان `supplierSettledElectronic` يُحسب ولا يُعرض في أي
     * مكان (نقصٌ من إصلاح الأمس). فالتاجر يرى أن التحويل لم يُخصم من الدرج ولا يرى أين ذهب،
     * والصندوق الإلكتروني يعرض المحصَّل وحده دون المدفوع فلا تكتمل مطابقة كشف البنك.
     */
    const electronicOut = supplierSettledElectronic + expensesElectronic;
    const byMethod = sumByMethod(
      dayInvoices.map(inv => ({ paidAmount: initialCashOf(inv), payments: inv.payments })),
    );
    for (const p of dayPayments) {
      if (isCashMethod(p.method)) continue;
      const k = (p.method ?? '').trim();
      byMethod.set(k, (byMethod.get(k) ?? 0) + p.amount);
    }
    const electronicByMethod = [...byMethod.entries()]
      .filter(([m]) => !isCashMethod(m))
      .sort((a, b) => b[1] - a[1]);

    return {
      cashSales, debtGiven, debtCollected, manualRevenue, expenses,
      electronicSales, debtCollectedElectronic, manualRevenueElectronic, expensesElectronic,
      electronicTotal, electronicOut, electronicByMethod,
      supplierPaid, purchaseCashPaid, supplierSettled, supplierSettledElectronic,
      supplierCredit, purchaseCount: dayPurchases.length,
      cashIn, cashOut, invoiceCount: dayInvoices.length, employees,
    };
  }, [invoices, payments, transactions, purchaseInvoices, supplierPayments, selectedDay, matchesActiveBranch]);

  // الفراغ يعني «بلا رأس مال افتتاحي» = صفر، أما النص غير المفهوم فيُعرض تنبيهه أدناه
  const openingRead = readAmount(openingCash);
  const openingInvalid = openingRead.state === 'invalid';
  const openingNum = openingRead.state === 'ok' ? Math.max(0, openingRead.value) : 0;
  const expectedCash = openingNum + day.cashIn - day.cashOut;
  const countedProvided = countedCash.trim() !== '' && !isNaN(parseAmount(countedCash));
  const countedNum = countedProvided ? parseAmount(countedCash) : 0;
  const difference = countedNum - expectedCash;

  // ---- تعبئة الحقول عند تبدّل اليوم (أو أول تحميل) دون الكتابة فوق ما يكتبه المستخدم ----
  // يُعبَّأ مرة واحدة لكل يوم بعد جهوز البيانات: من إقفال محفوظ إن وُجد، وإلا يُرحَّل النقد
  // المعدود من آخر إقفال سابق كرأس مال افتتاحي.
  const loadedDayRef = useRef<string>('');
  useEffect(() => {
    if (closingsLoading) return;
    // المفتاح يشمل الفرع: تبديل الفرع يعيد التعبئة من إقفالات ذلك الفرع وحده
    const loadKey = `${stampBranchId}|${selectedDay}`;
    if (loadedDayRef.current === loadKey) return;
    loadedDayRef.current = loadKey;

    // إقفالات هذا الفرع فقط (القديمة بلا فرع = الرئيسي)
    const branchClosings = closings.filter(c => (c.branchId?.trim() || MAIN_BRANCH_ID) === stampBranchId);

    const saved = branchClosings.find((c) => c.date === selectedDay);
    if (saved) {
      setOpeningCash(String(saved.openingCash));
      setCountedCash(String(saved.countedCash));
      setNotes(saved.notes || '');
      return;
    }
    const prior = branchClosings
      .filter((c) => c.date < selectedDay)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    setOpeningCash(prior ? String(prior.countedCash) : '');
    setCountedCash('');
    setNotes('');
  }, [selectedDay, closingsLoading, closings, stampBranchId]);

  // ---- حفظ إقفال اليوم ----
  const handleSave = async () => {
    if (!countedProvided || countedNum < 0) {
      triggerAlert('يرجى إدخال النقد المعدود فعلياً في الصندوق', 'danger');
      return;
    }
    const record: CashClosing = {
      id: closingDocId(selectedDay, stampBranchId),
      date: selectedDay,
      branchId: stampBranchId,
      openingCash: openingNum,
      countedCash: Math.round(countedNum),
      expectedCash: Math.round(expectedCash),
      difference: Math.round(countedNum - expectedCash),
      cashSales: Math.round(day.cashSales),
      debtCollected: Math.round(day.debtCollected),
      manualRevenue: Math.round(day.manualRevenue),
      expenses: Math.round(day.expenses),
      supplierPaid: Math.round(day.supplierPaid),
      supplierCredit: Math.round(day.supplierCredit),
      debtGiven: Math.round(day.debtGiven),
      // الجانب الإلكتروني في الأرشيف — بدونه لا تُطابَق كشوف البنك مع إقفال قديم
      electronicIn: Math.round(day.electronicTotal),
      electronicOut: Math.round(day.electronicOut),
      notes: notes.trim(),
      closedAt: Date.now(),
      closedByName: ownerName || 'صاحب المحل',
    };
    await saveClosing(record);
    void logAudit({
      action: savedClosing ? 'update' : 'create', entity: 'cash_closing', entityId: record.id,
      summary: `${savedClosing ? 'تعديل' : 'إقفال'} الصندوق ليوم ${record.date} — فرق ${record.difference}`,
      after: record as unknown as Record<string, unknown>, actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
    });
    triggerAlert(savedClosing ? 'تم تحديث إقفال اليوم ✅' : 'تم إقفال الصندوق وحفظه ✅');
  };

  /**
   * 🟠 كسر سلسلة الافتتاحي.
   *
   * الافتتاحي يُرحَّل من `countedCash` لآخر إقفال سابق **لحظة الفتح**، ثم يُخزَّن رقماً
   * ثابتاً في وثيقة اليوم. فتصحيح عدّ يوم الاثنين لا يُصحّح افتتاحي الثلاثاء، وتبقى
   * بقيّة الأسبوع محسوبةً على رقم خاطئ بلا أي إشارة. لا نُصحّح تلقائياً (قد يكون الفارق
   * مقصوداً: إيداعٌ في البنك، سحبٌ شخصي) — بل نُظهره ليقرّر التاجر.
   */
  const priorClosing = useMemo(() => {
    const branchClosings = closings.filter(c => (c.branchId?.trim() || MAIN_BRANCH_ID) === stampBranchId);
    return branchClosings
      .filter(c => c.date < selectedDay)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
  }, [closings, selectedDay, stampBranchId]);

  const openingDrift = priorClosing && openingRead.state === 'ok'
    ? Math.round(openingNum - priorClosing.countedCash)
    : 0;

  const pastClosings = useMemo(
    () => closings
      .filter(c => matchesActiveBranch(c))          // إقفالات الفرع النشط ('' = كل الفروع)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 30),
    [closings, matchesActiveBranch],
  );

  const isToday = selectedDay === todayKey();

  // صف تفصيلي في بطاقة حركة النقد
  const FlowRow = ({
    label, hint, value, sign, tone,
  }: {
    label: string; hint?: string; value: number;
    sign: '+' | '-' | '='; tone: 'in' | 'out' | 'neutral';
  }) => (
    <div className="flex items-center justify-between py-2.5">
      <div className="min-w-0">
        <span className="text-xs font-bold text-slate-700 block">{label}</span>
        {hint && <span className="text-[10px] text-slate-600 font-bold block mt-0.5">{hint}</span>}
      </div>
      <span
        className={`font-sans font-extrabold text-sm flex-shrink-0 ${
          tone === 'in' ? 'text-emerald-700' : tone === 'out' ? 'text-rose-700' : 'text-[#0B1F4D]'
        }`}
      >
        {sign === '=' ? '' : sign}
        {formatCurrency(value, currency, exchangeRate)}
      </span>
    </div>
  );

  return (
    <div className="space-y-6 font-tajawal" dir="rtl">

      {/* HEADER */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-[#0B1F4D] text-white p-6 rounded-2xl shadow-md border-b-4 border-amber-400">
        <div>
          <div className="flex items-center gap-2 text-slate-300 text-xs font-bold font-cairo">
            <Calculator className="w-3.5 h-3.5 text-emerald-400" />
            <span>الجرد النقدي والمساءلة اليومية</span>
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2">
            <Wallet className="w-6 h-6 text-amber-400" />
            <span>تقفيل الصندوق اليومي 🧮</span>
          </h2>
          <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed font-medium">
            طابق النقد المعدود في الدرج مع المتوقع من مبيعات اليوم وتسديداته ومصاريفه — واكتشف أي عجز أو فائض فوراً
          </p>
        </div>

        <div className="bg-slate-900/60 p-3 rounded-xl border border-slate-700/80 self-start md:self-center">
          {isMultiBranch && (
            <div className="mb-2 px-2 py-1 rounded-lg bg-amber-500/20 border border-amber-400/40">
              <span className="text-[10px] font-extrabold text-amber-200">
                🏢 صندوق: {branchName(stampBranchId)}
              </span>
            </div>
          )}
          {/* المخزن لا يبيع ⇒ لا صندوق له. نوضّحها بدل ترك المستخدم يحتار من الأصفار. */}
          {activeIsWarehouse && (
            <div className="mb-2 px-2 py-1.5 rounded-lg bg-indigo-500/20 border border-indigo-400/40">
              <span className="text-[10px] font-extrabold text-indigo-100 leading-relaxed block">
                🏬 هذا مخزن لا محل — لا بيع منه ولا صندوق نقد.
                بدّل إلى محل من أعلى الشاشة لتقفيل صندوقه.
              </span>
            </div>
          )}
          <label className="text-[10px] text-slate-400 font-bold block mb-1">يوم الإقفال</label>
          <input
            type="date"
            value={selectedDay}
            max={todayKey()}
            onChange={(e) => setSelectedDay(e.target.value || todayKey())}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-bold font-mono text-white outline-none focus:ring-1 focus:ring-amber-400"
          />
        </div>
      </div>

      {/* ALERT */}
      {alert && (
        <div className={`p-3 rounded-xl border text-xs font-bold flex items-center gap-2 ${
          alert.type === 'success'
            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : 'bg-rose-50 border-rose-200 text-rose-800'
        }`}>
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{alert.text}</span>
        </div>
      )}

      {savedClosing && (
        <div className="p-3 rounded-xl border border-blue-200 bg-blue-50 text-blue-800 text-xs font-bold flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <span>
            هذا اليوم مُقفَل مسبقاً بواسطة {savedClosing.closedByName}. يمكنك تعديل الأرقام وإعادة الحفظ.
          </span>
        </div>
      )}

      {/* TOP KPI STRIP */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <span className="text-[11px] font-bold text-[#5B6B86] block">الداخل للصندوق</span>
          <h3 className="text-lg font-black text-emerald-700 mt-1.5 font-sans leading-none">
            {formatCurrency(day.cashIn, currency, exchangeRate)}
          </h3>
          <span className="text-[10px] text-slate-600 font-bold block mt-1.5">مبيعات نقدية + تسديدات + إيرادات</span>
          <div className="absolute right-0 top-0 h-full w-1 bg-emerald-500" />
        </div>
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <span className="text-[11px] font-bold text-[#5B6B86] block">الخارج من الصندوق</span>
          <h3 className="text-lg font-black text-rose-700 mt-1.5 font-sans leading-none">
            {formatCurrency(day.cashOut, currency, exchangeRate)}
          </h3>
          <span className="text-[10px] text-slate-600 font-bold block mt-1.5">مصاريف ومسحوبات + مدفوعات الموردين</span>
          <div className="absolute right-0 top-0 h-full w-1 bg-rose-500" />
        </div>
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <span className="text-[11px] font-bold text-[#5B6B86] block">ديون مُنحت اليوم</span>
          <h3 className="text-lg font-black text-amber-700 mt-1.5 font-sans leading-none">
            {formatCurrency(day.debtGiven, currency, exchangeRate)}
          </h3>
          <span className="text-[10px] text-slate-600 font-bold block mt-1.5">لم تدخل الصندوق (بيع بالآجل)</span>
          <div className="absolute right-0 top-0 h-full w-1 bg-amber-500" />
        </div>
        <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm relative overflow-hidden">
          <span className="text-[11px] font-bold text-[#5B6B86] block">فواتير اليوم</span>
          <h3 className="text-lg font-black text-[#0B1F4D] mt-1.5 font-sans leading-none">
            {toArabicDigits(day.invoiceCount)}
          </h3>
          <span className="text-[10px] text-slate-600 font-bold block mt-1.5">عدد الوصولات المسجّلة</span>
          <div className="absolute right-0 top-0 h-full w-1 bg-[#0B1F4D]" />
        </div>
      </div>

      {/* MAIN GRID: flow + reconciliation */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* Cash flow breakdown */}
        <div className="lg:col-span-7 bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <HandCoins className="w-5 h-5 text-emerald-700" />
            <h4 className="font-extrabold text-sm text-[#0B1F4D] font-cairo">حركة نقد الصندوق ليوم {formatDayAr(selectedDay)}</h4>
          </div>
          <div className="px-5 py-2 divide-y divide-slate-50">
            <FlowRow
              label="رأس المال الافتتاحي"
              hint="النقد الموجود في الدرج بداية اليوم"
              value={openingNum}
              sign="="
              tone="neutral"
            />
            <FlowRow
              label="مبيعات نقدية"
              hint="المحصّل نقداً من فواتير اليوم"
              value={day.cashSales}
              sign="+"
              tone="in"
            />
            <FlowRow
              label="تسديدات ديون"
              hint="دفعات وردت اليوم عن فواتير سابقة"
              value={day.debtCollected}
              sign="+"
              tone="in"
            />
            <FlowRow
              label="إيرادات يدوية"
              hint="واردات سُجّلت في المصاريف والأرباح"
              value={day.manualRevenue}
              sign="+"
              tone="in"
            />
            <FlowRow
              label="مصاريف ومسحوبات"
              hint="ما صُرف من الصندوق اليوم"
              value={day.expenses}
              sign="-"
              tone="out"
            />
            <FlowRow
              label="مدفوعات الموردين"
              hint="نقد فواتير الشراء + تسديد ذمم الموردين"
              value={day.supplierPaid}
              sign="-"
              tone="out"
            />
          </div>

          {/* 🟠 المدفوع إلكترونياً — كان يُحسب ولا يُعرض، فلا يعرف التاجر أين ذهب المال */}
          {day.electronicOut > 0 && (
            <div className="mx-5 mb-3 p-3 rounded-xl border border-indigo-200 bg-indigo-50/70">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-extrabold text-indigo-900 block">مدفوع إلكترونياً (لم يخرج من الدرج)</span>
                  <span className="text-[10px] text-indigo-700 font-bold">تحويلات ومحافظ — طابقه مع كشف البنك</span>
                </div>
                <span className="font-sans font-black text-sm text-indigo-800">
                  {formatCurrency(day.electronicOut, currency, exchangeRate)}
                </span>
              </div>
              <div className="mt-2 pt-2 border-t border-indigo-200/70 space-y-1 text-[11px]">
                {day.supplierSettledElectronic > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-indigo-800">تسديد موردين</span>
                    <span className="font-extrabold font-sans text-indigo-900">{formatCurrency(day.supplierSettledElectronic, currency, exchangeRate)}</span>
                  </div>
                )}
                {day.expensesElectronic > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-indigo-800">مصاريف</span>
                    <span className="font-extrabold font-sans text-indigo-900">{formatCurrency(day.expensesElectronic, currency, exchangeRate)}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* المحصَّل إلكترونياً — خارج حساب الدرج تماماً (بطاقات/محافظ/تحويل) */}
          {day.electronicTotal > 0 && (
            <div className="mx-5 mb-4 p-3 rounded-xl border border-blue-200 bg-blue-50/70">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-extrabold text-blue-900 block">محصَّل إلكترونياً (لا يدخل الدرج)</span>
                  <span className="text-[10px] text-blue-700 font-bold">بطاقات ومحافظ وتحويل — طابقه مع كشف البنك</span>
                </div>
                <span className="font-sans font-black text-sm text-blue-800">
                  {formatCurrency(day.electronicTotal, currency, exchangeRate)}
                </span>
              </div>
              {day.electronicByMethod.length > 0 && (
                <div className="mt-2 pt-2 border-t border-blue-200/70 space-y-1">
                  {day.electronicByMethod.map(([method, amount]) => (
                    <div key={method} className="flex items-center justify-between text-[11px]">
                      <span className="font-bold text-blue-800">{method}</span>
                      <span className="font-extrabold font-sans text-blue-900">
                        {formatCurrency(amount, currency, exchangeRate)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="px-5 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
            <div>
              <span className="text-xs font-extrabold text-[#0B1F4D] block">المتوقع في الصندوق</span>
              <span className="text-[10px] text-slate-600 font-bold">الافتتاحي + الداخل − الخارج</span>
            </div>
            <span className="font-sans font-black text-lg text-[#0B1F4D]">
              {formatCurrency(expectedCash, currency, exchangeRate)}
            </span>
          </div>
        </div>

        {/* Reconciliation input + result */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm p-5 space-y-4">

            <div>
              <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">
                رأس المال الافتتاحي (د.ع)
              </label>
              <NumberInput inputMode="decimal"
                value={openingCash}
                onValueChange={(v) => setOpeningCash(v)}
                placeholder="النقد بداية اليوم — مثال: 100000"
                className={`w-full px-4 py-2.5 bg-slate-50 border rounded-xl text-sm font-bold text-center ${
                  openingInvalid ? 'border-rose-400 text-rose-700' : 'border-slate-200'
                }`}
              />
              {openingInvalid && (
                <p className="text-[10px] text-rose-700 font-bold mt-1 text-center">
                  قيمة غير مفهومة — تُحتسب صفراً حتى تُصحَّح
                </p>
              )}
              <p className="text-[10px] text-slate-600 font-bold mt-1 text-center">
                يُرحَّل تلقائياً من النقد المعدود في إقفال اليوم السابق
              </p>
              {openingDrift !== 0 && (
                <p className="text-[10px] text-amber-800 font-bold mt-1.5 text-center bg-amber-50 border border-amber-200 rounded-lg p-2 leading-relaxed">
                  ⚠️ يختلف عن معدود {formatDayAr(priorClosing!.date)} ({formatCurrency(priorClosing!.countedCash, currency, exchangeRate)})
                  بمقدار {openingDrift > 0 ? '+' : '−'}{formatCurrency(Math.abs(openingDrift), currency, exchangeRate)}.
                  إن كان الفارق مقصوداً (إيداع أو سحب) فاكتبه في الملاحظة، وإلا فراجع إقفال ذلك اليوم.
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">
                النقد المعدود فعلياً في الصندوق (د.ع)
              </label>
              <NumberInput inputMode="decimal"
                value={countedCash}
                onValueChange={(v) => setCountedCash(v)}
                placeholder="عُدّ الدرج واكتب الناتج"
                className="w-full px-4 py-3 bg-amber-50 border-2 border-amber-200 rounded-xl text-base font-black text-center focus:border-amber-400 outline-none"
                autoFocus
              />
            </div>

            {/* Difference result */}
            {countedProvided ? (
              <div
                className={`rounded-xl p-4 text-center border-2 ${
                  difference === 0
                    ? 'bg-emerald-50 border-emerald-300'
                    : difference > 0
                      ? 'bg-blue-50 border-blue-300'
                      : 'bg-rose-50 border-rose-300'
                }`}
              >
                <div className="flex items-center justify-center gap-1.5">
                  {difference === 0 ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-700" />
                  ) : difference > 0 ? (
                    <TrendingUp className="w-5 h-5 text-blue-600" />
                  ) : (
                    <TrendingDown className="w-5 h-5 text-rose-700" />
                  )}
                  <span
                    className={`text-sm font-extrabold ${
                      difference === 0 ? 'text-emerald-800' : difference > 0 ? 'text-blue-800' : 'text-rose-800'
                    }`}
                  >
                    {difference === 0 ? 'الصندوق مطابق تماماً 🎯' : difference > 0 ? 'فائض في الصندوق' : 'عجز في الصندوق'}
                  </span>
                </div>
                {difference !== 0 && (
                  <p
                    className={`font-sans font-black text-xl mt-1.5 ${
                      difference > 0 ? 'text-blue-700' : 'text-rose-700'
                    }`}
                  >
                    {difference > 0 ? '+' : '-'}
                    {formatCurrency(Math.abs(difference), currency, exchangeRate)}
                  </p>
                )}
                <p className="text-[10px] text-slate-600 font-bold mt-1">
                  المعدود {formatCurrency(countedNum, currency, exchangeRate)} مقابل متوقّع{' '}
                  {formatCurrency(expectedCash, currency, exchangeRate)}
                </p>
              </div>
            ) : (
              <div className="rounded-xl p-4 text-center border-2 border-dashed border-slate-200 bg-slate-50">
                <span className="text-xs font-bold text-slate-500">
                  أدخل النقد المعدود لتظهر نتيجة المطابقة
                </span>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">
                ملاحظة <span className="text-slate-500 font-normal">(اختياري)</span>
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="مثال: سبب العجز، سحب شخصي، فكة ناقصة..."
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-right"
              />
            </div>

            {/* الإقفال كتابةٌ — على الهاتف تُقرأ الأرقام ولا تُثبَّت */}
            <DesktopOnly>
              <button
                onClick={handleSave}
                className="w-full py-3 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-sm shadow transition cursor-pointer flex items-center justify-center gap-2 active:scale-95"
              >
                <Save className="w-4 h-4" />
                <span>{savedClosing ? 'تحديث إقفال اليوم' : 'إقفال الصندوق وحفظه'}</span>
              </button>
            </DesktopOnly>
            <ViewOnlyNote what="حركة صندوقك والمتوقّع فيه" />
          </div>
        </div>
      </div>

      {/* PER-EMPLOYEE ACCOUNTABILITY */}
      {day.employees.length > 0 && (
        <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <Users className="w-5 h-5 text-indigo-600" />
            <h4 className="font-extrabold text-sm text-[#0B1F4D] font-cairo">مبيعات اليوم حسب المُصدِر</h4>
            <span className="text-[10px] bg-slate-100 text-slate-600 font-extrabold px-2.5 py-0.5 rounded-full mr-auto">
              {toArabicDigits(day.employees.length)} مُصدِر
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 font-bold border-b border-slate-100">
                  <th className="text-right px-5 py-2.5 font-bold">المُصدِر</th>
                  <th className="text-left px-3 py-2.5 font-bold">الفواتير</th>
                  <th className="text-left px-3 py-2.5 font-bold">المبيعات</th>
                  <th className="text-left px-3 py-2.5 font-bold text-emerald-700">نقد محصّل</th>
                  <th className="text-left px-5 py-2.5 font-bold text-amber-700">دين مُنح</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {day.employees.map((e) => (
                  <tr key={e.name} className="hover:bg-slate-50 transition">
                    <td className="px-5 py-3 font-extrabold text-[#0B1F4D] whitespace-nowrap">{e.name}</td>
                    <td className="px-3 py-3 text-left font-bold text-slate-500 font-sans">{toArabicDigits(e.count)}</td>
                    <td className="px-3 py-3 text-left font-bold text-slate-700 font-sans whitespace-nowrap">
                      {formatCurrency(e.sales, currency, exchangeRate)}
                    </td>
                    <td className="px-3 py-3 text-left font-extrabold text-emerald-700 font-sans whitespace-nowrap">
                      {formatCurrency(e.cash, currency, exchangeRate)}
                    </td>
                    <td className="px-5 py-3 text-left font-extrabold text-amber-700 font-sans whitespace-nowrap">
                      {formatCurrency(e.debt, currency, exchangeRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* PAST CLOSINGS HISTORY */}
      <div className="bg-white rounded-2xl border border-[#E4EAF3] shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
          <History className="w-5 h-5 text-slate-500" />
          <h4 className="font-extrabold text-sm text-[#0B1F4D] font-cairo">سجل الإقفالات السابقة</h4>
        </div>
        {pastClosings.length === 0 ? (
          <div className="py-14 text-center text-slate-500 font-bold text-xs">
            لا توجد إقفالات محفوظة بعد — أقفل صندوق اليوم ليبدأ السجل
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {pastClosings.map((c) => {
              /**
               * 🔴 كان السجل يستعمل `c.id` كأنه تاريخ في ثلاثة مواضع. ومعرّف الوثيقة هو
               * التاريخ **للفرع الرئيسي وحده**؛ ولبقية الفروع `فرع_تاريخ` (بحكم
               * `closingDocId` أعلاه). فصاحب فرعين ينقر إقفالاً سابقاً فيصير `selectedDay`
               * نصّاً لا يطابق أي تاريخ ⟵ كل الأرقام أصفار، وحقل التاريخ يفرغ، والسطر
               * يعرض المعرّف الخام. قِسْتُها: `toDayKey('branch_…_2026-08-13')` تُرجع `''`
               * و`new Date(...)` تُرجع Invalid Date. والحقل الصحيح `c.date` بجواره.
               */
              const isSel = c.date === selectedDay;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedDay(c.date)}
                  className={`w-full flex items-center justify-between px-5 py-3.5 text-right transition cursor-pointer ${
                    isSel ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${
                        c.difference === 0
                          ? 'bg-emerald-50 text-emerald-700'
                          : c.difference > 0
                            ? 'bg-blue-50 text-blue-600'
                            : 'bg-rose-50 text-rose-700'
                      }`}
                    >
                      <Banknote className="w-4.5 h-4.5" />
                    </span>
                    <div className="min-w-0">
                      <span className="text-xs font-extrabold text-[#0B1F4D] block">{formatDayAr(c.date)}</span>
                      <span className="text-[10px] text-slate-600 font-bold block mt-0.5">
                        معدود {formatCurrency(c.countedCash, currency, exchangeRate)} · متوقّع{' '}
                        {formatCurrency(c.expectedCash, currency, exchangeRate)}
                      </span>
                    </div>
                  </div>
                  <span
                    className={`flex-shrink-0 text-[11px] font-extrabold px-2.5 py-1 rounded-full flex items-center gap-1 ${
                      c.difference === 0
                        ? 'bg-emerald-100 text-emerald-800'
                        : c.difference > 0
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-rose-100 text-rose-800'
                    }`}
                  >
                    {c.difference === 0 ? (
                      <>مطابق <CheckCircle2 className="w-3 h-3" /></>
                    ) : c.difference > 0 ? (
                      <>فائض {formatCurrency(c.difference, currency, exchangeRate)} <ArrowUpRight className="w-3 h-3" /></>
                    ) : (
                      <>عجز {formatCurrency(Math.abs(c.difference), currency, exchangeRate)} <ArrowDownRight className="w-3 h-3" /></>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {!isToday && (
        <p className="text-[11px] text-center text-slate-500 font-bold">
          أنت تستعرض يوماً سابقاً. اختر تاريخ اليوم من الأعلى للعودة إلى إقفال اليوم الحالي.
        </p>
      )}
    </div>
  );
}
