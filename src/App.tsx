import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { useProfile } from './hooks/useProfile';
import { useEmployeeDebtFold } from './hooks/useEmployeeDebtFold';
import { useBuyPriceMigration } from './hooks/useBuyPriceMigration';
import { useBranchStockMigration } from './hooks/useBranchStockMigration';
import { useAutoBackup } from './hooks/useAutoBackup';
import { useHardwareBack } from './hooks/useHardwareBack';
import { useAppUpdate } from './hooks/useAppUpdate';
import { useLicense } from './hooks/useLicense';
import { useTrialAnchor } from './hooks/useTrialAnchor';
import { trialStateOf, trialEndsAtISO } from './utils/trialPeriod';
import { SessionProvider, useSession } from './context/SessionContext';
import { UserProfile, SystemSettings } from './types';
import EmployeeShell, { EmployeeDisabledScreen } from './components/EmployeeShell';
import LoginView from './components/LoginView';
import LicenseGateView from './components/LicenseGateView';
import DashboardLayout from './components/DashboardLayout';
import ErrorBoundary from './components/ErrorBoundary';
import GeneralDashboard from './components/GeneralDashboard';
import CustomersView from './components/CustomersView';
import InvoicesView from './components/InvoicesView';
import ExpensesView from './components/ExpensesView';
import BackupView from './components/BackupView';
import SettingsView from './components/SettingsView';
import ProductsView from './components/ProductsView';
import ReportsView from './components/ReportsView';
import DebtView from './components/DebtView';
import CashClosingView from './components/CashClosingView';
import SplashScreen from './components/SplashScreen';
import AdminPanel from './components/AdminPanel';
import SuppliersView from './components/SuppliersView';
import PurchaseInvoicesView from './components/PurchaseInvoicesView';
import SupplierAccountsView from './components/SupplierAccountsView';
import InventoryAdjustmentsView from './components/InventoryAdjustmentsView';
import WarrantyLookupView from './components/WarrantyLookupView';
import InstallmentsView from './components/InstallmentsView';
import BranchesView from './components/BranchesView';
import StockTransfersView from './components/StockTransfersView';
import ExpiryView from './components/ExpiryView';
import GuideView from './components/GuideView';
import { ADMIN_UID } from './config/adminConfig';
import { OWNER_GUIDE, SCREEN_LABELS } from './utils/screenGuide';
import BranchComparisonView from './components/BranchComparisonView';
import DecisionReportsView from './components/DecisionReportsView';
import AuditLogView from './components/AuditLogView';
import { reportFirestoreError } from './utils/writeGuard';
import UpdateBanner from './components/UpdateBanner';

// مدة الفترة التجريبية (TRIAL_DAYS) انتقلت إلى utils/trialPeriod.ts مع منطق الحساب كلّه —
// مصدر واحد يستخدمه حساب المالك ومزامنة public/info للموظف، ومحروسٌ باختبارات.

/**
 * قشرة التطبيق بعد المصادقة — تعيش داخل SessionProvider فتستطيع قراءة الجلسة.
 * useProfile يقرأ ownerUid من الجلسة (للمالك = uid نفسه ⇒ سلوك مطابق للسابق).
 */
