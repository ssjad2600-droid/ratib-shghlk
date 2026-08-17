import { useState, useEffect } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile, SystemSettings } from '../types';
import { useSession } from '../context/SessionContext';

export type PersistedDoc = Partial<
  Pick<UserProfile,
    'storeName' | 'ownerName' | 'phone' | 'address' | 'logoUrl' |
    'businessType' | 'plan' | 'activationStatus' |
    'licenseStatus' | 'createdAt' | 'activationCode' | 'activatedAt' |
    'trialStartedAt' | 'lastSeenAt'
  >
  & SystemSettings
>;

const DEFAULTS: SystemSettings = {
  currency: 'IQD',
  exchangeRate: 1530,
  lastBackupDate: '',
  enabledModules: [],
  notifyOnExpiry: true,
  notifyOnLowStock: true,
  notifyOnUnpaidDebts: true,
  backupInterval: 'daily',
  autoBackup: true,
  lastBackupAt: 0,
  customCategories: [],
  customUnits: [],
};

function extractProfile(d: PersistedDoc): Partial<UserProfile> {
  return {
    storeName: d.storeName ?? '',
    ownerName: d.ownerName ?? '',
    phone: d.phone ?? '',
    address: d.address ?? '',
    logoUrl: d.logoUrl ?? '',
    businessType: d.businessType ?? 'general',
    plan: d.plan ?? 'free',
    activationStatus: d.activationStatus ?? false,
    licenseStatus: d.licenseStatus ?? 'trial',
    /**
     * 🔴 كان: `d.createdAt ?? new Date().toISOString()` — أي **اختراع «الآن» في كل قراءة**
     * حين يغيب الحقل. وأثره أن حذف الحقل (سطرٌ في أدوات المطوّر) يجعل التجربة تبدأ من
     * جديد **مع كل فتحةٍ للبرنامج** فلا تنتهي أبداً. وليست نظرية: قِسْتُ حساباً حقيقياً
     * في قاعدة البيانات بلا `createdAt` إطلاقاً.
     *
     * الآن يبقى الغياب غياباً، ويختم `useTrialAnchor` مرساةً خادمية مرة واحدة.
     */
    createdAt: d.createdAt,
    activationCode: d.activationCode,
    activatedAt: d.activatedAt,
    // مرساة التجربة ونبضة وقت الخادم — يختمهما useTrialAnchor بـserverTimestamp()
    trialStartedAt: d.trialStartedAt,
    lastSeenAt: d.lastSeenAt,
  };
}

function extractSettings(d: PersistedDoc): SystemSettings {
  return {
    currency: d.currency ?? DEFAULTS.currency,
    exchangeRate: d.exchangeRate ?? DEFAULTS.exchangeRate,
    lastBackupDate: d.lastBackupDate ?? DEFAULTS.lastBackupDate,
    lastBackupAt: d.lastBackupAt ?? DEFAULTS.lastBackupAt,
    enabledModules: d.enabledModules ?? [],
    notifyOnExpiry: d.notifyOnExpiry ?? DEFAULTS.notifyOnExpiry,
    notifyOnLowStock: d.notifyOnLowStock ?? DEFAULTS.notifyOnLowStock,
    notifyOnUnpaidDebts: d.notifyOnUnpaidDebts ?? DEFAULTS.notifyOnUnpaidDebts,
    backupInterval: d.backupInterval ?? DEFAULTS.backupInterval,
    autoBackup: d.autoBackup ?? DEFAULTS.autoBackup,
    customCategories: d.customCategories ?? [],
    customUnits: d.customUnits ?? [],
    customPaymentMethods: d.customPaymentMethods ?? [],
    // صيغة طباعة الفاتورة — غيابها = A4 (سلوك البرنامج قبل دعم الطابعة الحرارية)
    printFormat: d.printFormat ?? 'a4',
  };
}

/**
 * بروفايل/إعدادات المحل — يقرأ /users/{ownerUid} من SessionContext.
 * للمالك: ownerUid == uid المصادقة ⇒ نفس السلوك السابق حرفياً.
 * (للموظف مستقبلاً: يقرأ بروفايل مالكه — القواعد تمنع root doc عنه فيسقط للافتراضيات بأمان.)
 */
export function useProfile() {
  const { ownerUid: uid } = useSession();
  const [docData, setDocData] = useState<PersistedDoc>({});
  // resolvedUid tracks which uid's snapshot we've received.
  // loading = true whenever uid changed but snapshot hasn't arrived yet.
  const [resolvedUid, setResolvedUid] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!uid) {
      setDocData({});
      setResolvedUid(null);
      return;
    }
    const docRef = doc(db, 'users', uid);
    const unsub = onSnapshot(
      docRef,
      (snap) => {
        if (snap.exists()) {
          setDocData(snap.data() as PersistedDoc);
        } else {
          // أول مرة يسجل فيها المستخدم — نحفظ الإعدادات الأساسية فوراً
          setDoc(docRef, {
            createdAt: new Date().toISOString(),
            licenseStatus: 'trial',
            businessType: 'general',
          });
          setDocData({});
        }
        setResolvedUid(uid);
      },
      (err) => {
        console.error('[Firestore] profile:', err);
        setResolvedUid(uid);
      }
    );
    return () => unsub();
  }, [uid]);

  const saveProfile = (updates: PersistedDoc): Promise<void> => {
    if (!uid) return Promise.resolve();
    setDocData(prev => ({ ...prev, ...updates }));
    return setDoc(doc(db, 'users', uid), updates, { merge: true });
  };

  return {
    profileData: extractProfile(docData),
    settings: extractSettings(docData),
    loading: resolvedUid !== uid,
    saveProfile,
  };
}
