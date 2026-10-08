import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, Calendar, ExternalLink, AlertTriangle, CheckCircle, Clock, X, Ban } from 'lucide-react';
import { db } from '@/integrations/firebase/client';
import { toast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface ChargeExecution {
  id: string;
  scheduled_for: string;
  status: string;
  attempts: number;
  last_error?: string;
  planned_at?: string;
  dispatched_at?: string;
  finished_at?: string;
  payment_links?: {
    id: string;
    link_url: string;
    status: string;
    amount: number;
  };
}

interface ChargeExecutionsProps {
  chargeId: string;
}

export function ChargeExecutions({ chargeId }: ChargeExecutionsProps) {
  const [executions, setExecutions] = useState<ChargeExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingExecution, setMarkingExecution] = useState<string | null>(null);
  const [selectedExecution, setSelectedExecution] = useState<ChargeExecution | null>(null);
  const [markStatus, setMarkStatus] = useState('');
  const [markReason, setMarkReason] = useState('');

  const loadExecutions = async () => {
    try {
      setLoading(true);
      
      const { data, error } = await db.functions.invoke('recurrences-manager', {
        body: { 
          action: 'get_executions',
          charge_id: chargeId
        }
      });

      if (error) throw error;
      setExecutions(data.executions || []);
    } catch (error: any) {
      console.error('Error loading executions:', error);
      toast({
        title: 'Erro ao carregar execuções',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const markExecution = async () => {
    if (!selectedExecution || !markStatus) return;

    try {
      setMarkingExecution(selectedExecution.id);
      
      const { data, error } = await db.functions.invoke('recurrences-manager', {
        body: { 
          action: 'mark_execution',
          execution_id: selectedExecution.id,
          status: markStatus,
          reason: markReason
        }
      });

      if (error) throw error;
      
      toast({
        title: 'Execução marcada',
        description: `Execução marcada como ${markStatus.toLowerCase()}`,
      });

      setSelectedExecution(null);
      setMarkStatus('');
      setMarkReason('');
      await loadExecutions();
    } catch (error: any) {
      console.error('Error marking execution:', error);
      toast({
        title: 'Erro ao marcar execução',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setMarkingExecution(null);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'SCHEDULED': return <Clock className="w-4 h-4 text-secondary" />;
      case 'READY': return <CheckCircle className="w-4 h-4 text-primary" />;
      case 'RUNNING': return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
      case 'SUCCESS': return <CheckCircle className="w-4 h-4 text-success" />;
      case 'FAILED': return <AlertTriangle className="w-4 h-4 text-destructive" />;
      case 'SKIPPED': return <Ban className="w-4 h-4 text-muted-foreground" />;
      case 'CANCELED': return <X className="w-4 h-4 text-muted-foreground" />;
      default: return <Clock className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const statusMap = {
      'SCHEDULED': { label: 'Agendado', variant: 'secondary' as const },
      'READY': { label: 'Pronto', variant: 'default' as const },
      'RUNNING': { label: 'Executando', variant: 'default' as const },
      'SUCCESS': { label: 'Sucesso', variant: 'default' as const },
      'FAILED': { label: 'Falhou', variant: 'destructive' as const },
      'SKIPPED': { label: 'Pulado', variant: 'outline' as const },
      'CANCELED': { label: 'Cancelado', variant: 'outline' as const },
    };
    return statusMap[status as keyof typeof statusMap] || statusMap.SCHEDULED;
  };

  const canMarkExecution = (status: string) => {
    return ['SCHEDULED', 'READY', 'FAILED'].includes(status);
  };

  useEffect(() => {
    loadExecutions();
  }, [chargeId]);

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin mr-2" />
            Carregando execuções...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="w-5 h-5" />
          Execuções da Cobrança
        </CardTitle>
      </CardHeader>
      <CardContent>
        {executions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            Nenhuma execução encontrada para esta cobrança.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agendado Para</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Tentativas</TableHead>
                  <TableHead>Link de Pagamento</TableHead>
                  <TableHead>Planejado Em</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {executions.map((execution) => (
                  <TableRow key={execution.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-muted-foreground" />
                        <div>
                          <div className="font-medium">
                            {format(new Date(execution.scheduled_for), 'dd/MM/yyyy', { locale: ptBR })}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {format(new Date(execution.scheduled_for), 'HH:mm', { locale: ptBR })}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {getStatusIcon(execution.status)}
                        <Badge variant={getStatusBadge(execution.status).variant}>
                          {getStatusBadge(execution.status).label}
                        </Badge>
                      </div>
                      {execution.last_error && (
                        <div className="text-xs text-destructive mt-1" title={execution.last_error}>
                          {execution.last_error.length > 50 
                            ? `${execution.last_error.substring(0, 50)}...` 
                            : execution.last_error
                          }
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <span>{execution.attempts}</span>
                        {execution.attempts > 0 && (
                          <AlertTriangle className="w-3 h-3 text-warning" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {execution.payment_links ? (
                        <Button
                          size="sm"
                          variant="outline"
                          asChild
                        >
                          <a 
                            href={execution.payment_links.link_url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="flex items-center gap-1"
                          >
                            <ExternalLink className="w-3 h-3" />
                            Abrir
                          </a>
                        </Button>
                      ) : (
                        <span className="text-muted-foreground text-sm">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {execution.planned_at ? (
                        <div className="text-sm">
                          {format(new Date(execution.planned_at), 'dd/MM HH:mm', { locale: ptBR })}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {canMarkExecution(execution.status) && (
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setSelectedExecution(execution)}
                            >
                              Marcar
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Marcar Execução</DialogTitle>
                            </DialogHeader>
                            <div className="space-y-4">
                              <div>
                                <Label htmlFor="mark-status">Novo Status</Label>
                                <Select value={markStatus} onValueChange={setMarkStatus}>
                                  <SelectTrigger>
                                    <SelectValue placeholder="Selecione o status" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="SKIPPED">Pulado</SelectItem>
                                    <SelectItem value="CANCELED">Cancelado</SelectItem>
                                    <SelectItem value="FAILED">Falhado</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              
                              <div>
                                <Label htmlFor="mark-reason">Motivo (opcional)</Label>
                                <Textarea
                                  id="mark-reason"
                                  value={markReason}
                                  onChange={(e) => setMarkReason(e.target.value)}
                                  placeholder="Digite o motivo para esta alteração..."
                                  rows={3}
                                />
                              </div>
                              
                              <div className="flex gap-2 justify-end">
                                <Button
                                  variant="outline"
                                  onClick={() => {
                                    setSelectedExecution(null);
                                    setMarkStatus('');
                                    setMarkReason('');
                                  }}
                                >
                                  Cancelar
                                </Button>
                                <Button
                                  onClick={markExecution}
                                  disabled={!markStatus || markingExecution === selectedExecution?.id}
                                >
                                  {markingExecution === selectedExecution?.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                                  ) : null}
                                  Confirmar
                                </Button>
                              </div>
                            </div>
                          </DialogContent>
                        </Dialog>
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
  );
}