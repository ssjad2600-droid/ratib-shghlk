import { initializeApp } from 'firebase/app';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  CACHE_SIZE_UNLIMITED,
  connectFirestoreEmulator,
} from 'firebase/firestore';
import { getAuth, browserLocalPersistence, setPersistence, connectAuthEmulator } from 'firebase/auth';
import { getAnalytics } from 'firebase/analytics';

// مُصدَّر ليستخدمه إنشاء الموظف عبر نسخة Firebase ثانوية (secondary app) دون المساس بجلسة المالك
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const app = initializeApp(firebaseConfig);

// Persistent IndexedDB cache — enables full offline read/write support.
// Writes made offline are queued and synced automatically when back online.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    cacheSizeBytes: CACHE_SIZE_UNLIMITED,
    tabManager: persistentMultipleTabManager(),
  }),
  /**
   * 🔴 حقلٌ قيمته `undefined` كان **يرمي استثناءً يُفشل الكتابة كلها**.
   *
   * قِسْتُها في شاشة فواتير الشراء: بندٌ حرّ (بلا منتج) أو منتجٌ بلا سعر جملة مسجَّل
   * يجعل `WriteBatch.set()` يرمي `Unsupported field value: undefined` — والرمي **متزامن**
   * فيقفز فوق رسالة النجاح وإغلاق النموذج معاً. النتيجة: التاجر يضغط «حفظ» فلا يحدث شيء،
   * لا نجاح ولا خطأ، والفاتورة لا تُحفظ أبداً. تاجرٌ جديد بلا تاريخ تكاليف لا يستطيع
   * تسجيل ولا فاتورة شراء واحدة.
   *
   * تفعيل هذا الخيار يجعل Firestore **يتجاهل الحقل** بدل إسقاط العملية — وهو المعنى
   * المقصود أصلاً في كل مواضع الكود (`expiryDate?`، `wholesaleUnitPrice?`، `branchId?` …):
   * «غير معروف ⇒ لا تكتبه»، لا «أفشِل الفاتورة».
   *
   * ⚠️ وهذا لا يُغني عن تنظيف الحقول عند البناء: نُسقط المفاتيح غير المعروفة صراحةً كي
   * تبقى الوثائق نظيفة. هذا الخيار شبكة أمان للشاشات كلها، لا رخصة للإهمال.
   */
  ignoreUndefinedProperties: true,
});
export const auth = getAuth(app);

/**
 * وصل التطبيق بمحاكي فايربيس — **للتطوير والاختبار وحدهما**.
 *
 * 🔴 لماذا وُجد؟ لأن فحص الشاشات كان مستحيلاً: كل شاشة خلف تسجيل دخول، ولا
 * سبيل لفتحها إلا بحسابٍ حقيقي. فبقيت الواجهة تُفحص بقراءة الشيفرة وقياس
 * أصنافٍ محقونة — لا بضغطة زرّ ولا بحقلٍ مُلئ. والمحاكي يفتحها كلّها بحسابٍ
 * تجريبي على جهازك، بلا لمس بياناتٍ حقيقية.
 *
 * 🔴🔴 والحراسة هنا ليست تفصيلاً. وصلةٌ تتسرّب إلى نسخة الإنتاج تجعل برنامج
 * **كل زبون** يبحث عن قاعدة بيانات على جهازه هو — فلا يدخل أحد ولا يُحفظ شيء.
 * ولذلك شرطان لا واحد:
 *
 *   ١) `import.meta.env.DEV` — تستبدلها Vite بـ`false` نصّياً في كل بناء إنتاج،
 *      فتُحذف الكتلة كلها من الحزمة عند التشجير. لا شيفرة تصل الزبون أصلاً.
 *   ٢) `VITE_USE_EMULATORS === '1'` — نيّةٌ صريحة، فلا يقع بالخطأ في التطوير.
 *
 * ويحرسه اختبار: `hardening.test.ts` يفحص الحزمة المبنيّة فيرفض أي أثرٍ للمحاكي.
 *
 * التشغيل: `npm run dev:emulator` (يُشغّل المحاكيَين ثم خادم التطوير).
 */
/**
 * 🔴 مُصدَّرة لأن **كل** نسخة فايربيس في المشروع يجب أن تخضع لهذا الحارس، لا هذه وحدها.
 *
 * قِسْتُها بالفحص الفعلي: إنشاء موظف يفتح نسخةً ثانوية (`secondary-employee-creation`)
 * كي لا تنكسر جلسة المالك — وتلك النسخة كانت تستدعي `getAuth` بلا وصلِ محاكٍ. فبينما
 * كنتُ أظنّني في صندوقٍ معزول، **أُنشئ الحساب في مشروع الإنتاج الحقيقي**: وثيقة
 * الموظف كُتبت في المحاكي (فايرستور واحدٌ موصول)، والحساب ذهب إلى الخادم الحيّ.
 * والنتيجة موظفٌ لا يستطيع الدخول محلياً، وحسابٌ يتيم في مشروع التاجر.
 *
 * والأخطر أنه **صامت**: لا خطأ ولا تحذير — النجاح يبدو نجاحاً.
 */
export const USE_EMULATORS = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === '1';

/**
 * ⚠️ الترتيب هنا شرطٌ لا تفصيل: `connectAuthEmulator` يجب أن يُستدعى **فور**
 * `getAuth` وقبل أي عمليةٍ أخرى على المصادقة.
 *
 * قِسْتُه: وضعتُه أولاً بعد `setPersistence` فبقي التطبيق عالقاً على دوّارة
 * التحميل **إلى الأبد** — بلا خطأ في الطرفية ولا رسالة. الشاشة بيضاء وحدها.
 * ولذلك يسبق `setPersistence` أدناه.
 */
if (USE_EMULATORS) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  // eslint-disable-next-line no-console
  console.info('🔧 محاكي فايربيس: فايرستور ٨٠٨٠ · المصادقة ٩٠٩٩ — لا اتصال بالإنتاج');
}

setPersistence(auth, browserLocalPersistence);

/** التحليلات تُعطَّل مع المحاكي: لا معنى لإرسال أحداثٍ من بيئة اختبار. */
export const analytics = typeof window !== 'undefined' && !USE_EMULATORS
  ? getAnalytics(app)
  : null;

export default app;
