import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { db } from '@/integrations/firebase/client';
import { toast } from 'sonner';

interface PaymentLink {
  url: string;
  linkId: string;
}

interface ChargeExecution {
  id: string;
  execution_date: string;
  status: string;
  payment_link_url?: string;
  payment_link_id?: string;
  scheduled_for?: string;
}

// Track attempted charges to prevent refetch loops
const tried = new Set<string>();
const shownToast = new Set<string>();

export function useChargeLinks() {
  const queryClient = useQueryClient();

  const getExistingLink = (chargeId: string) => useQuery({
    queryKey: ['charge-link', chargeId],
    enabled: !!chargeId && !tried.has(chargeId),
    staleTime: 60_000,
    gcTime: 300_000,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      try {
        // First check DB
        const { data: dbData } = await db
          .from('charges')
          .select('checkout_url, checkout_link_id')
          .eq('id', chargeId)
          .maybeSingle();

        if (dbData?.checkout_url && dbData?.checkout_link_id) {
          tried.add(chargeId);
          return { url: dbData.checkout_url, linkId: dbData.checkout_link_id };
        }

        // Then try edge function with 15s timeout
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT')), 15_000)
        );

        const edgeResult = await Promise.race([
          db.functions.invoke('charge-links', {
            body: { chargeId, action: 'get' }
          }),
          timeoutPromise
        ]);

        const { data, error } = edgeResult as { data: any; error: any };

        // NOT_FOUND é um estado válido (link ainda não foi gerado)
        if (data?.code === 'NOT_FOUND') {
          tried.add(chargeId);
          return null;
        }

        if (error || !data?.link?.url) {
          console.error('Error fetching link:', error);
          return null;
        }

        // Save to DB
        await db
          .from('charges')
          .update({
            checkout_url: data.link.url,
            checkout_link_id: data.link.linkId
          })
          .eq('id', chargeId);

        tried.add(chargeId);
        return { url: data.link.url, linkId: data.link.linkId };
      } catch (err) {
        console.error('Charge link fetch failed (timeout or network):', err);
        // Return null instead of throwing to avoid infinite loading
        return null;
      }
    }
  });

  const generateLinkMutation = useMutation({
    mutationFn: async (chargeId: string) => {
      const { data, error } = await db.functions.invoke('charge-links', {
        body: { chargeId, action: 'create' }
      });

      if (error) throw error;
      if (data?.code === 'SUBSCRIPTION_BLOCKED') {
        throw new Error('Assinatura necessária para gerar novos links');
      }
      if (!data?.link?.url) {
        throw new Error('Link inválido');
      }

      return { url: data.link.url, linkId: data.link.linkId };
    },
    onSuccess: (data, chargeId) => {
      queryClient.setQueryData(['charge-link', chargeId], data);
      tried.add(chargeId);
      shownToast.delete(chargeId);
      toast.success('Link gerado com sucesso', { id: `link-${chargeId}` });
    },
    onError: (err: any, chargeId) => {
      console.error('Error generating link:', err);
      toast.error(`Falha ao gerar link: ${err.message || 'desconhecido'}`, { 
        id: `link-${chargeId}` 
      });
    }
  });

  const copyToClipboard = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copiado para a área de transferência');
    } catch (error) {
      console.error('Error copying to clipboard:', error);
      toast.error('Não foi possível copiar o link');
    }
  };

  const openPaymentLink = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const resetLinkState = (chargeId: string) => {
    tried.delete(chargeId);
    shownToast.delete(chargeId);
    queryClient.invalidateQueries({ queryKey: ['charge-link', chargeId] });
  };

  const getChargeExecutions = (chargeId: string) => useQuery({
    queryKey: ['charge-executions', chargeId],
    enabled: !!chargeId,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await db.functions.invoke('recurrences-manager', {
        body: { action: 'get_executions', charge_id: chargeId }
      });

      if (error) throw error;
      return (data?.executions || []) as ChargeExecution[];
    }
  });

  return {
    getExistingLink,
    generateLink: generateLinkMutation.mutateAsync,
    isGenerating: generateLinkMutation.isPending,
    copyToClipboard,
    openPaymentLink,
    resetLinkState,
    getChargeExecutions
  };
}