/**
 * قيمة واحدة مشتركة بين كل المكوّنات — خارج React.
 *
 * 🔴 لماذا وُجد هذا الملف؟
 * حالة React (`useState`) **ملك المكوّن الذي أنشأها**. فلو نادى مكوّنان الخطّاف نفسه،
 * صار لكلٍّ منهما نسخة مستقلة لا تعلم بالأخرى. وهذا يُنتج علّة صامتة قاتلة: الرأس
 * يُبدّل «الفرع النشط»، والشاشة المفتوحة تبقى تعرض أرقام الفرع القديم بلا أي مؤشّر —
 * فيقرأ التاجر أرقام فرع ويظنّها فرعاً آخر.
 *
 * الحل: قيمة واحدة في وحدة (module) خارج شجرة React، ومشتركون يُعلَمون فور تغيّرها،
 * ويربطها `useSyncExternalStore` بواجهة React بشكل آمن.
 *
 * ⚠️ لا يُستعمل هذا لأي بيانات من قاعدة البيانات — تلك مصدرها Firestore وحده.
 * هذا فقط لـ«تفضيل عرض» واحد يشترك فيه كل الشاشات.
 */

export interface SharedValue<T> {
  /** القيمة الحالية — تُستعمل كـ getSnapshot لـ useSyncExternalStore. */
  get: () => T;
  /** يضبط القيمة ويُعلم المشتركين. لا يُعلم أحداً إن لم تتغيّر القيمة فعلاً. */
  set: (next: T) => void;
  /** يشترك في التغييرات ويُعيد دالة إلغاء الاشتراك. */
  subscribe: (listener: () => void) => () => void;
  /** عدد المشتركين — للاختبار والتشخيص فقط. */
  listenerCount: () => number;
}

export function createSharedValue<T>(initial: T): SharedValue<T> {
  let value = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => value,
    set: (next: T) => {
      // المقارنة ضرورية: بدونها كل ضبط يُعيد رسم كل الشاشات بلا سبب
      if (Object.is(value, next)) return;
      value = next;
      // نسخة من القائمة: مشترك قد يُلغي اشتراكه أثناء الإعلام
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    listenerCount: () => listeners.size,
  };
}
