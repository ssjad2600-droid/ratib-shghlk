import { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * معلومات المحل العامة: /users/{ownerUid}/public/info
 * المصدر الوحيد الذي يقرؤه الموظف لاسم المحل/الشعار/العملة/سعر الصرف
 * (بروفايل المالك /users/{ownerUid} محجوب عنه بقواعد Firestore).
 * يكتبها المالك عبر تأثير المزامنة في OwnerShell.
 */
export interface PublicInfo {
  storeName: string;
  logoUrl: string;
  address: string;   // عنوان صاحب العمل — لترويسة فاتورة الموظف المطبوعة
  phone: string;     // هاتف المحل — لترويسة الفاتورة
  currency: 'IQD' | 'USD';
  exchangeRate: number;
  /** ترخيص المحل مفعّل مدى الحياة */
  licenseActive: boolean;
  /** صيغة طباعة الفاتورة — ليطبع الموظف بنفس إعداد المالك */
  printFormat: string;
  /** نهاية الفترة التجريبية (ISO). يحسب الموظف الانتهاء محلياً فلا يعتمد على فتح المالك للتطبيق */
  trialEndsAt: string;
}

const DEFAULTS: PublicInfo = {
  storeName: '',
  logoUrl: '',
  address: '',
  phone: '',
  currency: 'IQD',
  exchangeRate: 1500,
  licenseActive: false,
  printFormat: 'a4',
  trialEndsAt: '',
};

/**
 * هل المحل مسموح له بالعمل؟ مفعّل مدى الحياة، أو ما زال ضمن الفترة التجريبية.
 * غياب trialEndsAt (وثيقة public/info قديمة لم يكتبها المالك بعد) ⇒ نسمح بالعمل
 * تفادياً لحجب موظفي متجر سليم بسبب حقل مفقود (fail-open مقصود لهذا الحقل تحديداً).
 */
export function isShopLicenseActive(info: PublicInfo): boolean {
  if (info.licenseActive) return true;
  if (!info.trialEndsAt) return true;
  const ends = new Date(info.trialEndsAt).getTime();
  if (isNaN(ends)) return true;
  return Date.now() < ends;
}

export function usePublicInfo(ownerUid: string | null) {
  const [info, setInfo] = useState<PublicInfo>(DEFAULTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ownerUid) {
      setInfo(DEFAULTS);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ref = doc(db, 'users', ownerUid, 'public', 'info');
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const d = (snap.exists() ? snap.data() : {}) as Partial<PublicInfo>;
        setInfo({
          storeName: d.storeName ?? DEFAULTS.storeName,
          logoUrl: d.logoUrl ?? DEFAULTS.logoUrl,
          address: d.address ?? DEFAULTS.address,
          phone: d.phone ?? DEFAULTS.phone,
          currency: d.currency ?? DEFAULTS.currency,
          exchangeRate: d.exchangeRate ?? DEFAULTS.exchangeRate,
          printFormat: d.printFormat ?? DEFAULTS.printFormat,
          licenseActive: d.licenseActive ?? DEFAULTS.licenseActive,
          trialEndsAt: d.trialEndsAt ?? DEFAULTS.trialEndsAt,
        });
        setLoading(false);
      },
      (err) => {
        console.error('[Firestore] public/info:', err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [ownerUid]);

  return { info, loading };
}
