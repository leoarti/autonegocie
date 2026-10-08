import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/integrations/firebase/client';
import { useRef, useEffect, useCallback } from 'react';

export interface CompanySettings {
  creditor_document: string;
  creditor_name: string;
  merchant_id: string;
}

export function useCompanySettings() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const lastGoodSettings = useRef<CompanySettings | null>(null);
  const hasLoggedOnce = useRef(false);
  const retryCount = useRef(0);

  const fetchSettings = useCallback(async (): Promise<CompanySettings> => {
    if (!user) throw new Error('User not authenticated');

    const { data, error } = await db.functions.invoke<CompanySettings>('company-settings', {
      body: {},
    });

    if (error) {
      // Se 401, invalidar cache para retry automático do React Query
      if (error.message?.includes('401') && retryCount.current < 1) {
        retryCount.current++;
        console.warn('[useCompanySettings] ⚠️ 401 recebido, invalidando cache...');
        queryClient.invalidateQueries({ queryKey: ['company-settings'] });
      }
      throw error;
    }
    
    if (!data) throw new Error('Nenhum dado retornado');
    retryCount.current = 0;
    return data;
  }, [user, queryClient]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['company-settings', user?.id],
    queryFn: fetchSettings,
    enabled: !!user,
    staleTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const isValid = !!(data?.creditor_document && data?.creditor_name && data?.merchant_id);

  // Update lastGoodSettings when we have valid data
  useEffect(() => {
    if (isValid && data) {
      lastGoodSettings.current = data;
      
      if (!hasLoggedOnce.current) {
        console.log('[useCompanySettings] ✅ Settings loaded:', {
          creditor_document: data.creditor_document ? '***' + data.creditor_document.slice(-4) : 'EMPTY',
          creditor_name: data.creditor_name || 'EMPTY',
          merchant_id: data.merchant_id ? '***' + data.merchant_id.slice(-4) : 'EMPTY',
        });
        hasLoggedOnce.current = true;
      }
    }
  }, [isValid, data]);

  return {
    data: data || lastGoodSettings.current,
    isLoading,
    isError,
    error,
    isValid: isValid || !!lastGoodSettings.current,
    lastGoodSettings: lastGoodSettings.current,
  };
}
