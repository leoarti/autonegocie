import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Edit, Trash2, MessageSquare, Eye } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { db } from '@/integrations/firebase/client';
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";
import { Layout } from "@/components/Layout";

const templateSchema = z.object({
  name: z.string().min(1, "Nome é obrigatório").max(100, "Nome deve ter no máximo 100 caracteres"),
  content: z.string().min(1, "Conteúdo é obrigatório").max(1000, "Conteúdo deve ter no máximo 1000 caracteres"),
});

interface TemplateData {
  name: string;
  content: string;
}

interface MessageTemplate {
  id: string;
  name: string;
  content: string;
  variables: any;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export default function MessageTemplates() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<MessageTemplate | null>(null);
  const { profile } = useAuth();
  const { toast } = useToast();

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors }
  } = useForm<TemplateData>({
    resolver: zodResolver(templateSchema),
    defaultValues: {
      name: "",
      content: ""
    }
  });

  const watchContent = watch("content");

  // Extrair variáveis do conteúdo (ex: {{nome}}, {{valor}})
  const extractVariables = (content: string): string[] => {
    const regex = /\{\{([^}]+)\}\}/g;
    const matches = [];
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      if (!matches.includes(match[1].trim())) {
        matches.push(match[1].trim());
      }
    }
    
    return matches;
  };

  const variables = extractVariables(watchContent || "");

  const loadTemplates = async () => {
    if (!profile) return;
    
    setLoading(true);
    try {
      const { data, error } = await db
        .from('message_templates')
        .select('*')
        .eq('user_id', profile.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setTemplates(data || []);
    } catch (error) {
      console.error('Error loading templates:', error);
      toast({
        title: "Erro",
        description: "Erro ao carregar templates de mensagem.",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTemplates();
  }, [profile]);

  const onSubmit = async (data: TemplateData) => {
    if (!profile) return;
    
    setIsSubmitting(true);
    try {
      const templateData = {
        user_id: profile.id,
        company_id: profile.company_id,
        name: data.name,
        content: data.content,
        variables: extractVariables(data.content),
        is_active: true
      };

      if (editingTemplate) {
        // Update existing template
        const { error } = await db
          .from('message_templates')
          .update(templateData)
          .eq('id', editingTemplate.id);

        if (error) throw error;
        
        toast({
          title: "Template atualizado!",
          description: "Template de mensagem atualizado com sucesso."
        });
      } else {
        // Create new template
        const { error } = await db
          .from('message_templates')
          .insert(templateData);

        if (error) throw error;
        
        toast({
          title: "Template criado!",
          description: "Template de mensagem criado com sucesso."
        });
      }

      reset();
      setIsDialogOpen(false);
      setEditingTemplate(null);
      loadTemplates();
    } catch (error: any) {
      console.error('Error saving template:', error);
      toast({
        title: "Erro",
        description: "Erro ao salvar template. Tente novamente.",
        variant: "destructive"
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = (template: MessageTemplate) => {
    setEditingTemplate(template);
    reset({
      name: template.name,
      content: template.content
    });
    setIsDialogOpen(true);
  };

  const handleDelete = async (templateId: string) => {
    if (!confirm("Tem certeza que deseja excluir este template?")) return;
    
    try {
      const { error } = await db
        .from('message_templates')
        .update({ is_active: false })
        .eq('id', templateId);

      if (error) throw error;
      
      toast({
        title: "Template excluído!",
        description: "Template removido com sucesso."
      });
      
      loadTemplates();
    } catch (error) {
      console.error('Error deleting template:', error);
      toast({
        title: "Erro",
        description: "Erro ao excluir template.",
        variant: "destructive"
      });
    }
  };

  const handleNewTemplate = () => {
    setEditingTemplate(null);
    reset({ name: "", content: "" });
    setIsDialogOpen(true);
  };

  const renderPreview = (content: string) => {
    // Substituir variáveis por valores de exemplo
    const exampleValues: { [key: string]: string } = {
      'nome': 'João Silva',
      'valor': 'R$ 150,00',
      'vencimento': '25/12/2024',
      'empresa': 'Minha Empresa',
      'link': 'https://exemplo.com/pagamento/123'
    };

    let preview = content;
    Object.entries(exampleValues).forEach(([key, value]) => {
      preview = preview.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    });

    return preview;
  };

  return (
    <div className="container mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Templates de Mensagem</h1>
          <p className="text-muted-foreground">
            Gerencie templates para mensagens WhatsApp (simulado)
          </p>
        </div>
        
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={handleNewTemplate}>
              <Plus className="w-4 h-4 mr-2" />
              Novo Template
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {editingTemplate ? "Editar Template" : "Novo Template"}
              </DialogTitle>
            </DialogHeader>
            
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <Label htmlFor="name">Nome do Template *</Label>
                <Input
                  id="name"
                  placeholder="Ex: Cobrança Padrão"
                  {...register("name")}
                  className={errors.name ? "border-destructive" : ""}
                />
                {errors.name && (
                  <p className="text-sm text-destructive mt-1">{errors.name.message}</p>
                )}
              </div>
              
              <div>
                <Label htmlFor="content">Conteúdo da Mensagem *</Label>
                <Textarea
                  id="content"
                  placeholder="Olá {{nome}}, você tem uma cobrança de {{valor}} com vencimento em {{vencimento}}. Pague em: {{link}}"
                  rows={6}
                  {...register("content")}
                  className={errors.content ? "border-destructive" : ""}
                />
                {errors.content && (
                  <p className="text-sm text-destructive mt-1">{errors.content.message}</p>
                )}
                <p className="text-sm text-muted-foreground mt-1">
                  Use variáveis no formato &#123;&#123;variavel&#125;&#125; para personalizar a mensagem
                </p>
              </div>

              {variables.length > 0 && (
                <div>
                  <Label>Variáveis Detectadas</Label>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {variables.map((variable) => (
                      <Badge key={variable} variant="secondary">
                        &#123;&#123;{variable}&#125;&#125;
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {watchContent && (
                <div>
                  <Label>Pré-visualização</Label>
                  <div className="p-3 bg-muted rounded-md border text-sm">
                    {renderPreview(watchContent)}
                  </div>
                </div>
              )}

              <div className="flex justify-end space-x-2 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsDialogOpen(false)}
                >
                  Cancelar
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Salvando...
                    </>
                  ) : (
                    <>
                      <MessageSquare className="w-4 h-4 mr-2" />
                      {editingTemplate ? "Atualizar" : "Criar"} Template
                    </>
                  )}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Templates ({templates.filter(t => t.is_active).length})</CardTitle>
          </CardHeader>
          <CardContent>
            {templates.filter(t => t.is_active).length === 0 ? (
              <div className="text-center py-8">
                <MessageSquare className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">Nenhum template encontrado</h3>
                <p className="text-muted-foreground mb-4">
                  Crie seu primeiro template de mensagem
                </p>
                <Button onClick={handleNewTemplate}>
                  <Plus className="w-4 h-4 mr-2" />
                  Criar Template
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>Variáveis</TableHead>
                    <TableHead>Criado em</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {templates.filter(t => t.is_active).map((template) => (
                    <TableRow key={template.id}>
                      <TableCell className="font-medium">
                        {template.name}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {template.variables?.map((variable) => (
                            <Badge key={variable} variant="outline" className="text-xs">
                              &#123;&#123;{variable}&#125;&#125;
                            </Badge>
                          ))}
                          {(!template.variables || template.variables.length === 0) && (
                            <span className="text-muted-foreground text-sm">Nenhuma</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {new Date(template.created_at).toLocaleDateString('pt-BR')}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end space-x-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPreviewTemplate(template)}
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(template)}
                          >
                            <Edit className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(template.id)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
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

      {/* Preview Dialog */}
      <Dialog open={!!previewTemplate} onOpenChange={() => setPreviewTemplate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pré-visualização: {previewTemplate?.name}</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label>Conteúdo Original</Label>
              <div className="p-3 bg-muted rounded-md border text-sm whitespace-pre-wrap">
                {previewTemplate?.content}
              </div>
            </div>
            
            <div>
              <Label>Com Dados de Exemplo</Label>
              <div className="p-3 bg-primary/10 rounded-md border text-sm whitespace-pre-wrap">
                {previewTemplate && renderPreview(previewTemplate.content)}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}