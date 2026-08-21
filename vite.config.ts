import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, Plugin} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

/**
 * 🔴 سياسة أمان المحتوى (CSP) — كانت غائبة تماماً (ISSUE-015).
 *
 * البرنامج يُثبَّت عند التاجر ويحمل دفتره كلّه، فغياب CSP يعني أن أي نصّ يتسلّل إلى
 * الصفحة يستطيع الاتصال بأي خادم في الدنيا وتصدير ما شاء. ولم أجد ثغرة حقن فعلية
 * (كل مسارات الطباعة والتصدير تُهرّب HTML) — لكن CSP دفاعٌ في العمق: يجعل الثغرة
 * القادمة، إن وُجدت، عاجزةً عن إخراج شيء.
 *
 * ⚠️ ويُحقن في **البناء الإنتاجي وحده**: خادم التطوير يحتاج `eval` و`inline` لعمل HMR،
 * فحقنه هناك يُعطّل التطوير بلا فائدة أمنية (لا أحد يشحن خادم تطوير).
 *
 * النطاقات المسموحة مُشتقّة من حاجة فايربيس الفعلية لا من التخمين:
 *   · connect — فايرستور والمصادقة والتثبيتات والتحليلات
 *   · script  — الحزمة نفسها + apis.google.com (الدخول بحساب غوغل)
 *   · frame   — معالج المصادقة (نافذة غوغل) — وبدونه ينكسر تسجيل الدخول
 *   · style   — 'unsafe-inline' لازم: React يكتب أنماطاً مضمّنة وTailwind يحقن أنماطاً
 *   · img     — data: للصور المخزَّنة كـbase64 (صور المنتجات والشعار)
 */
/**
 * أصول Capacitor. الحزمة على أندرويد تُقدَّم من `https://localhost` (انظر
 * `androidScheme` في capacitor.config.ts)، فـ`'self'` يغطّيها. وتُضاف
 * `capacitor://localhost` صراحةً لأنها أصل iOS، وللملفات التي يُعيدها
 * `Filesystem` بمخطّط `capacitor:` — فلو عُرض ملفٌ محفوظ يوماً لم يُحجب.
 * إضافةٌ صرفة: لا تُنقص شيئاً مما كان مسموحاً على الكمبيوتر.
 */
const CAP_ORIGINS = "capacitor://localhost https://localhost";

const CSP = [
  `default-src 'self' ${CAP_ORIGINS}`,
  // googletagmanager: يُحمّله Firebase Analytics (getAnalytics في firebase.ts).
  // اكتُشف بالاختبار الفعلي لا بالتخمين — كان محجوباً في أول صياغة.
  "script-src 'self' https://apis.google.com https://www.gstatic.com https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https: capacitor:",
  `connect-src 'self' ${CAP_ORIGINS} https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.google-analytics.com https://*.firebaseapp.com`,
  "frame-src https://*.firebaseapp.com https://accounts.google.com https://*.google.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** يحقن وسم CSP في `index.html` عند البناء فقط. */
const cspPlugin = (): Plugin => ({
  name: 'ratib-csp',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace(
      '<meta charset="UTF-8" />',
      `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
    );
  },
});

/**
 * عامل الخدمة — يجعل التطبيق يُقلع بلا إنترنت على الهاتف والمتصفح.
 *
 * 🎯 يُخزَّن **هيكل التطبيق فقط** (js/css/خطوط/أيقونات). ولا تُخزَّن استجابات
 * الشبكة إطلاقاً: `runtimeCaching: []`. فلفايرستور مخزنه في IndexedDB يُدير
 * التزامن والتعارض، وتخزينُ استجاباته مرةً ثانية يعني عرض أرصدةٍ قديمة على أنها
 * حديثة — وذلك في برنامج محاسبةٍ أسوأ من ألا يُعرض شيء.
 *
 * ⚠️ التسجيل يدويٌّ (`injectRegister: null`) لا تلقائي، لأن `src/utils/serviceWorker.ts`
 * يمنعه داخل Electron. راجع التعليق هناك: تسجيله على أصل الخادم المحلي الثابت
 * يُجمّد نسخة سطح المكتب على ملفات إصدارٍ قديم بعد كل تحديث.
 *
 * والـmanifest مكتوبٌ يدوياً في `public/manifest.webmanifest` (`manifest: false`)
 * لأنه يحمل `dir:"rtl"` و`lang:"ar"` وأيقونة maskable — ووصفه هناك أوضح.
 */
const pwaPlugin = () => VitePWA({
  registerType: 'autoUpdate',
  injectRegister: null,
  manifest: false,
  workbox: {
    globPatterns: ['**/*.{js,css,html,woff2,png,svg,ico,webmanifest}'],
    // الحزمة ملفٌ واحد يقارب ٢ م.ب، وحدّ workbox الافتراضي ٢ م.ب — فيسقط بصمت
    maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
    navigateFallback: 'index.html',
    // معالج مصادقة فايربيس صفحةٌ حقيقية على الخادم، لا مسارٌ داخل التطبيق
    navigateFallbackDenylist: [/^\/__\//],
    runtimeCaching: [],
    cleanupOutdatedCaches: true,
  },
});

export default defineConfig(() => {
  return {
    base: './',
    /**
     * رقم الإصدار من package.json داخل الحزمة — يقارنه فحص التحديث
     * (utils/appUpdate.ts). بلا متجرٍ لا تحديث تلقائي، فالتاجر يبقى على نسخةٍ
     * فيها علّةٌ أُصلحت قبل أشهر ولا يعلم.
     */
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [react(), tailwindcss(), cspPlugin(), pwaPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // يحترم متغيّر البيئة PORT إن وُجد (تشغيل الأدوات الآلية يمرّره)، وإلا يبقى
      // السلوك كما هو: العلم --port من سكربت npm، أو منفذ Vite الافتراضي.
      port: process.env.PORT ? Number(process.env.PORT) : undefined,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
