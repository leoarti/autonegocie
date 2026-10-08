import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore';

const env = import.meta.env;

const REQUIRED_ENV = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

const missingEnv = REQUIRED_ENV.filter((name) => !env[name]);

export const firebaseConfigError = missingEnv.length
  ? `Defina no arquivo .env: ${missingEnv.join(', ')}. O modelo está em .env.example.`
  : null;

const projectId = env.VITE_FIREBASE_PROJECT_ID || 'autonegocie-local';

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'missing',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
  projectId,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '000000000000',
  appId: env.VITE_FIREBASE_APP_ID || '1:000000000000:web:local',
};

export const firebaseApp: FirebaseApp = getApps().length
  ? getApps()[0]
  : initializeApp(firebaseConfig);

export const auth: Auth = getAuth(firebaseApp);
export const db: Firestore = getFirestore(firebaseApp);

const emulatorFlag = '__AUTONEGOCIE_FIREBASE_EMULATORS__';

if (
  !firebaseConfigError
  && env.DEV
  && env.VITE_FIREBASE_USE_EMULATOR === 'true'
  && !(globalThis as Record<string, unknown>)[emulatorFlag]
) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8088);
  (globalThis as Record<string, unknown>)[emulatorFlag] = true;
}

export const functionsBaseUrl = (env.VITE_FIREBASE_FUNCTIONS_URL || '/api').replace(/\/$/, '');
