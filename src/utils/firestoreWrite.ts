import {
  writeBatch, WriteBatch,
  updateDoc as fsUpdateDoc, setDoc as fsSetDoc, deleteDoc as fsDeleteDoc,
} from 'firebase/firestore';
import { db } from '../firebase';
import { assertWritable } from './viewOnly';

/**
 * إنشاء دفعة كتابة — **البوّابة الوحيدة** لكل كتابةٍ مجمّعة في البرنامج.
 *
 * 🔴 لماذا عند الإنشاء لا عند التنفيذ؟ لأن الدفعة الواحدة تُنفَّذ في موضعٍ واحد
 * (`commit`) لكنها تُبنى عبر عشرات الأسطر قبله: خصمُ مخزون، وقيدُ مالية، وتحديثُ
 * رصيد. فالمنع عند الإنشاء يوقف المسار **قبل** أن يبني شيئاً — والمنع عند التنفيذ
 * يترك الشاشة وقد غيّرت حالتها المحلّية ثم يفشل، فيرى التاجر رقماً لا وجود له.
 *
 * 🔴 ولماذا دالّةٌ لا `writeBatch(db)` مباشرةً؟ لأن الحارس المنسيّ هو الحارس
 * المعدوم. ٣٤ موضعاً تُنشئ دفعات، ولو تُرك لكل موضعٍ أن يتذكّر `assertWritable`
 * لَنُسِيَ في أوّل موضعٍ يُضاف بعد اليوم. ويحرسه مسحٌ في `viewOnly.test.ts` يرفض
 * أي `writeBatch(db)` مباشرٍ في الشاشات.
 *
 * ⚠️ لا يغيّر شيئاً على الكمبيوتر: `assertWritable` لا ترمي إلا داخل تطبيق الهاتف.
 */
export function newBatch(): WriteBatch {
  assertWritable();
  return writeBatch(db);
}

/**
 * كتاباتُ الوثيقة المفردة — محروسةٌ كالدفعات.
 *
 * 🔴 كُشفت الثغرة **بالنظر إلى الشاشة** على مقاس هاتف: ظهر عدّاد الكمية
 * `- ٢ +` في شاشة المخزون. وهو يكتب بـ`updateDoc` مباشرةً، لا عبر دفعة ولا
 * عبر `useCollection` — فكان خارج الحارس كلّه رغم أنه يُنقص مخزوناً حقيقياً.
 * ومعه سبعةٌ مثله. أي أن «كل الكتابات محروسة» كانت **دعوى غير صحيحة**.
 *
 * 🔧 والأسماء مطابقة لأسماء فايرستور عمداً: الترحيل تبديلُ سطر استيرادٍ واحد
 * (`import { updateDoc } from '../utils/firestoreWrite'`)، فلا يُلمس أي نداء
 * ولا يتسلّل خطأٌ في إعادة الصياغة. والأنواع تُنقل كما هي بـ`typeof` فتبقى
 * سلامة النوع عند كل نداء.
 *
 * ⚠️ الاستثناء الوحيد المقصود: `useTrialAnchor` — يكتب أختام ترخيصٍ فقط
 * (`trialStartedAt`، `lastSeenAt`) لا بيانات تاجر، وهو تلقائيٌّ داخل `useEffect`.
 * ومنعُه يكسر حماية التجربة لمن يفتح الهاتف أولاً، ورميُه يُسقط الشاشة.
 */
export const updateDoc: typeof fsUpdateDoc = ((...args: unknown[]) => {
  assertWritable();
  return (fsUpdateDoc as (...a: unknown[]) => Promise<void>)(...args);
}) as typeof fsUpdateDoc;

export const setDoc: typeof fsSetDoc = ((...args: unknown[]) => {
  assertWritable();
  return (fsSetDoc as (...a: unknown[]) => Promise<void>)(...args);
}) as typeof fsSetDoc;

export const deleteDoc: typeof fsDeleteDoc = ((...args: unknown[]) => {
  assertWritable();
  return (fsDeleteDoc as (...a: unknown[]) => Promise<void>)(...args);
}) as typeof fsDeleteDoc;
