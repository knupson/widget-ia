const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT_DIR, 'android');
const PUBLIC_DIR = path.join(ROOT_DIR, 'src', 'public');
const OUT_APK = path.join(PUBLIC_DIR, 'ai-pulse.apk');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

const JDK_DIR = 'E:\\Repositorios\\Personal\\_datos\\herramientas\\jdk-21.0.12.1+1\\bin';
const SDK_SCRATCH =
  'C:\\Users\\KnuPwns\\.gemini\\antigravity-cli\\brain\\d64afe54-ac9e-4f29-a7f8-875f01abd136\\scratch\\android-sdk';

const JAVAC = path.join(JDK_DIR, 'javac.exe');
const JAVA = path.join(JDK_DIR, 'java.exe');
const JAR = path.join(JDK_DIR, 'jar.exe');
const KEYTOOL = path.join(JDK_DIR, 'keytool.exe');

const AAPT2 = path.join(SDK_SCRATCH, 'android-14', 'aapt2.exe');
const ZIPALIGN = path.join(SDK_SCRATCH, 'android-14', 'zipalign.exe');
const D8_JAR = path.join(SDK_SCRATCH, 'android-14', 'lib', 'd8.jar');
const APKSIGNER_JAR = path.join(SDK_SCRATCH, 'android-14', 'lib', 'apksigner.jar');
const ANDROID_JAR = path.join(SDK_SCRATCH, 'android-34', 'android.jar');

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

async function main() {
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
  console.log(`  - Auth Token : ${authToken}`);
  console.log(`  - Ntfy Topic : ${ntfyTopic}`);

  const buildDir = path.join(SDK_SCRATCH, 'build-apk');
  fs.rmSync(buildDir, { recursive: true, force: true });
  const genDir = path.join(buildDir, 'gen');
  const srcDir = path.join(buildDir, 'src', 'com', 'knupson', 'aipulse');
  const classesDir = path.join(buildDir, 'classes');
  const dexDir = path.join(buildDir, 'dex');
  fs.mkdirSync(genDir, { recursive: true });
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(classesDir, { recursive: true });
  fs.mkdirSync(dexDir, { recursive: true });

  // Copiar fuentes Java inyectando los valores por defecto de esta PC
  const javaFiles = ['ConfigStore.java', 'PulseWidgetProvider.java', 'MainActivity.java'];
  for (const jf of javaFiles) {
    let content = fs.readFileSync(path.join(ANDROID_DIR, 'src', 'com', 'knupson', 'aipulse', jf), 'utf8');
    if (jf === 'ConfigStore.java') {
      content = content
        .replace('__DEFAULT_LAN_BASE__', lanBase)
        .replace('__DEFAULT_TUNNEL_BASE__', tunnelBase)
        .replace('__DEFAULT_AUTH_TOKEN__', authToken)
        .replace('__DEFAULT_NTFY_TOPIC__', ntfyTopic);
    }
    fs.writeFileSync(path.join(srcDir, jf), content, 'utf8');
  }

  // 1. aapt2 compile
  const resZip = path.join(buildDir, 'res.zip');
  execFileSync(AAPT2, ['compile', '--dir', path.join(ANDROID_DIR, 'res'), '-o', resZip], {
    stdio: 'inherit'
  });

  // 2. aapt2 link
  const unsignedApk = path.join(buildDir, 'unsigned.apk');
  execFileSync(
    AAPT2,
    [
      'link',
      '-o',
      unsignedApk,
      '-I',
      ANDROID_JAR,
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
    JAVAC,
    [
      '--release',
      '11',
      '-encoding',
      'UTF-8',
      '-cp',
      ANDROID_JAR,
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
    JAVA,
    ['-cp', D8_JAR, 'com.android.tools.r8.D8', '--min-api', '24', '--lib', ANDROID_JAR, '--output', dexDir, ...classFiles],
    { stdio: 'inherit' }
  );

  // 5. Empaquetar classes.dex en la raíz de unsigned.apk usando jar.exe -uf
  execFileSync(JAR, ['uf', unsignedApk, '-C', dexDir, 'classes.dex'], { stdio: 'inherit' });

  // 6. zipalign
  const alignedApk = path.join(buildDir, 'aligned.apk');
  execFileSync(ZIPALIGN, ['-f', '-p', '4', unsignedApk, alignedApk], { stdio: 'inherit' });

  // 7. Keystore y firma v1+v2+v3 con apksigner
  const keystorePath = path.join(SDK_SCRATCH, 'aipulse-release.jks');
  if (!fs.existsSync(keystorePath)) {
    execFileSync(
      KEYTOOL,
      [
        '-genkeypair',
        '-v',
        '-keystore',
        keystorePath,
        '-alias',
        'aipulse',
        '-keyalg',
        'RSA',
        '-keysize',
        '2048',
        '-validity',
        '10000',
        '-storepass',
        'aipulse123',
        '-keypass',
        'aipulse123',
        '-dname',
        'CN=AI Pulse, OU=Dev, O=Knupson, L=BA, S=BA, C=AR'
      ],
      { stdio: 'inherit' }
    );
  }

  execFileSync(
    JAVA,
    [
      '-jar',
      APKSIGNER_JAR,
      'sign',
      '--ks',
      keystorePath,
      '--ks-key-alias',
      'aipulse',
      '--ks-pass',
      'pass:aipulse123',
      '--key-pass',
      'pass:aipulse123',
      '--out',
      OUT_APK,
      alignedApk
    ],
    { stdio: 'inherit' }
  );

  const stat = fs.statSync(OUT_APK);
  console.log(`[APK Build] ¡Éxito! APK firmado generado en: ${OUT_APK} (${Math.round(stat.size / 1024)} KB)`);
}

main().catch((err) => {
  console.error('[APK Build Error]', err);
  process.exit(1);
});
