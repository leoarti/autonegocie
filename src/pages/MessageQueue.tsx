import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, MessageSquare, Send, RefreshCw, Eye, Clock } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { db } from '@/integrations/firebase/client';
import { useToast } from "@/hooks/use-toast";
import { Layout } from "@/components/Layout";

interface ChargeMessage {
  id: string;
  charge_id: string;
  template_id: string | null;
  content: string;
  phone_number: string;
  status: string;
  sent_at: string | null;
  error_details: any;
  created_at: string;
  charges?: {
    payer_name: string;
    amount: number;
    description?: string;
  };
}

export default function MessageQueue() {
  const [messages, setMessages] = useState<ChargeMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<ChargeMessage | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const { isAdmin, isOperador } = useAuth();
  const { toast } = useToast();

  // Verificar permissões
  if (!isAdmin && !isOperador) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center py-8">
          <h1 className="text-2xl font-bold text-destructive mb-4">Acesso Negado</h1>
          <p className="text-muted-foreground">
            Você não tem permissão para acessar esta página.
          </p>
        </div>
      </div>
    );
  }

  const loadMessages = async () => {
    setLoading(true);
    try {
      // Carregar mensagens primeiro
      let query = db
        .from('charge_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (statusFilter !== "all") {
        query = query.eq('status', statusFilter);
      }

      const { data: messagesData, error: messagesError } = await query;
      if (messagesError) throw messagesError;

      // Buscar dados das cobranças relacionadas
      const chargeIds = messagesData?.map(m => m.charge_id) || [];
      const { data: chargesData, error: chargesError } = await db
        .from('charges')
        .select('id, payer_name, amount, description')
        .in('id', chargeIds);
      
      if (chargesError) throw chargesError;

      // Combinar os dados
      const messagesWithCharges = messagesData?.map(message => ({
        ...message,
        charges: chargesData?.find(charge => charge.id === message.charge_id) || null
      })) || [];

      setMessages(messagesWithCharges as any);
    } catch (error) {
      console.error('Error loading messages:', error);
      toast({
        title: "Erro",
        description: "Erro ao carregar fila de mensagens.",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMessages();
  }, [statusFilter]);

  const simulateMessageSending = async (messageId: string) => {
    setProcessing(prev => [...prev, messageId]);
    
    try {
      // Simular delay de envio (1-3 segundos)
      const delay = Math.random() * 2000 + 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      
      // Simular sucesso ou falha (90% sucesso)
      const success = Math.random() > 0.1;
      
      const updateData = success ? {
        status: 'sent',
        sent_at: new Date().toISOString(),
        error_details: null
      } : {
        status: 'failed',
        error_details: {
          code: 'MOCK_ERROR',
          message: 'Simulação de falha no envio'
        }
      };

      const { error } = await db
        .from('charge_messages')
        .update(updateData)
        .eq('id', messageId);

      if (error) throw error;

      toast({
        title: success ? "Mensagem enviada!" : "Falha no envio",
        description: success 
          ? "Mensagem WhatsApp enviada com sucesso (simulado)."
          : "Falha simulada no envio da mensagem.",
        variant: success ? "default" : "destructive"
      });

      loadMessages();
    } catch (error) {
      console.error('Error processing message:', error);
      toast({
        title: "Erro",
        description: "Erro ao processar mensagem.",
        variant: "destructive"
      });
    } finally {
      setProcessing(prev => prev.filter(id => id !== messageId));
    }
  };

  const processAllPending = async () => {
    const pendingMessages = messages.filter(m => m.status === 'pending');
    
    for (const message of pendingMessages) {
      await simulateMessageSending(message.id);
      // Pequeno delay entre mensagens
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline"><Clock className="w-3 h-3 mr-1" />Pendente</Badge>;
      case 'sent':
        return <Badge variant="default"><Send className="w-3 h-3 mr-1" />Enviada</Badge>;
      case 'failed':
        return <Badge variant="destructive">Falhou</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(cents / 100);
  };

  const formatPhone = (phone: string) => {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 11) {
      return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2, 7)}-${cleaned.slice(7)}`;
    }
    return phone;
  };

  return (
    <div className="container mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Fila de Mensagens WhatsApp</h1>
          <p className="text-muted-foreground">
            Gerenciamento da fila de mensagens (simulado)
          </p>
        </div>
        
        <div className="flex space-x-2">
          <Button
            variant="outline"
            onClick={loadMessages}
            disabled={loading}
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Atualizar
          </Button>
          
          <Button
            onClick={processAllPending}
            disabled={messages.filter(m => m.status === 'pending').length === 0}
          >
            <Send className="w-4 h-4 mr-2" />
            Processar Pendentes
          </Button>
        </div>
      </div>

      {/* Filtros */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex space-x-4">
            <div>
              <Label htmlFor="status-filter">Status</Label>
              <select
                id="status-filter"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="all">Todos</option>
                <option value="pending">Pendentes</option>
                <option value="sent">Enviadas</option>
                <option value="failed">Falhas</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Estatísticas */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold">{messages.length}</div>
            <div className="text-sm text-muted-foreground">Total</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-yellow-600">
              {messages.filter(m => m.status === 'pending').length}
            </div>
            <div className="text-sm text-muted-foreground">Pendentes</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-green-600">
              {messages.filter(m => m.status === 'sent').length}
            </div>
            <div className="text-sm text-muted-foreground">Enviadas</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-red-600">
              {messages.filter(m => m.status === 'failed').length}
            </div>
            <div className="text-sm text-muted-foreground">Falhas</div>
          </CardContent>
        </Card>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Mensagens na Fila</CardTitle>
          </CardHeader>
          <CardContent>
            {messages.length === 0 ? (
              <div className="text-center py-8">
                <MessageSquare className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">Nenhuma mensagem encontrada</h3>
                <p className="text-muted-foreground">
                  As mensagens aparecerão aqui quando forem criadas
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cliente</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Valor</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Criada em</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {messages.map((message) => (
                    <TableRow key={message.id}>
                      <TableCell>
                        <div>
                          <div className="font-medium">
                            {message.charges?.payer_name || 'N/A'}
                          </div>
                          {message.charges?.description && (
                            <div className="text-sm text-muted-foreground">
                              {message.charges.description}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {formatPhone(message.phone_number)}
                      </TableCell>
                      <TableCell>
                        {message.charges ? formatCurrency(message.charges.amount) : 'N/A'}
                      </TableCell>
                      <TableCell>
                        {getStatusBadge(message.status)}
                      </TableCell>
                      <TableCell>
                        {new Date(message.created_at).toLocaleString('pt-BR')}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end space-x-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelectedMessage(message)}
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                          {message.status === 'pending' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => simulateMessageSending(message.id)}
                              disabled={processing.includes(message.id)}
                            >
                              {processing.includes(message.id) ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Send className="w-4 h-4" />
                              )}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Dialog de visualização */}
      <Dialog open={!!selectedMessage} onOpenChange={() => setSelectedMessage(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Detalhes da Mensagem</DialogTitle>
          </DialogHeader>
          
          {selectedMessage && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Cliente</Label>
                  <div className="font-medium">
                    {selectedMessage.charges?.payer_name || 'N/A'}
                  </div>
                </div>
                <div>
                  <Label>Telefone</Label>
                  <div className="font-medium">
                    {formatPhone(selectedMessage.phone_number)}
                  </div>
                </div>
                <div>
                  <Label>Status</Label>
                  <div>{getStatusBadge(selectedMessage.status)}</div>
                </div>
                <div>
                  <Label>Criada em</Label>
                  <div>{new Date(selectedMessage.created_at).toLocaleString('pt-BR')}</div>
                </div>
                {selectedMessage.sent_at && (
                  <>
                    <div>
                      <Label>Enviada em</Label>
                      <div>{new Date(selectedMessage.sent_at).toLocaleString('pt-BR')}</div>
                    </div>
                  </>
                )}
              </div>
              
              <div>
                <Label>Conteúdo da Mensagem</Label>
                <Textarea
                  value={selectedMessage.content}
                  readOnly
                  rows={6}
                  className="mt-1"
                />
              </div>
              
              {selectedMessage.error_details && (
                <div>
                  <Label>Detalhes do Erro</Label>
                  <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
                    <pre className="text-sm">
                      {JSON.stringify(selectedMessage.error_details, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}