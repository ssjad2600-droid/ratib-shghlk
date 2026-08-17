/**
 * مُشغّل اختبارات قواعد Firestore.
 *
 * محاكي Firestore يحتاج Java، وهي ليست دائماً على PATH — على هذا الجهاز مثلاً وُجد JDK
 * مثبَّتاً مع أدوات JetBrains في `~/.jdks` بلا أن يكون في PATH ولا في JAVA_HOME.
 * فبدل أن يفشل الاختبار برسالة غامضة («Could not start Firestore Emulator»)، يبحث هذا
 * السكربت عن JDK في المواضع المعتادة ويقول بوضوح ما وجده وما ينقص.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

/** نفس المعرّف المستعمل في اختبارات القواعد — المحاكي يعزل البيانات بالمشروع. */
const PROJECT = 'ratib-rules-test';

const isWin = process.platform === 'win32';
const javaBin = isWin ? 'java.exe' : 'java';

/** مواضع يُحتمل أن يسكن فيها JDK — تُفحص بالترتيب. */
function candidates() {
  const out = [];
  if (process.env.JAVA_HOME) out.push(join(process.env.JAVA_HOME, 'bin', javaBin));

  const roots = [
    join(homedir(), '.jdks'),                                   // JetBrains / IntelliJ
    'C:/Program Files/Java',
    'C:/Program Files/Eclipse Adoptium',
    'C:/Program Files/Microsoft',
    '/usr/lib/jvm',
    '/Library/Java/JavaVirtualMachines',
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      out.push(join(root, entry, 'bin', javaBin));
      out.push(join(root, entry, 'Contents', 'Home', 'bin', javaBin)); // macOS
    }
  }
  return out;
}

function findJava() {
  // موجودة على PATH أصلاً؟
  const onPath = spawnSync(javaBin, ['-version'], { stdio: 'ignore', shell: isWin });
  if (onPath.status === 0) return null; // لا حاجة لضبط شيء

  for (const c of candidates()) {
    if (existsSync(c)) return c;
  }
  return undefined; // لم تُوجد
}

const found = findJava();

if (found === undefined) {
  console.error('\n⛔ لم يُعثر على Java، ومحاكي Firestore يحتاجها.');
  console.error('   ثبّتها ثم أعد المحاولة:  winget install EclipseAdoptium.Temurin.21.JDK');
  console.error('   أو اضبط JAVA_HOME على مسار JDK لديك.\n');
  process.exit(1);
}

const env = { ...process.env };
if (found) {
  const home = found.replace(/[\\/]bin[\\/]java(\.exe)?$/, '');
  env.JAVA_HOME = home;
  env.PATH = `${join(home, 'bin')}${isWin ? ';' : ':'}${env.PATH}`;
  console.log(`☕ Java: ${home}`);
} else {
  console.log('☕ Java: من PATH');
}

console.log('🔥 تشغيل محاكي Firestore ثم اختبارات القواعد…\n');

/**
 * ⚠️ يُمرَّر أمراً واحداً لا مصفوفة: مع `shell: true` على ويندوز تُفكَّك المصفوفة فيقرأ
 * `emulators:exec` كل كلمة وسيطاً مستقلاً ويردّ «Too many arguments». والاقتباسات
 * المزدوجة داخل السلسلة تُبقي أمر vitest وحدةً واحدة.
 */
const inner = 'npx vitest run --config vitest.rules.config.ts';
const cmd = `npx firebase emulators:exec --project ${PROJECT} --only firestore "${inner}"`;

const r = spawnSync(cmd, { stdio: 'inherit', env, shell: true });
process.exit(r.status ?? 1);
