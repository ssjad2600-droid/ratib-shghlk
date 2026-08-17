import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import {installGlobalErrorHandlers} from './utils/errorReporter.ts';
import './index.css';

// الملتقطات العامة: أخطاء خارج شجرة React (مؤقّتات، مستمعات، وعود مرفوضة).
// حاجز الأخطاء لا يلتقط هذه، ولولاها لظلّت صامتة تماماً عند الزبون.
installGlobalErrorHandlers(() => 'خارج الشجرة');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* الشبكة الأخيرة — وداخل App حاجز أدقّ يلتفّ حول محتوى كل شاشة وحدها */}
    <ErrorBoundary screen="التطبيق">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
