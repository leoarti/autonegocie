import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { PaymentForm } from '@/components/PaymentForm';
import { CheckoutOptionCard } from '@/components/CheckoutOptionCard';
import { db, functionsBaseUrl } from '@/integrations/firebase/client';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { mapSimulationToPaymentOptions, findClosestInstallment } from '@/lib/checkout-utils';
import { PaymentOption } from '@/types/payment-options';
import { AlertCircle, CreditCard } from 'lucide-react';
import { usePaymentSimulation } from '@/hooks/usePaymentSimulation';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function PaymentDirect() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [charge, setCharge] = useState<any>(null);
  const [alreadyProcessed, setAlreadyProcessed] = useState(false);

  const BLOCKING_STATUSES = new Set([
    'analyzing', 'processing', 'validating', 'approved',
    'awaiting_validation', 'boleto_linked', 'concluded',
  ]);
  const [selectedOption, setSelectedOption] = useState<PaymentOption | null>(null);
  const [customAmount, setCustomAmount] = useState(0);
  const [customInstallments, setCustomInstallments] = useState(1);
  const [customResult, setCustomResult] = useState<{
    installments: number;
    totalCents: number;
    installmentValueCents: number;
  } | null>(null);
  const [selectInstallments, setSelectInstallments] = useState(0);
  const [selectResult, setSelectResult] = useState<{
    installments: number;
    totalCents: number;
    installmentValueCents: number;
  } | null>(null);

  const { 
    data: simulation, 
    isLoading: isSimulating, 
    error: simulationError 
  } = usePaymentSimulation(charge?.amount_cents || null);

  useEffect(() => {
    const fetchCharge = async () => {
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

        const response = await fetch(
          `${functionsBaseUrl}/public-payment-link?id=${id}`
        );

        if (!response.ok) {
          throw new Error('Failed to fetch payment link');
        }

        const data = await response.json();

        if (!data?.amount_cents) {
          toast({
            title: "Link inválido",
            description: "Este link de pagamento não existe ou expirou.",
            variant: "destructive",
          });
          setLoading(false);
          return;
        }

        // Cobrança já finalizada
        if (data.status === 'completed') {
          setAlreadyProcessed(true);
          setLoading(false);
          return;
        }

        // Verificar splits existentes para bloquear reentrada
        const chargeId = data.charge_id || data.id;
        const { data: existingSplits } = await db
          .from('payment_splits')
          .select('status, method')
          .eq('charge_id', chargeId);

        const hasBlockingSplit = (existingSplits || []).some(
          (s: { status: string }) => BLOCKING_STATUSES.has(s.status)
        );

        if (hasBlockingSplit) {
          setAlreadyProcessed(true);
          setLoading(false);
          return;
        }

        setCharge(data);
      } catch (error: any) {
        console.error('Error fetching charge:', error);
        toast({
          title: "Erro ao carregar",
          description: "Não foi possível carregar os dados do pagamento.",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    };

    fetchCharge();
  }, [id, toast]);

  const handlePaymentSuccess = async (transactionId: string, paymentStatus: 'approved' | 'pending' | 'failed' = 'approved') => {
    console.log('[PaymentDirect] Payment result:', { transactionId, paymentStatus, chargeId: charge?.id });

    if (paymentStatus === 'approved') {
      if (!charge?.id) {
        console.error('[PaymentDirect] No charge ID available');
        return;
      }

      try {
        console.log('[PaymentDirect] Calling conclude-card-payment edge function');
        
        const displayAmountCents = selectedOption
          ? (selectedOption.isCustom
              ? (customResult?.totalCents || 0)
              : selectedOption.isSelectInstallments
                ? (selectResult?.totalCents || 0)
                : selectedOption.totalCents)
          : 0;

        const { data, error } = await db.functions.invoke('conclude-card-payment', {
          body: {
            payment_link_id: charge.id,
            amount_cents: charge.amount_cents, // ✅ Usar valor original
            display_amount_cents: displayAmountCents || charge.amount_cents,
            installments: finalInstallments,
            transaction_id: transactionId,
          },
        });

        if (error) {
          console.error('[PaymentDirect] Error from edge function:', error);
          toast({
            title: "Erro",
            description: "Erro ao registrar pagamento. Tente novamente.",
            variant: "destructive",
          });
          return;
        }

        console.log('[PaymentDirect] Payment concluded successfully:', data);
        
        toast({
          title: "Pagamento aprovado!",
          description: "Seu pagamento foi processado com sucesso.",
        });

        setTimeout(() => {
          navigate(`/thank-you?pl=${id}`);
        }, 1500);
      } catch (error) {
        console.error('[PaymentDirect] Error processing payment:', error);
        toast({
          title: "Erro",
          description: "Erro ao processar pagamento. Tente novamente.",
          variant: "destructive",
        });
      }
    } else if (paymentStatus === 'pending') {
      toast({
        title: "Pagamento pendente",
        description: "Seu pagamento está sendo processado. Aguarde a confirmação.",
        variant: "default",
      });
    } else if (paymentStatus === 'failed') {
      toast({
        title: "Pagamento recusado",
        description: "Não foi possível processar seu pagamento. Verifique os dados e tente novamente.",
        variant: "destructive",
      });
    }
  };

  if (alreadyProcessed) {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="text-primary mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold mb-2">Pagamento em Processamento</h2>
          <p className="text-muted-foreground">
            Este pagamento já foi enviado e está sendo processado. Em breve você receberá a confirmação.
          </p>
        </Card>
      </div>
    );
  }

  if (loading || isSimulating) {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center p-4">
        <Card className="max-w-6xl w-full p-6 lg:p-8 rounded-2xl">
          <Skeleton className="h-8 w-48 mb-6" />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <div className="space-y-3">
              <Skeleton className="h-28 w-full rounded-2xl" />
              <Skeleton className="h-28 w-full rounded-2xl" />
              <Skeleton className="h-28 w-full rounded-2xl" />
            </div>
            <Skeleton className="h-[500px] w-full rounded-2xl" />
          </div>
        </Card>
      </div>
    );
  }

  if (!charge) {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-8 text-center rounded-2xl">
          <div className="text-destructive mb-4">
            <AlertCircle className="w-16 h-16 mx-auto" />
          </div>
          <h2 className="text-2xl font-bold text-foreground mb-2">Link Inválido</h2>
          <p className="text-muted-foreground">
            Este link de pagamento não existe ou expirou.
          </p>
        </Card>
      </div>
    );
  }

  const paymentOptions = charge 
    ? mapSimulationToPaymentOptions(simulation, charge.amount_cents)
    : [];

  // ✅ CORREÇÃO: Separar valor original (para API) do valor com juros (para exibição)
  // originalAmount = valor base da cobrança (enviado à API Quita+)
  // displayAmount = valor com juros simulados (exibido ao cliente)
  const originalAmount = charge.amount_cents; // SEMPRE o valor original da cobrança
  const displayAmount = selectedOption 
    ? (selectedOption.isCustom 
        ? customAmount 
        : selectedOption.isSelectInstallments 
          ? (selectResult?.totalCents || 0)
          : selectedOption.totalCents)
    : 0; // Zero quando nenhuma opção selecionada
  const finalInstallments = selectedOption
    ? (selectedOption.isCustom 
        ? customInstallments 
        : selectedOption.isSelectInstallments 
          ? selectInstallments
          : selectedOption.installments)
    : 0; // Zero quando nenhuma opção selecionada

  const handleCustomValueChange = (desiredValueCents: number) => {
    if (desiredValueCents === 0) {
      setCustomAmount(0);
      setCustomInstallments(1);
      setCustomResult(null);
      return;
    }

    if (!simulation?.simulation?.conditions) {
      toast({
        title: "Erro",
        description: "Não foi possível buscar opções de parcelamento.",
        variant: "destructive"
      });
      return;
    }

    const closest = findClosestInstallment(
      desiredValueCents,
      simulation.simulation.conditions
    );

    if (closest) {
      setCustomAmount(closest.totalAmount);
      setCustomInstallments(closest.installments);
      setCustomResult({
        installments: closest.installments,
        totalCents: closest.totalAmount,
        installmentValueCents: closest.installmentAmount
      });
    }
  };

  const handleSelectInstallmentsChange = (installments: number) => {
    console.log('[PaymentDirect] handleSelectInstallmentsChange:', { 
      installments, 
      hasSimulation: !!simulation,
      hasConditions: !!simulation?.simulation?.conditions,
      conditionsLength: simulation?.simulation?.conditions?.length 
    });

    if (!simulation?.simulation?.conditions) {
      console.error('[PaymentDirect] Sem conditions disponíveis!');
      toast({
        title: "Erro",
        description: "Não foi possível buscar opções de parcelamento.",
        variant: "destructive"
      });
      return;
    }

    const condition = simulation.simulation.conditions.find(c => c.installments === installments);
    console.log('[PaymentDirect] Condition encontrada:', condition);
    
    if (condition) {
      setSelectInstallments(installments);
      setSelectResult({
        installments: condition.installments,
        totalCents: condition.totalAmount,
        installmentValueCents: condition.installmentAmount
      });
      console.log('[PaymentDirect] Estados atualizados:', { 
        selectInstallments: installments, 
        selectResult: { installments: condition.installments, totalCents: condition.totalAmount }
      });
    } else {
      console.error('[PaymentDirect] Condition não encontrada para installments:', installments);
    }
  };

  return (
    <div className="min-h-screen bg-muted">
      {/* Header */}
      <div className="border-b border-border/40 bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 lg:px-6 py-4">
          <div className="flex items-center gap-3">
            <CreditCard className="w-5 h-5 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Escolha a melhor forma de pagamento
            </h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {charge.description || `Pagamento para ${charge.payer_name || 'Cliente'}`}
          </p>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-4 lg:px-6 py-6 lg:py-8">
        {/* Error Alert */}
        {simulationError && (
          <Alert variant="destructive" className="mb-6 rounded-xl">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Não foi possível simular as opções de parcelamento. Por favor, tente novamente.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 lg:gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          {/* Left Column: Payment Options */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground mb-4">
              Selecione o valor e as parcelas
            </h2>
            
            <div className="space-y-3">
              {paymentOptions.map((option) => (
                <CheckoutOptionCard
                  key={option.id}
                  option={option}
                  isSelected={selectedOption?.id === option.id}
                  onSelect={() => setSelectedOption(option)}
                  onCustomValueChange={handleCustomValueChange}
                  customResult={option.isCustom ? customResult : undefined}
                  onSelectInstallmentsChange={handleSelectInstallmentsChange}
                  selectResult={option.isSelectInstallments ? selectResult : undefined}
                  installmentConditions={option.isSelectInstallments ? simulation?.simulation?.conditions : undefined}
                />
              ))}
            </div>
          </section>

          {/* Right Column: Payment Form */}
          <section>
            <PaymentForm
              amount={originalAmount / 100}       // ✅ Valor ORIGINAL para API Quita+
              amountDisplay={displayAmount / 100} // Valor COM JUROS para exibição
              installments={finalInstallments}
              productName={charge.description || `Cobrança - ${charge.payer_name || 'Cliente'}`}
              onSuccess={handlePaymentSuccess}
              skipSplitCheck={true}
              disableSubmit={!selectedOption || isSimulating || (selectedOption?.isCustom && customAmount <= 0) || (selectedOption?.isSelectInstallments && selectInstallments <= 0)}
              initialPayerData={{
                name: charge.payer_name || '',
                email: charge.payer_email || '',
                document: charge.payer_document || '',
                phone: charge.payer_phone || '',
              }}
              chargeId={charge.charge_id || charge.id || ''}
              paymentLinkId={id || ''}
              hasBoleto={charge.has_boleto_link || false}
              boletoLinhaDigitavel={charge.boleto_linha_digitavel || ''}
              creditorDocument={charge.creditor_document || ''}
              creditorName={charge.creditor_name || ''}
            />
          </section>
        </div>

        {/* Security Info */}
        <div className="mt-8 text-center text-sm text-muted-foreground">
          <p>🔒 Pagamento 100% seguro e criptografado</p>
        </div>
      </div>
    </div>
  );
}