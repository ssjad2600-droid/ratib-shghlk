import { useState } from 'react';
import { Bot, LogOut, BadgeCheck, ShieldAlert, Clock, RefreshCw, WifiOff, CloudUpload, Lock, Building2, HelpCircle } from 'lucide-react';
import { usePublicInfo, isShopLicenseActive } from '../hooks/usePublicInfo';
import { useSession } from '../context/SessionContext';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { usePendingWrites } from '../hooks/usePendingWrites';
import { useConfirm } from '../hooks/useConfirm';
import { toArabicDigits } from '../utils/arabicFormatters';
import ScreenGuideModal from './ScreenGuideModal';
import { EMPLOYEE_GUIDE } from '../utils/screenGuide';
import EmployeeInvoicesView from './EmployeeInvoicesView';
import WarrantyLookupView from './WarrantyLookupView';
import WriteFailureBanner from './WriteFailureBanner';

/**
 * شاشة الحساب المعطّل — تُعرض عندما disabled=true (القواعد تمنع بياناته خادمياً أيضاً).
 */
export function EmployeeDisabledScreen({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#EEF2F8] p-6" dir="rtl">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-8 text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-rose-50 border border-rose-200 flex items-center justify-center mx-auto">
          <ShieldAlert className="w-8 h-8 text-rose-600" />
        </div>
        <h2 className="font-extrabold text-lg text-[#0B1F4D] font-cairo">الحساب معطّل</h2>
        <p className="text-sm text-slate-500 font-bold leading-relaxed">
          تم إيقاف هذا الحساب مؤقتاً. يرجى مراجعة صاحب المحل لإعادة تفعيله.
        </p>
        <button
          onClick={onLogout}
          className="w-full py-3 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-xs flex items-center justify-center gap-2 transition cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          <span>تسجيل الخروج</span>
        </button>
      </div>
    </div>
  );
}

/**
 * شاشة انتهاء ترخيص المحل — تُعرض للموظف حين تنتهي تجربة المالك ولم يفعّل.
 * بدونها كان الموظف يواصل إصدار الفواتير بينما المالك محجوب ببوابة الترخيص.
 */
function ShopLicenseExpiredScreen({ storeName, onLogout }: { storeName: string; onLogout: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#EEF2F8] p-6" dir="rtl">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-8 text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center mx-auto">
          <Clock className="w-8 h-8 text-amber-600" />
        </div>
        <h2 className="font-extrabold text-lg text-[#0B1F4D] font-cairo">انتهت فترة اشتراك المحل</h2>
        <p className="text-sm text-slate-500 font-bold leading-relaxed">
          {storeName ? `محل «${storeName}» ` : 'هذا المحل '}
          بحاجة إلى تفعيل الاشتراك لمواصلة العمل. يرجى مراجعة صاحب المحل.
        </p>
        <button
          onClick={onLogout}
          className="w-full py-3 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-xs flex items-center justify-center gap-2 transition cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          <span>تسجيل الخروج</span>
        </button>
      </div>
    </div>
  );
}

/**
 * قشرة الموظف: واجهة مبسّطة محصورة بصلاحياته — فقط الفواتير.
 * لا تستدعي useProfile (بروفايل المالك محجوب)؛ معلومات المحل من public/info.
 */
