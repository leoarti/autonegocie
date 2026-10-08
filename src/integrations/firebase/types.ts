export interface AuthUser {
  id: string;
  email?: string;
  user_metadata?: {
    full_name?: string;
  };
}

export interface AuthSession {
  user: AuthUser;
  access_token: string;
}

export interface AuthError {
  message: string;
  code?: string;
}

export interface QueryResult<T = any> {
  data: T;
  error: AuthError | null;
  count: number | null;
}
