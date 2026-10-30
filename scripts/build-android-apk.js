const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT_DIR, 'android');
// Salida junto a config.json, FUERA de src/public: el APK lleva token y tópico y no debe servirse
const APK_DIR = path.join(ROOT_DIR, 'apk');
const OUT_APK = path.join(APK_DIR, 'ai-pulse.apk');
const BUILD_DIR = path.join(APK_DIR, '.build');
const OLD_PUBLIC_APK = path.join(ROOT_DIR, 'src', 'public', 'ai-pulse.apk');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const EXE = process.platform === 'win32' ? '.exe' : '';

// Fallbacks documentados: solo se usan si JAVA_HOME / ANDROID_HOME / ANDROID_SDK_ROOT no sirven
const LEGACY_JDK_DIR = 'E:\\Repositorios\\Personal\\_datos\\herramientas\\jdk-21.0.12.1+1';
const LEGACY_SDK_DIR =
  'C:\\Users\\KnuPwns\\.gemini\\antigravity-cli\\brain\\d64afe54-ac9e-4f29-a7f8-875f01abd136\\scratch\\android-sdk';

// Keystore fuera del repo. El de la ruta legacy se reutiliza para no romper la actualización del APK instalado.
const KEYSTORE_NAME = 'aipulse-release.jks';
const KEYSTORE_DIR = process.env.AIPULSE_KEYSTORE_DIR || path.join(os.homedir(), '.aipulse');
const LEGACY_KEYSTORE = path.join(LEGACY_SDK_DIR, KEYSTORE_NAME);

/** Busca la primera fuente válida; si ninguna sirve, error listando todo lo buscado. */
function pickFirst(label, sources, check) {
  const searched = [];
  for (const { source, dir } of sources) {
    if (!dir) {
      searched.push(`${source}: no definido`);
      continue;
    }
    const r = check(dir);
    if (r.paths) return r.paths;
    searched.push(`${source}: ${dir} (faltan: ${r.missing.join(', ')})`);
  }
  throw new Error(
    `No se encontró ${label}. Buscado en:\n  - ${searched.join('\n  - ')}\n` +
      'Definí JAVA_HOME (JDK) y ANDROID_HOME o ANDROID_SDK_ROOT (Android SDK).'
  );
}

function missingOf(paths) {
  return Object.entries(paths)
    .filter(([, p]) => !fs.existsSync(p))
    .map(([k]) => k);
}

function resolveJdk() {
  return pickFirst(
    'JDK',
    [
      { source: 'JAVA_HOME', dir: process.env.JAVA_HOME },
      { source: 'fallback legacy', dir: LEGACY_JDK_DIR }
    ],
    (dir) => {
      const bin = path.join(dir, 'bin');
      const tools = {
        javac: path.join(bin, `javac${EXE}`),
        java: path.join(bin, `java${EXE}`),
        jar: path.join(bin, `jar${EXE}`),
        keytool: path.join(bin, `keytool${EXE}`)
      };
      const missing = missingOf(tools);
      return missing.length ? { missing } : { paths: tools };
    }
  );
}

/** Dos layouts: SDK estándar (build-tools/<ver>, platforms/android-34) y el scratch legacy (android-14, android-34). */
function sdkLayouts(root) {
  const layouts = [];
  const btDir = path.join(root, 'build-tools');
  if (fs.existsSync(btDir)) {
    const versions = fs
      .readdirSync(btDir)
      .filter((d) => /^\d/.test(d))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      layouts.push({ bt: path.join(btDir, v), android: path.join(root, 'platforms', 'android-34', 'android.jar') });
    }
  }
  layouts.push({ bt: path.join(root, 'android-14'), android: path.join(root, 'android-34', 'android.jar') });
  return layouts;
}

function checkSdk(root) {
  const missing = new Set();
  for (const l of sdkLayouts(root)) {
    const tools = {
      aapt2: path.join(l.bt, `aapt2${EXE}`),
      zipalign: path.join(l.bt, `zipalign${EXE}`),
      d8Jar: path.join(l.bt, 'lib', 'd8.jar'),
      apksignerJar: path.join(l.bt, 'lib', 'apksigner.jar'),
      androidJar: l.android
    };
    const miss = missingOf(tools);
    if (miss.length === 0) return { paths: tools };
    miss.forEach((m) => missing.add(m));
  }
  return { missing: [...missing] };
}

function resolveSdk() {
  return pickFirst(
    'Android SDK',
    [
      { source: 'ANDROID_HOME', dir: process.env.ANDROID_HOME },
      { source: 'ANDROID_SDK_ROOT', dir: process.env.ANDROID_SDK_ROOT },
      { source: 'fallback legacy', dir: LEGACY_SDK_DIR }
    ],
    checkSdk
  );
}

/**
 * Contraseña del keystore: AIPULSE_KEYSTORE_PASS, o archivo <keystore>.pass (generado al crear el keystore).
 * Nunca una clave fija en el código.
 */
