import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, CheckCircle2, Clock, Copy, QrCode, RefreshCw } from 'lucide-react';
// db client still needed for functions.invoke in createPixPayment and status check
import { db, functionsBaseUrl } from '@/integrations/firebase/client';
import { toast } from 'sonner';
import { ErrorBoundary } from '@/components/ErrorBoundary';

interface PixData {
  qr_code: string;
  qr_code_base64: string;
  ticket_url?: string;
  payment_id: string;
  status: string;
  expiration?: string;
  amount_cents: number;
}

interface ChargeData {
  id: string;
  amount: number;
  payer_name: string;
  payer_email: string;
  payer_document: string;
  description: string | null;
  checkout_link_id: string | null;
  status: string;
  fee_amount: number | null;
  payment_method: string | null;
}

const PIX_FEE_PERCENT = 0.015; // 1.5% fee

const formatCurrency = (cents: number): string => {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
};

function CheckoutPixContent() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [charge, setCharge] = useState<ChargeData | null>(null);
  const [pixData, setPixData] = useState<PixData | null>(null);
  const [splitId, setSplitId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);

  // Fetch charge data via public edge function (no RLS issues)
  useEffect(() => {
    async function fetchData() {
      if (!id) {
        setError('ID não fornecido');
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`${functionsBaseUrl}/public-payment-link?id=${encodeURIComponent(id)}`, {
          method: 'GET',
        });

        if (!response.ok) {
          console.error('public-payment-link error:', response.status);
          setError('Cobrança não encontrada');
          setLoading(false);
          return;
        }

        const checkoutData = await response.json();

        if (!checkoutData || checkoutData.error) {
          setError('Cobrança não encontrada');
          setLoading(false);
          return;
        }

        const chargeData: ChargeData = {
          id: checkoutData.charge_id || checkoutData.id,
          amount: checkoutData.amount_cents,
          payer_name: checkoutData.payer_name || 'Cliente',
          payer_email: checkoutData.payer_email || '',
          payer_document: checkoutData.payer_document || '',
          description: checkoutData.description || checkoutData.title || null,
          checkout_link_id: id,
          status: checkoutData.status || checkoutData.charge_status || 'pending',
          fee_amount: checkoutData.fee_amount ?? null,
          payment_method: checkoutData.payment_method ?? null,
        };

        // Check if already completed
        if (chargeData.status === 'completed') {
          navigate(`/thank-you?chargeId=${chargeData.id}&method=pix&amount=${chargeData.amount}`, { replace: true });
          return;
        }

        setCharge(chargeData);

        // Check if there's an existing PIX split (payment_splits has public read RLS)
        // Fetch ALL pix splits to find one with active QR or concluded status
        const { data: existingSplits } = await db
          .from('payment_splits')
          .select('*')
          .eq('charge_id', chargeData.id)
          .eq('method', 'pix')
          .order('created_at', { ascending: false });

        // Priority: 1) concluded split, 2) split with active QR (mp_payment_id + mp_status=ATIVA), 3) most recent
        const concludedSplit = existingSplits?.find(s => s.status === 'concluded' || s.pix_paid_at);
        const activeSplit = existingSplits?.find(s => s.mp_payment_id && s.mp_status === 'ATIVA');
        const existingSplit = concludedSplit || activeSplit || existingSplits?.[0] || null;

        if (existingSplit) {
          setSplitId(existingSplit.id);

          if (existingSplit.status === 'concluded' || existingSplit.pix_paid_at) {
            navigate(`/thank-you?chargeId=${chargeData.id}&method=pix&amount=${chargeData.amount}`, { replace: true });
            return;
          }

          // Validar se o display_amount_cents do split confere com 1.5%
          const expectedTotal = chargeData.amount + Math.round(chargeData.amount * PIX_FEE_PERCENT);
          const splitDisplayAmount = existingSplit.display_amount_cents || existingSplit.amount_cents;
          const isAmountCorrect = Math.abs(splitDisplayAmount - expectedTotal) <= 1;

          if (existingSplit.mp_payment_id && existingSplit.mp_qr_code && isAmountCorrect) {
            // Split com dados corretos - reaproveitar
            setPixData({
              payment_id: existingSplit.mp_payment_id,
              qr_code: existingSplit.mp_qr_code,
              qr_code_base64: existingSplit.mp_qr_code_base64 || '',
              ticket_url: existingSplit.mp_ticket_url || undefined,
              status: existingSplit.mp_status || 'pending',
              amount_cents: expectedTotal,
            });
          } else if (!isAmountCorrect) {
            // Split com taxa errada - limpar metadados para forçar regeneração
            console.warn('[CheckoutPix] Split com display_amount incorreto:', {
              atual: splitDisplayAmount,
              esperado: expectedTotal,
              diff: splitDisplayAmount - expectedTotal,
            });
            await db
              .from('payment_splits')
              .update({
                amount_cents: chargeData.amount,
                display_amount_cents: expectedTotal,
                mp_payment_id: null,
                mp_qr_code: null,
                mp_qr_code_base64: null,
                mp_status: null,
                mp_status_detail: null,
                mp_ticket_url: null,
                mp_date_of_expiration: null,
              })
              .eq('id', existingSplit.id);
            console.log('[CheckoutPix] Split corrigido, QR será regenerado');
          }
        }

        setLoading(false);
      } catch (err) {
        console.error('Error fetching data:', err);
        setError('Erro ao carregar dados');
        setLoading(false);
      }
    }

    fetchData();
  }, [id, navigate]);

  // Create PIX payment
  const createPixPayment = useCallback(async () => {
    if (!charge || pixData) return;

    setCreating(true);
    try {
      // charge.amount sempre armazena o valor BASE da dívida (sem taxa)
      // A taxa de 1.5% é calculada aqui no checkout
      const baseCents = charge.amount;
      const feeCents = Math.round(baseCents * PIX_FEE_PERCENT);
      const totalCents = baseCents + feeCents;

      // Reuse existing split or create new one — prevents duplicates
      let currentSplitId = splitId;

      if (!currentSplitId) {
        // Double-check: look for any existing pending pix split with QR for this charge
        const { data: existingPix } = await db
          .from('payment_splits')
          .select('id, mp_payment_id')
          .eq('charge_id', charge.id)
          .eq('method', 'pix')
          .eq('status', 'pending')
          .not('mp_payment_id', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1);

        if (existingPix?.[0]) {
          console.log('[CheckoutPix] Reusing existing split with QR:', existingPix[0].id);
          currentSplitId = existingPix[0].id;
          setSplitId(currentSplitId);
        } else {
          const { data: newSplit, error: splitError } = await db
            .from('payment_splits')
            .insert({
              charge_id: charge.id,
              method: 'pix',
              amount_cents: baseCents,
              display_amount_cents: totalCents,
              status: 'pending',
            })
            .select('id')
            .single();

          if (splitError || !newSplit) {
            console.error('Error creating split:', splitError);
            setError('Erro ao criar pagamento');
            setCreating(false);
            return;
          }

          currentSplitId = newSplit.id;
          setSplitId(currentSplitId);
        }
      }

      // Create PIX payment via Mercado Pago
      const { data, error: createError } = await db.functions.invoke('treeal-pix-create', {
        body: {
          payment_split_id: currentSplitId,
          charge_id: charge.id,
          amount_cents: totalCents,
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
          amount_cents: totalCents,
        });
      } else {
        setError(data.error || 'Erro ao criar pagamento PIX');
      }
    } catch (err) {
      console.error('Error creating PIX:', err);
      setError('Erro ao conectar com o serviço de pagamento');
    } finally {
      setCreating(false);
    }
  }, [charge, pixData, splitId]);

  // Create PIX after charge is loaded
  useEffect(() => {
    if (charge && !pixData && !creating && !error) {
      createPixPayment();
    }
  }, [charge, pixData, creating, error, createPixPayment]);

  // Poll for payment status
  useEffect(() => {
    if (!pixData || !splitId || pixData.status === 'approved') return;

    const checkStatus = async () => {
      try {
        const { data, error: statusError } = await db.functions.invoke('treeal-pix-status', {
          body: {
            payment_split_id: splitId,
          },
        });

        if (statusError) {
          console.error('Error checking status:', statusError);
          return;
        }

        if (data.pix_paid) {
          toast.success('Pagamento PIX confirmado!');
          navigate(`/thank-you?chargeId=${charge?.id}&method=pix&amount=${charge?.amount}`, { replace: true });
        }
      } catch (err) {
        console.error('Error polling status:', err);
      }
    };

    const interval = setInterval(checkStatus, 5000);
    return () => clearInterval(interval);
  }, [pixData, splitId, charge, navigate]);

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
    if (!splitId) return;

    setChecking(true);
    try {
      const { data, error: statusError } = await db.functions.invoke('treeal-pix-status', {
        body: {
          payment_split_id: splitId,
        },
      });

      if (statusError) {
        toast.error('Erro ao verificar status');
        return;
      }

      if (data.pix_paid) {
        toast.success('Pagamento confirmado!');
        navigate(`/thank-you?chargeId=${charge?.id}&method=pix&amount=${charge?.amount}`, { replace: true });
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

export default function CheckoutPix() {
  return (
    <ErrorBoundary>
      <CheckoutPixContent />
    </ErrorBoundary>
  );
}
