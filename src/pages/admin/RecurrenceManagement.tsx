import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/integrations/firebase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Play, Calendar, Clock, BarChart3, AlertTriangle } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { DashboardShell } from '@/components/dashboard/DashboardShell';

interface PlannerStats {
  charges_analyzed: number;
  executions_created: number;
  executions_skipped: number;
  errors: string[];
}

interface DispatcherStats {
  executions_processed: number;
  executions_ready: number;
  payment_links_created: number;
  errors: string[];
}

interface RecentExecution {
  id: string;
  charge_id: string;
  scheduled_for: string;
  status: string;
  attempts: number;
  payment_link_id?: string;
  planned_at?: string;
  dispatched_at?: string;
  charges: {
    payer_name: string;
    description: string;
    amount: number;
    recurrence_type: string;
  };
}

export default function RecurrenceManagement() {
  const { isAdmin } = useAuth();
  const [loading, setLoading] = useState(false);
  const [plannerStats, setPlannerStats] = useState<PlannerStats | null>(null);
  const [dispatcherStats, setDispatcherStats] = useState<DispatcherStats | null>(null);
  const [recentExecutions, setRecentExecutions] = useState<RecentExecution[]>([]);
  const [horizonDays, setHorizonDays] = useState('45');
  const [dispatchLimit, setDispatchLimit] = useState('200');

  const runPlanner = async () => {
    try {
      setLoading(true);
      setPlannerStats(null);
      
      const { data, error } = await db.functions.invoke('recurrences-manager', {
        body: { 
          action: 'plan',
          horizon_days: parseInt(horizonDays)
        }
      });

      if (error) throw error;
      
      setPlannerStats(data);
      
      toast({
        title: 'Planner executado',
        description: `${data.executions_created} execuções criadas, ${data.executions_skipped} puladas`,
      });

      await loadRecentExecutions();
    } catch (error: any) {
      console.error('Error running planner:', error);
      toast({
        title: 'Erro ao executar planner',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const runDispatcher = async () => {
    try {
      setLoading(true);
      setDispatcherStats(null);
      
      const { data, error } = await db.functions.invoke('recurrences-manager', {
        body: { 
          action: 'dispatch',
          limit: parseInt(dispatchLimit)
        }
      });

      if (error) throw error;
      
      setDispatcherStats(data);
      
      toast({
        title: 'Dispatcher executado',
        description: `${data.executions_ready} execuções marcadas como READY, ${data.payment_links_created} links criados`,
      });

      await loadRecentExecutions();
    } catch (error: any) {
      console.error('Error running dispatcher:', error);
      toast({
        title: 'Erro ao executar dispatcher',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const runBoth = async () => {
    await runPlanner();
    if (!loading) {
      await runDispatcher();
    }
  };

  const loadRecentExecutions = async () => {
    try {
      const { data, error } = await db
        .from('charge_executions')
        .select(`
          *,
          charges!inner(
            payer_name,
            description,
            amount,
            recurrence_type
          )
        `)
        .order('planned_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      setRecentExecutions(data || []);
    } catch (error: any) {
      console.error('Error loading recent executions:', error);
    }
  };

  const getStatusBadge = (status: string) => {
    const statusMap = {
      'SCHEDULED': { label: 'Agendado', variant: 'secondary' as const },
      'READY': { label: 'Pronto', variant: 'info' as const },
      'RUNNING': { label: 'Executando', variant: 'warning' as const },
      'SUCCESS': { label: 'Sucesso', variant: 'success' as const },
      'FAILED': { label: 'Falhou', variant: 'destructive' as const },
      'SKIPPED': { label: 'Pulado', variant: 'outline' as const },
      'CANCELED': { label: 'Cancelado', variant: 'outline' as const },
    };
    return statusMap[status as keyof typeof statusMap] || statusMap.SCHEDULED;
  };

  const getRecurrenceLabel = (type: string) => {
    const labels = {
      diaria: 'Diária',
      semanal: 'Semanal',
      quinzenal: 'Quinzenal',
      mensal: 'Mensal',
      semestral: 'Semestral',
      anual: 'Anual'
    };
    return labels[type as keyof typeof labels] || type;
  };

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(cents / 100);
  };

  useEffect(() => {
    if (isAdmin) {
      loadRecentExecutions();
    }
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <DashboardShell>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-destructive mb-2">Acesso Negado</h2>
            <p className="text-ds-text-muted">Você não tem permissão para acessar esta área.</p>
          </div>
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-ds-text-strong">Gestão de Recorrentes</h1>
          <p className="text-ds-text-muted">
            Gerenciar execuções e agendamentos de cobranças recorrentes
          </p>
        </div>

        {/* Control Panel */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="w-5 h-5 text-primary" />
                Planner (Fase A)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="horizon-days">Horizonte (dias)</Label>
                <Input
                  id="horizon-days"
                  type="number"
                  value={horizonDays}
                  onChange={(e) => setHorizonDays(e.target.value)}
                  min="1"
                  max="365"
                />
                <p className="text-xs text-ds-text-muted">
                  Gerar execuções para os próximos N dias
                </p>
              </div>
              
              <Button onClick={runPlanner} disabled={loading} className="w-full">
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                Executar Planner
              </Button>

              {plannerStats && (
                <div className="mt-4 p-3 bg-ds-bg-surface-alt rounded-lg">
                  <h4 className="font-medium mb-2 text-ds-text-strong">Últimas Estatísticas</h4>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="text-center">
                      <div className="font-bold text-primary">{plannerStats.charges_analyzed}</div>
                      <div className="text-xs text-ds-text-muted">Analisadas</div>
                    </div>
                    <div className="text-center">
                      <div className="font-bold text-primary">{plannerStats.executions_created}</div>
                      <div className="text-xs text-ds-text-muted">Criadas</div>
                    </div>
                    <div className="text-center">
                      <div className="font-bold text-primary">{plannerStats.executions_skipped}</div>
                      <div className="text-xs text-ds-text-muted">Puladas</div>
                    </div>
                  </div>
                  {plannerStats.errors.length > 0 && (
                    <div className="mt-2 text-xs text-destructive">
                      {plannerStats.errors.length} erro(s) encontrado(s)
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-primary" />
                Dispatcher (Fase B)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="dispatch-limit">Limite de execuções</Label>
                <Input
                  id="dispatch-limit"
                  type="number"
                  value={dispatchLimit}
                  onChange={(e) => setDispatchLimit(e.target.value)}
                  min="1"
                  max="1000"
                />
                <p className="text-xs text-ds-text-muted">
                  Processar no máximo N execuções vencidas
                </p>
              </div>

              <Button onClick={runDispatcher} disabled={loading} className="w-full">
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                Executar Dispatcher
              </Button>

              {dispatcherStats && (
                <div className="mt-4 p-3 bg-ds-bg-surface-alt rounded-lg">
                  <h4 className="font-medium mb-2 text-ds-text-strong">Últimas Estatísticas</h4>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="text-center">
                      <div className="font-bold text-primary">{dispatcherStats.executions_processed}</div>
                      <div className="text-xs text-ds-text-muted">Processadas</div>
                    </div>
                    <div className="text-center">
                      <div className="font-bold text-primary">{dispatcherStats.executions_ready}</div>
                      <div className="text-xs text-ds-text-muted">Prontas</div>
                    </div>
                    <div className="text-center">
                      <div className="font-bold text-primary">{dispatcherStats.payment_links_created}</div>
                      <div className="text-xs text-ds-text-muted">Links</div>
                    </div>
                  </div>
                  {dispatcherStats.errors.length > 0 && (
                    <div className="mt-2 text-xs text-destructive">
                      {dispatcherStats.errors.length} erro(s) encontrado(s)
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Batch Actions */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-primary" />
              Ações em Lote
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-4">
              <Button onClick={runBoth} disabled={loading}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                Executar Planner + Dispatcher
              </Button>
              
              <Button 
                onClick={() => db.functions.invoke('recurring-charges-cron')} 
                variant="outline"
                disabled={loading}
              >
                Executar Cron Completo
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Recent Executions */}
        <Card>
          <CardHeader>
            <CardTitle>Execuções Recentes (50 mais recentes)</CardTitle>
          </CardHeader>
          <CardContent>
            {recentExecutions.length === 0 ? (
              <div className="text-center py-8 text-ds-text-muted">
                Nenhuma execução encontrada
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pagador</TableHead>
                      <TableHead>Valor</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Agendado Para</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Tentativas</TableHead>
                      <TableHead>Link</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentExecutions.map((execution) => (
                      <TableRow key={execution.id}>
                        <TableCell>
                          <div>
                            <div className="font-medium text-ds-text-strong">{execution.charges.payer_name}</div>
                            <div className="text-xs text-ds-text-muted">
                              {execution.charges.description}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>{formatCurrency(execution.charges.amount)}</TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {getRecurrenceLabel(execution.charges.recurrence_type)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {execution.scheduled_for && (
                            <div className="text-sm">
                              {format(new Date(execution.scheduled_for), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={getStatusBadge(execution.status).variant}>
                            {getStatusBadge(execution.status).label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <span>{execution.attempts}</span>
                            {execution.attempts > 0 && (
                              <AlertTriangle className="w-3 h-3 text-destructive" />
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {execution.payment_link_id ? (
                            <Badge variant="success">Criado</Badge>
                          ) : (
                            <span className="text-ds-text-muted">-</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
