import React from 'react';
import { isViewOnly } from '../utils/viewOnly';

/**
 * يُخفي ما بداخله في نسخة الهاتف — للأزرار التي تكتب.
 *
 * 🎯 لماذا يُخفى ولا يُعطَّل؟ لأن زرّاً معطَّلاً يبقى سؤالاً بلا جواب: التاجر يراه
 * رمادياً فيظنّ عطلاً أو صلاحيةً ناقصة، ويتّصل بالدعم. وزرٌّ غائبٌ في تطبيقٍ
 * وُصف بأنه «للاطّلاع» لا يُثير سؤالاً أصلاً.
 *
 * ⚠️ وهذه **طبقة عرضٍ لا حماية**: المنع الحقيقي في `assertWritable` داخل بوّابة
 * الكتابة والخطّافات المشتركة. لو أُزيل هذا الغلاف كلّه، لظلّت الكتابة ممنوعة —
 * وهذا هو الترتيب الصحيح: الحارس أولاً، والتجميل بعده.
 *
 * ولا أثر له على الكمبيوتر: `isViewOnly` تُعيد `false` هناك دائماً.
 */
export default function DesktopOnly({ children }: { children: React.ReactNode }) {
  if (isViewOnly()) return null;
  return <>{children}</>;
}

/**
 * بطاقة تشرح للتاجر لماذا اختفت الأزرار — تُعرض في الهاتف وحده.
 *
 * 🔴 بلا هذه البطاقة يبدو الاختفاء عطلاً. وقد سبق في `InvoicesView` أن استُبدل
 * نموذج البيع ببطاقةٍ تشرح، فثبت أن الشرح في مكان الغياب أنفع من تركه فراغاً.
 */
export function ViewOnlyNote({ what }: { what: string }) {
  if (!isViewOnly()) return null;
  return (
    <div className="bg-white rounded-2xl p-4 border border-[#E4EAF3] shadow-sm">
      <p className="text-xs text-slate-600 font-bold leading-relaxed">
        على الهاتف تتابع {what} وتفاصيلها. أمّا الإضافة والتعديل والحذف فتُنفَّذ من
        نسخة الكمبيوتر حيث الشاشة الواسعة والطابعة وقارئ الباركود.
      </p>
    </div>
  );
}
