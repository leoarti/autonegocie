import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import type { AuthSession as Session, AuthUser as User } from '@/integrations/firebase/types';
import { db } from '@/integrations/firebase/client';
import { auth } from '@/integrations/firebase/config';

export interface Profile {
  id: string;
  full_name: string;
  role: 'admin' | 'operador';
  is_active: boolean;
  company_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: any }>;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: any }>;
  signOut: () => Promise<{ error: any }>;
  isAdmin: boolean;
  isOperador: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const readProfile = (userId: string) => db
    .from('profiles')
    .select('id, full_name, is_active, company_id, created_at, updated_at')
    .eq('id', userId)
    .maybeSingle();

  const readRole = async (userId: string) => {
    const byId = await db
      .from('user_roles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (byId.data?.role) return byId;

    const byUser = await db
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle();
    if (byUser.data?.role) return byUser;
    return byId.error ? byId : byUser;
  };

  const createOwnProfile = async (userId: string) => {
    const now = new Date().toISOString();
    const current = auth.currentUser;
    const fullName = current?.displayName?.trim()
      || current?.email?.split('@')[0]
      || 'Usuário';
    const row = {
      id: userId,
      full_name: fullName,
      is_active: true,
      company_id: null,
      created_at: now,
      updated_at: now,
    };

    const { error } = await db.from('profiles').insert(row);
    if (!error) return row;

    const again = await readProfile(userId);
    if (again.data) return again.data;

    console.error('❌ [AuthContext] Erro ao criar profile:', error.message);
    return null;
  };

  const ensureRole = async (userId: string, existing: string | undefined) => {
    if (existing === 'admin' || existing === 'operador') return existing;

    const now = new Date().toISOString();
    const { error } = await db.from('user_roles').insert({
      id: userId,
      user_id: userId,
      role: 'operador',
      created_at: now,
    });
    if (error) {
      console.warn('⚠️ [AuthContext] Erro ao criar role (usando operador):', error.message);
    }
    return 'operador' as const;
  };

  const fetchProfile = async (userId: string) => {
    try {
      const [profileResult, roleResult] = await Promise.all([
        readProfile(userId),
        readRole(userId),
      ]);

      if (profileResult.error) {
        console.error('❌ [AuthContext] Erro ao buscar profile:', profileResult.error.message);
        return null;
      }

      const profileData = profileResult.data ?? await createOwnProfile(userId);
      if (!profileData) return null;

      if (roleResult.error) {
        console.warn('⚠️ [AuthContext] Erro ao buscar role (usando default):', roleResult.error.message);
      }

      const role = await ensureRole(userId, roleResult.data?.role);

      const profile: Profile = {
        ...profileData,
        role,
      };

      return profile;
    } catch (error) {
      console.error('❌ [AuthContext] Erro inesperado em fetchProfile:', error);
      return null;
    }
  };

  const clearLocalStorage = () => {
    Object.keys(localStorage)
      .filter(k => k.startsWith('sb-'))
      .forEach(k => localStorage.removeItem(k));
  };

  useEffect(() => {
    // Controle de corrida: ignora respostas de fetchProfile para sessões antigas
    let currentUserId: string | null = null;

    const { data: { subscription } } = db.auth.onAuthStateChange(
      (event, session) => {
        // O callback do Firebase Auth não pode ser async.
        // (queries ficam pendentes esperando o callback terminar)
        console.log('[AuthContext] event:', event, '| session:', session?.user?.id ?? 'null');

        if (event === 'SIGNED_OUT' || !session) {
          currentUserId = null;
          clearLocalStorage();
          setUser(null);
          setSession(null);
          setProfile(null);
          setLoading(false);
          return;
        }

        if (
          event === 'SIGNED_IN' ||
          event === 'TOKEN_REFRESHED' ||
          event === 'INITIAL_SESSION' ||
          event === 'USER_UPDATED'
        ) {
          const userId = session.user.id;
          currentUserId = userId;
          if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
            setLoading(true);
          }
          setSession(session);
          setUser(session.user);

          // Disparar fetch de perfil FORA do callback para não bloquear o auth client
          setTimeout(() => {
            const loadProfile = async () => {
              for (let attempt = 0; attempt < 3; attempt += 1) {
                const userProfile = await fetchProfile(userId);
                if (userProfile || currentUserId !== userId) return userProfile;
                await new Promise((resolve) => setTimeout(resolve, 300));
              }
              return null;
            };

            loadProfile().then((userProfile) => {
              if (currentUserId === userId) {
                setProfile(userProfile);
                setLoading(false);
              }
            });
          }, 0);
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await db.auth.signInWithPassword({
      email,
      password,
    });
    return { error };
  };

  const signUp = async (email: string, password: string, fullName: string) => {
    const redirectUrl = `${window.location.origin}/`;
    
    const { error } = await db.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
        data: {
          full_name: fullName,
        }
      }
    });
    return { error };
  };

  const signOut = async () => {
    // Limpar localStorage ANTES do signOut para evitar race condition
    Object.keys(localStorage)
      .filter(k => k.startsWith('sb-'))
      .forEach(k => localStorage.removeItem(k));

    const { error } = await db.auth.signOut();

    if (error) {
      console.warn('[AuthContext] signOut com erro (esperado se sessão já expirou):', error.message);
    }

    // Sempre limpar estado React
    setUser(null);
    setSession(null);
    setProfile(null);

    return { error };
  };

  const isAdmin = profile?.role === 'admin' && profile?.is_active;
  const isOperador = (profile?.role === 'operador' || profile?.role === 'admin') && profile?.is_active;


  const value = useMemo(() => ({
    user,
    session,
    profile,
    loading,
    signIn,
    signUp,
    signOut,
    isAdmin,
    isOperador,
  }), [user, session, profile, loading, isAdmin, isOperador]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}