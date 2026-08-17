import React, { useState, useMemo } from 'react';
import {
  Bot, Bell, RefreshCw, LogOut, Settings, Users,
  FileText, TrendingUp, Shield, Landmark, Store, Package, BarChart3, Banknote, Key,
  WifiOff, PanelRightClose, PanelRightOpen, Calculator, Phone, Truck, ReceiptText, ClipboardList, ShieldCheck,
  CalendarClock, Building2, ArrowLeftRight, Trophy, Target, ChevronDown, ChevronLeft, CalendarX2, HelpCircle, BookOpen
} from 'lucide-react';
import { useBranches } from '../hooks/useBranches';
import { visibleStock } from '../utils/branchStock';
import { expiryStatus, STAGE_LABEL } from '../utils/expiry';
import { todayISO } from '../utils/dateLocal';
import { BusinessType, UserProfile, SystemSettings, Customer, Product, ExpiryBatch } from '../types';
import { toArabicDigits, formatExchangeRate } from '../utils/arabicFormatters';
import { useCollection } from '../hooks/useCollection';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { ADMIN_UID, SUPPORT_PHONE } from '../config/adminConfig';
import ScreenGuideModal from './ScreenGuideModal';
import { guideFor } from '../utils/screenGuide';

interface DashboardLayoutProps {
  user: UserProfile;
  settings: SystemSettings;
  updateSettings: (newSettings: Partial<SystemSettings>) => void;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onLogout: () => void;
  trialDaysRemaining: number | null;
  children: React.ReactNode;
}

