import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import {installGlobalErrorHandlers} from './utils/errorReporter.ts';
import {installArabicValidation} from './utils/formValidation.ts';
import {setupServiceWorker} from './utils/serviceWorker.ts';
import './index.css';

// الملتقطات العامة: أخطاء خارج شجرة React (مؤقّتات، مستمعات، وعود مرفوضة).
// حاجز الأخطاء لا يلتقط هذه، ولولاها لظلّت صامتة تماماً عند الزبون.
installGlobalErrorHandlers(() => 'خارج الشجرة');

// رسائل تحقّق النماذج بالعربية — مستمعٌ واحد يغطّي كل حقول البرنامج (الحالية والقادمة).
// بدونه يرى التاجر العراقي «Please fill out this field» في برنامجٍ كلّه عربي.
installArabicValidation();

// عامل الخدمة: يُشغّل التطبيق بلا إنترنت على الهاتف والمتصفح، ويُمنع داخل Electron
// (وإلا جمّد نسخة سطح المكتب على ملفات إصدارٍ قديم بعد كل تحديث). لا ينتظره الإقلاع.
void setupServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* الشبكة الأخيرة — وداخل App حاجز أدقّ يلتفّ حول محتوى كل شاشة وحدها */}
    <ErrorBoundary screen="التطبيق">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