function OwnerShell({ uid, email, authLoading }: { uid: string | null; email: string; authLoading: boolean }) {
  const [activeTabRaw, setActiveTabRaw] = useState('dashboard');
  const [purchaseSupplierId, setPurchaseSupplierId] = useState<string | null>(null);

  /**
   * 🔴 زرّ الرجوع في أندرويد كان **يُغلق التطبيق من أي شاشة** — لا Router في
   * البرنامج ولا سجلّ متصفّح. المكدّس في `utils/navHistory.ts` والوصل بالمنصّة
   * في `hooks/useHardwareBack.ts`؛ وهو يخدم زرّ رجوع أندرويد ورجوعَ المتصفّح
   * في نسخة الآيفون (PWA) بالمنطق نفسه.
   *
   * `navBack` هو الانتقال **بلا تسجيل**: الرجوع يجب ألا يُضيف خطوةً جديدة وإلا
   * دار المستخدم بين شاشتين بلا وصولٍ إلى الجذر أبداً.
   */
  const [exitHint, setExitHint] = useState(false);
  const navHistory = useHardwareBack({
    onNavigate: setActiveTabRaw,
    onExitHint: () => {
      setExitHint(true);
      setTimeout(() => setExitHint(false), 2000);
    },
  });

  const setActiveTab = useCallback((tab: string) => {
    navHistory.push(tab);
    setActiveTabRaw(tab);
  }, [navHistory]);

  const activeTab = activeTabRaw;

  // بلا متجرٍ لا تحديث تلقائي — فحصٌ واحد عند الإقلاع يُغني عن مكالمةٍ لكل تاجر
  const appUpdate = useAppUpdate(!authLoading);
  const session = useSession();
  const { profileData, settings, loading: profileLoading, saveProfile } = useProfile();

  // الترخيص مشتقّ من وثيقة كود التفعيل (usedBy==uid) لا من حقل قابل للكتابة في وثيقة المستخدم (Fix A)
  const { licensed: isLicenseActive, loading: licenseLoading } = useLicense(uid, profileData.activationCode);

  // الطي التلقائي لديون الموظفين في customer.balance — جلسة المالك فقط، تفاعلي مستمر طوال
  // الجلسة (لا "مرة واحدة"): الموظف قد ينشئ فاتورة دين في أي لحظة أثناء انفتاح الجلسة،
  // فيُعاد التقييم مع كل تحديث حي لبيانات invoices/customers. إضافة صامتة لا تغيّر سلوك المالك.
  useEmployeeDebtFold();

  // ترحيل buyPrice المضمّن (الموروث) إلى product_costs — جلسة المالك فقط، مرة واحدة، idempotent.
  // مستدعى هنا (مستوى الجلسة) لا من داخل ProductsView: يعمل فور بداية الجلسة بصرف النظر عن
  // التبويب المفتوح، فيغلق ثغرة تسرّب buyPrice لموظف قبل أن يزور المالك تبويب المنتجات.
  useBuyPriceMigration();

  // تهيئة خريطة مخزون الفروع للمنتجات القديمة — يمنع ظهور كميات سالبة عند أول بيع بعد
  // تفعيل الفروع. جلسة المالك فقط، idempotent، صامت تماماً.
  useBranchStockMigration();

  /**
   * ---- حالة التجربة المجانية ----
   *
   * 🔴 كان الحساب مضمَّناً في هذه الشاشة على مُدخَلَين **كلاهما بيد المستخدم**:
   * `createdAt` (حقلٌ يملك كتابته وحذفه) و`Date.now()` (ساعة جهازه). انتقل إلى
   * `utils/trialPeriod.ts` ليُحسب من مرساةٍ يختمها الخادم ومن «الآن» الذي لا تُقصّره
   * ساعةٌ مُرجَعة، ولِيُحرَس باختبارات.
   *
   * ويُحسب **قبل** مستهلكيه (مزامنة public/info والبوابة) فيبقى مصدراً واحداً: ما يراه
   * الموظف من نهاية التجربة هو نفسه ما تحسب به بوابة المالك.
   */
  const trial = trialStateOf({
    licensed: isLicenseActive,
    trialStartedAtMs: profileData.trialStartedAt as number | null | undefined,
    legacyCreatedAt: profileData.createdAt,
    lastSeenAtMs: profileData.lastSeenAt as number | null | undefined,
    deviceNowMs: Date.now(),
  });

  // ختم المرساة ونبضة وقت الخادم — جلسة المالك فقط: المرساة مرة واحدة، والنبضة كل ٦ ساعات
  useTrialAnchor(!profileLoading, isLicenseActive, profileData.trialStartedAt, profileData.lastSeenAt);

  // مزامنة public/info (متطلب أ): إسقاط عام يقرؤه الموظف (اسم/شعار/عملة/سعر صرف) — بروفايل المالك محجوب عنه.
  // نضمّنه أيضاً حالة الترخيص (licenseActive + trialEndsAt) ليتمكّن الموظف من احترام بوابة الترخيص
  // دون قراءة بروفايل المالك. trialEndsAt طابع زمني مطلق ⇒ الموظف يحسب الانتهاء محلياً ولا ينتظر
  // أن يفتح المالك التطبيق. كتابة مالك فقط، fire-and-forget، لا تتكرّر إلا عند تغيّر أحد الحقول.
  const publicInfoRef = useRef<string>('');
  useEffect(() => {
    if (session.role !== 'owner' || !session.ownerUid || profileLoading || licenseLoading) return;
    // مشتقّ من كود التفعيل (Fix A) — فيرث الموظف نفس الحماية بدل الوثوق بحقل قابل للتزوير
    const licenseActive = isLicenseActive;
    // المرساة نفسها التي تحسب بها البوابة — مصدرٌ واحد فلا يفترق ما يراه الموظف عمّا يراه المالك
    const trialEndsAt = trialEndsAtISO(trial.anchorMs);

    const payload = {
      storeName: profileData.storeName ?? '',
      logoUrl: profileData.logoUrl ?? '',
      // عنوان صاحب العمل وهاتف المحل — معلومات المحل العامة، تظهر في ترويسة فواتير الموظف المطبوعة
      address: profileData.address ?? '',
      phone: profileData.phone ?? '',
      currency: settings.currency,
      exchangeRate: settings.exchangeRate,
      // صيغة الطباعة تُنشر للموظف: بروفايل المالك محجوب عنه، وهذه وثيقته الوحيدة المقروءة
      printFormat: settings.printFormat ?? 'a4',
      licenseActive,
      trialEndsAt,
    };
    const key = JSON.stringify(payload);
    if (key === publicInfoRef.current) return;
    publicInfoRef.current = key;
    setDoc(doc(db, 'users', session.ownerUid, 'public', 'info'), payload, { merge: true })
      .catch(err => reportFirestoreError('public_info', 'save', err, '[Firestore] public/info sync'));
  }, [
    session.role, session.ownerUid, profileLoading, licenseLoading, isLicenseActive,
    profileData.storeName, profileData.logoUrl, profileData.address, profileData.phone, profileData.createdAt,
    settings.currency, settings.exchangeRate, settings.printFormat,
  ]);

  const user: UserProfile | null = uid ? {
    uid,
    email,
    storeName: profileData.storeName ?? '',
    ownerName: profileData.ownerName ?? '',
    phone: profileData.phone ?? '',
    address: profileData.address,
    logoUrl: profileData.logoUrl,
    businessType: profileData.businessType ?? 'general',
    plan: profileData.plan ?? 'free',
    activationStatus: profileData.activationStatus ?? false,
    licenseStatus: profileData.licenseStatus ?? 'trial',
    createdAt: profileData.createdAt ?? new Date().toISOString(),
    activationCode: profileData.activationCode,
    activatedAt: profileData.activatedAt,
    syncRenewalExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  } : null;

  // أثناء تحميل حالة الكود لا نُظهر البانر ولا البوابة (يخصّ فقط من له كود مخزَّن)
  const trialDaysRemaining: number | null =
    !user || licenseLoading ? null : trial.daysRemaining;

  const isTrialExpired = trialDaysRemaining !== null && trialDaysRemaining <= 0;

  const handleLogout = async () => {
    await signOut(auth);
    setActiveTab('dashboard');
    setPurchaseSupplierId(null);
  };

  const openPurchaseForSupplier = (supplierId: string) => {
    setPurchaseSupplierId(supplierId);
    setActiveTab('purchase-invoices');
  };

  const updateSettings = (newSettings: Partial<SystemSettings>) => {
    saveProfile(newSettings);
  };

  // النسخ الاحتياطي التلقائي المجدول (جلسة المالك فقط) — يحترم autoBackup/backupInterval.
  // ready = اكتمال تحميل البروفايل حتى لا يُطلَق على إعدادات افتراضية عابرة.
  useAutoBackup(
    {
      uid: uid ?? '',
      storeName: profileData.storeName ?? '',
      ownerName: profileData.ownerName ?? '',
      businessType: profileData.businessType ?? 'general',
    },
    settings,
    !profileLoading,
    updateSettings,
  );

  const updateUserProfile = (newUser: Partial<UserProfile>) => {
    // Strip fields that belong to Firebase Auth or are computed, not persisted in Firestore
    const { uid: _u, email: _e, syncRenewalExpiry: _s, createdAt: _c, ...persistable } = newUser as any;
    if (Object.keys(persistable).length) saveProfile(persistable);
  };

  const renderActiveTabView = () => {
    if (!user) return null;

    switch (activeTab) {
      case 'dashboard':
        return <GeneralDashboard currency={settings.currency} exchangeRate={settings.exchangeRate} onGo={setActiveTab} />;
      case 'customers':
        return <CustomersView currency={settings.currency} exchangeRate={settings.exchangeRate} storeName={user.storeName} storeAddress={user.address} storePhone={user.phone} />;
      case 'products':
        return (
          <ProductsView
            currency={settings.currency}
            exchangeRate={settings.exchangeRate}
            settings={settings}
            updateSettings={updateSettings}
            storeName={user.storeName}
          />
        );
      case 'invoices':
        return <InvoicesView currency={settings.currency} exchangeRate={settings.exchangeRate} ownerName={user.ownerName} storeName={user.storeName} storeAddress={user.address} storePhone={user.phone} customPaymentMethods={settings.customPaymentMethods} printFormat={settings.printFormat} />;
      case 'expenses':
        return (
          <ExpensesView
            currency={settings.currency}
            exchangeRate={settings.exchangeRate}
            updateSettings={updateSettings}
          />
        );
      case 'debts':
        return <DebtView currency={settings.currency} exchangeRate={settings.exchangeRate} storeName={user.storeName} customPaymentMethods={settings.customPaymentMethods} />;
      case 'suppliers':
        return <SuppliersView currency={settings.currency} exchangeRate={settings.exchangeRate} onCreatePurchaseFor={openPurchaseForSupplier} />;
      case 'purchase-invoices':
        return <PurchaseInvoicesView currency={settings.currency} exchangeRate={settings.exchangeRate} initialSupplierId={purchaseSupplierId} onConsumedInitialSupplier={() => setPurchaseSupplierId(null)} />;
      case 'supplier-accounts':
        return <SupplierAccountsView currency={settings.currency} exchangeRate={settings.exchangeRate} customPaymentMethods={settings.customPaymentMethods} />;
      case 'inventory-adjustments':
        return <InventoryAdjustmentsView currency={settings.currency} exchangeRate={settings.exchangeRate} />;
      case 'warranty':
        return <WarrantyLookupView currency={settings.currency} exchangeRate={settings.exchangeRate} />;
      case 'branches':
        return <BranchesView storeName={user.storeName} />;
      case 'guide':
        return (
          <GuideView
            labelOf={(id) => SCREEN_LABELS[id] ?? id}
            onGo={setActiveTab}
            isVisible={(id) => (id === 'admin' ? user.uid === ADMIN_UID : !!OWNER_GUIDE[id])}
          />
        );
      case 'expiry':
        return <ExpiryView currency={settings.currency} exchangeRate={settings.exchangeRate} settings={settings} />;
      case 'stock-transfers':
        return <StockTransfersView />;
      case 'decision-reports':
        return <DecisionReportsView currency={settings.currency} exchangeRate={settings.exchangeRate} storeName={user.storeName} />;
      case 'branch-performance':
        return <BranchComparisonView currency={settings.currency} exchangeRate={settings.exchangeRate} />;
      case 'installments':
        return <InstallmentsView currency={settings.currency} exchangeRate={settings.exchangeRate} storeName={user.storeName} customPaymentMethods={settings.customPaymentMethods} />;
      case 'audit-log':
        return <AuditLogView />;
      case 'cashclosing':
        return (
          <CashClosingView
            currency={settings.currency}
            exchangeRate={settings.exchangeRate}
            ownerName={user.ownerName}
          />
        );
      case 'reports':
        return <ReportsView user={user} settings={settings} />;
      case 'backup':
        return <BackupView user={user} settings={settings} updateSettings={updateSettings} />;
      case 'settings':
        return (
          <SettingsView
            user={user}
            settings={settings}
            updateUser={updateUserProfile}
            updateSettings={updateSettings}
            saveProfile={saveProfile}
            isLicensed={isLicenseActive}
          />
        );
      case 'admin':
        return <AdminPanel uid={uid!} />;
      default:
        return <GeneralDashboard currency={settings.currency} exchangeRate={settings.exchangeRate} />;
    }
  };

  // حسم الجلسة (مالك/موظف) جزء من التحميل — للمالك فوري عملياً (تلميح محلي أو snapshot واحد)
  if (authLoading || session.loading || profileLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#EEF2F8]">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-[#0B1F4D] border-t-transparent" />
      </div>
    );
  }

  // 🔴 `select-none` أُزيل من الجذر: كان يمنع تحديد النصّ في **كل** البرنامج،
  // فلا يستطيع التاجر نسخ رقم فاتورة ولا رقم هاتف زبون — لا باللمس المطوّل على
  // الهاتف ولا بالسحب على الكمبيوتر. والعناصر التي يجب ألا تُحدَّد (التسميات
  // والشارات وأزرار التبويب) تحمل `select-none` بنفسها في ٦٠+ موضعاً، فبقيت كما
  // هي. النتيجة: القشرة غير قابلة للتحديد كما كانت، والبيانات صارت تُنسخ.
  return (
    <div className="min-h-screen bg-[#EEF2F8] text-right" dir="rtl">
      {/* تلميح الخروج — يظهر عند أول ضغطةٍ على «رجوع» في الشاشة الجذر.
          ضغطةٌ واحدة كانت ستُخرج التاجر من برنامجه بلمسةٍ عرَضية في منتصف يومه. */}
      {exitHint && (
        <div
          role="status"
          className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[100] bg-slate-900/90 text-white text-xs font-bold px-4 py-2.5 rounded-full shadow-lg pointer-events-none"
        >
          اضغط «رجوع» مرّةً أخرى للخروج
        </div>
      )}
      <AnimatePresence mode="wait">
        {!user ? (
          <motion.div
            key="login"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <LoginView />
          </motion.div>
        ) : isTrialExpired ? (
          <motion.div
            key="license-gate"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <LicenseGateView
              uid={uid!}
              ownerName={user.ownerName}
              onLogout={handleLogout}
            />
          </motion.div>
        ) : (
          <motion.div
            key="dashboard-layout"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
          >
            <DashboardLayout
              user={user}
              settings={settings}
              updateSettings={updateSettings}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              onLogout={handleLogout}
              trialDaysRemaining={trialDaysRemaining}
            >
              {/* فوق حاجز الأخطاء عمداً: انهيار شاشةٍ لا يجوز أن يُخفي إشعار التحديث
                  — وقد يكون التحديث نفسه هو إصلاح ذلك الانهيار. */}
              <UpdateBanner update={appUpdate} />
              {/* حاجز داخلي: انهيار شاشة لا يُسقط القائمة والرأس، فيستطيع التاجر
                  الانتقال لشاشة أخرى ومتابعة عمله بدل توقّف المحل */}
              <ErrorBoundary screen={activeTab} resetKey={activeTab} inline onGoHome={() => setActiveTab('dashboard')}>
                {renderActiveTabView()}
              </ErrorBoundary>
            </DashboardLayout>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * يوجّه بعد حسم الجلسة: موظف نشط → قشرة الموظف؛ موظف معطّل → شاشة التعطيل؛
 * وإلا (مالك أو غير مسجّل أو أثناء الحسم) → OwnerShell كما هو حرفياً (يعالج الدخول/الترخيص/التحميل).
 */
function SessionRouter({ uid, email, authLoading }: { uid: string | null; email: string; authLoading: boolean }) {
  const session = useSession();
  const handleLogout = async () => { await signOut(auth); };

  if (uid && !authLoading && !session.loading && session.role === 'employee') {
    if (session.disabled) return <EmployeeDisabledScreen onLogout={handleLogout} />;
    if (session.ownerUid) return <EmployeeShell ownerUid={session.ownerUid} onLogout={handleLogout} />;
  }

  return <OwnerShell uid={uid} email={email} authLoading={authLoading} />;
}

export default function App() {
  const [uid, setUid] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [authLoading, setAuthLoading] = useState(true);
  const [showSplash, setShowSplash] = useState(false);
  const splashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // undefined = auth not yet resolved; null = logged out; string = logged in uid
  const prevUidRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      const prevUid = prevUidRef.current;
      const newUid = firebaseUser?.uid ?? null;

      // Show splash when transitioning TO a logged-in state:
      // - prevUid undefined means first auth check just resolved
      // - prevUid null means user just signed in from the login screen
      if (newUid && (prevUid === undefined || prevUid === null)) {
        if (splashTimerRef.current) clearTimeout(splashTimerRef.current);
        setShowSplash(true);
        splashTimerRef.current = setTimeout(() => setShowSplash(false), 2500);
      }

      prevUidRef.current = newUid;

      if (firebaseUser) {
        setUid(firebaseUser.uid);
        setEmail(firebaseUser.email || '');
      } else {
        setUid(null);
        setEmail('');
      }
      setAuthLoading(false);
    });
    return () => {
      unsubscribe();
      if (splashTimerRef.current) clearTimeout(splashTimerRef.current);
    };
  }, []);

  return (
    <>
      {/* Splash: always in render tree so AnimatePresence exit animation works.
          z-[9999] means it covers the spinner or app underneath. */}
      <AnimatePresence>
        {showSplash && (
          <motion.div
            key="splash"
            className="fixed inset-0 z-[9999]"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45, ease: 'easeInOut' }}
          >
            <SplashScreen />
          </motion.div>
        )}
      </AnimatePresence>

      <SessionProvider uid={uid}>
        <SessionRouter uid={uid} email={email} authLoading={authLoading} />
      </SessionProvider>
    </>
  );
}
