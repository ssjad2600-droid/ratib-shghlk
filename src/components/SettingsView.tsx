import React, { useState, useRef, useEffect } from 'react';
import NumberInput from './NumberInput';
import {
  Building2, Key, HelpCircle, RefreshCw, Check, Landmark, Wallet,
  AlertOctagon, Info, Upload, Image, MapPin, Phone, Bell, Database,
  Sparkles, Award, Trash2, Loader2, MessageCircle, Printer, Receipt, FileText
} from 'lucide-react';
import { doc, runTransaction, getDocFromServer } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { UserProfile, SystemSettings } from '../types';
import { normalizePrintFormat, PRINT_FORMAT_LABEL, PrintFormat } from '../utils/printReceipt';
import { PersistedDoc } from '../hooks/useProfile';
import { exportBackup } from '../utils/exportBackup';
import { SUPPORT_PHONE, SUPPORT_PHONE_INTL } from '../config/adminConfig';
import {
  toArabicDigits, formatCurrency,
  isValidExchangeRate, EXCHANGE_RATE_ERROR, EXCHANGE_RATE_MIN, EXCHANGE_RATE_MAX, parseAmount,
} from '../utils/arabicFormatters';
import EmployeeManagement from './EmployeeManagement';
import { compressLogo, dataUrlBytes } from '../utils/productImage';
import { toWhatsappNumber } from '../utils/whatsapp';
import { onExternalLink } from '../utils/openExternal';

interface SettingsViewProps {
  user: UserProfile;
  settings: SystemSettings;
  updateUser: (newUser: Partial<UserProfile>) => void;
  updateSettings: (newSettings: Partial<SystemSettings>) => void;
  saveProfile: (updates: PersistedDoc) => Promise<void>;
  isLicensed: boolean; // مشتقّ من كود التفعيل (Fix A) — لا من user.plan القابل للتزوير
}

