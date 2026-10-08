import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { functionsBaseUrl } from '@/integrations/firebase/client';
import type { PaymentFormData, PaymentResponse, PaymentState } from '@/types/payment';

export function usePayment() {
  const [paymentState, setPaymentState] = useState<PaymentState>({
    isProcessing: false,
    isSuccess: false,
    error: null,
    transactionId: null,
  });

  const { toast } = useToast();

  const processPayment = async (
    formData: PaymentFormData,
    amount: number,
    installments: number
  ): Promise<PaymentResponse> => {
    setPaymentState({
      isProcessing: true,
      isSuccess: false,
      error: null,
      transactionId: null,
    });

    try {
      const response = await fetch(`${functionsBaseUrl}/process-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...formData,
          amountInCents: Math.round(amount * 100),
          installments,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result: PaymentResponse = await response.json();

      if (result.success) {
        setPaymentState({
          isProcessing: false,
          isSuccess: true,
          error: null,
          transactionId: result.transactionId || null,
        });

        toast({
          title: "Pagamento Autorizado!",
          description: `Transação processada com sucesso. ID: ${result.transactionId}`,
        });
      } else {
        throw new Error(result.message || 'Erro no processamento do pagamento');
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      
      setPaymentState({
        isProcessing: false,
        isSuccess: false,
        error: errorMessage,
        transactionId: null,
      });

      toast({
        title: "Erro no Pagamento",
        description: errorMessage,
        variant: "destructive",
      });

      return {
        success: false,
        message: errorMessage,
      };
    }
  };

  const resetPaymentState = () => {
    setPaymentState({
      isProcessing: false,
      isSuccess: false,
      error: null,
      transactionId: null,
    });
  };

  return {
    paymentState,
    processPayment,
    resetPaymentState,
  };
}