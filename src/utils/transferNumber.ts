/**
 * ترقيم النقل الداخلي — غلافٌ رقيق فوق {@link ./sequenceNumber}.
 *
 * كان هذا الملف نسخةً كاملة من منطق الترقيم. ثم ظهرت **نفس العلّة** في فواتير الشراء،
 * فكانت النسخة الثالثة على الأبواب. وُحِّد المحرّك في `sequenceNumber.ts` وبقي هذا
 * الملف واجهةً باسم المجال — واختباراته السبعة عشر هي الدليل على أن التوحيد لم يغيّر سلوكاً.
 *
 * 🔴 العلّة الأصلية: `TR-${transfers.length + 1}` يعدّ من قائمة هذا الجهاز، فجهازان
 * ينقلان معاً يكتبان `TR-٧` نفسه، وحذف نقلٍ يُعيد استعمال رقمه.
 */

import {
  NumberedDoc, seqOf, deviceTagOf, shouldTag, nextSeq,
  formatNumber, allocateNumber, duplicateNumbersOf,
} from './sequenceNumber';

export const TRANSFER_PREFIX = 'TR-';

type NumberedTransfer = { transferNumber?: string; deviceTag?: string };

const asDocs = (list: NumberedTransfer[]): NumberedDoc[] =>
  list.map(t => ({ number: t.transferNumber, deviceTag: t.deviceTag }));

/** التسلسل داخل رقم النقل — يقبل `TR-٧` و`TR-٧/٧٣`، ويرفض التالف. */
export const transferSeqOf = (transferNumber?: string): number | null =>
  seqOf(TRANSFER_PREFIX, transferNumber);

/** رمز الجهاز داخل الرقم، أو '' إن لم يكن موسوماً. */
export const transferDeviceTagOf = (transferNumber?: string): string =>
  deviceTagOf(TRANSFER_PREFIX, transferNumber);

/** هل يوسم هذا الجهاز أرقامه؟ الإشارة **حقل `deviceTag`** لا شكل الرقم. */
export const shouldTagTransfer = (transfers: NumberedTransfer[], myTag: string): boolean =>
  shouldTag(TRANSFER_PREFIX, asDocs(transfers), myTag);

/** أعلى تسلسل مستعمل + ١ (وأوّله ١). */
export const nextTransferSeq = (transfers: NumberedTransfer[]): number =>
  nextSeq(TRANSFER_PREFIX, asDocs(transfers), 0);

export const formatTransferNumber = (seq: number, tag = ''): string =>
  formatNumber(TRANSFER_PREFIX, seq, tag);

/** الرقم التالي — حرٌّ بالبناء على هذا الجهاز، ومفصول عن بقية الأجهزة برمزها. */
export const allocateTransferNumber = (transfers: NumberedTransfer[], myTag = ''): string =>
  allocateNumber(TRANSFER_PREFIX, asDocs(transfers), myTag, 0);

/** الأرقام المكرَّرة الموجودة فعلاً — ما وقع قبل الإصلاح يُكشف بدل أن يُسكت عنه. */
export const duplicateTransferNumbers = (transfers: NumberedTransfer[]) =>
  duplicateNumbersOf(asDocs(transfers));
