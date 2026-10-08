import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/integrations/firebase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Loader2, Plus, Building2, Edit, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { DashboardShell } from '@/components/dashboard/DashboardShell';
import { formatDocument } from '@/lib/input-masks';

interface Company {
  id: string;
  name: string;
  document: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface CompanyFormData {
  name: string;
  document: string;
  email: string;
  phone: string;
}

export default function CompanyManagement() {
  const { isAdmin } = useAuth();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [formData, setFormData] = useState<CompanyFormData>({
    name: '',
    document: '',
    email: '',
    phone: '',
  });

  const fetchCompanies = async () => {
    try {
      const { data, error } = await db
        .from('companies')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setCompanies(data);
    } catch (error: any) {
      toast({
        title: "Erro ao carregar empresas",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      fetchCompanies();
    }
  }, [isAdmin]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      const cleanDocument = formData.document.replace(/\D/g, '');
      
      if (editingCompany) {
        const { error } = await db
          .from('companies')
          .update({
            name: formData.name,
            document: cleanDocument,
            email: formData.email || null,
            phone: formData.phone || null,
          })
          .eq('id', editingCompany.id);

        if (error) throw error;

        toast({
          title: "Empresa atualizada",
          description: "As alterações foram salvas com sucesso",
        });
      } else {
        const { error } = await db
          .from('companies')
          .insert({
            name: formData.name,
            document: cleanDocument,
            email: formData.email || null,
            phone: formData.phone || null,
          });

        if (error) throw error;

        toast({
          title: "Empresa criada",
          description: "Nova empresa cadastrada com sucesso",
        });
      }

      setIsDialogOpen(false);
      setEditingCompany(null);
      setFormData({ name: '', document: '', email: '', phone: '' });
      fetchCompanies();
    } catch (error: any) {
      toast({
        title: "Erro ao salvar empresa",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const toggleCompanyStatus = async (company: Company) => {
    try {
      const { error } = await db
        .from('companies')
        .update({ is_active: !company.is_active })
        .eq('id', company.id);

      if (error) throw error;

      toast({
        title: company.is_active ? "Empresa desativada" : "Empresa ativada",
      });

      fetchCompanies();
    } catch (error: any) {
      toast({
        title: "Erro ao alterar status",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const openEditDialog = (company: Company) => {
    setEditingCompany(company);
    setFormData({
      name: company.name,
      document: company.document,
      email: company.email || '',
      phone: company.phone || '',
    });
    setIsDialogOpen(true);
  };

  if (!isAdmin) {
    return (
      <DashboardShell>
        <div className="flex items-center justify-center min-h-[400px]">
          <Card>
            <CardHeader>
              <CardTitle>Acesso Negado</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-ds-text-muted">Você não tem permissão para acessar esta página.</p>
            </CardContent>
          </Card>
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-ds-text-strong">Gestão de Empresas</h1>
            <p className="text-ds-text-muted">Gerencie empresas e suas configurações</p>
          </div>
          
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/admin/users">
                <Users className="w-4 h-4 mr-2" />
                Gerenciar Usuários
              </Link>
            </Button>
            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
              <DialogTrigger asChild>
                <Button onClick={() => {
                  setEditingCompany(null);
                  setFormData({ name: '', document: '', email: '', phone: '' });
                }}>
                  <Plus className="mr-2 h-4 w-4" />
                  Nova Empresa
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {editingCompany ? 'Editar Empresa' : 'Nova Empresa'}
                  </DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Nome da Empresa *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="Empresa LTDA"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="document">CNPJ *</Label>
                    <Input
                      id="document"
                      value={formatDocument(formData.document)}
                      onChange={(e) => setFormData({ ...formData, document: e.target.value })}
                      placeholder="00.000.000/0000-00"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      placeholder="contato@empresa.com.br"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phone">Telefone</Label>
                    <Input
                      id="phone"
                      value={formData.phone}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      placeholder="(11) 99999-9999"
                    />
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
                      Cancelar
                    </Button>
                    <Button type="submit">
                      {editingCompany ? 'Salvar' : 'Criar'}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex justify-center items-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="grid gap-4">
            {companies.map((company) => (
              <Card key={company.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <Building2 className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <CardTitle className="text-lg">{company.name}</CardTitle>
                        <div className="flex gap-2 mt-1">
                          <Badge variant={company.is_active ? 'success' : 'secondary'}>
                            {company.is_active ? 'Ativa' : 'Inativa'}
                          </Badge>
                          <span className="text-sm text-ds-text-muted">
                            CNPJ: {formatDocument(company.document)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2 items-center">
                      <Button variant="outline" size="sm" onClick={() => openEditDialog(company)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Switch
                        checked={company.is_active}
                        onCheckedChange={() => toggleCompanyStatus(company)}
                      />
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                    {company.email && (
                      <div>
                        <span className="text-ds-text-muted">Email:</span>
                        <p className="font-medium text-ds-text-default">{company.email}</p>
                      </div>
                    )}
                    {company.phone && (
                      <div>
                        <span className="text-ds-text-muted">Telefone:</span>
                        <p className="font-medium text-ds-text-default">{company.phone}</p>
                      </div>
                    )}
                    <div>
                      <span className="text-ds-text-muted">Criada em:</span>
                      <p className="font-medium text-ds-text-default">
                        {format(new Date(company.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
            
            {companies.length === 0 && (
              <Card>
                <CardContent className="flex flex-col items-center justify-center h-40">
                  <Building2 className="h-12 w-12 text-ds-text-muted mb-2" />
                  <p className="text-ds-text-muted">Nenhuma empresa cadastrada</p>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
