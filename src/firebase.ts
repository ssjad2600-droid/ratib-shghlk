import { initializeApp } from 'firebase/app';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  CACHE_SIZE_UNLIMITED,
} from 'firebase/firestore';
import { getAuth, browserLocalPersistence, setPersistence } from 'firebase/auth';
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
setPersistence(auth, browserLocalPersistence);
export const analytics = typeof window !== 'undefined' ? getAnalytics(app) : null;

export default app;
