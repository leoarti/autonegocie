import { useState, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/integrations/firebase/client';
import { 
  PaymentLinkRequest, 
  PaymentLinkResponse, 
  PaymentLinkHistory, 
  OrderType,
  QuitaMaisError 
} from '@/types/quitamais';

interface UseQuitaMaisState {
  isLoading: boolean;
  error: string | null;
  paymentLinks: PaymentLinkHistory[];
}

export const useQuitaMais = () => {
  const [state, setState] = useState<UseQuitaMaisState>({
    isLoading: false,
    error: null,
    paymentLinks: []
  });
  
  const { toast } = useToast();

  const testConnectivity = useCallback(async (): Promise<boolean> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      // Test authentication with QuitaPlus API via new token endpoint
      const { data: tokenData, error } = await db.functions.invoke('quitaplus-token');

      if (error) {
        throw new Error(error.message || 'Erro ao testar conectividade');
      }

      if (!tokenData?.accessToken) {
        throw new Error('Token de acesso não recebido');
      }

      toast({
        title: "Conectividade OK!",
        description: "Conexão com QuitaPlus funcionando corretamente.",
        variant: "default"
      });

      setState(prev => ({ ...prev, isLoading: false, error: null }));
      return true;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      
      setState(prev => ({ 
        ...prev, 
        isLoading: false, 
        error: errorMessage 
      }));

      toast({
        title: "Erro de Conectividade",
        description: errorMessage,
        variant: "destructive"
      });

      return false;
    }
  }, [toast]);

  const createPaymentLink = useCallback(async (
    request: PaymentLinkRequest,
    orderType: OrderType = 'boleto'
  ): Promise<PaymentLinkResponse | null> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      // Send data directly in the expected structure
      const { data: paymentLink, error } = await db.functions.invoke('quitaplus-proxy', {
        body: {
          orderType, // for path normalization
          amount: request.amount, // for EXTRAS_TO_STORE
          orderId: request.orderId, // for EXTRAS_TO_STORE
          description: request.description,
          details: (request as any).details,
          initiatorKey: (request as any).initiatorKey,
          expirationDate: request.expirationDate,
          payer: {
            name: request.payer.name,
            email: request.payer.email,
            phoneNumber: request.payer.phoneNumber,
            document: request.payer.document
          },
          ...(request.bankslip ? {
            bankslip: {
              number: request.bankslip.number,
              creditorDocument: request.bankslip.creditorDocument,
              creditorName: request.bankslip.creditorName
            }
          } : {}),
          checkout: {
            installments: request.checkout.installments,
            maskFee: request.checkout.maskFee
          }
        }
      });

      if (error) {
        throw new Error(error.message || 'Erro ao criar link de pagamento');
      }

      if (!paymentLink) {
        throw new Error('Resposta inválida do servidor');
      }

      // Extract extras data returned by proxy (from EXTRAS_TO_STORE)
      const extrasToStore = paymentLink._extrasToStore || {};
      
      // Get company_id from user profile
      const { data: profile } = await db
        .from('profiles')
        .select('company_id')
        .eq('id', (await db.auth.getUser()).data.user?.id)
        .single();

      if (!profile?.company_id) {
        throw new Error('Company ID not found for user');
      }
      
      // Save complete data to database using both API response and EXTRAS_TO_STORE
      const { data: savedLink, error: saveError } = await db
        .from('payment_links')
        .insert({
          link_id: paymentLink.linkId || `link_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          url: paymentLink.linkUrl,
          guid: paymentLink.guid,
          company_id: profile.company_id,
          amount: extrasToStore.amount || request.amount,
          payer_name: request.payer.name,
          payer_email: request.payer.email,
          payer_document: request.payer.document,
          payer_phone_number: request.payer.phoneNumber,
          order_type: extrasToStore.order_type_ui || orderType,
          order_id: request.orderId,
          description: request.description,
          installments: request.checkout.installments,
          mask_fee: request.checkout.maskFee,
          creditor_name: request.bankslip?.creditorName,
          creditor_document: request.bankslip?.creditorDocument,
          expiration_date: request.expirationDate ? new Date(request.expirationDate).toISOString() : null,
          status: paymentLink.status,
          ui_snapshot: extrasToStore.ui_snapshot || {
            amount: request.amount,
            orderId: request.orderId,
            orderType: orderType,
            originalRequest: request
          }
        } as any)
        .select()
        .single();

      if (saveError) {
        console.error('Error saving payment link:', saveError);
        // Continue anyway, don't fail the whole operation
      }

      const historyItem: PaymentLinkHistory = {
        id: savedLink?.id || crypto.randomUUID(),
        linkId: paymentLink.linkId,
        linkUrl: paymentLink.linkUrl,
        amount: request.amount,
        payerName: request.payer.name,
        payerEmail: request.payer.email,
        status: paymentLink.status,
        createdAt: new Date().toISOString(),
        orderId: request.orderId,
        description: request.description
      };

      setState(prev => ({
        ...prev,
        isLoading: false,
        paymentLinks: [historyItem, ...prev.paymentLinks]
      }));

      toast({
        title: "Link de pagamento criado!",
        description: "O link foi gerado com sucesso e está pronto para uso.",
      });

      return paymentLink;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage
      }));

      toast({
        title: "Erro ao criar link",
        description: errorMessage,
        variant: "destructive",
      });

      return null;
    }
  }, [toast]);

  const getPaymentLinkDetails = useCallback(async (linkId: string): Promise<PaymentLinkResponse | null> => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      // Use QuitaPlus proxy to search for payment link (no direct API calls)
      const { data: linkDetails, error } = await db.functions.invoke('quitaplus-proxy', {
        body: {
          targetPath: `payment/order/${linkId}`,
          httpMethod: 'GET'
        }
      });
      
      if (error) {
        throw new Error(error.message || 'Erro ao consultar link de pagamento');
      }
      
      setState(prev => ({ ...prev, isLoading: false }));
      
      return linkDetails;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage
      }));

      return null;
    }
  }, []);

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({
        title: "Copiado!",
        description: "Link copiado para a área de transferência.",
      });
    } catch (error) {
      toast({
        title: "Erro ao copiar",
        description: "Não foi possível copiar o link.",
        variant: "destructive",
      });
    }
  }, [toast]);

  const shareViaWhatsApp = useCallback((linkUrl: string, message?: string) => {
    const encodedMessage = encodeURIComponent(
      message || `Olá! Aqui está seu link de pagamento: ${linkUrl}`
    );
    const whatsappUrl = `https://wa.me/?text=${encodedMessage}`;
    window.open(whatsappUrl, '_blank');
  }, []);

  const shareViaEmail = useCallback((linkUrl: string, email?: string, subject?: string, message?: string) => {
    const encodedSubject = encodeURIComponent(subject || 'Link de Pagamento');
    const encodedMessage = encodeURIComponent(
      message || `Olá!\n\nSeu link de pagamento está disponível em: ${linkUrl}\n\nObrigado!`
    );
    const emailUrl = `mailto:${email || ''}?subject=${encodedSubject}&body=${encodedMessage}`;
    window.open(emailUrl, '_blank');
  }, []);

  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }));
  }, []);

  const loadHistory = useCallback(async () => {
    setState(prev => ({ ...prev, isLoading: true }));
    
    try {
      const { data: links, error } = await db
        .from('payment_links')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      const historyItems: PaymentLinkHistory[] = (links || []).map(link => ({
        id: link.id,
        linkId: link.link_id,
        linkUrl: link.link_url,
        amount: link.amount,
        payerName: link.payer_name,
        payerEmail: link.payer_email,
        status: link.status,
        createdAt: link.created_at,
        orderId: link.order_id,
        description: link.description
      }));

      setState(prev => ({ 
        ...prev, 
        isLoading: false,
        paymentLinks: historyItems 
      }));
    } catch (error) {
      console.error('Error loading payment link history:', error);
      setState(prev => ({ ...prev, isLoading: false }));
      
      // Fallback to localStorage
      const savedHistory = localStorage.getItem('quitamais-history');
      if (savedHistory) {
        try {
          const parsedHistory: PaymentLinkHistory[] = JSON.parse(savedHistory);
          setState(prev => ({ ...prev, paymentLinks: parsedHistory }));
        } catch (parseError) {
          console.error('Error parsing localStorage history:', parseError);
        }
      }
    }
  }, []);

  // Save to localStorage whenever paymentLinks changes
  const saveHistory = useCallback((links: PaymentLinkHistory[]) => {
    localStorage.setItem('quitamais-history', JSON.stringify(links));
  }, []);

  return {
    ...state,
    testConnectivity,
    createPaymentLink,
    getPaymentLinkDetails,
    copyToClipboard,
    shareViaWhatsApp,
    shareViaEmail,
    clearError,
    loadHistory,
    saveHistory
  };
};