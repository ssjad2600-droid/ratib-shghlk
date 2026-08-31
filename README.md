# Ratib Shghlak — Business & Retail Management Desktop App

A Windows desktop application with full Arabic right-to-left (RTL) interface, enabling small business owners (shops, restaurants, pharmacies) to manage their entire operation from a single app: employees, products, inventory, invoices, sales, and reporting — all working offline.

**Built for real Iraqi market conditions:** Iraqi Dinar support, branch-based access control, synchronized multi-user sessions, and automatic Firebase sync when reconnected.

---

## Features

### For Business Owners
- **Full Arabic RTL interface** — every string is right-to-left, Arabic icons, Arabic numerals throughout
- **Works offline** — no internet required; data auto-syncs when connection returns
- **Multi-branch management** — if you operate multiple locations, manage everything from one dashboard
- **Real-time reports** — daily sales, profit margins, top products, inventory levels — all live
- **Iraqi Dinar accounting** — invoices, reports, and calculations all in Iraqi Dinar

### For Employees
- **Secure login** — each employee has their own account
- **Role-based permissions** — sales-only, sales + inventory, or full admin access
- **Audit trail** — every change (delete, edit, user creation) is logged with timestamp and who did it
- **Data isolation** — each branch's data is completely separate

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 18, TypeScript, Tailwind CSS |
| **State Management** | React Context, Custom Hooks |
| **Backend & Database** | Firebase (Firestore, Auth) |
| **Arabic/RTL** | Full RTL architecture, bidirectional text handling |
| **Desktop** | Electron, Vite |
| **Testing** | Vitest (844 tests) |
| **Offline Support** | Firestore IndexedDB Persistence |

---

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Setup
```bash
cp .env.example .env.local
# Edit .env.local and add your Firebase credentials
```

### 3. Run Development
```bash
npm run dev
```

### 4. Build for Windows
```bash
npm run build:electron
npm run electron:build
```

---

## Testing

```bash
npm run test              # Run all tests
npm run test:watch       # Watch mode
```

---

## Architecture

- **RTL-first design** — all layouts built from right-to-left
- **Firestore security rules** — enforce branch-based access control
- **Offline-first** — IndexedDB caches all Firestore data locally
- **844 unit tests** — covering formatters, validation, and business logic

---

## License

All rights reserved © Sajad Hussam Ali — 2026

---

## Contact

- **Email:** ssjad2600@gmail.com
- **GitHub:** github.com/ssjad2600-droid