function resolveSigning() {
  const existing = [path.join(KEYSTORE_DIR, KEYSTORE_NAME), LEGACY_KEYSTORE].find((p) => fs.existsSync(p));
  const envPass = process.env.AIPULSE_KEYSTORE_PASS || '';

  if (existing) {
    const passFile = `${existing}.pass`;
    const filePass = fs.existsSync(passFile) ? fs.readFileSync(passFile, 'utf8').trim() : '';
    const pass = envPass || filePass;
    if (!pass) {
      throw new Error(
        `Keystore existente en ${existing} sin contraseña disponible.\n` +
          '  Definí AIPULSE_KEYSTORE_PASS con su clave. El valor fijo anterior ("aipulse123") ya no se usa en el build:\n' +
          `  si el keystore todavía lo tiene, rotalo con: keytool -storepasswd -keystore "${existing}" y guardá la nueva clave en AIPULSE_KEYSTORE_PASS.`
      );
    }
    return { keystorePath: existing, pass, create: false, passFile: null };
  }

  const keystorePath = path.join(KEYSTORE_DIR, KEYSTORE_NAME);
  if (envPass) return { keystorePath, pass: envPass, create: true, passFile: null };
  // Sin env: generar clave aleatoria y guardarla junto al keystore (fuera del repo)
  const pass = crypto.randomBytes(24).toString('base64url');
  return { keystorePath, pass, create: true, passFile: `${keystorePath}.pass` };
}

function getLocalLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    if (/vethernet|wsl|docker|vmware|virtualbox|loopback/i.test(name)) continue;
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(net.address)) {
        return net.address;
      }
    }
  }
  return '192.168.0.1';
}

