import { useQuery } from '@tanstack/react-query';
import { db } from '@/integrations/firebase/client';

export interface MessageTemplate {
  id: string;
  name: string;
  variables: string[];
  is_active: boolean;
  updated_at: string;
}

export function useMessageTemplates(companyId?: string) {
  return useQuery({
    queryKey: ['message-templates', companyId],
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      // RLS agora filtra automaticamente por company_id
      const { data, error } = await db
        .from('message_templates')
        .select('id, name, variables, is_active, updated_at')
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(100);
      
      if (error) {
        console.error('Error loading message templates:', error);
        throw error;
      }
      
      return (data ?? []) as MessageTemplate[];
    },
  });
}
