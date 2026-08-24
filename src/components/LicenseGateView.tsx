import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { doc, runTransaction } from 'firebase/firestore';
import { db } from '../firebase';
import { Key, ShieldAlert, CheckCircle2, LogOut, Loader2, AlertOctagon } from 'lucide-react';
import { toArabicDigits } from '../utils/arabicFormatters';

interface LicenseGateViewProps {
  uid: string;
  ownerName: string;
  onLogout: () => void;
}

export default function LicenseGateView({ uid, ownerName, onLogout }: LicenseGateViewProps) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // شبكة أمان: التفعيل نجح لكن onSnapshot لم يرفع الشاشة (انقطاع مزامنة بعد النجاح مباشرة)
  const [showReloadHint, setShowReloadHint] = useState(false);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setShowReloadHint(true), 6000);
    return () => clearTimeout(t);
  }, [success]);

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedCode = code.trim();
    if (!trimmedCode) return;

    setLoading(true);
    setError(null);

    try {
      const codeRef = doc(db, 'activationCodes', trimmedCode);
      const userRef = doc(db, 'users', uid);

      await runTransaction(db, async (transaction) => {
        const codeSnap = await transaction.get(codeRef);

        if (!codeSnap.exists() || codeSnap.data().used === true) {
          throw new Error('invalid');
        }

        const now = new Date().toISOString();
        transaction.update(codeRef, {
          used: true,
          usedBy: uid,
          usedAt: now,
        });
        transaction.update(userRef, {
          licenseStatus: 'active',
          activationCode: trimmedCode,
          activatedAt: now,
        });
      });

      setSuccess(true);
      // الـ onSnapshot في useProfile سيلتقط التغيير تلقائياً ويرفع شاشة القفل
    } catch (err: any) {
      if (err.message === 'invalid') {
        setError('كود غير صحيح أو تم استخدامه مسبقاً');
      } else {
        console.error('[LicenseGate] activation error:', err);
        setError('حدث خطأ في الاتصال أو الصلاحيات، تحقق من الإنترنت وحاول مجدداً');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B1F4D] flex items-center justify-center p-4 relative overflow-hidden" dir="rtl">

      {/* خلفية مزخرفة */}
      <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-sky-600/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-emerald-500/10 rounded-full blur-[100px] pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden"
      >
        {/* رأس الشاشة */}
        <div className="bg-gradient-to-br from-[#0B1F4D] to-[#1B3A7A] px-8 py-8 text-center text-white">
          <div className="w-16 h-16 rounded-2xl bg-white/10 border border-white/20 flex items-center justify-center mx-auto mb-4">
            <ShieldAlert className="w-8 h-8 text-amber-400" />
          </div>
          <h2 className="text-xl font-extrabold font-cairo mb-1">انتهت فترتك التجريبية</h2>
          <p className="text-sm text-blue-200 font-medium">
            مرحباً {ownerName}، لمواصلة استخدام رتب شغلك يرجى تفعيل حسابك
          </p>
        </div>

        {/* جسم النموذج */}
        <div className="px-8 py-7 space-y-5">

          {success ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="text-center py-6 space-y-3"
            >
              <CheckCircle2 className="w-16 h-16 text-emerald-700 mx-auto" />
              <h3 className="font-extrabold text-[#0B1F4D] text-lg font-cairo">تم التفعيل بنجاح! 🎉</h3>
              <p className="text-sm text-slate-500">جاري تحديث حسابك تلقائياً...</p>

              {showReloadHint && (
                <div className="pt-2 space-y-2.5">
                  <p className="text-[11px] text-slate-500 font-bold leading-relaxed">
                    تأخّر تحديث الشاشة (قد يكون الاتصال ضعيفاً). تفعيلك محفوظ — أعد تحميل التطبيق.
                  </p>
                  <button
                    onClick={() => window.location.reload()}
                    className="px-5 py-2.5 bg-[#0B1F4D] hover:bg-[#152e6d] text-white font-extrabold rounded-xl text-xs transition cursor-pointer"
                  >
                    إعادة تحميل التطبيق
                  </button>
                </div>
              )}
            </motion.div>
          ) : (
            <>
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-xs text-amber-800 leading-relaxed font-medium flex gap-2.5 items-start">
                <Key className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block mb-0.5">للتفعيل تواصل مع مندوبينا في العراق</span>
                  أو أرسل لنا على واتساب على الرقم:
                  <span className="font-mono font-extrabold text-amber-900 block mt-1">٠٧٧٢٤١٠٦٤١٤</span>
                </div>
              </div>

              <form onSubmit={handleActivate} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-[#0B1F4D] mb-2">
                    كود التفعيل المستلم
                  </label>
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => { setCode(e.target.value); setError(null); }}
                    placeholder="أدخل الكود هنا..."
                    dir="ltr"
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-center font-mono font-bold tracking-widest focus:outline-none focus:ring-2 focus:ring-[#0B1F4D] uppercase"
                    disabled={loading}
                    autoComplete="off"
                  />
                </div>

                {error && (
                  <motion.div
                    initial={{ opacity: 0, y: -5 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-2 p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs font-bold text-rose-700"
                  >
                    <AlertOctagon className="w-4 h-4 flex-shrink-0" />
                    <span>{error}</span>
                  </motion.div>
                )}

                <button
                  type="submit"
                  disabled={loading || !code.trim()}
                  className="w-full py-3.5 bg-[#0B1F4D] hover:bg-[#152e6d] active:scale-95 text-white font-extrabold rounded-xl transition-all text-sm flex items-center justify-center gap-2 disabled:opacity-40 cursor-pointer"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>جاري التحقق...</span>
                    </>
                  ) : (
                    <>
                      <Key className="w-4 h-4" />
                      <span>تفعيل الحساب</span>
                    </>
                  )}
                </button>
              </form>
            </>
          )}

          {!success && (
            <div className="pt-2 border-t border-slate-100 text-center">
              <button
                onClick={onLogout}
                className="text-xs text-slate-500 hover:text-red-700 font-bold flex items-center gap-1.5 mx-auto transition cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>تسجيل الخروج</span>
              </button>
            </div>
          )}
        </div>

        {/* تذييل */}
        <div className="px-8 pb-5 text-center">
          <p className="text-[10px] text-slate-500 font-mono">
            معرّف حسابك: {toArabicDigits(uid.slice(0, 8))}...
          </p>
        </div>
      </motion.div>
    </div>
  );
}
