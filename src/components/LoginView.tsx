import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Mail, Lock, LogIn, UserPlus, Sparkles, Send, ArrowRight, KeyRound } from 'lucide-react';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  signInWithPopup,
} from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { auth } from '../firebase';
import { Capacitor } from '@capacitor/core';

function getFirebaseErrorMessage(error: unknown): string {
  if (error instanceof FirebaseError) {
    switch (error.code) {
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential':
        return 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
      case 'auth/email-already-in-use':
        return 'هذا البريد الإلكتروني مسجّل بالفعل، حاول تسجيل الدخول';
      case 'auth/weak-password':
        return 'كلمة المرور ضعيفة جداً (٦ أحرف على الأقل)';
      case 'auth/invalid-email':
        return 'صيغة البريد الإلكتروني غير صحيحة';
      case 'auth/too-many-requests':
        return 'محاولات كثيرة، انتظر قليلاً ثم حاول مجدداً';
      case 'auth/popup-closed-by-user':
        return 'أُغلقت نافذة تسجيل الدخول';
      default:
        return `خطأ غير متوقع (${error.code})`;
    }
  }
  return 'حدث خطأ، يرجى المحاولة مجدداً';
}

export default function LoginView() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [notification, setNotification] = useState<{ text: string; isError: boolean } | null>(null);
  // ---- استعادة كلمة المرور (تعمل لأي حساب: مالك أو موظف — كلاهما حساب Firebase Auth عادي) ----
  const [showReset, setShowReset] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [isSending, setIsSending] = useState(false);

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setNotification(null);
    try {
      if (isSignUp) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      // onAuthStateChanged in App.tsx handles navigation after success
    } catch (error) {
      setNotification({ text: getFirebaseErrorMessage(error), isError: true });
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * 🔴 الدخول بحساب غوغل **لا يعمل داخل تطبيق الهاتف** — وهذا ليس عطلاً عندنا:
   * غوغل تحجب OAuth عمداً داخل أي WebView مُضمَّن (`disallowed_useragent`) منذ
   * ٢٠٢١، حمايةً من تطبيقاتٍ تسرق كلمات المرور بعرض صفحة دخولٍ مزيّفة.
   *
   * والمحاولة رغم ذلك تُنتج شاشة غوغل بيضاء برسالةٍ إنجليزية غامضة، فيظنّ
   * التاجر التطبيق معطوباً. فنقول له الحقيقة، ونعطيه مخرجاً يعمل الآن.
   *
   * 🎯 والحلّ الدائم: تسجيل دخولٍ **أصلي** عبر خدمات غوغل على الجهاز
   * (`@capacitor-firebase/authentication`). وهو يتطلّب ملف `google-services.json`
   * من لوحة فايربيس وبصمة SHA-1 لمفتاح التوقيع — كلاهما بيد مالك الحساب لا بيد
   * الشيفرة. ولذلك يبقى هذا المسار معطّلاً على الهاتف حتى يُضاف الملف، بدل أن
   * يُشحن زرٌّ يفشل عند كل ضغطة.
   */
  const handleGoogleSignIn = async () => {
    if (Capacitor.isNativePlatform()) {
      setNotification({
        text: 'الدخول بحساب غوغل غير متاح داخل تطبيق الهاتف (قيدٌ من غوغل نفسها). '
          + 'استعمل البريد وكلمة المرور هنا، أو ادخل من نسخة الكمبيوتر أو المتصفّح.',
        isError: true,
      });
      return;
    }
    setIsLoading(true);
    setNotification(null);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      setNotification({ text: getFirebaseErrorMessage(error), isError: true });
    } finally {
      setIsLoading(false);
    }
  };

  const switchMode = (signUp: boolean) => {
    setIsSignUp(signUp);
    setNotification(null);
  };

  // فتح لوحة الاستعادة — نعبّئ البريد تلقائياً إن كتبه المستخدم أصلاً في نموذج الدخول
  const openReset = () => {
    setResetEmail(email);
    setShowReset(true);
    setNotification(null);
  };

  const backToLogin = () => {
    setShowReset(false);
    setNotification(null);
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = resetEmail.trim();
    if (!target) {
      setNotification({ text: 'يرجى إدخال بريدك الإلكتروني أولاً', isError: true });
      return;
    }
    setIsSending(true);
    setNotification(null);
    try {
      await sendPasswordResetEmail(auth, target);
      // رسالة موحّدة عند النجاح — نطمئن المستخدم دون تأكيد أن البريد مسجّل (أمان قياسي)
      setNotification({
        text: 'تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك الإلكتروني. تحقق من صندوق الوارد (وقد تحتاج مراجعة مجلد الرسائل غير المرغوب فيها).',
        isError: false,
      });
    } catch (error) {
      let msg: string;
      if (error instanceof FirebaseError) {
        switch (error.code) {
          case 'auth/user-not-found':
            // لا نكشف أن البريد غير مسجّل — نفس نبرة رسالة النجاح
            msg = 'إن كان هذا البريد مسجّلاً لدينا فستصلك رسالة بها رابط إعادة التعيين. تحقق من الوارد ومجلد الرسائل غير المرغوب فيها.';
            setNotification({ text: msg, isError: false });
            setIsSending(false);
            return;
          case 'auth/invalid-email':
            msg = 'صيغة البريد الإلكتروني غير صحيحة';
            break;
          case 'auth/missing-email':
            msg = 'يرجى إدخال بريدك الإلكتروني أولاً';
            break;
          case 'auth/too-many-requests':
            msg = 'محاولات كثيرة، انتظر قليلاً ثم حاول مجدداً';
            break;
          case 'auth/network-request-failed':
            msg = 'تعذّر الاتصال بالإنترنت — تحقق من الشبكة وحاول مجدداً';
            break;
          default:
            msg = `تعذّر إرسال الرابط (${error.code})`;
        }
      } else {
        msg = 'حدث خطأ، يرجى المحاولة مجدداً';
      }
      setNotification({ text: msg, isError: true });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-radial from-[#1B3A7A] to-[#0B1F4D] px-4 py-12 relative overflow-hidden">
      {/* Background accents */}
      <div className="absolute top-[-10%] left-[-15%] w-[60%] h-[60%] rounded-full bg-blue-500/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-15%] w-[60%] h-[60%] rounded-full bg-teal-500/10 blur-[120px] pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-[#E4EAF3] overflow-hidden z-10"
        id="login_card_container"
      >
        {/* Header */}
        <div className="p-8 text-center bg-gradient-to-b from-slate-50 to-white border-b border-slate-100">
          <div className="flex justify-center items-center gap-2 mb-4">
            <div className="w-12 h-12 rounded-xl bg-[#0B1F4D] flex items-center justify-center text-white shadow-lg shadow-blue-900/30">
              <Sparkles className="w-6 h-6 text-[#00e5a3]" />
            </div>
            <h1 className="text-3xl font-extrabold font-cairo tracking-tight text-[#0B1F4D] select-none">
              رتب <span className="text-[#10b981]">شغلك</span>
            </h1>
          </div>
          <p className="text-[#5B6B86] text-sm font-medium">
            منصة إدارة الأعمال والقطاعات المتكاملة للمحلات العراقية
          </p>
        </div>

        <div className="p-8">
          {/* Notification */}
          {notification && (
            <div
              className={`mb-4 p-3 rounded-xl text-xs flex items-center gap-2 border ${
                notification.isError
                  ? 'bg-red-50 text-red-700 border-red-100'
                  : 'bg-amber-50 text-amber-700 border-amber-100'
              }`}
              id="login_notification"
            >
              <span>{notification.text}</span>
            </div>
          )}

          {showReset ? (
            /* ---- Password reset panel ---- */
            <div id="password_reset_panel">
              <div className="text-center mb-5">
                <div className="w-11 h-11 rounded-xl bg-[#EEF2F8] flex items-center justify-center text-[#0B1F4D] mx-auto mb-3">
                  <KeyRound className="w-5 h-5" />
                </div>
                <h2 className="text-base font-extrabold font-cairo text-[#0B1F4D]">إعادة تعيين كلمة المرور</h2>
                <p className="text-[11px] text-[#5B6B86] mt-1 leading-relaxed">
                  أدخل بريدك الإلكتروني وسنرسل لك رابط إعادة تعيين كلمة المرور
                </p>
              </div>

              <form onSubmit={handleForgotPassword} className="space-y-4" id="password_reset_form">
                <div>
                  <label className="block text-xs font-bold text-[#0B1F4D] mb-2">البريد الإلكتروني</label>
                  <div className="relative">
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
                      <Mail className="w-4 h-4" />
                    </span>
                    <input
                      type="email"
                      value={resetEmail}
                      onChange={(e) => setResetEmail(e.target.value)}
                      className="w-full pr-10 pl-4 py-3 bg-slate-50 border border-[#E4EAF3] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#0B1F4D] focus:bg-white font-medium"
                      placeholder="example@email.com"
                      dir="ltr"
                      required
                      autoFocus
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isSending}
                  className="w-full py-3 px-4 bg-[#0B1F4D] hover:bg-[#1B3A7A] text-white font-bold rounded-xl transition duration-200 flex items-center justify-center gap-2 text-sm disabled:opacity-50 cursor-pointer"
                >
                  {isSending ? (
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                  ) : (
                    <><Send className="w-4 h-4" /><span>إرسال رابط إعادة التعيين</span></>
                  )}
                </button>

                <button
                  type="button"
                  onClick={backToLogin}
                  disabled={isSending}
                  className="w-full py-2.5 px-4 border border-[#E4EAF3] hover:bg-slate-50 text-slate-600 font-bold rounded-xl transition flex items-center justify-center gap-1.5 text-xs disabled:opacity-50 cursor-pointer"
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                  <span>العودة لتسجيل الدخول</span>
                </button>
              </form>
            </div>
          ) : (
          <>
          {/* Login / Sign-up toggle */}
          <div className="flex rounded-xl bg-slate-100 p-1 mb-5">
            <button
              type="button"
              onClick={() => switchMode(false)}
              className={`flex-1 py-2 text-xs font-bold rounded-lg transition ${
                !isSignUp ? 'bg-white text-[#0B1F4D] shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              تسجيل الدخول
            </button>
            <button
              type="button"
              onClick={() => switchMode(true)}
              className={`flex-1 py-2 text-xs font-bold rounded-lg transition ${
                isSignUp ? 'bg-white text-[#0B1F4D] shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              إنشاء حساب جديد
            </button>
          </div>

          {/* Email / Password form */}
          <form onSubmit={handleEmailAuth} className="space-y-4" id="email_login_form">
            <div>
              <label className="block text-xs font-bold text-[#0B1F4D] mb-2">البريد الإلكتروني</label>
              <div className="relative">
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
                  <Mail className="w-4 h-4" />
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pr-10 pl-4 py-3 bg-slate-50 border border-[#E4EAF3] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#0B1F4D] focus:bg-white font-medium"
                  placeholder="example@email.com"
                  dir="ltr"
                  required
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="text-xs font-bold text-[#0B1F4D]">كلمة المرور</label>
                {!isSignUp && (
                  <button
                    type="button"
                    className="text-xs text-[#1B3A7A] hover:underline cursor-pointer"
                    onClick={openReset}
                  >
                    نسيت كلمة المرور؟
                  </button>
                )}
              </div>
              <div className="relative">
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
                  <Lock className="w-4 h-4" />
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pr-10 pl-4 py-3 bg-slate-50 border border-[#E4EAF3] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#0B1F4D] focus:bg-white text-right"
                  placeholder="••••••••"
                  required
                  minLength={6}
                />
              </div>
              {isSignUp && (
                <p className="text-slate-400 text-[10px] mt-1 text-right">٦ أحرف على الأقل</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 px-4 bg-[#0B1F4D] hover:bg-[#1B3A7A] text-white font-bold rounded-xl transition duration-200 flex items-center justify-center gap-2 text-sm disabled:opacity-50 cursor-pointer"
              id="btn_submit_login"
            >
              {isLoading ? (
                <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
              ) : isSignUp ? (
                <><UserPlus className="w-4 h-4" /><span>إنشاء الحساب</span></>
              ) : (
                <><LogIn className="w-4 h-4" /><span>تسجيل الدخول</span></>
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="relative flex py-5 items-center">
            <div className="flex-grow border-t border-slate-200" />
            <span className="flex-shrink mx-4 text-xs font-bold text-slate-400">أو تابع عبر</span>
            <div className="flex-grow border-t border-slate-200" />
          </div>

          {/* Google sign-in */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 p-3 border border-[#E4EAF3] hover:bg-slate-50 rounded-xl transition text-slate-700 bg-white cursor-pointer group disabled:opacity-50"
            id="btn_google_sign_in"
          >
            <svg className="w-5 h-5 group-hover:scale-110 transition flex-shrink-0" viewBox="0 0 24 24" fill="none">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.85c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            <span className="text-xs font-bold">متابعة عبر حساب غوغل</span>
          </button>
          </>
          )}
        </div>

        <div className="p-4 bg-slate-50 border-t border-slate-100 text-center">
          <p className="text-xs text-[#5B6B86]">
            بتسجيل الدخول توافق على شروط الاستخدام وسياسة الخصوصية
          </p>
        </div>
      </motion.div>
    </div>
  );
}
