import { useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { SplitModal } from '@/components/SplitModal';
import { CombinedCheckoutSummary } from '@/components/CombinedCheckoutSummary';
import { db, functionsBaseUrl } from '@/integrations/firebase/client';
import { useToast } from '@/hooks/use-toast';

interface PaymentSplit {
  id: string;
  method: string;
  status: string;
  amount_cents: number;
  installments?: number;
  pix_paid_at?: string;
  mp_payment_id?: string;
  pre_payment_key?: string;
  transaction_id?: string;
}

export default function Checkout() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [charge, setCharge] = useState<any>(null);
  const [isSplitModalOpen, setIsSplitModalOpen] = useState(false);
  const [existingSplits, setExistingSplits] = useState<PaymentSplit[]>([]);
  const [alreadyProcessed, setAlreadyProcessed] = useState(false);

  // Statuses que indicam que o cliente já agiu — link deve ser bloqueado
  const BLOCKING_STATUSES = new Set([
    'analyzing', 'processing', 'validating', 'approved',
    'awaiting_validation', 'boleto_linked', 'concluded',
  ]);
  
  const mode = searchParams.get('mode') || 'direct';

  useEffect(() => {
    const fetchChargeAndSplits = async () => {
      if (!id) {
        toast({
          title: "Erro",
          description: "Link de pagamento inválido.",
          variant: "destructive",
        });
        setLoading(false);
        return;
      }

      try {
        setLoading(true);

        // Buscar dados do pagamento E splits existentes em paralelo
        const [paymentResponse, splitsResponse] = await Promise.all([
          fetch(`${functionsBaseUrl}/public-payment-link?id=${id}`),
          fetch(`${functionsBaseUrl}/public-payment-splits?id=${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          })
        ]);

        if (!paymentResponse.ok) {
          const errorData = await paymentResponse.json();
          throw new Error(errorData.message || 'Failed to fetch payment link');
        }

        const data = await paymentResponse.json();
        let splits: PaymentSplit[] = [];

        if (splitsResponse.ok) {
          const splitsData = await splitsResponse.json();
          splits = splitsData.payment_splits || [];
          console.log('[Checkout] Splits existentes:', splits);
        }

        if (!data?.amount_cents) {
          toast({
            title: "Link inválido",
            description: "Este link de pagamento não existe ou expirou.",
            variant: "destructive",
          });
          setLoading(false);
          return;
        }

        // Cobrança já finalizada → redirecionar para confirmação
        if (data.status === 'completed') {
          navigate(`/thank-you?pl=${id}`, { replace: true });
          return;
        }

        setCharge(data);
        setExistingSplits(splits);
        
        // Verificar o método de pagamento
        const paymentMethod = data.payment_method;
        
        // Se for PIX puro, redirecionar para checkout PIX
        if (paymentMethod === 'pix' || paymentMethod === 'PIX') {
          navigate(`/checkout-pix/${data.charge_id || id}`, { replace: true });
          return;
        }
        
        // Se for pagamento combinado (cartão + PIX), verificar splits existentes
        if (paymentMethod === 'cartao_pix') {
          const pixSplit = splits.find(s => s.method === 'pix') as any;
          const cardSplit = splits.find(s => s.method === 'credit_card') as any;
          
          console.log('[Checkout] Estado dos splits:', {
            pixSplit: pixSplit ? { 
              status: pixSplit.status, 
              amount: pixSplit.amount_cents,
              pix_paid_at: pixSplit.pix_paid_at 
            } : null,
            cardSplit: cardSplit ? { 
              status: cardSplit.status, 
              amount: cardSplit.amount_cents,
              pre_payment_key: cardSplit.pre_payment_key,
              transaction_id: cardSplit.transaction_id
            } : null
          });

          // Helper para verificar se PIX foi pago (status OU pix_paid_at)
          const isPixPaid = pixSplit && (
            pixSplit.status === 'concluded' ||
            !!pixSplit.pix_paid_at
          );

          // Helper para verificar se Cartão foi pago - SOMENTE status === 'concluded'
          const isCardPaid = cardSplit && cardSplit.status === 'concluded';

          // Helper: cartão em processamento (ação já submetida, não cancelado/negado)
          const isCardInProgress = cardSplit &&
            BLOCKING_STATUSES.has(cardSplit.status) &&
            !isCardPaid;

          // CENÁRIO 1: PIX já pago, cartão pendente → ir direto para cartão
          // Exceção: se cartão já está em processamento, bloquear link
          if (isPixPaid && cardSplit && !isCardPaid) {
            if (isCardInProgress) {
              console.log('[Checkout] PIX pago + cartão em processamento, bloqueando link');
              setAlreadyProcessed(true);
              setLoading(false);
              return;
            }
            console.log('[Checkout] PIX já pago, redirecionando para cartão');
            navigate(`/payment-card/${id}`, { replace: true });
            return;
          }

          // CENÁRIO 2: Ambos splits existem mas nenhum pago → MOSTRAR CombinedCheckoutSummary
          // (removido redirecionamento automático - cliente deve ver o resumo e confirmar parcelas)

          // CENÁRIO 3: Ambos concluídos → ir para thank-you
          if (isPixPaid && isCardPaid) {
            console.log('[Checkout] Ambos pagamentos concluídos');
            navigate(`/thank-you?pl=${id}`, { replace: true });
            return;
          }

          // CENÁRIO 4: Só cartão existe e está pendente → ir para cartão
          if (!pixSplit && cardSplit && !isCardPaid) {
            console.log('[Checkout] Só cartão pendente, redirecionando para cartão');
            navigate(`/payment-card/${id}`, { replace: true });
            return;
          }

          // CENÁRIO 5: PIX existe, não pago, MAS já tem QR Code gerado → ir direto para PIX
          // Isso evita que o cliente confirme novamente e delete o split com dados do MP
          if (pixSplit && !isPixPaid && pixSplit.mp_payment_id) {
            console.log('[Checkout] PIX já tem QR Code gerado (mp_payment_id existe), redirecionando direto');
            navigate(`/payment-pix/${id}`, { replace: true });
            return;
          }

          // CENÁRIO 6: Só PIX existe e ainda não pago (sem QR gerado) → ir para PIX
          if (pixSplit && !isPixPaid && !cardSplit) {
            console.log('[Checkout] Só PIX pendente, redirecionando para PIX');
            navigate(`/payment-pix/${id}`, { replace: true });
            return;
          }

          // CENÁRIO 7: Nenhum split existe → exibir CombinedCheckoutSummary
          console.log('[Checkout] Nenhum split existente, exibindo formulário de divisão');
          setLoading(false);
          return;
        }
        
        // Se for cartão puro, redirecionar para payment-direct
        if (mode === 'direct') {
          navigate(`/payment-direct/${id}`, { replace: true });
          return;
        }
        
        if (mode === 'split') {
          setIsSplitModalOpen(true);
        }

      } catch (error: any) {
        console.error('Error fetching charge:', error);
        toast({
          title: "Erro ao carregar",
          description: error.message === 'Timeout' 
            ? "A solicitação demorou muito tempo. Tente novamente."
            : "Não foi possível carregar os dados do pagamento.",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    };

    fetchChargeAndSplits();
  }, [id, toast, navigate, mode]);

  // Handler para confirmação do checkout combinado
  // cardOriginalCents = valor ORIGINAL (para salvar no DB e enviar à API Quita+)
  // cardTotalWithInterestCents = valor COM JUROS (apenas para exibição ao cliente)
  const handleCombinedConfirm = async (
    pixTotalCents: number,
    cardOriginalCents: number,
    cardTotalWithInterestCents: number,
    cardInstallments: number,
    installmentValueCents: number
  ) => {
    if (!charge) return;

    try {
      // Salvar splits no banco de dados (via Edge Function para bypass RLS)
      const chargeId = charge.charge_id || charge.id;
      const paymentLinkId = charge.id;
      
      // Criar array de splits
      const splits = [];
      
      if (pixTotalCents > 0) {
        // pixTotalCents já inclui taxa de 1.5%
        // amount_cents = valor base (sem taxa), display_amount_cents = valor com taxa
        const pixBaseCents = Math.round(pixTotalCents / 1.015);
        splits.push({
          charge_id: chargeId,
          payment_link_id: paymentLinkId,
          method: 'pix',
          amount_cents: pixBaseCents,
          display_amount_cents: pixTotalCents,
          order_index: 1,
          status: 'pending',
        });
      }
      
      if (cardOriginalCents > 0) {
        splits.push({
          charge_id: chargeId,
          payment_link_id: paymentLinkId,
          method: 'credit_card',
          amount_cents: cardOriginalCents,              // ✅ Valor ORIGINAL (para API Quita+)
          display_amount_cents: cardTotalWithInterestCents, // ✅ Valor COM JUROS (para exibição)
          installments: cardInstallments,
          order_index: pixTotalCents > 0 ? 2 : 1,
          status: 'pending',
        });
      }

      if (splits.length > 0) {
        // Usar Edge Function para criar splits (deleta antigos automaticamente)
        const response = await fetch(`${functionsBaseUrl}/public-payment-splits`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            id: paymentLinkId,
            action: 'create_splits',
            splits 
          })
        });

        if (!response.ok) {
          const error = await response.json();
          console.error('[Checkout] Error creating splits:', error);
          throw new Error('Falha ao salvar configuração de pagamento');
        }
        
        const result = await response.json();
        console.log('[Checkout] ✅ Splits criados via Edge Function:', result);
      }

      console.log('[Checkout] ✅ Splits salvos com sucesso:', {
        pixTotalCents,
        cardOriginalCents,
        cardTotalWithInterestCents,
        cardInstallments,
        installmentValueCents
      });

      // Redirecionar para o primeiro método de pagamento
      if (pixTotalCents > 0) {
        // Se há PIX, ir para tela de PIX primeiro
        navigate(`/payment-pix/${id}?next=card`);
      } else if (cardOriginalCents > 0) {
        // Se só há cartão, ir direto para cartão
        navigate(`/payment-card/${id}`);
      }

    } catch (error: any) {
      console.error('[Checkout] Error in handleCombinedConfirm:', error);
      toast({
        title: "Erro",
        description: error.message || "Falha ao processar configuração de pagamento.",
        variant: "destructive",
      });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-ds-bg-body flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-ds-text-muted">Carregando dados do pagamento...</p>
        </div>
      </div>
    );
  }

  if (alreadyProcessed) {
    return (
      <div className="min-h-screen bg-ds-bg-body flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="text-primary mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-ds-text-strong mb-2">Pagamento em Processamento</h2>
          <p className="text-ds-text-muted">
            Este pagamento já foi enviado e está sendo processado. Em breve você receberá a confirmação.
          </p>
        </Card>
      </div>
    );
  }

  if (!charge) {
    return (
      <div className="min-h-screen bg-ds-bg-body flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="text-destructive mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-ds-text-strong mb-2">Link Inválido</h2>
          <p className="text-ds-text-muted">
            Este link de pagamento não existe ou expirou.
          </p>
        </Card>
      </div>
    );
  }

  // Renderizar checkout combinado para cartao_pix
  if (charge.payment_method === 'cartao_pix') {
    return (
      <CombinedCheckoutSummary
        totalOriginalCents={charge.amount_cents}
        initialPixCents={charge.pix_amount || 0}
        initialCardCents={charge.card_amount || 0}
        chargeId={charge.charge_id || charge.id}
        paymentLinkId={charge.id || id || ''}
        onConfirm={handleCombinedConfirm}
      />
    );
  }

  return (
    <div className="min-h-screen bg-ds-bg-body flex items-center justify-center p-4">
      <SplitModal
        isOpen={isSplitModalOpen}
        onClose={() => setIsSplitModalOpen(false)}
        totalCents={charge.amount_cents}
        chargeId={charge.charge_id || ''}
        paymentLinkId={charge.id || id || ''}
      />
    </div>
  );
}
