import { useState, useEffect, useRef } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { CheckCircle, ArrowLeft, History, Printer, RefreshCw, Calendar, Download, QrCode, CreditCard, Phone, Mail, Building2, XCircle, AlertTriangle, Clock } from "lucide-react";
import { db, functionsBaseUrl } from '@/integrations/firebase/client';
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useToast } from "@/hooks/use-toast";

const useDocumentTitle = (title: string) => {
  useEffect(() => {
    document.title = title;
    
    const metaRobots = document.querySelector('meta[name="robots"]') as HTMLMetaElement;
    if (metaRobots) {
      metaRobots.content = 'noindex,nofollow';
    } else {
      const meta = document.createElement('meta');
      meta.name = 'robots';
      meta.content = 'noindex,nofollow';
      document.head.appendChild(meta);
    }
    
    document.documentElement.lang = 'pt-BR';
  }, [title]);
};

interface ThankYouData {
  paid: boolean;
  processing?: boolean;
  analyzing?: boolean;
  failed?: boolean;
  failedMethod?: string;
  failedMethodLabel?: string;
  message?: string;
  charge?: {
    id: string;
    type: string;
    total_amount_cents: number;
    total_paid_cents?: number;
    total_confirmed_cents?: number;
    total_analyzing_cents?: number;
    currency: string;
    paid: boolean;
    analyzing?: boolean;
    paid_at?: string;
    submitted_at?: string;
  };
  splits?: Array<{
    id: string;
    method: string;
    amount_cents: number;
    status: string;
    processed_at?: string;
  }>;
  transactions?: Array<{
    id: string;
    created_at: string;
    amount_cents: number;
    method: string;
    transaction_id: string;
  }>;
  recurrence?: {
    next_dates: string[];
  };
  company?: {
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  ui?: {
    return_url?: string;
    support_email: string;
  };
}

const analyticsLocal = {
  track: (event: string, data: any) => {
    console.log(`Analytics: ${event}`, data);
  }
};

export default function ThankYou() {
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const [data, setData] = useState<ThankYouData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [isDownloadingPDF, setIsDownloadingPDF] = useState(false);
  
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutTimerRef = useRef<NodeJS.Timeout | null>(null);

  const token = searchParams.get('pl');
  const chargeIdParam = searchParams.get('chargeId') || searchParams.get('charge');
  const methodParam = searchParams.get('method');
  const amountParam = searchParams.get('amount');
  const payerNameParam = searchParams.get('payerName');
  const paidAtParam = searchParams.get('paidAt');

  useDocumentTitle('Pagamento Confirmado - Sistema de Cobrança');

  // Dados fictícios para demonstração (PIX + Cartão)
  const DEMO_COMBINED_DATA: ThankYouData = {
    paid: true,
    message: 'Obrigado! Seu pagamento combinado foi processado com sucesso.',
    charge: {
      id: 'demo-abc12345-6789-pix-card',
      type: 'cartao_pix',
      total_amount_cents: 150000, // R$ 1.500,00
      total_paid_cents: 150000,
      currency: 'BRL',
      paid: true,
      paid_at: new Date().toISOString(),
    },
    splits: [
      {
        id: 'split-pix-demo-001',
        method: 'PIX',
        amount_cents: 50000, // R$ 500,00
        status: 'concluded',
        processed_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(), // 5 min atrás
      },
      {
        id: 'split-card-demo-002',
        method: 'CREDIT_CARD',
        amount_cents: 100000, // R$ 1.000,00
        status: 'concluded',
        processed_at: new Date().toISOString(),
      }
    ],
    transactions: [
      {
        id: 'txn-pix-demo-001',
        created_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
        amount_cents: 50000,
        method: 'PIX',
        transaction_id: 'E60746948202501091234abcdef123456',
      },
      {
        id: 'txn-card-demo-002',
        created_at: new Date().toISOString(),
        amount_cents: 100000,
        method: 'CREDIT_CARD',
        transaction_id: 'AUTH-789456123',
      }
    ],
    company: {
      name: 'Autonegocie Soluções LTDA',
      email: 'contato@autonegocie.com.br',
      phone: '(11) 98765-4321',
    },
    ui: {
      return_url: '/',
      support_email: 'suporte@autonegocie.com.br',
    }
  };

  const loadData = async () => {
    // Modo demo - dados fictícios para demonstração
    const demoParam = searchParams.get('demo');
    if (demoParam === 'combined') {
      setData(DEMO_COMBINED_DATA);
      setLoading(false);
      return;
    }

    // Montar query params para a edge function
    const queryParams = new URLSearchParams();
    if (token) queryParams.set('pl', token);
    if (chargeIdParam) queryParams.set('chargeId', chargeIdParam);
    if (methodParam) queryParams.set('method', methodParam);
    if (amountParam) queryParams.set('amount', amountParam);
    if (payerNameParam) queryParams.set('payerName', payerNameParam);
    if (paidAtParam) queryParams.set('paidAt', paidAtParam);
    
    // Se não tem nenhum parâmetro útil, exibir mensagem genérica
    if (!token && !chargeIdParam && !amountParam) {
      setData({
        paid: true,
        message: 'Pagamento confirmado com sucesso!'
      });
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      
      const functionUrl = `${functionsBaseUrl}/thank-you-summary?${queryParams.toString()}`;
      const response = await fetch(functionUrl, {
        method: 'GET',
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      setData(data);
      
      if (data.paid && data.charge) {
        analyticsLocal.track('thank_you.view', {
          charge_id: data.charge.id,
          total: data.charge.total_paid_cents,
          methods: data.splits?.map((s: any) => s.method) || []
        });
      }
    } catch (err) {
      console.error('Error loading thank you data:', err);
      setError('Erro ao carregar dados do pagamento');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    };
  }, [token]);

  useEffect(() => {
    if (data?.processing && !data?.paid && retryCount < 3) {
      console.log(`[ThankYou] Auto-retry ${retryCount + 1}/3 in 3s...`);
      
      retryTimerRef.current = setTimeout(() => {
        setRetryCount(prev => prev + 1);
        loadData();
      }, 3000);
    }
    
    if (data?.processing && !data?.paid && retryCount === 0) {
      timeoutTimerRef.current = setTimeout(() => {
        console.log('[ThankYou] Timeout reached (30s)');
        setError('O pagamento está demorando mais do que o esperado. Por favor, entre em contato com o suporte.');
      }, 30000);
    }
    
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [data, retryCount]);

  const formatCurrency = (amountCents: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(amountCents / 100);
  };

  const formatDate = (dateString: string) => {
    return format(new Date(dateString), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
  };

  const getMethodBadgeVariant = (method: string) => {
    switch (method.toUpperCase()) {
      case 'PIX': return 'success';
      case 'CARD': return 'info';
      case 'CREDIT_CARD': return 'info';
      case 'QUITA': return 'outline';
      default: return 'outline';
    }
  };

  const getMethodLabel = (method: string) => {
    switch (method.toUpperCase()) {
      case 'PIX': return 'PIX';
      case 'CARD': return 'Cartão';
      case 'CREDIT_CARD': return 'Cartão';
      case 'QUITA': return 'Quita+';
      default: return method;
    }
  };

  const handlePrint = () => {
    analyticsLocal.track('thank_you.print', {
      charge_id: data?.charge?.id,
      total: data?.charge?.total_paid_cents
    });
    window.print();
  };

  const handleDownloadPDF = async () => {
    setIsDownloadingPDF(true);
    
    try {
      analyticsLocal.track('thank_you.download_pdf', {
        charge_id: data?.charge?.id,
        total: data?.charge?.total_paid_cents
      });

      const html2pdf = (await import('html2pdf.js')).default;
      
      const element = document.getElementById('comprovante-container');
      if (!element) {
        throw new Error('Elemento do comprovante não encontrado');
      }

      const opt = {
        margin: 10,
        filename: `comprovante-${data?.charge?.id.slice(0, 8)}.pdf`,
        image: { type: 'jpeg' as const, quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as const }
      };

      await html2pdf().set(opt).from(element).save();
      
      toast({
        title: "PDF gerado!",
        description: "O comprovante foi baixado com sucesso.",
      });
    } catch (err) {
      console.error('Error generating PDF:', err);
      toast({
        title: "Erro ao gerar PDF",
        description: "Não foi possível gerar o PDF. Tente usar a opção de imprimir.",
        variant: "destructive",
      });
    } finally {
      setIsDownloadingPDF(false);
    }
  };

  // Helper para buscar split por método
  const getPixSplit = () => data?.splits?.find(s => s.method.toUpperCase() === 'PIX');
  const getCardSplit = () => data?.splits?.find(s => s.method.toUpperCase() === 'CREDIT_CARD' || s.method.toUpperCase() === 'CARD');

  if (loading) {
    return (
      <div className="min-h-screen bg-ds-bg-body flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
          <p className="text-ds-text-muted">Carregando dados do pagamento...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-ds-bg-body flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-destructive mb-4">{error}</p>
            <Button onClick={() => window.location.href = '/'}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Voltar ao início
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ✅ TELA DE ERRO: Pagamento não aprovado
  if (!data?.paid && data?.failed) {
    const methodLabel = data.failedMethodLabel || 
      (data.failedMethod === 'credit_card' ? 'Cartão de Crédito' : 
       data.failedMethod === 'pix' ? 'PIX' : 'Pagamento');
    
    return (
      <div className="min-h-screen bg-ds-bg-body flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <div className="w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <XCircle className="h-8 w-8 text-destructive" />
            </div>
            <h2 className="text-xl font-semibold mb-2 text-ds-text-strong">
              Pagamento Não Aprovado
            </h2>
            <p className="text-ds-text-muted mb-4">
              Infelizmente seu pagamento via <strong>{methodLabel}</strong> não foi aprovado.
            </p>
            
            <div className="bg-muted/50 rounded-lg p-4 mb-6 text-left">
              <p className="text-sm font-medium text-ds-text-strong mb-2 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Isso pode acontecer por:
              </p>
              <ul className="text-sm text-ds-text-muted space-y-1 ml-6 list-disc">
                <li>Saldo ou limite insuficiente</li>
                <li>Cartão bloqueado ou vencido</li>
                <li>Tempo de sessão expirado</li>
                <li>Dados do cartão incorretos</li>
              </ul>
            </div>
            
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button onClick={() => window.history.back()} variant="default">
                <RefreshCw className="h-4 w-4 mr-2" />
                Tentar Novamente
              </Button>
              <Button asChild variant="outline">
                <Link to="/">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Voltar ao Início
                </Link>
              </Button>
            </div>
            
            {data?.ui?.support_email && (
              <p className="text-xs text-ds-text-muted mt-6">
                Precisa de ajuda? Entre em contato: {data.ui.support_email}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // ✅ NOVO: TELA DE ANÁLISE - Pagamento recebido, aguardando confirmação
  if (!data?.paid && data?.analyzing) {
    const pixSplitAnalysis = data?.splits?.find(s => s.method.toUpperCase() === 'PIX');
    const cardSplitAnalysis = data?.splits?.find(s => 
      s.method.toUpperCase() === 'CREDIT_CARD' || s.method.toUpperCase() === 'CARD'
    );
    
    return (
      <div className="min-h-screen bg-muted">
        <div id="comprovante-container" className="container mx-auto py-8 px-4 max-w-4xl">
          {/* Header com ícone de análise */}
          <div className="text-center mb-8">
            <div className="w-20 h-20 bg-amber-100 dark:bg-amber-950/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <Clock className="h-10 w-10 text-amber-600" />
            </div>
            <h1 className="text-3xl font-bold text-amber-600 mb-2">
              Pagamento em Análise
            </h1>
            <p className="text-muted-foreground max-w-md mx-auto">
              Seu pagamento foi recebido e está em análise. Assim que ele for confirmado, você será notificado no email cadastrado.
            </p>
          </div>

          {/* Resumo da Transação */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Resumo da Transação</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Total */}
              <div className="flex justify-between items-center">
                <span className="font-medium text-muted-foreground">Valor Total:</span>
                <span className="text-2xl font-bold text-foreground">
                  {formatCurrency(data?.charge?.total_amount_cents || 0)}
                </span>
              </div>

              <Separator />

              {/* Detalhamento por método */}
              <div className="space-y-3">
                {/* PIX (se existir e estiver pago) */}
                {pixSplitAnalysis && pixSplitAnalysis.status === 'CONCLUDED' && (
                  <div className="flex justify-between items-center p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg border border-emerald-200 dark:border-emerald-800">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="h-5 w-5 text-emerald-600" />
                      <span className="font-medium">PIX</span>
                    </div>
                    <div className="text-right flex items-center gap-2">
                      <Badge variant="success">Pago</Badge>
                      <span className="font-medium text-emerald-600">
                        {formatCurrency(pixSplitAnalysis.amount_cents)}
                      </span>
                    </div>
                  </div>
                )}
                
                {/* Cartão (em análise) */}
                {cardSplitAnalysis && cardSplitAnalysis.status === 'ANALYZING' && (
                  <div className="flex justify-between items-center p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800">
                    <div className="flex items-center gap-2">
                      <Clock className="h-5 w-5 text-amber-600 animate-pulse" />
                      <span className="font-medium">Cartão de Crédito</span>
                    </div>
                    <div className="text-right flex items-center gap-2">
                      <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
                        Em Análise
                      </Badge>
                      <span className="font-medium text-amber-600">
                        {formatCurrency(cardSplitAnalysis.amount_cents)}
                      </span>
                    </div>
                  </div>
                )}
                
                {/* Caso seja apenas cartão em análise (sem PIX) */}
                {!pixSplitAnalysis && cardSplitAnalysis && cardSplitAnalysis.status === 'ANALYZING' && (
                  <div className="flex justify-between items-center p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800">
                    <div className="flex items-center gap-2">
                      <Clock className="h-5 w-5 text-amber-600 animate-pulse" />
                      <span className="font-medium">Cartão de Crédito</span>
                    </div>
                    <div className="text-right flex items-center gap-2">
                      <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
                        Em Análise
                      </Badge>
                      <span className="font-medium text-amber-600">
                        {formatCurrency(cardSplitAnalysis.amount_cents)}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <Separator />

              {/* Informação importante */}
              <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <p className="text-sm text-blue-800 dark:text-blue-200 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <span>
                    O pagamento via cartão está sendo analisado pela operadora.
                    Você receberá um email de confirmação em até 24 horas.
                    <strong className="block mt-1">Não é necessário realizar o pagamento novamente.</strong>
                  </span>
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Botões */}
          <div className="flex flex-col sm:flex-row gap-3 justify-center print:hidden">
            <Button onClick={handlePrint} variant="outline">
              <Printer className="h-4 w-4 mr-2" />
              Imprimir
            </Button>
            <Button onClick={handleDownloadPDF} variant="outline" disabled={isDownloadingPDF}>
              {isDownloadingPDF ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              Baixar PDF
            </Button>
            <Button asChild>
              <Link to="/">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Voltar ao Início
              </Link>
            </Button>
          </div>
          
          {/* Suporte */}
          <div className="mt-8 text-center text-sm text-muted-foreground">
            <p>Precisa de ajuda? Entre em contato:</p>
            <p className="flex items-center justify-center gap-1 mt-1">
              <Mail className="h-3 w-3" />
              {data?.ui?.support_email || 'faleconosco@autonegocie.com'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Tela de processamento
  if (!data?.paid && data?.processing) {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
            <h2 className="text-xl font-semibold mb-2 text-foreground">Pagamento em processamento</h2>
            <p className="text-muted-foreground mb-4">
              Estamos confirmando seu pagamento. Isso pode levar alguns segundos.
            </p>
            <Button onClick={loadData}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Atualizar
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const pixSplit = getPixSplit();
  const cardSplit = getCardSplit();

  return (
    <div className="min-h-screen bg-ds-bg-body">
      <div id="comprovante-container" className="container mx-auto py-8 px-4 max-w-4xl">
        {/* Header */}
        <div className="text-center mb-8 print:mb-4">
          <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="h-10 w-10 text-primary print:h-8 print:w-8" />
          </div>
          <h1 className="text-3xl font-bold text-primary mb-2 print:text-xl">
            Pagamento Confirmado!
          </h1>
          <p className="text-ds-text-muted print:text-xs">
            {data?.message || 'Obrigado! Seu pagamento foi processado com sucesso.'}
          </p>
        </div>

        {/* Resumo Principal */}
        {data?.charge && (
          <Card className="mb-6 print:shadow-none">
            <CardHeader className="print:pb-2">
              <CardTitle className="print:text-lg">Resumo da Transação</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 print:space-y-2">
              <div className="flex justify-between items-center">
                <span className="font-medium text-ds-text-muted print:text-sm">Valor Total Pago:</span>
                <span className="text-2xl font-bold text-primary print:text-lg">
                  {formatCurrency(data?.charge?.total_paid_cents || 0)}
                </span>
              </div>

              <div className="flex justify-between items-center print:text-sm">
                <span className="text-ds-text-muted">Data/Hora:</span>
                <span className="text-ds-text-default">{data?.charge?.paid_at ? formatDate(data.charge.paid_at) : '-'}</span>
              </div>

              <div className="flex justify-between items-center print:text-sm">
                <span className="text-ds-text-muted">ID da Cobrança:</span>
                <span className="font-mono text-xs bg-ds-bg-surface-alt px-2 py-1 rounded">
                  {data?.charge?.id.slice(0, 8)}...
                </span>
              </div>

              <div className="flex justify-between items-start print:text-sm">
                <span className="text-ds-text-muted">Meios Utilizados:</span>
                <div className="flex flex-wrap gap-1">
                  {data?.splits?.map((split) => (
                    <Badge 
                      key={split.id} 
                      variant={getMethodBadgeVariant(split.method) as any}
                      className="print:text-xs print:px-1 print:py-0"
                    >
                      {getMethodLabel(split.method)}
                    </Badge>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Comprovante PIX */}
        {pixSplit && (
          <Card className="mb-6 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 print:shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-emerald-700 dark:text-emerald-400 text-base flex items-center gap-2">
                <QrCode className="h-4 w-4" />
                Comprovante PIX
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span className="text-ds-text-muted">Valor:</span>
                <span className="font-bold text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(pixSplit.amount_cents)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-ds-text-muted">Data/Hora:</span>
                <span>{pixSplit.processed_at ? formatDate(pixSplit.processed_at) : '-'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ds-text-muted">Status:</span>
                <Badge variant="success" className="text-xs">
                  {pixSplit.status}
                </Badge>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Comprovante Cartão */}
        {cardSplit && (
          <Card className="mb-6 bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 print:shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-blue-700 dark:text-blue-400 text-base flex items-center gap-2">
                <CreditCard className="h-4 w-4" />
                Comprovante Cartão de Crédito
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span className="text-ds-text-muted">Valor:</span>
                <span className="font-bold text-blue-600 dark:text-blue-400">
                  {formatCurrency(cardSplit.amount_cents)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-ds-text-muted">Data/Hora:</span>
                <span>{cardSplit.processed_at ? formatDate(cardSplit.processed_at) : '-'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ds-text-muted">Status:</span>
                <Badge variant="info" className="text-xs">
                  {cardSplit.status}
                </Badge>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Próximas Cobranças (Recorrente) */}
        {data?.recurrence?.next_dates && data.recurrence.next_dates.length > 0 && (
          <Card className="mb-6 print:break-inside-avoid print:shadow-none">
            <CardHeader className="print:pb-2">
              <CardTitle className="flex items-center gap-2 print:text-lg">
                <Calendar className="h-5 w-5 text-primary print:h-4 print:w-4" />
                Próximas Cobranças
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 print:space-y-1">
                {data.recurrence.next_dates.slice(0, 3).map((date, index) => (
                  <div key={index} className="flex justify-between items-center print:text-sm">
                    <span className="text-ds-text-muted">#{index + 1}</span>
                    <span className="font-medium text-ds-text-default">
                      {formatDate(date)}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row gap-4 justify-center print:hidden">
          <Button asChild>
            <Link to="/">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Voltar ao início
            </Link>
          </Button>

          {data?.charge && (
            <>
              <Button variant="outline" onClick={handlePrint}>
                <Printer className="h-4 w-4 mr-2" />
                Imprimir
              </Button>

              <Button variant="outline" onClick={handleDownloadPDF} disabled={isDownloadingPDF}>
                {isDownloadingPDF ? (
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Download className="h-4 w-4 mr-2" />
                )}
                Baixar PDF
              </Button>
            </>
          )}
        </div>

        {/* Footer - Suporte */}
        <div className="mt-8 text-sm text-ds-text-muted print:mt-4 print:text-xs">
          {/* Empresa Cobradora */}
          {data?.company?.name && (
            <Card className="mb-4 print:shadow-none">
              <CardContent className="pt-4">
                <div className="flex items-start gap-3">
                  <Building2 className="h-5 w-5 text-ds-text-muted mt-0.5" />
                  <div>
                    <p className="font-semibold text-ds-text-strong mb-1">Empresa Cobradora</p>
                    <p className="text-ds-text-default">{data.company.name}</p>
                    {data.company.phone && (
                      <p className="flex items-center gap-1 mt-1">
                        <Phone className="h-3 w-3" />
                        {data.company.phone}
                      </p>
                    )}
                    {data.company.email && (
                      <p className="flex items-center gap-1 mt-1">
                        <Mail className="h-3 w-3" />
                        {data.company.email}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Suporte AutoPay */}
          <div className="text-center border-t border-ds-border pt-4">
            <p className="font-medium text-ds-text-strong">Suporte AutoPay</p>
            <p className="flex items-center justify-center gap-1">
              <Mail className="h-3 w-3" />
              {data?.ui?.support_email || 'faleconosco@autonegocie.com'}
            </p>
          </div>

          <p className="text-center mt-4">
            Guarde este comprovante para seus registros.
          </p>
        </div>
      </div>

      {/* CSS de Impressão */}
      <style>{`
        @media print {
          @page {
            margin: 1cm;
            size: A4;
          }
          
          body {
            -webkit-print-color-adjust: exact;
            color-adjust: exact;
          }
          
          .print\\:hidden {
            display: none !important;
          }
          
          .print\\:text-xs {
            font-size: 0.75rem !important;
          }
          
          .print\\:text-lg {
            font-size: 1.125rem !important;
          }
          
          .print\\:text-xl {
            font-size: 1.25rem !important;
          }
          
          .print\\:shadow-none {
            box-shadow: none !important;
          }
          
          .print\\:pb-2 {
            padding-bottom: 0.5rem !important;
          }
          
          .print\\:mt-4 {
            margin-top: 1rem !important;
          }
          
          .print\\:mb-4 {
            margin-bottom: 1rem !important;
          }
          
          .print\\:space-y-1 > :not([hidden]) ~ :not([hidden]) {
            margin-top: 0.25rem !important;
          }
          
          .print\\:space-y-2 > :not([hidden]) ~ :not([hidden]) {
            margin-top: 0.5rem !important;
          }
          
          .print\\:break-inside-avoid {
            break-inside: avoid !important;
          }
          
          .print\\:px-1 {
            padding-left: 0.25rem !important;
            padding-right: 0.25rem !important;
          }
          
          .print\\:py-0 {
            padding-top: 0 !important;
            padding-bottom: 0 !important;
          }
        }
      `}</style>
    </div>
  );
}