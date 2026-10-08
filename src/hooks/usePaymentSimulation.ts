import { useQuery } from '@tanstack/react-query';
import { db } from '@/integrations/firebase/client';

export interface InstallmentCondition {
  installments: number;
  installmentAmount: number;
  totalAmount: number;
  paymentMethod: string;
}

export interface SimulationResponse {
  success: boolean;
  simulation: {
    conditions: InstallmentCondition[];
  };
}

export function usePaymentSimulation(amountCents: number | null) {
  return useQuery({
    queryKey: ['payment-simulation', amountCents],
    queryFn: async () => {
      if (!amountCents || amountCents <= 0) {
        throw new Error('Valor inválido para simulação');
      }

      const { data, error } = await db.functions.invoke('quitaplus-simulation', {
        body: { amountInCents: amountCents }
      });

      if (error) {
        console.error('[usePaymentSimulation] Error:', error);
        throw error;
      }

      if (!data?.success) {
        throw new Error(data?.error || 'Erro na simulação');
      }

      return data as SimulationResponse;
    },
    enabled: !!amountCents && amountCents > 0,
    staleTime: 0, // ✅ SEM CACHE - resimular sempre
    gcTime: 0, // ✅ Não manter em cache
    retry: 1,
  });
}