export default function EmployeeShell({ ownerUid, onLogout }: { ownerUid: string; onLogout: () => void }) {
  const { info, loading } = usePublicInfo(ownerUid);
  const { employeeName, employeeUid, branchName } = useSession();
  const { isOnline, syncState } = useNetworkStatus();
  const { pendingCount } = usePendingWrites(ownerUid, employeeUid);
  const { requestConfirm, confirmDialog } = useConfirm();
  const [tab, setTab] = useState<'invoices' | 'warranty'>('invoices');
  // شرح شاشة الموظف — سطران يقطعان سلسلة: موظف يسأل صاحب المحل، وصاحب المحل يسألك
  const [guideOpen, setGuideOpen] = useState(false);
  const empGuide = EMPLOYEE_GUIDE[tab === 'invoices' ? 'emp-invoices' : 'emp-warranty'];
  const empTitle = tab === 'invoices' ? 'إصدار الفواتير' : 'الضمان والسيريال';

  // حارس تسجيل الخروج:
  // 1) أوفلاين ⇒ **منع قطعي** للخروج (حماية بيانات المستخدم) — الخروج بلا اتصال قد يفقد فواتير
  //    لم تصل الخادم بعد. الزر نفسه مُعطَّل أوفلاين؛ وهذا الحارس طبقة أمان ثانية.
  // 2) أونلاين مع كتابات معلّقة ⇒ تحذير قوي (المزامنة جارية، لكن ننبّه قبل الخروج).
  const handleLogoutGuarded = async () => {
    if (!isOnline) {
      await requestConfirm(
        `لا يمكن تسجيل الخروج بدون اتصال بالإنترنت 🔒\n\n` +
        `الخروج الآن قد يفقد فواتير لم تُرسَل للخادم بعد. انتظر عودة الإنترنت حتى يظهر «متزامن» ثم اخرج.`
      );
      return; // منع قطعي — لا خروج أوفلاين مهما كان
    }
    if (pendingCount > 0) {
      const ok = await requestConfirm(
        `تنبيه ⚠️\n\nلا تزال ${toArabicDigits(pendingCount)} فاتورة قيد المزامنة مع الخادم.\n\n` +
        `يُفضّل الانتظار حتى تكتمل المزامنة (يختفي العدّاد) قبل الخروج.\n\nهل تريد الخروج رغم ذلك؟`
      );
      if (!ok) return;
    }
    onLogout();
  };

  // بوابة الترخيص للموظف — تُحسب من public/info (بروفايل المالك محجوب عنه).
  // ننتظر تحميل الوثيقة قبل الحكم حتى لا نحجبه بلمحة خاطئة أثناء التحميل.
  if (!loading && !isShopLicenseActive(info)) {
    return <ShopLicenseExpiredScreen storeName={info.storeName} onLogout={onLogout} />;
  }

  return (
    <div className="min-h-screen bg-[#EEF2F8] text-[#0B1F4D]" dir="rtl">
      {confirmDialog}
      {/* Header */}
      <header className="bg-white border-b border-[#E4EAF3] sticky top-0 z-20 px-4 md:px-8 py-3.5 flex justify-between items-center gap-2 bg-white/95 backdrop-blur shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          {info.logoUrl ? (
            <img src={info.logoUrl} alt="Logo" className="w-9 h-9 rounded-lg object-cover border border-slate-200 flex-shrink-0" referrerPolicy="no-referrer" />
          ) : (
            <div className="w-9 h-9 rounded-lg bg-[#0B1F4D] flex items-center justify-center text-white flex-shrink-0">
              <Bot className="w-4.5 h-4.5 text-emerald-400" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-sm font-bold font-cairo text-[#0B1F4D] truncate">{info.storeName || 'رتب شغلك'}</h1>
            <span className="text-[10px] text-emerald-700 font-bold flex items-center gap-1">
              <BadgeCheck className="w-3 h-3" />
              حساب موظف: {employeeName || 'موظف'}
            </span>
            {/* الفرع — يظهر فقط لموظف مُسنَد لفرع مُسمّى (محل بفرع واحد: لا يظهر شيء) */}
            {branchName && (
              <span className="text-[10px] text-indigo-700 font-extrabold flex items-center gap-1 mt-0.5">
                <Building2 className="w-3 h-3" />
                <span title={branchName} className="truncate">{branchName}</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {/* عدّاد الفواتير غير المزامَنة — يظهر فقط عند وجودها */}
          {pendingCount > 0 && (
            <span
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[11px] font-extrabold bg-amber-50 border-amber-200 text-amber-800 animate-pulse"
              title="فواتير محفوظة على جهازك لم تصل الخادم بعد — ستُرسَل تلقائياً عند رجوع الإنترنت"
            >
              <CloudUpload className="w-3.5 h-3.5" />
              <span>{toArabicDigits(pendingCount)} بانتظار المزامنة</span>
            </span>
          )}

          {/* مؤشر الاتصال / المزامنة */}
          <span className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[11px] font-bold select-none ${
            !isOnline
              ? 'bg-rose-50 text-rose-700 border-rose-200'
              : syncState === 'syncing'
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-emerald-50 text-emerald-700 border-emerald-200'
          }`}>
            {!isOnline
              ? <WifiOff className="w-3.5 h-3.5" />
              : <RefreshCw className={`w-3.5 h-3.5 ${syncState === 'syncing' ? 'animate-spin' : ''}`} />}
            <span>{!isOnline ? 'غير متصل' : syncState === 'syncing' ? 'جاري المزامنة' : 'متزامن'}</span>
          </span>

          <button
            onClick={handleLogoutGuarded}
            disabled={!isOnline}
            title={!isOnline ? 'لا يمكن تسجيل الخروج بدون اتصال بالإنترنت — حمايةً لفواتيرك' : undefined}
            className={`px-3 py-2 border rounded-xl text-xs font-bold flex items-center gap-1.5 transition ${
              !isOnline
                ? 'border-slate-200 bg-slate-50 text-slate-500 cursor-not-allowed'
                : pendingCount > 0
                  ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 cursor-pointer'
                  : 'border-slate-200 hover:bg-red-50 text-slate-500 hover:text-red-700 cursor-pointer'
            }`}
          >
            {!isOnline ? <Lock className="w-3.5 h-3.5" /> : <LogOut className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{!isOnline ? 'الخروج مقفل (أوفلاين)' : 'تسجيل الخروج'}</span>
          </button>
        </div>
      </header>

      {/* Content: الفواتير + البحث بالضمان (بلا بيانات زبائن) */}
      {/* حشوة سفلية للمنطقة الآمنة: لا شريط سفلي هنا، لكن آخر صفٍّ في القائمة
          كان يختفي تحت شريط إيماءات الهاتف. تساوي 0px على الكمبيوتر. */}
      <main className="p-4 md:p-8 pb-[calc(1rem+env(safe-area-inset-bottom))] md:pb-8">
        {/* 🔴 الموظف أولى الناس بهذا: كتاباته تُرفض خادمياً عند تعطيله، وكان يبيع يوماً
            كاملاً على «نجاحات» وهمية لا يعلم بها أحد */}
        <WriteFailureBanner />
        {/* تبويبان بسيطان — صلاحيات الموظف تبقى كما هي تماماً */}
        <div className="flex gap-1.5 bg-white border border-[#E4EAF3] p-1 rounded-xl w-fit shadow-sm mb-5 select-none">
          <button
            onClick={() => setTab('invoices')}
            className={`px-4 py-2 rounded-lg text-xs font-extrabold transition cursor-pointer flex items-center gap-1.5 ${
              tab === 'invoices' ? 'bg-[#0B1F4D] text-white' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            📄 <span>المبيعات والفواتير</span>
          </button>
          <button
            onClick={() => setTab('warranty')}
            className={`px-4 py-2 rounded-lg text-xs font-extrabold transition cursor-pointer flex items-center gap-1.5 ${
              tab === 'warranty' ? 'bg-[#0B1F4D] text-white' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            🛡️ <span>الضمان والسيريال</span>
          </button>

          {/* شرح الشاشة — للموظف الجديد بدل أن يسأل صاحب المحل */}
          <button
            onClick={() => setGuideOpen(true)}
            title="ما هذه الشاشة؟"
            className="px-3 py-2 rounded-lg text-xs font-extrabold text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 transition cursor-pointer flex items-center gap-1.5"
          >
            <HelpCircle className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">شرح</span>
          </button>
        </div>

        {guideOpen && empGuide && (
          <ScreenGuideModal
            title={empTitle}
            guide={empGuide}
            labelOf={(id) => id}
            onClose={() => setGuideOpen(false)}
          />
        )}

        {tab === 'invoices' ? (
          <>
            <div className="mb-5">
              <h2 className="text-lg font-extrabold font-cairo text-[#0B1F4D]">المبيعات والفواتير 📄</h2>
              <p className="text-xs text-[#5B6B86] mt-1 font-tajawal">أصدر فواتير البيع النقدي واطبعها</p>
            </div>
            <EmployeeInvoicesView
              currency={info.currency}
              exchangeRate={info.exchangeRate}
              storeName={info.storeName}
              storeAddress={info.address}
              storePhone={info.phone}
              printFormat={info.printFormat}
            />
          </>
        ) : (
          <WarrantyLookupView
            currency={info.currency}
            exchangeRate={info.exchangeRate}
            employeeMode
          />
        )}
      </main>
    </div>
  );
}
