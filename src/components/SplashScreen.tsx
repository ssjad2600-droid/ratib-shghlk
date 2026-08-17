import { motion } from 'motion/react';

export default function SplashScreen() {
  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center select-none overflow-hidden"
      style={{ background: 'linear-gradient(145deg, #0a1838 0%, #0f2557 60%, #0a1d45 100%)' }}
      dir="rtl"
    >
      {/* Ambient glow behind icon */}
      <motion.div
        className="absolute rounded-full pointer-events-none"
        style={{
          width: 320,
          height: 320,
          background: 'radial-gradient(circle, rgba(14,165,233,0.22) 0%, transparent 70%)',
        }}
        initial={{ opacity: 0, scale: 0.4 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 1.2, delay: 0.1, ease: 'easeOut' }}
      />

      {/* Icon — scale-in + rotateY 3D flip */}
      <motion.div
        style={{ perspective: 900 }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15, delay: 0.1 }}
      >
        <motion.div
          style={{
            filter: 'drop-shadow(0 0 32px rgba(14,165,233,0.55)) drop-shadow(0 8px 24px rgba(3,105,161,0.4))',
          }}
          initial={{ scale: 0.45, rotateY: -75 }}
          animate={{ scale: 1, rotateY: 0 }}
          transition={{ duration: 0.85, delay: 0.1, ease: [0.34, 1.46, 0.64, 1] }}
        >
          <svg width="112" height="112" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="sp-bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#0ea5e9" />
                <stop offset="100%" stopColor="#0369a1" />
              </linearGradient>
              <linearGradient id="sp-arrow" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor="#22c55e" />
                <stop offset="50%" stopColor="#eab308" />
                <stop offset="100%" stopColor="#ef4444" />
              </linearGradient>
            </defs>
            <rect x="32" y="32" width="448" height="448" rx="104" fill="url(#sp-bg)" />
            <path d="M32 224 Q256 360 480 200 L480 136 Q480 32 376 32 L136 32 Q32 32 32 136 Z" fill="#ffffff" opacity="0.08" />
            <rect x="104" y="120" width="190" height="28" rx="14" fill="#ffffff" opacity="0.9" />
            <rect x="104" y="186" width="150" height="28" rx="14" fill="#ffffff" opacity="0.6" />
            <rect x="104" y="252" width="110" height="28" rx="14" fill="#ffffff" opacity="0.45" />
            <path d="M96 410 L184 318 L244 378 L380 240" fill="none" stroke="url(#sp-arrow)" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M330 240 L384 236 L380 290" fill="none" stroke="#ef4444" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </motion.div>
      </motion.div>

      {/* App name */}
      <motion.h1
        className="mt-7 text-4xl font-extrabold font-cairo tracking-tight"
        style={{ color: '#ffffff' }}
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, delay: 0.9, ease: 'easeOut' }}
      >
        رتب{' '}
        <span style={{ color: '#10b981' }}>شغلك</span>
      </motion.h1>

      {/* Subtitle */}
      <motion.p
        className="mt-2 text-sm font-medium"
        style={{ color: 'rgba(148,163,184,0.85)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 1.25 }}
      >
        منصة إدارة الأعمال المتكاملة
      </motion.p>

      {/* Loading dots */}
      <motion.div
        className="flex gap-2 mt-10"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35, delay: 1.5 }}
      >
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="block w-2 h-2 rounded-full"
            style={{ backgroundColor: '#0ea5e9' }}
            animate={{ opacity: [0.25, 1, 0.25], scale: [0.8, 1.15, 0.8] }}
            transition={{
              duration: 0.9,
              delay: 1.55 + i * 0.18,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
          />
        ))}
      </motion.div>
    </div>
  );
}
