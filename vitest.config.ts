import { defineConfig } from 'vitest/config';

/**
 * إعداد الاختبارات.
 *
 * 🔴 اختبارات قواعد Firestore (`firestoreRules.test.ts`) **مستثناة من المجموعة الافتراضية**
 * لأنها تحتاج محاكي Firestore يعمل (وهو يحتاج Java). تشغيلها:
 *
 *     npm run test:rules
 *
 * وهو يُشغّل المحاكي ثم الاختبارات ثم يُطفئه. لولا الاستثناء لفشل `npm test` عند كل من
 * لا يملك Java — فيصير ٩٥٠ اختباراً سليماً «أحمر» لسببٍ لا علاقة له بها.
 */
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-app/**',
      // 🔴 الملفّان يحتاجان محاكي Firestore يعمل على ٨٠٨٠. خلطهما بالمجموعة
      //    السريعة يُفشل `npm test` عند من لا يملك Java — والفشل هنا لا يعني
      //    عطلاً في البرنامج بل غياب أداة. تشغيلهما: `npm run test:rules`.
      '**/firestoreRules.test.ts',
      '**/shopLifecycle.test.ts',
    ],
  },
});
