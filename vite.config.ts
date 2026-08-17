import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, Plugin} from 'vite';

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
const CSP = [
  "default-src 'self'",
  // googletagmanager: يُحمّله Firebase Analytics (getAnalytics في firebase.ts).
  // اكتُشف بالاختبار الفعلي لا بالتخمين — كان محجوباً في أول صياغة.
  "script-src 'self' https://apis.google.com https://www.gstatic.com https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.google-analytics.com https://*.firebaseapp.com",
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

export default defineConfig(() => {
  return {
    base: './',
    plugins: [react(), tailwindcss(), cspPlugin()],
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
