import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Clock, AlertTriangle, RefreshCw, DollarSign, CheckCircle, XCircle } from 'lucide-react';
import { db } from '@/integrations/firebase/client';
import { toast } from '@/hooks/use-toast';
import { format, addHours, differenceInHours } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface PaymentSplit {
  id: string;
  method: string;
  amount_cents: number;
  status: string;
  processed_at?: string;
}

interface RefundJob {
  id: string;
  original_amount_cents: number;
  refund_amount_cents: number;
  fee_amount_cents: number;
  reason: string;
  status: string;
  processed_at?: string;
  created_at: string;
}

interface ChargeRefundTimelineProps {
  chargeId: string;
  hasBoletoLink: boolean;
}

export function ChargeRefundTimeline({ chargeId, hasBoletoLink }: ChargeRefundTimelineProps) {
  const [splits, setSplits] = useState<PaymentSplit[]>([]);
  const [refundJobs, setRefundJobs] = useState<RefundJob[]>([]);
  const [loading, setLoading] = useState(true);

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(cents / 100);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'concluded': return <CheckCircle className="w-4 h-4 text-success" />;
      case 'pending': return <Clock className="w-4 h-4 text-warning" />;
      case 'failed': return <XCircle className="w-4 h-4 text-destructive" />;
      case 'refunded': return <RefreshCw className="w-4 h-4 text-info" />;
      default: return <Clock className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const statusMap = {
      pending: { label: 'Pendente', variant: 'secondary' as const },
      concluded: { label: 'Concluído', variant: 'default' as const },
      failed: { label: 'Falhado', variant: 'destructive' as const },
      refunded: { label: 'Estornado', variant: 'outline' as const },
    };
    return statusMap[status as keyof typeof statusMap] || statusMap.pending;
  };

  const loadData = async () => {
    try {
      setLoading(true);
      
      // Load splits
      const { data: splitsData, error: splitsError } = await db
        .from('payment_splits')
        .select('*')
        .eq('charge_id', chargeId)
        .order('created_at', { ascending: true });

      if (splitsError) throw splitsError;
      setSplits(splitsData || []);

      // Load refund jobs
      const { data: refundData, error: refundError } = await db
        .from('refund_jobs')
        .select('*')
        .eq('charge_id', chargeId)
        .order('created_at', { ascending: true });

      if (refundError) throw refundError;
      setRefundJobs(refundData || []);

    } catch (error: any) {
      console.error('Error loading refund timeline:', error);
      toast({
        title: 'Erro ao carregar timeline',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const calculateRefundWindow = () => {
    const concludedSplits = splits.filter(s => s.status === 'concluded' && s.processed_at);
    if (concludedSplits.length === 0) return null;

    const firstConcludedAt = new Date(Math.min(...concludedSplits.map(s => new Date(s.processed_at!).getTime())));
    const refundDeadline = addHours(firstConcludedAt, 24);
    const now = new Date();
    const hoursRemaining = differenceInHours(refundDeadline, now);

    return {
      firstConcludedAt,
      refundDeadline,
      hoursRemaining,
      isEligible: hoursRemaining <= 0 && splits.some(s => ['pending', 'failed'].includes(s.status))
    };
  };

  useEffect(() => {
    loadData();
  }, [chargeId]);

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center">
            <RefreshCw className="w-6 h-6 animate-spin mr-2" />
            Carregando timeline...
          </div>
        </CardContent>
      </Card>
    );
  }

  const refundWindow = calculateRefundWindow();
  const hasRefunds = refundJobs.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="w-5 h-5" />
          Timeline de Pagamento e Estornos
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Boleto Warning */}
        {hasBoletoLink && (
          <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg">
            <div className="flex items-center gap-2 text-orange-800">
              <AlertTriangle className="w-4 h-4" />
              <span className="font-medium">Cobrança com vínculo de boleto</span>
            </div>
            <p className="text-sm text-orange-700 mt-1">
              Cobranças com boleto normalmente têm apenas um split QUITA e não estão sujeitas à regra de 24h.
            </p>
          </div>
        )}

        {/* Current Splits Status */}
        <div>
          <h4 className="font-medium mb-3">Status Atual dos Splits</h4>
          <div className="space-y-2">
            {splits.map((split, index) => (
              <div key={split.id} className="flex items-center justify-between p-3 border rounded">
                <div className="flex items-center gap-3">
                  {getStatusIcon(split.status)}
                  <div>
                    <div className="font-medium">{split.method}</div>
                    <div className="text-sm text-muted-foreground">
                      {formatCurrency(split.amount_cents)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={getStatusBadge(split.status).variant}>
                    {getStatusBadge(split.status).label}
                  </Badge>
                  {split.processed_at && (
                    <div className="text-xs text-muted-foreground">
                      {format(new Date(split.processed_at), 'dd/MM HH:mm', { locale: ptBR })}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Refund Window Info */}
        {refundWindow && !hasRefunds && (
          <>
            <Separator />
            <div>
              <h4 className="font-medium mb-3 flex items-center gap-2">
                <Clock className="w-4 h-4" />
                Janela de Estorno (24h)
              </h4>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Primeiro split concluído:</span>
                    <div className="font-medium">
                      {format(refundWindow.firstConcludedAt, 'dd/MM/yyyy HH:mm', { locale: ptBR })}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Prazo para estorno:</span>
                    <div className="font-medium">
                      {format(refundWindow.refundDeadline, 'dd/MM/yyyy HH:mm', { locale: ptBR })}
                    </div>
                  </div>
                </div>
                
                {refundWindow.hoursRemaining > 0 ? (
                  <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <div className="flex items-center gap-2 text-yellow-800">
                      <Clock className="w-4 h-4" />
                      <span className="font-medium">
                        {refundWindow.hoursRemaining}h restantes para possível estorno automático
                      </span>
                    </div>
                    <p className="text-sm text-yellow-700 mt-1">
                      Se houver splits pendentes após esse prazo, splits concluídos serão estornados com taxa de 5%.
                    </p>
                  </div>
                ) : refundWindow.isEligible ? (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                    <div className="flex items-center gap-2 text-red-800">
                      <AlertTriangle className="w-4 h-4" />
                      <span className="font-medium">Elegível para estorno automático</span>
                    </div>
                    <p className="text-sm text-red-700 mt-1">
                      Esta cobrança pode ser processada pelo scheduler de estornos automáticos.
                    </p>
                  </div>
                ) : (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                    <div className="flex items-center gap-2 text-green-800">
                      <CheckCircle className="w-4 h-4" />
                      <span className="font-medium">Prazo expirado - sem necessidade de estorno</span>
                    </div>
                    <p className="text-sm text-green-700 mt-1">
                      Todos os splits necessários foram concluídos dentro do prazo.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* Refund History */}
        {hasRefunds && (
          <>
            <Separator />
            <div>
              <h4 className="font-medium mb-3 flex items-center gap-2">
                <RefreshCw className="w-4 h-4" />
                Histórico de Estornos
              </h4>
              <div className="space-y-3">
                {refundJobs.map((job) => (
                  <div key={job.id} className="p-4 border rounded-lg bg-muted/30">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <DollarSign className="w-4 h-4 text-destructive" />
                        <span className="font-medium">Estorno Automático</span>
                        <Badge variant={job.status === 'processed' ? 'default' : 'destructive'}>
                          {job.status === 'processed' ? 'Processado' : 'Falhou'}
                        </Badge>
                      </div>
                      {job.processed_at && (
                        <div className="text-sm text-muted-foreground">
                          {format(new Date(job.processed_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
                        </div>
                      )}
                    </div>
                    
                    <div className="grid grid-cols-3 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">Valor original:</span>
                        <div className="font-medium text-destructive">
                          -{formatCurrency(job.original_amount_cents)}
                        </div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Taxa (5%):</span>
                        <div className="font-medium text-warning">
                          -{formatCurrency(job.fee_amount_cents)}
                        </div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Valor líquido:</span>
                        <div className="font-medium">
                          {formatCurrency(job.refund_amount_cents - job.fee_amount_cents)}
                        </div>
                      </div>
                    </div>
                    
                    <div className="mt-2 text-xs text-muted-foreground">
                      Motivo: {job.reason === 'TIMEOUT_24H_PENDING_OTHER_SPLITS' ? 
                        'Timeout de 24h com outros splits pendentes' : job.reason}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {splits.length === 0 && (
          <div className="text-center py-6 text-muted-foreground">
            Nenhum split de pagamento encontrado para esta cobrança.
          </div>
        )}
      </CardContent>
    </Card>
  );
}