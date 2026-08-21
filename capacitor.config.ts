import type { CapacitorConfig } from '@capacitor/cli';

/**
 * إعداد تغليف التطبيق لأندرويد (ولاحقاً iOS) عبر Capacitor.
 *
 * 🔴 `androidScheme: 'https'` ليس تفصيلاً: يجعل أصل التطبيق `https://localhost`
 * بدل `http://localhost`، وهذا **سياقٌ آمن (secure context)**. وبدونه:
 *   · `crypto.getRandomValues` غير متاح ⟶ ينكسر توليد أكواد التفعيل وكلمات
 *     مرور الموظفين (`utils/secureRandom.ts`) — وهو مسارٌ يمسّ المال والصلاحيات.
 *   · فايرستور والمصادقة يرفضان العمل، و`navigator.clipboard` يختفي.
 *   · عامل الخدمة لا يُسجَّل أصلاً.
 * وهو الافتراضي في Capacitor الحديث؛ يُثبَّت هنا **صراحةً** كي لا يتغيّر بصمت.
 *
 * ⚠️ ويجب أن يكون `localhost` ضمن «النطاقات المصرّح بها» في فايربيس
 * (Authentication ← Settings ← Authorized domains). وهو مُدرَجٌ افتراضياً.
 *
 * والهوية `com.ratibshghlk.app` هي نفسها المستعملة في مثبّت ويندوز
 * (`package.json` ← build.appId) — هويةٌ واحدة للمنتج على المنصّتين.
 */
const config: CapacitorConfig = {
  appId: 'com.ratibshghlk.app',
  appName: 'رتب شغلك',
  webDir: 'dist',

  android: {
    /** لا محتوى غير مشفّر داخل صفحة مشفّرة — دفاعٌ في العمق مع CSP. */
    allowMixedContent: false,
    /**
     * 🔴 تنقيح WebView مُطفأ: تركُه مفتوحاً يسمح لأي شخص يصل إلى جهاز التاجر
     * بفتح أدوات المطوّر على تطبيقه وقراءة دفتره كاملاً عبر USB.
     */
    webContentsDebuggingEnabled: false,
  },

  server: {
    androidScheme: 'https',
  },
};

export default config;