function fetchLiveState(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/state`, { timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Escapa un valor para un literal Java entre comillas (sin el par de comillas). */
function javaLiteral(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

async function main() {
  const jdk = resolveJdk();
  const sdk = resolveSdk();
  const signing = resolveSigning();

  const cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
  const port = cfg.port || 19876;
  const live = await fetchLiveState(port);

  const lanIp = (live && live.mobileAccess && live.mobileAccess.lanIp) || getLocalLanIp();
  const lanBase = `http://${lanIp}:${port}`;
  const tunnelBase =
    (live && live.mobileAccess && live.mobileAccess.tunnel && live.mobileAccess.tunnel.publicUrl) || '';
  const authToken = cfg.remoteAuthToken || '';
  const ntfyTopic = cfg.ntfyTopic || '';

  console.log(`[APK Build] Preconfigurando APK con:`);
  console.log(`  - LAN Wi-Fi  : ${lanBase}`);
  console.log(`  - Túnel 4G   : ${tunnelBase || '(autodescubrimiento por ntfy)'}`);
  // No se imprimen secretos: solo si están y cuántos caracteres tienen
  console.log(`  - Auth Token : ${authToken ? `inyectado (${authToken.length} caracteres)` : '(vacío)'}`);
  console.log(`  - Ntfy Topic : ${ntfyTopic ? `inyectado (${ntfyTopic.length} caracteres)` : '(vacío)'}`);
  console.log(`  - JDK        : ${path.dirname(jdk.javac)}`);
  console.log(`  - Android SDK: ${sdk.aapt2}`);

  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const genDir = path.join(BUILD_DIR, 'gen');
  const srcDir = path.join(BUILD_DIR, 'src', 'com', 'knupson', 'aipulse');
  const classesDir = path.join(BUILD_DIR, 'classes');
  const dexDir = path.join(BUILD_DIR, 'dex');
  fs.mkdirSync(genDir, { recursive: true });
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(classesDir, { recursive: true });
  fs.mkdirSync(dexDir, { recursive: true });
  fs.mkdirSync(APK_DIR, { recursive: true });

  try {
    // Copiar fuentes Java inyectando los valores por defecto de esta PC (el build dir se borra al final)
    const javaFiles = ['ActionReceiver.java', 'ConfigStore.java', 'MainActivity.java', 'PulseWidgetProvider.java'];
    for (const jf of javaFiles) {
      let content = fs.readFileSync(path.join(ANDROID_DIR, 'src', 'com', 'knupson', 'aipulse', jf), 'utf8');
      if (jf === 'ConfigStore.java') {
        content = content
          .replace('__DEFAULT_LAN_BASE__', () => javaLiteral(lanBase))
          .replace('__DEFAULT_TUNNEL_BASE__', () => javaLiteral(tunnelBase))
          .replace('__DEFAULT_AUTH_TOKEN__', () => javaLiteral(authToken))
          .replace('__DEFAULT_NTFY_TOPIC__', () => javaLiteral(ntfyTopic));
      }
      fs.writeFileSync(path.join(srcDir, jf), content, 'utf8');
    }

    // 1. aapt2 compile
    const resZip = path.join(BUILD_DIR, 'res.zip');
    execFileSync(sdk.aapt2, ['compile', '--dir', path.join(ANDROID_DIR, 'res'), '-o', resZip], {
      stdio: 'inherit'
    });

    // 2. aapt2 link
    const unsignedApk = path.join(BUILD_DIR, 'unsigned.apk');
    execFileSync(
      sdk.aapt2,
      [
        'link',
        '-o',
        unsignedApk,
        '-I',
        sdk.androidJar,
        '--manifest',
        path.join(ANDROID_DIR, 'AndroidManifest.xml'),
        '--java',
        genDir,
        resZip,
        '--auto-add-overlay'
      ],
      { stdio: 'inherit' }
    );

    // 3. javac
    const rJava = path.join(genDir, 'com', 'knupson', 'aipulse', 'R.java');
    execFileSync(
      jdk.javac,
      [
        '--release',
        '11',
        '-encoding',
        'UTF-8',
        '-cp',
        sdk.androidJar,
        '-d',
        classesDir,
        rJava,
        ...javaFiles.map((f) => path.join(srcDir, f))
      ],
      { stdio: 'inherit' }
    );

    // 4. d8 (compilar .class -> classes.dex)
    const classFiles = fs
      .readdirSync(path.join(classesDir, 'com', 'knupson', 'aipulse'))
      .filter((f) => f.endsWith('.class'))
      .map((f) => path.join(classesDir, 'com', 'knupson', 'aipulse', f));

    execFileSync(
      jdk.java,
      ['-cp', sdk.d8Jar, 'com.android.tools.r8.D8', '--min-api', '24', '--lib', sdk.androidJar, '--output', dexDir, ...classFiles],
      { stdio: 'inherit' }
    );

    // 5. Empaquetar classes.dex en la raíz de unsigned.apk usando jar -uf
    execFileSync(jdk.jar, ['uf', unsignedApk, '-C', dexDir, 'classes.dex'], { stdio: 'inherit' });

    // 6. zipalign
    const alignedApk = path.join(BUILD_DIR, 'aligned.apk');
    execFileSync(sdk.zipalign, ['-f', '-p', '4', unsignedApk, alignedApk], { stdio: 'inherit' });

    // 7. Keystore: la clave viaja por variable de entorno (no aparece en la línea de comandos)
    const pwEnv = { ...process.env, AIPULSE_KEYSTORE_PASS: signing.pass };
    if (signing.create) {
      fs.mkdirSync(path.dirname(signing.keystorePath), { recursive: true });
      execFileSync(
        jdk.keytool,
        [
          '-genkeypair',
          '-v',
          '-keystore',
          signing.keystorePath,
          '-alias',
          'aipulse',
          '-keyalg',
          'RSA',
          '-keysize',
          '2048',
          '-validity',
          '10000',
          '-storepass:env',
          'AIPULSE_KEYSTORE_PASS',
          '-keypass:env',
          'AIPULSE_KEYSTORE_PASS',
          '-dname',
          'CN=AI Pulse, OU=Dev, O=Knupson, L=BA, S=BA, C=AR'
        ],
        { stdio: 'inherit', env: pwEnv }
      );
      if (signing.passFile) {
        fs.writeFileSync(signing.passFile, signing.pass + '\n', { encoding: 'utf8', mode: 0o600 });
        console.log(`[APK Build] Keystore nuevo creado. Contraseña generada guardada en: ${signing.passFile}`);
      }
    }

    // Firma v1+v2+v3 con apksigner
    execFileSync(
      jdk.java,
      [
        '-jar',
        sdk.apksignerJar,
        'sign',
        '--ks',
        signing.keystorePath,
        '--ks-key-alias',
        'aipulse',
        '--ks-pass',
        'env:AIPULSE_KEYSTORE_PASS',
        '--key-pass',
        'env:AIPULSE_KEYSTORE_PASS',
        '--out',
        OUT_APK,
        alignedApk
      ],
      { stdio: 'inherit', env: pwEnv }
    );
  } finally {
    // Las fuentes del build tienen el token inyectado: se borran siempre
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  }

  const stat = fs.statSync(OUT_APK);
  console.log(`[APK Build] ¡Éxito! APK firmado generado en: ${OUT_APK} (${Math.round(stat.size / 1024)} KB)`);
  console.warn(
    '[APK Build] ADVERTENCIA: el APK contiene credenciales (token remoto y tópico ntfy). No lo compartas ni lo subas a ningún lado.'
  );
  if (fs.existsSync(OLD_PUBLIC_APK)) {
    console.warn(
      `[APK Build] ADVERTENCIA: existe un APK viejo con credenciales en ${OLD_PUBLIC_APK}. Borralo a mano.`
    );
  }
}

main().catch((err) => {
  console.error('[APK Build Error]', err && err.message ? err.message : err);
  process.exit(1);
});
