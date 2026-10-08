import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, CheckCircle2, Clock, Copy, QrCode, RefreshCw } from 'lucide-react';
import { db } from '@/integrations/firebase/client';
import { toast } from 'sonner';

interface PixData {
  qr_code: string;
  qr_code_base64: string;
  ticket_url?: string;
  payment_id: string;
  status: string;
  expiration?: string;
  amount_cents: number;
}

interface PaymentSplit {
  id: string;
  charge_id: string | null;
  payment_link_id: string | null;
  amount_cents: number;
  display_amount_cents: number | null;
  method: string;
  status: string;
  mp_payment_id: string | null;
  mp_qr_code: string | null;
  mp_qr_code_base64: string | null;
  mp_ticket_url: string | null;
  mp_status: string | null;
  pix_paid_at: string | null;
}

interface ChargeData {
  id: string;
  amount: number;
  payer_name: string;
  payer_email: string;
  payer_document: string;
  description: string | null;
}

const PIX_FEE_PERCENT = 0.015;

const formatCurrency = (cents: number): string => {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
};

export default function PaymentPix() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [split, setSplit] = useState<PaymentSplit | null>(null);
  const [allSplits, setAllSplits] = useState<PaymentSplit[]>([]); // Store all splits for redirect logic
  const [charge, setCharge] = useState<ChargeData | null>(null);
  const [pixData, setPixData] = useState<PixData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [resolvedSplitId, setResolvedSplitId] = useState<string | null>(null);
  const [paymentLinkId, setPaymentLinkId] = useState<string | null>(null);

  // Fetch split and charge data using public edge function (bypasses RLS)
  useEffect(() => {
    async function fetchData() {
      if (!id) {
        setError('ID não fornecido');
        setLoading(false);
        return;
      }

      try {
        console.log('PaymentPix: Fetching data for id:', id);

        // Use public edge function that bypasses RLS
        const { data, error: fetchError } = await db.functions.invoke('public-payment-splits', {
          body: { id }
        });

        if (fetchError) {
          console.error('PaymentPix: Error fetching data via edge function:', fetchError);
          
          // Check for specific error types
          if (fetchError.message?.includes('401') || fetchError.message?.includes('403')) {
            setError('Erro de autenticação. Link público não autorizado.');
          } else if (fetchError.message?.includes('404')) {
            setError('Serviço de pagamento não encontrado.');
          } else {
            setError('Erro ao carregar dados do pagamento');
          }
          setLoading(false);
          return;
        }

        if (!data) {
          console.error('PaymentPix: No data returned from edge function');
          setError('Pagamento não encontrado');
          setLoading(false);
          return;
        }

        console.log('PaymentPix: Data received:', { 
          splitsCount: data.payment_splits?.length,
          hasCharge: !!data.charge,
          hasPaymentLink: !!data.payment_link
        });

        // Find PIX split from the returned data
        const splits = data.payment_splits || [];
        const pixSplit = splits.find((s: any) => s.method === 'pix');

        if (!pixSplit) {
          console.error('PaymentPix: PIX split not found in returned data');
          setError('Pagamento PIX não encontrado');
          setLoading(false);
          return;
        }

        // Store all splits for later use in redirect logic
        setAllSplits(splits as PaymentSplit[]);
        setPaymentLinkId(data.payment_link?.id || null);

        setSplit(pixSplit as PaymentSplit);
        setResolvedSplitId(pixSplit.id);

        // Check if already paid
        if (pixSplit.status === 'concluded' || pixSplit.pix_paid_at) {
          // Check for pending card split in the same response
          const cardSplit = splits.find(
            (s: any) => s.method === 'credit_card' && s.status === 'pending'
          );

          if (cardSplit) {
            // Use payment_link.id instead of split.id for correct routing
            navigate(`/payment-card/${data.payment_link?.id || id}`, { replace: true });
          } else {
            navigate(`/thank-you?pl=${data.payment_link?.id || pixSplit.charge_id}`, { replace: true });
          }
          return;
        }

        // Set charge data for PIX creation
        if (data.charge) {
          setCharge({
            id: data.charge.id,
            amount: data.charge.amount,
            payer_name: data.charge.payer_name,
            payer_email: data.charge.payer_email,
            payer_document: data.charge.payer_document,
            description: data.payment_link?.description || data.charge.description || null,
          });
        }

        // If we already have MP data, validate amount before reusing
        if (pixSplit.mp_payment_id && pixSplit.mp_qr_code && pixSplit.mp_qr_code_base64) {
          const splitDisplayAmount = pixSplit.display_amount_cents || pixSplit.amount_cents;
          
          // For combined payments, validate against split's own amount_cents
          // For pure PIX, validate against charge amount + 1.5%
          const baseForValidation = pixSplit.amount_cents;
          const expectedTotal = baseForValidation + Math.round(baseForValidation * PIX_FEE_PERCENT);
          const isAmountCorrect = Math.abs(splitDisplayAmount - expectedTotal) <= 1;

          if (isAmountCorrect) {
            setPixData({
              payment_id: pixSplit.mp_payment_id,
              qr_code: pixSplit.mp_qr_code,
              qr_code_base64: pixSplit.mp_qr_code_base64,
              ticket_url: pixSplit.mp_ticket_url || undefined,
              status: pixSplit.mp_status || 'pending',
              amount_cents: expectedTotal,
            });
          } else {
            // Split com taxa errada - limpar para forçar regeneração
            console.warn('[PaymentPix] Split com display_amount incorreto:', {
              atual: splitDisplayAmount,
              esperado: expectedTotal,
            });
            const { error: updateErr } = await db
              .from('payment_splits')
              .update({
                display_amount_cents: expectedTotal,
                mp_payment_id: null,
                mp_qr_code: null,
                mp_qr_code_base64: null,
                mp_status: null,
                mp_status_detail: null,
                mp_ticket_url: null,
                mp_date_of_expiration: null,
              })
              .eq('id', pixSplit.id);
            if (updateErr) console.error('[PaymentPix] Error fixing split:', updateErr);
          }
        }

        setLoading(false);
      } catch (err) {
        console.error('PaymentPix: Unexpected error:', err);
        setError('Erro ao carregar dados do pagamento');
        setLoading(false);
      }
    }

    fetchData();
  }, [id, navigate]);

  // Create PIX payment if needed
  const createPixPayment = useCallback(async () => {
    if (!split || !charge || pixData) return;

    setCreating(true);
    try {
      // Calcular valor correto com 1.5% de taxa
      const baseCents = split.amount_cents;
      const expectedTotal = baseCents + Math.round(baseCents * PIX_FEE_PERCENT);
      const amountCents = expectedTotal;

      const { data, error: createError } = await db.functions.invoke('treeal-pix-create', {
        body: {
          payment_split_id: split.id,
          charge_id: split.charge_id,
          amount_cents: amountCents,
          payer_name: charge.payer_name,
          payer_email: charge.payer_email,
          payer_document: charge.payer_document,
          description: charge.description || 'Pagamento via PIX - Autonegocie',
        },
      });

      if (createError) {
        console.error('Error creating PIX:', createError);
        toast.error('Erro ao gerar QR Code PIX');
        setError('Erro ao gerar QR Code. Tente novamente.');
        return;
      }

      if (data.success) {
        setPixData({
          payment_id: data.payment_id,
          qr_code: data.qr_code,
          qr_code_base64: data.qr_code_base64,
          ticket_url: data.ticket_url,
          status: data.status,
          expiration: data.expiration,
          amount_cents: amountCents,
        });
      } else {
        setError(data.error || 'Erro ao criar pagamento PIX');
      }
    } catch (err) {
      console.error('Error creating PIX payment:', err);
      setError('Erro ao conectar com o serviço de pagamento');
    } finally {
      setCreating(false);
    }
  }, [split, charge, pixData]);

  // Create PIX after charge data is loaded
  useEffect(() => {
    if (split && charge && !pixData && !creating && !error) {
      createPixPayment();
    }
  }, [split, charge, pixData, creating, error, createPixPayment]);

  // Poll for payment status
  useEffect(() => {
    if (!pixData || pixData.status === 'approved') return;

    const checkStatus = async () => {
      try {
        const splitIdToCheck = resolvedSplitId || split?.id;
        if (!splitIdToCheck) return;

        const { data, error: statusError } = await db.functions.invoke('treeal-pix-status', {
          body: {
            payment_split_id: splitIdToCheck,
          },
        });

        if (statusError) {
          console.error('Error checking status:', statusError);
          return;
        }

        if (data.pix_paid) {
          toast.success('Pagamento PIX confirmado!');
          
          // Use already loaded splits to find pending card payment (avoids RLS issues)
          const cardSplit = allSplits.find(
            s => s.id !== splitIdToCheck && s.method === 'credit_card' && s.status === 'pending'
          );
          
          if (cardSplit) {
            // Use paymentLinkId instead of split.id for correct routing
            navigate(`/payment-card/${paymentLinkId || id}`, { replace: true });
          } else {
            navigate(`/thank-you?pl=${paymentLinkId || split?.charge_id}`, { replace: true });
          }
        }
      } catch (err) {
        console.error('Error polling status:', err);
      }
    };

    const interval = setInterval(checkStatus, 5000); // Check every 5 seconds
    return () => clearInterval(interval);
  }, [pixData, resolvedSplitId, split, allSplits, paymentLinkId, navigate]);

  const handleCopyCode = async () => {
    if (!pixData?.qr_code) return;

    try {
      await navigator.clipboard.writeText(pixData.qr_code);
      setCopied(true);
      toast.success('Código PIX copiado!');
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      toast.error('Erro ao copiar código');
    }
  };

  const handleCheckStatus = async () => {
    setChecking(true);
    try {
      const splitIdToCheck = resolvedSplitId || split?.id;
      if (!splitIdToCheck) {
        toast.error('ID do pagamento não encontrado');
        return;
      }

      const { data, error: statusError } = await db.functions.invoke('treeal-pix-status', {
        body: {
          payment_split_id: splitIdToCheck,
        },
      });

      if (statusError) {
        toast.error('Erro ao verificar status');
        return;
      }

      if (data.pix_paid) {
        toast.success('Pagamento confirmado!');
        
        // Use already loaded splits to find pending card payment (avoids RLS issues)
        const cardSplit = allSplits.find(
          s => s.id !== splitIdToCheck && s.method === 'credit_card' && s.status === 'pending'
        );
        
        if (cardSplit) {
          // Use paymentLinkId instead of split.id for correct routing
          navigate(`/payment-card/${paymentLinkId || id}`, { replace: true });
        } else {
          navigate(`/thank-you?pl=${paymentLinkId || split?.charge_id}`, { replace: true });
        }
      } else {
        toast.info('Aguardando pagamento...');
      }
    } catch (err) {
      toast.error('Erro ao verificar status');
    } finally {
      setChecking(false);
    }
  };

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center p-4">
        <Card className="max-w-lg w-full p-6 space-y-4">
          <Skeleton className="h-8 w-48 mx-auto" />
          <Skeleton className="h-64 w-64 mx-auto rounded-xl" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-10 w-full" />
        </Card>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center p-4">
        <Card className="max-w-lg w-full p-6 text-center space-y-4">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-destructive/10 mx-auto">
            <AlertCircle className="w-7 h-7 text-destructive" />
          </div>
          <h1 className="text-xl font-semibold">Erro no Pagamento</h1>
          <p className="text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Tentar novamente
          </Button>
        </Card>
      </div>
    );
  }

  // Creating PIX state
  if (creating || !pixData) {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center p-4">
        <Card className="max-w-lg w-full p-6 text-center space-y-4">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10 mx-auto animate-pulse">
            <QrCode className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-xl font-semibold">Gerando QR Code PIX...</h1>
          <p className="text-muted-foreground">Aguarde enquanto preparamos seu pagamento</p>
          <div className="flex justify-center">
            <RefreshCw className="w-6 h-6 animate-spin text-primary" />
          </div>
        </Card>
      </div>
    );
  }

  const displayAmount = pixData.amount_cents;

  return (
    <div className="min-h-screen bg-muted flex items-center justify-center p-4">
      <Card className="max-w-lg w-full p-6 lg:p-8 rounded-2xl shadow-md space-y-6">
        {/* Header */}
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10 mb-4">
            <QrCode className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-semibold text-foreground mb-2">Pagamento via PIX</h1>
          <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-amber-300">
            <Clock className="w-3 h-3 mr-1" />
            Aguardando Pagamento
          </Badge>
        </div>

        {/* Amount */}
        <div className="text-center py-4 bg-muted rounded-xl">
          <p className="text-sm text-muted-foreground mb-1">Valor a pagar</p>
          <p className="text-3xl font-bold text-primary">{formatCurrency(displayAmount)}</p>
        </div>

        {/* QR Code */}
        <div className="flex justify-center">
          <div className="bg-white p-4 rounded-2xl shadow-sm border">
            <img
              src={pixData.qr_code_base64.startsWith('data:') 
                ? pixData.qr_code_base64 
                : `data:image/png;base64,${pixData.qr_code_base64}`}
              alt="QR Code PIX"
              className="w-56 h-56 sm:w-64 sm:h-64"
            />
          </div>
        </div>

        {/* Copy Code Button */}
        <div className="space-y-3">
          <Button
            onClick={handleCopyCode}
            variant="outline"
            className="w-full h-12 text-base"
          >
            {copied ? (
              <>
                <CheckCircle2 className="w-5 h-5 mr-2 text-green-600" />
                Código copiado!
              </>
            ) : (
              <>
                <Copy className="w-5 h-5 mr-2" />
                Copiar código PIX
              </>
            )}
          </Button>
        </div>

        {/* Instructions */}
        <div className="bg-muted/50 rounded-xl p-4 space-y-2">
          <h3 className="font-medium text-sm">Como pagar:</h3>
          <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
            <li>Abra o app do seu banco</li>
            <li>Escolha pagar com PIX</li>
            <li>Escaneie o QR Code ou copie o código</li>
            <li>Confirme o pagamento</li>
          </ol>
        </div>

        {/* Check Status Button */}
        <Button
          onClick={handleCheckStatus}
          disabled={checking}
          className="w-full h-12"
        >
          {checking ? (
            <>
              <RefreshCw className="w-5 h-5 mr-2 animate-spin" />
              Verificando...
            </>
          ) : (
            <>
              <RefreshCw className="w-5 h-5 mr-2" />
              Já paguei - Verificar status
            </>
          )}
        </Button>

        {/* Auto-check info */}
        <p className="text-xs text-center text-muted-foreground">
          O status é verificado automaticamente a cada 5 segundos
        </p>
      </Card>
    </div>
  );
}
