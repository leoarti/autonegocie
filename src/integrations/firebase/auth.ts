import {
  browserSessionPersistence,
  confirmPasswordReset as firebaseConfirmPasswordReset,
  createUserWithEmailAndPassword,
  onIdTokenChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updatePassword,
  updateProfile,
  type User,
} from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db, firebaseConfigError } from './config';
import type { AuthError, AuthSession, AuthUser } from './types';

const persistenceReady = firebaseConfigError
  ? Promise.resolve()
  : setPersistence(auth, browserSessionPersistence);

const AUTH_MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Email ou senha incorretos.',
  'auth/user-not-found': 'Email ou senha incorretos.',
  'auth/wrong-password': 'Email ou senha incorretos.',
  'auth/email-already-in-use': 'Este email já está cadastrado.',
  'auth/weak-password': 'A senha deve ter pelo menos 6 caracteres.',
  'auth/invalid-email': 'Email inválido.',
  'auth/too-many-requests': 'Muitas tentativas. Tente novamente em alguns minutos.',
  'auth/invalid-action-code': 'Link de recuperação inválido ou expirado.',
  'auth/network-request-failed': 'Sem conexão com o Firebase. Verifique a rede e a configuração.',
};

export function toAuthError(error: unknown): AuthError {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code: string }).code)
    : undefined;
  const fallback = error instanceof Error ? error.message : 'Erro de autenticação.';
  return { message: (code && AUTH_MESSAGES[code]) || fallback, code };
}

function toAuthUser(user: User): AuthUser {
  return {
    id: user.uid,
    email: user.email ?? undefined,
    user_metadata: {
      full_name: user.displayName ?? undefined,
    },
  };
}

async function toSession(user: User): Promise<AuthSession> {
  return {
    user: toAuthUser(user),
    access_token: await user.getIdToken(),
  };
}

export const firebaseAuth = {
  async signInWithPassword({ email, password }: { email: string; password: string }) {
    try {
      await persistenceReady;
      await signInWithEmailAndPassword(auth, email, password);
      return { data: { user: auth.currentUser ? toAuthUser(auth.currentUser) : null }, error: null };
    } catch (error) {
      return { data: { user: null }, error: toAuthError(error) };
    }
  },

  async signUp({
    email,
    password,
    options,
  }: {
    email: string;
    password: string;
    options?: { emailRedirectTo?: string; data?: { full_name?: string } };
  }) {
    try {
      await persistenceReady;
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      const fullName = options?.data?.full_name?.trim() || '';
      if (fullName) {
        await updateProfile(credential.user, { displayName: fullName });
      }

      const now = new Date().toISOString();
      await setDoc(doc(db, 'user_roles', credential.user.uid), {
        id: credential.user.uid,
        user_id: credential.user.uid,
        role: 'operador',
        created_at: now,
      });
      await setDoc(doc(db, 'profiles', credential.user.uid), {
        id: credential.user.uid,
        full_name: fullName,
        is_active: true,
        company_id: null,
        created_at: now,
        updated_at: now,
      });

      return { data: { user: toAuthUser(credential.user) }, error: null };
    } catch (error) {
      return { data: { user: null }, error: toAuthError(error) };
    }
  },

  async signOut() {
    try {
      await firebaseSignOut(auth);
      return { error: null };
    } catch (error) {
      return { error: toAuthError(error) };
    }
  },

  async getSession() {
    await persistenceReady;
    const user = auth.currentUser;
    if (!user) return { data: { session: null }, error: null };
    return { data: { session: await toSession(user) }, error: null };
  },

  async getUser() {
    await persistenceReady;
    const user = auth.currentUser;
    return { data: { user: user ? toAuthUser(user) : null }, error: null };
  },

  async updateUser({ password }: { password: string }) {
    try {
      if (!auth.currentUser) {
        return { data: { user: null }, error: { message: 'Sessão expirada. Entre novamente.' } };
      }
      await updatePassword(auth.currentUser, password);
      return { data: { user: toAuthUser(auth.currentUser) }, error: null };
    } catch (error) {
      return { data: { user: null }, error: toAuthError(error) };
    }
  },

  async resetPasswordForEmail(email: string, options?: { redirectTo?: string }) {
    try {
      await sendPasswordResetEmail(auth, email, options?.redirectTo
        ? { url: options.redirectTo, handleCodeInApp: false }
        : undefined);
      return { data: {}, error: null };
    } catch (error) {
      return { data: {}, error: toAuthError(error) };
    }
  },

  async confirmPasswordReset(code: string, password: string) {
    try {
      await firebaseConfirmPasswordReset(auth, code, password);
      return { data: {}, error: null };
    } catch (error) {
      return { data: {}, error: toAuthError(error) };
    }
  },

  onAuthStateChange(callback: (event: string, session: AuthSession | null) => void) {
    let unsubscribe = () => {};
    let active = true;
    let initialized = false;
    let lastUid: string | null = null;

    persistenceReady.then(() => {
      if (!active) return;
      unsubscribe = onIdTokenChanged(auth, (user) => {
        if (!user) {
          lastUid = null;
          initialized = true;
          callback('SIGNED_OUT', null);
          return;
        }

        toSession(user).then((session) => {
          if (!active) return;
          let event = 'SIGNED_IN';
          if (!initialized) event = 'INITIAL_SESSION';
          else if (lastUid === user.uid) event = 'TOKEN_REFRESHED';
          lastUid = user.uid;
          initialized = true;
          callback(event, session);
        }).catch((error) => {
          console.error('[firebase auth] falha ao montar sessão:', error);
          callback('SIGNED_OUT', null);
        });
      });
    });

    return {
      data: {
        subscription: {
          unsubscribe: () => {
            active = false;
            unsubscribe();
          },
        },
      },
    };
  },
};