export default function DashboardLayout({
  user,
  settings,
  updateSettings,
  activeTab,
  setActiveTab,
  onLogout,
  trialDaysRemaining,
  children
}: DashboardLayoutProps) {
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const { isOnline, syncState } = useNetworkStatus();
  // مبدّل الفروع — يظهر فقط عند وجود أكثر من فرع (فرع واحد ⇒ الواجهة كما كانت تماماً)
  const { activeBranches, isMultiBranch, activeBranchId, setActiveBranchId } = useBranches(user.storeName);

  // ---- طيّ/توسيع القائمة الجانبية (سطح المكتب فقط) — محفوظ محلياً بين الجلسات ----
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('sidebarCollapsed') === 'true'; } catch { return false; }
  });
  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('sidebarCollapsed', String(next)); } catch { /* تجاهل تعذّر التخزين */ }
      return next;
    });
  };

  const getAccentColor = (_type: BusinessType) => '#1B3A7A';

  const getSegmentName = (_type: BusinessType) => 'محل تجاري عام';

  const getSegmentIcon = (_type: BusinessType) => Store;

  const accentColor = getAccentColor(user.businessType || 'general');
  const SegmentIcon = getSegmentIcon(user.businessType || 'general');


  // Firestore real-time collections for notifications
  const { items: notifCustomers } = useCollection<Customer>('customers');
  const { items: notifProducts } = useCollection<Product>('products');
  // شحنات الصلاحية — لا تُحمّل شيئاً لمن لا يستعمل الميزة (المجموعة تبقى فارغة عنده)
  const { items: notifBatches } = useCollection<ExpiryBatch>('expiry_batches');

  const currentNotifs = useMemo(() => {
    const list: Array<{ id: string; title: string; desc: string; type: 'info' | 'warning' | 'danger'; tab: string }> = [];

    // ديون مستحقة
    notifCustomers
      .filter(c => c.balance > 0)
      .forEach(c => {
        list.push({
          id: `debt_${c.id}`,
          title: 'دين مستحق',
          desc: `العميل ${c.name} عليه دين ${toArabicDigits(c.balance.toLocaleString())} د.ع`,
          type: 'warning',
          tab: 'debts',
        });
      });

    // نقص مخزون
    notifProducts
      .filter(p => visibleStock(p, activeBranchId) <= p.lowStockThreshold)
      .forEach(p => {
        list.push({
          id: `low_prod_${p.id}`,
          title: 'نقص في المخزون',
          desc: `${p.name} — المتوفر: ${toArabicDigits(visibleStock(p, activeBranchId))} (الحد: ${toArabicDigits(p.lowStockThreshold)})`,
          type: visibleStock(p, activeBranchId) === 0 ? 'danger' : 'warning',
          tab: 'products',
        });
      });

    // صلاحية: المنتهية والتي يجب تصريفها الآن — تظهر فقط لمن سجّل شحنات
    const today = todayISO();
    const prodById = new Map(notifProducts.map(p => [p.id, p]));
    notifBatches
      .filter(b => b.status === 'active')
      .forEach(b => {
        const st = expiryStatus(b, today, prodById.get(b.productId), settings.categoryExpiryAlertDays);
        if (st.stage !== 'expired' && st.stage !== 'act') return;
        list.push({
          id: `exp_${b.id}`,
          title: st.stage === 'expired' ? 'بضاعة منتهية الصلاحية' : 'صلاحية على وشك الانتهاء',
          desc: `${b.productName} — ${st.daysLeft < 0 ? `منتهية منذ ${toArabicDigits(Math.abs(st.daysLeft))} يوماً` : `بقي ${toArabicDigits(st.daysLeft)} يوماً`}`,
          type: st.stage === 'expired' ? 'danger' : 'warning',
          tab: 'expiry',
        });
      });

    return list;
  }, [notifCustomers, notifProducts, notifBatches, settings.categoryExpiryAlertDays, activeBranchId]);

  /**
   * القائمة الجانبية — مجموعات مرتّبة **حسب يوم صاحب المحل** لا حسب ترتيب البناء:
   * يبيع أولاً، ثم يتابع بضاعته، ثم يشتري، ثم يحاسب، ثم يقرأ التقارير، وأخيراً الإدارة.
   * البند الوحيد خارج المجموعات هو «الرئيسية» لأنه نقطة البداية دائماً.
   */
  interface NavItem { id: string; label: string; icon: typeof TrendingUp }
  interface NavGroup { id: string; label: string; icon: typeof TrendingUp; items: NavItem[] }

  const homeItem: NavItem = { id: 'dashboard', label: 'الرئيسية', icon: TrendingUp };

  const navGroups: NavGroup[] = [
    {
      id: 'sales', label: 'البيع والزبائن', icon: FileText,
      items: [
        { id: 'invoices', label: 'الوصولات والفواتير', icon: FileText },
        { id: 'customers', label: 'الزبائن والعملاء', icon: Users },
        { id: 'debts', label: 'الديون والتسديدات', icon: Banknote },
        { id: 'installments', label: 'الأقساط والمتأخرات 📅', icon: CalendarClock },
        { id: 'warranty', label: 'الضمان والسيريال 🛡️', icon: ShieldCheck },
      ],
    },
    {
      id: 'stock', label: 'المخزون والبضاعة', icon: Package,
      items: [
        { id: 'products', label: 'المنتجات والمخزون 📦', icon: Package },
        { id: 'inventory-adjustments', label: 'تسوية المخزون', icon: ClipboardList },
        { id: 'expiry', label: 'الصلاحية ⏳', icon: CalendarX2 },
        { id: 'stock-transfers', label: 'نقل بضاعة 🔄', icon: ArrowLeftRight },
      ],
    },
    {
      id: 'purchasing', label: 'الشراء والموردون', icon: Truck,
      items: [
        { id: 'suppliers', label: 'الموردون', icon: Truck },
        { id: 'purchase-invoices', label: 'فواتير الشراء', icon: ReceiptText },
        { id: 'supplier-accounts', label: 'آجل الموردين', icon: Banknote },
      ],
    },
    {
      id: 'money', label: 'الصندوق والمصاريف', icon: Calculator,
      items: [
        { id: 'cashclosing', label: 'تقفيل الصندوق', icon: Calculator },
        { id: 'expenses', label: 'المصاريف والأرباح', icon: Landmark },
      ],
    },
    {
      id: 'reports', label: 'التقارير', icon: BarChart3,
      items: [
        { id: 'decision-reports', label: 'تقارير القرار 🎯', icon: Target },
        { id: 'reports', label: 'التقارير والتحليلات', icon: BarChart3 },
        { id: 'branch-performance', label: 'أداء الفروع 📊', icon: Trophy },
      ],
    },
    {
      id: 'admin', label: 'الإدارة والإعدادات', icon: Settings,
      items: [
        { id: 'branches', label: 'الفروع والمخازن 🏢', icon: Building2 },
        { id: 'audit-log', label: 'سجل التدقيق', icon: ShieldCheck },
        { id: 'backup', label: 'النسخ الاحتياطي والاستعادة', icon: Shield },
        { id: 'settings', label: 'الإعدادات', icon: Settings },
        { id: 'guide', label: 'دليل البرنامج 📖', icon: BookOpen },
        ...(user.uid === ADMIN_UID ? [{ id: 'admin', label: 'لوحة المالك 🔑', icon: Key }] : []),
      ],
    },
  ];

  // قائمة مسطّحة — يحتاجها وضع الأيقونات المطوي وشريط الهاتف السفلي
  const navItems: NavItem[] = [homeItem, ...navGroups.flatMap(g => g.items)];

  /** اسم الشاشة كما في القائمة — مصدر واحد فلا يتعارض اسمان بين القائمة والدليل */
  const labelOf = (id: string) => navItems.find(i => i.id === id)?.label ?? id;
  const isVisibleScreen = (id: string) => navItems.some(i => i.id === id);
  const [guideOpen, setGuideOpen] = useState(false);
  const activeGuide = guideFor(activeTab);
  const activeLabel = labelOf(activeTab);

  /** أكثر ٦ شاشات استخداماً يومياً — شريط الهاتف السفلي (لا أول ٦ بالترتيب) */
  const mobileNavIds = ['dashboard', 'invoices', 'products', 'customers', 'debts', 'cashclosing'];
  const mobileNavItems = mobileNavIds
    .map(id => navItems.find(i => i.id === id))
    .filter(Boolean) as NavItem[];

  // ---- طيّ/فتح المجموعات — محفوظ بين الجلسات، ومجموعة الشاشة الحالية تُفتح تلقائياً ----
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('navOpenGroups');
      if (saved) return JSON.parse(saved) as Record<string, boolean>;
    } catch { /* تعذّر التخزين — غير حرج */ }
    return { sales: true, stock: true }; // الأكثر استخداماً مفتوحتان أول مرة
  });

  const toggleGroup = (id: string) => {
    setOpenGroups(prev => {
      const next = { ...prev, [id]: !prev[id] };
      try { localStorage.setItem('navOpenGroups', JSON.stringify(next)); } catch { /* تجاهل */ }
      return next;
    });
  };

  const groupOfActive = navGroups.find(g => g.items.some(i => i.id === activeTab))?.id;
  /** المجموعة مفتوحة إن اختارها المستخدم، أو لأن الشاشة المعروضة بداخلها */
  const isGroupOpen = (id: string) => openGroups[id] === true || groupOfActive === id;

  const handleNavClick = (id: string) => {
    setActiveTab(id);
  };

  return (
    <div className="min-h-screen bg-[#EEF2F8] text-[#0B1F4D] flex" dir="rtl">

      {/* Sidebar - Desktop.
          الحد md (٧٦٨px) لا lg (١٠٢٤px): مع تكبير شاشة ويندوز 150-200% ينخفض العرض المحسوب
          لنافذة 1920 إلى ~960px، فكان lg يُخفي القائمة الجانبية ويُظهر وضع الهاتف بالخطأ. */}
      <aside className={`hidden md:flex flex-col bg-[#0B1F4D] text-white fixed top-0 bottom-0 right-0 z-30 shadow-xl border-l border-slate-800 transition-all duration-300 ease-in-out ${sidebarCollapsed ? 'w-20' : 'w-64'}`}>

        {/* Brand header + collapse toggle */}
        <div className={`border-b border-slate-800 flex items-center ${sidebarCollapsed ? 'flex-col gap-3 p-4' : 'gap-3 p-6'}`}>
          {user.logoUrl ? (
            <img src={user.logoUrl} alt="Store Logo" className="w-10 h-10 rounded-xl object-cover shadow-lg border border-slate-700 flex-shrink-0" referrerPolicy="no-referrer" />
          ) : (
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-[#10b981] to-emerald-400 flex items-center justify-center shadow-lg flex-shrink-0">
              <Bot className="w-5 h-5 text-white animate-bounce" />
            </div>
          )}
          {!sidebarCollapsed && (
            <div className="min-w-0 flex-1 text-right">
              <span className="text-sm font-bold block leading-none font-cairo truncate">{user.storeName || 'رتب شغلك'}</span>
              <span className="text-[10px] text-emerald-400 block mt-1 truncate">صاحب العمل: {user.ownerName}</span>
            </div>
          )}
          <button
            onClick={toggleSidebar}
            title={sidebarCollapsed ? 'توسيع القائمة الجانبية' : 'طيّ القائمة الجانبية'}
            aria-label={sidebarCollapsed ? 'توسيع القائمة الجانبية' : 'طيّ القائمة الجانبية'}
            className="flex-shrink-0 w-8 h-8 rounded-lg bg-slate-800/60 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center justify-center transition cursor-pointer border border-slate-700"
          >
            {sidebarCollapsed ? <PanelRightOpen className="w-4.5 h-4.5" /> : <PanelRightClose className="w-4.5 h-4.5" />}
          </button>
        </div>

        {/* Business segment badge */}
        <div className={`bg-slate-900/50 rounded-xl border border-slate-800 flex items-center ${sidebarCollapsed ? 'justify-center m-2 p-2' : 'm-4 p-3 gap-2.5'}`}>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: accentColor + '30', color: accentColor }}>
            <SegmentIcon className="w-4.5 h-4.5" />
          </div>
          {!sidebarCollapsed && (
            <div>
              <span className="text-[10px] text-slate-400 block font-medium">الشريحة المفعلة:</span>
              <span className="text-xs font-bold text-white block select-none font-cairo truncate max-w-[140px]" style={{ color: accentColor }}>
                {getSegmentName(user.businessType || 'general')}
              </span>
            </div>
          )}
        </div>

        {/* Nav items — مجموعات مرتّبة حسب يوم العمل. الوضع المطوي يعرض أيقونات فقط. */}
        <nav className="flex-1 px-4 space-y-1 py-4 overflow-y-auto">
          {(() => {
            const NavButton = ({ item, nested }: { item: NavItem; nested?: boolean }) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              const isAdminItem = item.id === 'admin';
              return (
                <button
                  onClick={() => handleNavClick(item.id)}
                  title={sidebarCollapsed ? item.label : undefined}
                  className={`w-full rounded-xl flex items-center gap-3 text-xs font-semibold transition-all duration-150 cursor-pointer ${
                    sidebarCollapsed ? 'justify-center px-0 py-3' : nested ? 'px-3 pr-6 py-2.5' : 'px-4 py-3'
                  } ${
                    isActive
                      ? 'text-white'
                      : isAdminItem
                        ? 'text-amber-400 hover:text-white hover:bg-amber-500/20 border border-amber-500/20'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800/40'
                  }`}
                  style={isActive ? { backgroundColor: accentColor } : {}}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {!sidebarCollapsed && <span className="truncate text-right">{item.label}</span>}
                </button>
              );
            };

            // مطوي: لا مجال لعناوين المجموعات — نعرض كل الأيقونات بتسلسلها
            if (sidebarCollapsed) {
              return navItems.map(item => <NavButton key={item.id} item={item} />);
            }

            return (
              <>
                <NavButton item={homeItem} />
                {navGroups.map(group => {
                  const open = isGroupOpen(group.id);
                  const GroupIcon = group.icon;
                  const hasActive = group.items.some(i => i.id === activeTab);
                  return (
                    <div key={group.id} className="pt-1.5">
                      <button
                        onClick={() => toggleGroup(group.id)}
                        className={`w-full px-3 py-2 rounded-lg flex items-center gap-2 transition cursor-pointer ${
                          hasActive ? 'text-slate-200' : 'text-slate-500 hover:text-slate-300'
                        }`}
                      >
                        <GroupIcon className="w-3.5 h-3.5 flex-shrink-0 opacity-70" />
                        <span className="text-[10px] font-extrabold tracking-wide">{group.label}</span>
                        <span className="text-[9px] font-bold text-slate-600 mr-auto">
                          {toArabicDigits(group.items.length)}
                        </span>
                        {open ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" /> : <ChevronLeft className="w-3.5 h-3.5 flex-shrink-0" />}
                      </button>
                      {open && (
                        <div className="space-y-0.5 mt-0.5 border-r border-slate-800 mr-3">
                          {group.items.map(item => <NavButton key={item.id} item={item} nested />)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            );
          })()}
        </nav>

        {/* User / License footer */}
        <div className={`border-t border-slate-800 space-y-3 bg-slate-950/20 ${sidebarCollapsed ? 'p-2' : 'p-4'}`}>
          {!sidebarCollapsed && (
            <div className="flex items-center justify-between text-[11px] font-bold text-slate-500 bg-emerald-500/10 p-2.5 rounded-lg border border-emerald-950/20">
              <span className="text-emerald-400">مفعل مدى الحياة 💎</span>
              <span className="text-white text-[9px] bg-emerald-600 px-1.5 py-0.5 rounded font-mono">
                {toArabicDigits('١')} سنة متبقي مزامنة
              </span>
            </div>
          )}
          <button
            onClick={onLogout}
            title={sidebarCollapsed ? 'تسجيل الخروج' : undefined}
            className={`w-full py-2.5 hover:bg-red-500/10 text-slate-400 hover:text-red-400 transition rounded-xl text-xs font-bold flex items-center justify-center gap-2 border border-slate-850 cursor-pointer ${sidebarCollapsed ? 'px-0' : ''}`}
          >
            <LogOut className="w-3.5 h-3.5 flex-shrink-0" />
            {!sidebarCollapsed && <span>تسجيل الخروج</span>}
          </button>
        </div>
      </aside>

      {/* Main content area — right padding tracks the sidebar width so content expands when collapsed */}
      <div className={`flex-1 flex flex-col min-w-0 transition-all duration-300 ease-in-out ${sidebarCollapsed ? 'md:pr-20' : 'md:pr-64'}`}>{/* pr matches aside width (w-20 / w-64) */}

        {/* Top header */}
        <header className="bg-white border-b border-[#E4EAF3] sticky top-0 z-20 px-4 md:px-8 py-3.5 flex justify-between items-center bg-white/95 backdrop-blur shadow-sm">

          {/* Mobile brand */}
          <div className="flex items-center gap-2.5 md:hidden max-w-[180px]">
            {user.logoUrl ? (
              <img src={user.logoUrl} alt="Store Logo" className="w-8 h-8 rounded-lg object-cover shadow border border-slate-200" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-8 h-8 rounded-lg bg-[#0B1F4D] flex items-center justify-center text-white">
                <Bot className="w-4 h-4 text-emerald-405" />
              </div>
            )}
            <h1 className="text-sm font-bold font-cairo text-[#0B1F4D] truncate">{user.storeName || 'رتب شغلك'}</h1>
          </div>

          <div className="hidden md:flex items-center gap-1">
            <div className="font-bold text-slate-700 text-sm font-cairo">
              مرحباً بك: <span className="text-[#0B1F4D]">{user.ownerName}</span> 👋
            </div>
          </div>

          {/* Header actions */}
          <div className="flex items-center gap-3">

            {/* مبدّل الفروع — لا يظهر إطلاقاً لصاحب الفرع الواحد */}
            {isMultiBranch && (
              <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-xl px-2.5 py-1.5 shadow-sm">
                <Building2 className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
                <select
                  value={activeBranchId}
                  onChange={(e) => setActiveBranchId(e.target.value)}
                  title="الفرع النشط — تُنسب إليه العمليات الجديدة"
                  className="bg-transparent text-xs font-extrabold text-amber-900 outline-none cursor-pointer max-w-[140px]"
                >
                  <option value="">كل الفروع (عرض مجمّع)</option>
                  {activeBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            )}

            {/* Exchange rate chip */}
            <div className="bg-[#EEF2F8] px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 flex items-center gap-2 select-none shadow-sm font-sans">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              <span>{formatExchangeRate(settings.exchangeRate)}</span>
            </div>

            {/* زر شرح الشاشة الحالية — واحد في الرأس يخدم كل الشاشات بلا تعديل أيٍّ منها */}
            {activeGuide && (
              <button
                onClick={() => setGuideOpen(true)}
                title={`ما فائدة شاشة «${activeLabel}»؟`}
                className="bg-amber-50 px-3 py-1.5 rounded-xl border border-amber-200 text-xs font-extrabold text-amber-800 flex items-center gap-1.5 select-none shadow-sm hover:bg-amber-100 transition cursor-pointer"
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">ما هذه الشاشة؟</span>
              </button>
            )}

            {/* Support contact chip — رقم التواصل بجانب سعر الصرف */}
            <a
              href={`tel:${SUPPORT_PHONE}`}
              title="للتواصل والدعم الفني"
              className="hidden sm:flex bg-[#EEF2F8] px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 items-center gap-1.5 select-none shadow-sm hover:bg-slate-100 transition cursor-pointer"
            >
              <Phone className="w-3.5 h-3.5 text-emerald-600" />
              <span>للتواصل: <span dir="ltr" className="font-sans font-extrabold">{SUPPORT_PHONE}</span></span>
            </a>

            {/* Network / sync status indicator */}
            <div className={`hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-bold select-none ${
              !isOnline
                ? 'bg-rose-50 text-rose-700 border-rose-200'
                : syncState === 'syncing'
                  ? 'bg-amber-50 text-amber-700 border-amber-200'
                  : 'bg-emerald-50 text-emerald-700 border-emerald-200'
            }`}>
              {!isOnline
                ? <WifiOff className="w-3.5 h-3.5" />
                : <RefreshCw className={`w-3.5 h-3.5 ${syncState === 'syncing' ? 'animate-spin' : ''}`} />
              }
              <span>
                {!isOnline
                  ? 'دون اتصال — البيانات محلياً'
                  : syncState === 'syncing'
                    ? 'جاري المزامنة...'
                    : 'تمت المزامنة سحابياً'
                }
              </span>
            </div>

            {/* Notifications bell */}
            <div className="relative">
              <button
                onClick={() => setIsNotifOpen(!isNotifOpen)}
                className="w-10 h-10 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-700 relative cursor-pointer"
              >
                <Bell className="w-5 h-5" />
                {currentNotifs.length > 0 && (
                  <span className="absolute top-1.5 left-1.5 w-4.5 h-4.5 bg-red-500 text-white text-[9px] font-extrabold rounded-full flex items-center justify-center ring-2 ring-white">
                    {toArabicDigits(currentNotifs.length)}
                  </span>
                )}
              </button>

              {isNotifOpen && (
                <div className="absolute left-0 mt-2 w-72 bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden z-45">
                  <div className="p-3.5 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
                    <span className="text-xs font-bold text-[#0B1F4D]">التنبيهات العاجلة</span>
                    <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-extrabold">مهم جداً</span>
                  </div>
                  <div className="divide-y divide-slate-100 max-h-60 overflow-y-auto">
                    {currentNotifs.length > 0 ? (
                      currentNotifs.map((item) => (
                        <div
                          key={item.id}
                          className="p-3 hover:bg-slate-50 transition text-right cursor-pointer"
                          onClick={() => { setActiveTab(item.tab); setIsNotifOpen(false); }}
                        >
                          <p className="text-xs font-bold text-[#0B1F4D] flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${item.type === 'danger' ? 'bg-red-500' : 'bg-amber-500'}`} />
                            {item.title}
                          </p>
                          <p className="text-[11px] text-[#5B6B86] mt-1">{item.desc}</p>
                        </div>
                      ))
                    ) : (
                      <p className="p-4 text-xs text-slate-400 text-center">ما في تنبيهات حالياً ✅</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* User avatar → settings */}
            <div className="flex items-center gap-2 border-r border-slate-200 pr-3 mr-1">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-white font-extrabold text-sm select-none border-2 border-white shadow-md cursor-pointer"
                style={{ backgroundColor: accentColor }}
                onClick={() => setActiveTab('settings')}
              >
                {user.ownerName.slice(0, 2)}
              </div>
            </div>
          </div>
        </header>

        {/* شريط التجربة المجانية */}
        {trialDaysRemaining !== null && trialDaysRemaining > 0 && (
          <div className={`px-4 md:px-8 py-2.5 flex items-center justify-between text-xs font-bold border-b ${
            trialDaysRemaining <= 3
              ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            <span>
              {trialDaysRemaining <= 3 ? '⚠️' : '⏳'} متبقّي{' '}
              <span className="font-extrabold underline">
                {toArabicDigits(trialDaysRemaining)} {trialDaysRemaining === 1 ? 'يوم' : 'أيام'}
              </span>{' '}
              على انتهاء فترة التجربة المجانية
            </span>
            <button
              onClick={() => setActiveTab('settings')}
              className="underline hover:no-underline transition font-extrabold cursor-pointer"
            >
              تفعيل الآن ←
            </button>
          </div>
        )}

        {/* Page content */}
        <main className="flex-1 p-4 md:p-8 space-y-6 pb-24 md:pb-8">
          <div className="relative" id="current_active_tab_view">
            {children}
          </div>
        </main>

        {/* Mobile bottom nav — للهواتف الحقيقية فقط (< ٧٦٨px) */}
        <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 py-2.5 px-1.5 flex justify-around items-center md:hidden z-40 shadow-xl rounded-t-xl">
          {mobileNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className="flex flex-col items-center justify-center flex-1 py-1 min-w-0"
                style={{ color: isActive ? accentColor : '#5B6B86' }}
              >
                <Icon className="w-4.5 h-4.5 mb-1" />
                <span className="text-[7.5px] font-bold tracking-tighter truncate w-full text-center px-0.5">{item.label}</span>
              </button>
            );
          })}
          <button
            onClick={() => setActiveTab('settings')}
            className="flex flex-col items-center justify-center flex-1 py-1 min-w-0"
            style={{ color: activeTab === 'settings' ? accentColor : '#5B6B86' }}
          >
            <Settings className="w-4.5 h-4.5 mb-1" />
            <span className="text-[7.5px] font-bold tracking-tighter truncate w-full text-center px-0.5">الإعدادات</span>
          </button>
          {user.uid === ADMIN_UID && (
            <button
              onClick={() => setActiveTab('admin')}
              className="flex flex-col items-center justify-center flex-1 py-1 min-w-0"
              style={{ color: activeTab === 'admin' ? '#F59E0B' : '#5B6B86' }}
            >
              <Key className="w-4.5 h-4.5 mb-1" />
              <span className="text-[7.5px] font-bold tracking-tighter truncate w-full text-center px-0.5">المالك</span>
            </button>
          )}
        </nav>

      </div>

      {/* شرح الشاشة المفتوحة — مساعدة في مكان الحيرة بلا مغادرتها */}
      {guideOpen && activeGuide && (
        <ScreenGuideModal
          title={activeLabel}
          guide={activeGuide}
          labelOf={labelOf}
          onGo={(id) => { if (isVisibleScreen(id)) setActiveTab(id); }}
          onClose={() => setGuideOpen(false)}
        />
      )}
    </div>
  );
}