export default function SettingsView({ user, settings, updateUser, updateSettings, saveProfile, isLicensed }: SettingsViewProps) {
  // Local state managers
  const [storeName, setStoreName] = useState(user.storeName);
  const [ownerName, setOwnerName] = useState(user.ownerName);
  const [phone, setPhone] = useState(user.phone);
  const [address, setAddress] = useState(user.address || '');
  const [logoUrl, setLogoUrl] = useState(user.logoUrl || '');
  /**
   * 🔴 سعر الصرف نصٌّ خام لا رقم.
   *
   * كان `useState<number>` مع `setRate(Number(e.target.value))`، والحقل `type="text"`
   * (حُوِّل ضمن إصلاح الأرقام العربية) والمعالِج بقي `Number`:
   *   · `Number('١٥٠٠')` ⟵ **NaN**، فيُعرض «NaN» في الحقل
   *   · `Number('')` ⟵ **٠**، فلا يستطيع تفريغه ليعيد الكتابة
   * والنصّ الخام يحلّ الاثنين، و`parseAmount` تقرأ العربية والفارسية عند الحفظ.
   */
  const [rate, setRate] = useState(String(settings.exchangeRate));
  useEffect(() => { setRate(String(settings.exchangeRate)); }, [settings.exchangeRate]);

  // Licence and unlock keys
  const [licenseCode, setLicenseCode] = useState('');
  const [isActivating, setIsActivating] = useState(false);

  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // File Upload drag states
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Notifications Toggles inside settings state
  const [notifyOnExpiry, setNotifyOnExpiry] = useState(settings.notifyOnExpiry ?? true);
  const [notifyOnLowStock, setNotifyOnLowStock] = useState(settings.notifyOnLowStock ?? true);
  const [notifyOnUnpaidDebts, setNotifyOnUnpaidDebts] = useState(settings.notifyOnUnpaidDebts ?? true);

  // Backup states
  const [backupInterval, setBackupInterval] = useState(settings.backupInterval || 'daily');
  const [autoBackup, setAutoBackup] = useState(settings.autoBackup ?? true);
  // صيغة طباعة الفاتورة المفردة — تُطبَّق فوراً بلا زر حفظ (إعداد تشغيلي يومي)
  const printFormat = normalizePrintFormat(settings.printFormat);
  const [isBackingUp, setIsBackingUp] = useState(false);

  const triggerSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 5000);
  };

  const triggerError = (msg: string) => {
    setErrorMsg(msg);
    setTimeout(() => setErrorMsg(null), 5000);
  };

  // Profile Save — single atomic write so the store profile fields and the
  // exchange rate land in Firestore together, avoiding a race where a
  // snapshot for one field overwrites the other before both are merged.
  const saveGeneralSettings = (e: React.FormEvent) => {
    e.preventDefault();
    // تحقق كان غائباً كلياً هنا — قيمة خارج المدى تكسر كل تحويلات الدولار في التطبيق
    if (!isValidExchangeRate(parseAmount(rate))) {
      triggerError(EXCHANGE_RATE_ERROR);
      return;
    }
    // 🟡 الهاتف يظهر على الفواتير المطبوعة — نفحص صيغته كما في الزبائن والموردين
    if (phone.trim() && !toWhatsappNumber(phone)) {
      triggerError('رقم هاتف المحل غير صالح — اكتبه بصيغة ٠٧٧٠٠٠٠٠٠٠٠ أو اتركه فارغاً');
      return;
    }
    saveProfile({
      storeName,
      ownerName,
      phone,
      address,
      logoUrl,
      exchangeRate: parseAmount(rate),
    });
    triggerSuccess('تم حفظ إعدادات المحل وسعر الصرف والشعار بنجاح! 🌟');
  };

  /**
   * 🔴 الشعار يُضغط قبل أي شيء — ولا يُكتب حتى يضغط التاجر «حفظ».
   *
   * كان الفحص `> 2.5MB` ثم تخزين Base64 خاماً. وBase64 يزيد ٣٣٪، وحدّ وثيقة Firestore
   * **١ ميغا** — فكل شعار بين ٧٦٨ كيلو و٢٫٥ ميغا يمرّ من الفحص ثم **تفشل كتابته**،
   * ورسالة «تم الحفظ بنجاح 🎉» تظهر قبل أن يُعرف شيء.
   *
   * وكان `updateUser` يُكتب فور اختيار الملف: من يجرّب شعاراً ثم يغيّر رأيه ويغادر بلا
   * حفظ — الشعار محفوظ فعلاً. الآن يبقى في المعاينة حتى الحفظ، كبقيّة حقول النموذج.
   */
  const handleLogoFile = async (file: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      triggerError('يرجى اختيار ملف صورة 🖼️');
      return;
    }
    try {
      const compressed = await compressLogo(file);
      setLogoUrl(compressed);
      triggerSuccess(
        `جُهّز الشعار (${toArabicDigits(Math.round(dataUrlBytes(compressed) / 1024))} كيلوبايت) — `
        + 'اضغط «حفظ إعدادات المحل» لتثبيته.',
      );
    } catch (err) {
      triggerError(err instanceof Error ? err.message : 'تعذّر تجهيز الصورة');
    }
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
      handleLogoFile(e.dataTransfer.files[0]);
    }
  };

  // Generate dynamic premium logo inside dynamic canvas based on Store Name
  const handleGeneratePresetLogo = (style: 'royal' | 'modern' | 'classic' | 'warm') => {
    if (!storeName.trim()) {
      triggerError('اكتب اسم المحل أولاً حتى نولد الشعار باسمه عيني!');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Elegant background gradient
    const grad = ctx.createLinearGradient(0, 0, 256, 256);
    if (style === 'royal') {
      grad.addColorStop(0, '#0F172A'); // Midnight Royal
      grad.addColorStop(1, '#1E293B');
    } else if (style === 'modern') {
      grad.addColorStop(0, '#0B1F4D'); // Modern Iraqi Blue
      grad.addColorStop(1, '#1A365D');
    } else if (style === 'classic') {
      grad.addColorStop(0, '#064E3B'); // Emerald/Rx Pharmacy
      grad.addColorStop(1, '#0F766E');
    } else {
      grad.addColorStop(0, '#6C2A0C'); // General Warm/Clay
      grad.addColorStop(1, '#8C3D10');
    }

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(128, 128, 120, 0, Math.PI * 2);
    ctx.fill();

    // Gold/Emerald border ring
    ctx.strokeStyle = style === 'royal' ? '#FBBF24' : style === 'modern' ? '#10B981' : style === 'classic' ? '#34D399' : '#F97316';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(128, 128, 110, 0, Math.PI * 2);
    ctx.stroke();

    // Dashed subtle grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(128, 128, 98, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]); // Reset line dash

    // Text rendering setup
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // First Character Monogram
    const monogram = storeName.trim().charAt(0);
    ctx.font = 'bold 90px "IBM Plex Sans Arabic", "Traditional Arabic", Tahoma, sans-serif';
    ctx.fillStyle = style === 'royal' ? '#FBBF24' : '#FFFFFF';
    ctx.fillText(monogram, 128, 110);

    // Store Name substring
    ctx.font = 'bold 20px "IBM Plex Sans Arabic", Tahoma, sans-serif';
    ctx.fillStyle = style === 'royal' ? '#F3F4F6' : 'rgba(255, 255, 255, 0.9)';
    const cleanSub = storeName.substring(0, 11).trim();
    ctx.fillText(cleanSub, 128, 185);

    // Elegant stars ornaments
    ctx.font = '22px Arial';
    ctx.fillStyle = style === 'royal' ? '#FBBF24' : style === 'modern' ? '#10B981' : '#FFFFFF';
    ctx.fillText('★', 60, 128);
    ctx.fillText('★', 196, 128);

    const base64Url = canvas.toDataURL('image/png');
    setLogoUrl(base64Url);
    updateUser({ logoUrl: base64Url });
    triggerSuccess(`تم توليد الشعار المخصص وحفظه بنجاح بأسلوب: ${
      style === 'royal' ? 'الملكي الذهبي 👑' : style === 'modern' ? 'الإنترنت التكنولوجي 🌐' : style === 'classic' ? 'الزمرد الطبي 💊' : 'النشاط العام 🏪'
    }`);
  };

  // Delete logo
  const handleRemoveLogo = () => {
    setLogoUrl('');
    updateUser({ logoUrl: '' });
    triggerSuccess('تم إزالة الشعار؛ سيعود النظام إلى الأيقونة الافتراضية');
  };

  // Save Notifications & Ops parameters
  const saveNotificationAndBackupSettings = () => {
    updateSettings({
      notifyOnExpiry,
      notifyOnLowStock,
      notifyOnUnpaidDebts,
      backupInterval,
      autoBackup
    });
    triggerSuccess('تم حفظ إعدادات الإشعارات وجدول النسخ الاحتياطي بنجاح! ⚙️');
  };

  // نسخة احتياطية فورية حقيقية — تصدّر ملف JSON فعلياً (كانت سابقاً تدّعي النجاح دون تنزيل أي ملف)
  const handleBackupNow = async () => {
    if (isBackingUp) return;
    setIsBackingUp(true);
    try {
      const payload = await exportBackup({
        uid: user.uid,
        storeName: user.storeName,
        ownerName: user.ownerName,
        businessType: user.businessType,
        settings,
      });
      updateSettings({ lastBackupAt: Date.now(), lastBackupDate: new Date().toLocaleDateString('ar-IQ') });
      // 🟡 نفس تحفّظ شاشة النسخ الاحتياطي: العدد يُقال، والنقص المحتمل يُقال
      if (payload.fromCache) {
        triggerError(
          `حُفظ الملف لكن **بلا اتصال بالخادم** — بُني من ذاكرة هذا الجهاز وقد يكون ناقصاً `
          + `(${toArabicDigits(payload.totalDocs)} وثيقة). أعد التصدير بعد عودة الإنترنت.`,
        );
      } else {
        triggerSuccess(`تم أخذ نسخة احتياطية وتنزيلها 💾 — ${toArabicDigits(payload.totalDocs)} وثيقة من الخادم.`);
      }
    } catch {
      triggerError('تعذّر أخذ النسخة الاحتياطية — تأكد من السماح بالتنزيل وحاول مجدداً');
    } finally {
      setIsBackingUp(false);
    }
  };

  // License activation via code — Firestore transaction
  const handleActivateLicense = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmedCode = licenseCode.trim();
    if (!trimmedCode) {
      setErrorMsg('الرجاء إدخال كود التفعيل المستلم أولاً');
      return;
    }

    const uid = auth.currentUser?.uid;
    if (!uid) {
      triggerError('يرجى إعادة تسجيل الدخول أولاً');
      return;
    }

    setIsActivating(true);
    setErrorMsg(null);

    try {
      const codeRef = doc(db, 'activationCodes', trimmedCode);
      const userRef = doc(db, 'users', uid);

      /**
       * 🔴 التفعيل يشترط قراءةً من **الخادم** قبل المعاملة.
       *
       * قِسْتُ الحالة في إصلاح الجرد الفعلي ولم أظنّها: `runTransaction` **لا تفشل** بلا
       * إنترنت، بل تقرأ من الذاكرة المحلية وتُكمل. فلو كانت وثيقة الكود مخبوءة من محاولة
       * سابقة، تمرّ المعاملة محلياً وتظهر «تهانينا! تم تفعيل حسابك مدى الحياة 🎉» — ثم
       * يرفضها الخادم عند المزامنة. والتاجر يكون قد دفع.
       *
       * `getDocFromServer` وحدها ترمي `[code=unavailable]` عند انعدام النفاذ الحقيقي،
       * مهما قال المتصفح عن حالة الشبكة.
       */
      try {
        await getDocFromServer(codeRef);
      } catch {
        throw new Error('offline');
      }

      await runTransaction(db, async (transaction) => {
        const codeSnap = await transaction.get(codeRef);

        if (!codeSnap.exists() || codeSnap.data().used === true) {
          throw new Error('invalid');
        }

        const now = new Date().toISOString();
        transaction.update(codeRef, { used: true, usedBy: uid, usedAt: now });
        transaction.update(userRef, {
          licenseStatus: 'active',
          activationCode: trimmedCode,
          activatedAt: now,
        });
      });

      setLicenseCode('');
      triggerSuccess('تهانينا! تم تفعيل حسابك مدى الحياة بنجاح 🎉');
    } catch (err: any) {
      console.error('[Activation]', err);
      if (err.message === 'offline') {
        triggerError(
          'التفعيل يحتاج اتصالاً حقيقياً بالإنترنت للتحقّق من الكود على الخادم. '
          + 'لم يُفعَّل شيء ولم يُستهلك كودك — تحقّق من الاتصال وأعد المحاولة.',
        );
      } else if (err.message === 'invalid') {
        triggerError('الكود غير صحيح أو تم استخدامه مسبقاً');
      } else {
        triggerError('حدث خطأ في الاتصال أو الصلاحيات، تحقق من الإنترنت وحاول مجدداً');
      }
    } finally {
      setIsActivating(false);
    }
  };

  return (
    <div className="space-y-6" id="settings_panel_view">
      
      {/* Toast Alert System banners */}
      {successMsg && (
        <div className="p-4 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-2xl text-xs md:text-sm font-bold flex items-center gap-2 animate-bounce" id="settings_success">
          <Check className="w-5 h-5 text-emerald-700 animate-pulse" />
          <span>{successMsg}</span>
        </div>
      )}

      {errorMsg && (
        <div className="p-4 bg-rose-50 text-rose-800 border border-rose-200 rounded-2xl text-xs md:text-sm font-bold flex items-center gap-2" id="settings_error">
          <AlertOctagon className="w-5 h-5 text-rose-700" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Grid Settings structure */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* RIGHT COLUMN: BRAND PROFILE SETUP (7 cols) */}
        <div className="lg:col-span-7 bg-white rounded-2xl p-6 border border-[#E4EAF3] shadow-sm space-y-6">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-100">
            <Building2 className="w-5.5 h-5.5 text-[#0B1F4D]" />
            <div>
              <h3 className="font-extrabold text-base font-cairo text-[#0B1F4D]">بيانات الهوية والمشروع الأولى</h3>
              <p className="text-[10px] text-slate-600 mt-0.5">اضبط اسم محلك وعنوانك والتفاصيل التي تظهر في الواجهة والوصولات</p>
            </div>
          </div>

          <form onSubmit={saveGeneralSettings} className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">اسم المحل / العلامة التجارية</label>
                <input
                  type="text"
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs md:text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#0B1F4D] font-bold"
                  placeholder="مثال: أسواق النور، منظومة الفجر"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">اسم صاحب العمل</label>
                <input
                  type="text"
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs md:text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#0B1F4D]"
                  placeholder="مثال: كفاح العامري"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">رقم هاتف المحل العراقي</label>
                <div className="relative">
                  <Phone className="absolute right-3.5 top-3 w-4 h-4 text-slate-500 pointer-events-none" />
                  {/* inputMode="tel": لوحة أرقام على الهاتف، بلا أثر على الكمبيوتر */}
                  <input
                    type="text"
                    inputMode="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full pl-4 pr-10 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs md:text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#0B1F4D] font-mono"
                    placeholder="مثال: 0770XXXXXXX"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">عنوان النشاط في العراق</label>
                <div className="relative">
                  <MapPin className="absolute right-3.5 top-3 w-4 h-4 text-slate-500 pointer-events-none" />
                  <input
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    className="w-full pl-4 pr-10 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs md:text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#0B1F4D]"
                    placeholder="مثال: بغداد - الكرادة - قرب ساحة التحريات"
                  />
                </div>
              </div>
            </div>

            {/* LICENSE & ACTIVATION — حلّت محلّ مربع الشعار/الختم السابق */}
            <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-orange-200 rounded-2xl p-5 space-y-3">
              <h4 className="font-extrabold text-xs md:text-sm text-orange-800 flex items-center gap-2">
                <Key className="w-5 h-5 text-orange-600 animate-pulse" />
                <span>ترخيص وتفعيل البرنامج مدى الحياة</span>
              </h4>
              <p className="text-[11px] text-slate-600 leading-relaxed">
                نظام "رتب شغلك" أوفلاين بالكامل. شراء نسختك يضمن دعم التحديث والمزامنة. للتفعيل، تواصل مع الرقم أدناه.
              </p>

              {isLicensed ? (
                <div className="p-3 bg-emerald-500/10 border border-emerald-300 text-emerald-800 text-xs font-bold rounded-xl text-center">
                  ✔ جهازك مرخص مدى الحياة بكافة الموديلات النشطة. المزامنة مستمرة.
                </div>
              ) : (
                <div className="space-y-3 pt-1">
                  <div className="p-3 bg-white rounded-xl border border-orange-100 space-y-2.5">
                    <div className="flex items-center justify-between text-[11px] font-bold">
                      <span className="text-slate-600">للتواصل والتفعيل:</span>
                      <span className="text-orange-700 font-mono font-extrabold tracking-wide" dir="ltr">{SUPPORT_PHONE}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <a
                        href={`https://wa.me/${SUPPORT_PHONE_INTL}`}
                        target="_blank"
                        onClick={onExternalLink}
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-1.5 py-2 px-3 bg-[#25D366] hover:bg-[#1ebe5d] text-white text-[11px] font-extrabold rounded-xl transition"
                      >
                        <MessageCircle className="w-3.5 h-3.5" />
                        <span>واتساب</span>
                      </a>
                      <a
                        href={`tel:${SUPPORT_PHONE}`}
                        className="flex items-center justify-center gap-1.5 py-2 px-3 bg-[#0B1F4D] hover:bg-[#152e6d] text-white text-[11px] font-extrabold rounded-xl transition"
                      >
                        <Phone className="w-3.5 h-3.5" />
                        <span>اتصال</span>
                      </a>
                    </div>
                  </div>

                  {/* إدخال كود التفعيل — بلا <form> متداخل (نموذج الهوية يحيط بها)؛ التفعيل عبر النقر/Enter */}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={licenseCode}
                      onChange={(e) => setLicenseCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleActivateLicense(); } }}
                      placeholder="أدخل كود التفعيل المستلم هُنـا..."
                      className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-orange-500 font-bold text-center"
                    />
                    <button
                      type="button"
                      onClick={() => handleActivateLicense()}
                      disabled={isActivating}
                      className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-xl text-xs font-extrabold transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {isActivating
                        ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>جاري التحقق...</span></>
                        : 'تفعيل'
                      }
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* CURRENCY & EXCHANGE RATE SETTINGS */}
            <div className="border-t border-slate-100 pt-5 space-y-4">
              <h4 className="font-extrabold text-xs text-[#0B1F4D] block mb-1 flex items-center gap-1.5">
                <Landmark className="w-4 h-4 text-emerald-700" />
                <span>إعدادات العملة وسعر الصرف بالدينار</span>
              </h4>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">سعر صرف الدولار (د.ع مقابل 1$)</label>
                  <NumberInput inputMode="decimal"
                    value={rate}
                    onValueChange={(v) => setRate(v)}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs md:text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#0B1F4D] font-bold"
                    placeholder="مثال: 1530"
                    required
                  />
                  <span className="text-[10px] text-slate-600 mt-1 block">يستخدم للتحويل الفوري بين الدينار والدولار بالوصولات</span>
                </div>

                <div>
                  <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">العملة الافتراضية المعتمدة بالحسابات</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => updateSettings({ currency: 'IQD' })}
                      className={`flex-1 py-2.5 px-4 rounded-xl font-extrabold text-xs transition border cursor-pointer ${
                        settings.currency === 'IQD' 
                          ? 'bg-[#0B1F4D] text-white border-[#0B1F4D]' 
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      دينار عراقي (IQD)
                    </button>
                    <button
                      type="button"
                      onClick={() => updateSettings({ currency: 'USD' })}
                      className={`flex-1 py-2.5 px-4 rounded-xl font-extrabold text-xs transition border cursor-pointer ${
                        settings.currency === 'USD' 
                          ? 'bg-[#0B1F4D] text-white border-[#0B1F4D]' 
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      دولار أمريكي (USD)
                    </button>
                  </div>
                  {/**
                    * 🟠 نموذجان بسلوكَي حفظ متناقضين: العملة تُطبَّق **فوراً** وسعر الصرف
                    * ينتظر زرّ الحفظ. فمن يبدّل للدولار ثم يكتب سعراً جديداً ويغادر —
                    * تتحوّل أرقامه كلها بالسعر **القديم** وهو يظنّ أنه غيّره. نقولها بدل
                    * أن نفترض أنه يعرف، وننبّه صراحةً حين يكون السعر المكتوب غير محفوظ.
                    */}
                  <span className="text-[10px] text-slate-600 mt-1.5 block leading-relaxed">
                    تبديل العملة يُطبَّق فوراً على كل الشاشات. أمّا <b>سعر الصرف</b> أعلاه فيحتاج زرّ الحفظ.
                  </span>
                  {settings.currency === 'USD' && parseAmount(rate) !== settings.exchangeRate && (
                    <span className="text-[10px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2 mt-1.5 block leading-relaxed">
                      ⚠️ العرض بالدولار يستعمل السعر المحفوظ ({toArabicDigits(settings.exchangeRate)} د.ع)،
                      والسعر المكتوب أعلاه لم يُحفظ بعد. اضغط «حفظ إعدادات المحل» ليُطبَّق.
                    </span>
                  )}
                </div>
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-3 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl transition text-xs shadow cursor-pointer mt-2"
            >
              حفظ وتثبيت إعدادات الهوية وسعر الصرف 💾
            </button>
          </form>
        </div>

        {/* LEFT COLUMN: OPERATIONS, NOTIFICATIONS & BACKUP SETTINGS (5 cols) */}
        <div className="lg:col-span-5 space-y-6">

          {/* Employee management — owner only (self-gated) */}
          <EmployeeManagement />

          {/* Notifications and Safety Warnings panel */}
          <div className="bg-white rounded-2xl p-6 border border-[#E4EAF3] shadow-sm space-y-5">
            <h3 className="font-extrabold text-base font-cairo text-[#0B1F4D] flex items-center gap-2 pb-3 border-b border-slate-100">
              <Bell className="w-5.5 h-5.5 text-blue-600" />
              <div>
                <span>خيارات التنبيهات والإشعارات الذكية</span>
                <p className="text-[10px] text-slate-600 font-normal mt-0.5">تحكم بظهور التحذيرات العراقية بمستشارك الذكي</p>
              </div>
            </h3>

            <div className="space-y-4">
              
              {/* Toggle row 1 */}
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-200">
                <div className="max-w-[75%]">
                  <span className="text-xs font-bold text-[#0B1F4D] block">إشعارات انتهاء الصلاحيات والمدد 🕒</span>
                  <p className="text-[10px] text-slate-600 mt-0.5">للأدوية القريبة الصلاحية وللاشتراكات المنتهية بالمنظومة</p>
                </div>
                <input 
                  type="checkbox"
                  checked={notifyOnExpiry}
                  onChange={(e) => setNotifyOnExpiry(e.target.checked)}
                  className="w-5 h-5 text-emerald-700 rounded border-slate-300 focus:ring-0 cursor-pointer"
                />
              </div>

              {/* Toggle row 2 */}
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-200">
                <div className="max-w-[75%]">
                  <span className="text-xs font-bold text-[#0B1F4D] block">إشعار نقص المخزون (حد الأمان) 📦</span>
                  <p className="text-[10px] text-slate-600 mt-0.5">عند نزول بضاعة أو علبة في الرف دبل حد الطلب الحرج</p>
                </div>
                <input 
                  type="checkbox"
                  checked={notifyOnLowStock}
                  onChange={(e) => setNotifyOnLowStock(e.target.checked)}
                  className="w-5 h-5 text-emerald-700 rounded border-slate-300 focus:ring-0 cursor-pointer"
                />
              </div>

              {/* Toggle row 3 */}
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-200">
                <div className="max-w-[75%]">
                  <span className="text-xs font-bold text-[#0B1F4D] block">تنبيه مواعيد الديون والذمم المتأخرة 💸</span>
                  <p className="text-[10px] text-slate-600 mt-0.5">جباية المشتركين ودفتر الزبائن المطلوبين ذمم مالية</p>
                </div>
                <input 
                  type="checkbox"
                  checked={notifyOnUnpaidDebts}
                  onChange={(e) => setNotifyOnUnpaidDebts(e.target.checked)}
                  className="w-5 h-5 text-emerald-700 rounded border-slate-300 focus:ring-0 cursor-pointer"
                />
              </div>

            </div>

            <button 
              onClick={saveNotificationAndBackupSettings}
              className="w-full py-2 bg-blue-50 text-[#1B3A7A] hover:bg-blue-100 border border-blue-200 text-xs font-bold rounded-xl transition cursor-pointer"
            >
              حفظ تفضيلات التنبيهات والتشغيل
            </button>
          </div>

          {/* Backup options and Cloud configurations */}
          {/* ---- صيغة طباعة الفاتورة ---- */}
          <div className="bg-white rounded-2xl p-6 border border-[#E4EAF3] shadow-sm space-y-4">
            <h3 className="font-extrabold text-base font-cairo text-[#0B1F4D] flex items-center gap-2 pb-3 border-b border-slate-100">
              <Printer className="w-5.5 h-5.5 text-indigo-600" />
              <div>
                <span>طباعة الفاتورة</span>
                <p className="text-[10px] text-slate-600 font-normal mt-0.5">اختر مرة واحدة، وكل زر طباعة في البرنامج يلتزم بها</p>
              </div>
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {(['a4', 'thermal80', 'thermal58'] as PrintFormat[]).map(f => {
                const active = printFormat === f;
                const hint = f === 'a4'
                  ? 'فاتورة رسمية بجدول وألوان — للشركات والدوائر'
                  : f === 'thermal80'
                    ? 'الأكثر شيوعاً في المحلات — بكرة ٨٠ملم'
                    : 'بكرة صغيرة ٥٨ملم — للأكشاك والمحلات الصغيرة';
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => updateSettings({ printFormat: f })}
                    className={`p-3.5 rounded-xl border-2 text-right transition cursor-pointer ${
                      active ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
                    }`}
                  >
                    <span className="flex items-center gap-1.5 font-extrabold text-xs text-[#0B1F4D]">
                      {f === 'a4' ? <FileText className="w-4 h-4 text-slate-500" /> : <Receipt className="w-4 h-4 text-indigo-600" />}
                      {PRINT_FORMAT_LABEL[f]}
                    </span>
                    <span className="text-[10px] text-slate-600 font-bold block mt-1 leading-relaxed">{hint}</span>
                  </button>
                );
              })}
            </div>

            <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-[10px] font-bold text-blue-900 leading-relaxed flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>
                للطابعة الحرارية: ثبّتها في ويندوز أولاً، ثم في نافذة الطباعة اختر اسمها واضبط
                <b> حجم الورق</b> على <b>{printFormat === 'thermal58' ? '٥٨ملم' : '٨٠ملم'}</b> والهوامش على <b>بلا</b>.
                كشف حساب الزبون متعدّد الفواتير يُطبع على A4 دائماً مهما كان اختيارك — لا معنى لطباعته على بكرة.
              </span>
            </div>
          </div>

          <div className="bg-white rounded-2xl p-6 border border-[#E4EAF3] shadow-sm space-y-4">
            <h3 className="font-extrabold text-base font-cairo text-[#0B1F4D] flex items-center gap-2 pb-3 border-b border-slate-100">
              <Database className="w-5.5 h-5.5 text-emerald-700" />
              <div>
                <span>إدارة النسخ الاحتياطي والأرشفة</span>
                <p className="text-[10px] text-slate-600 font-normal mt-0.5">احمِ حسابات محلك من الفقدان والانهيارات المفاجئة</p>
              </div>
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[#0B1F4D] mb-1.5">جدول النسخ الاحتياطي التلقائي</label>
                <select 
                  value={backupInterval}
                  onChange={(e: any) => setBackupInterval(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-right text-slate-700 bg-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#0B1F4D]"
                >
                  <option value="daily">نسخ احتياطي يومي مجدول (أمان قوي)</option>
                  <option value="weekly">نسخ احتياطي أسبوعي (أمان وسط)</option>
                  <option value="monthly">نسخ احتياطي شهري</option>
                  <option value="manual">يدوي بالكامل (حسب الرغبة)</option>
                </select>
              </div>

              {/* Toggle trigger */}
              <div className="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl">
                <div>
                  <span className="text-xs font-bold text-[#0B1F4D] block">تفعيل النسخ الاحتياطي التلقائي</span>
                  <p className="text-[11px] text-slate-500">ينزّل ملف نسخة تلقائياً حسب الجدول أعلاه عند فتح البرنامج</p>
                </div>
                <input 
                  type="checkbox"
                  checked={autoBackup}
                  onChange={(e) => setAutoBackup(e.target.checked)}
                  className="w-4 h-4 text-emerald-700 rounded border-slate-300 focus:ring-0 cursor-pointer"
                />
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleBackupNow}
                  disabled={isBackingUp}
                  className="w-full py-3 bg-[#EEF2F8] hover:bg-slate-200 text-[#0B1F4D] font-bold rounded-xl text-xs border border-slate-200 flex items-center justify-center gap-2 transition disabled:opacity-50 cursor-pointer"
                >
                  {isBackingUp ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin text-emerald-700" />
                      <span>جاري تشفير وأرشفة الكود...</span>
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-4 h-4 text-slate-500" />
                      <span>أرسل نسخة احتياطية فورية وحملها للجهاز</span>
                    </>
                  )}
                </button>
                <div className="flex justify-between items-center text-[10px] text-slate-600 mt-2 font-mono">
                  <span>آخر نسخ آمن محفوظ:</span>
                  <span className="text-slate-600 font-bold">{toArabicDigits(settings.lastBackupDate)}</span>
                </div>
              </div>

            </div>
          </div>

        </div>

      </div>

    </div>
  );
}
