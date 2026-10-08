import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/integrations/firebase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Loader2, RefreshCw, UserPlus, Building2, Trash2, KeyRound, Users } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { DashboardShell } from '@/components/dashboard/DashboardShell';

interface Profile {
  id: string;
  full_name: string;
  role: 'admin' | 'operador';
  is_active: boolean;
  created_at: string;
  updated_at: string;
  company_id: string;
  company_name?: string;
}

interface Company {
  id: string;
  name: string;
}

interface NewUserData {
  email: string;
  password: string;
  full_name: string;
  company_id: string;
  role: 'admin' | 'operador';
}

export default function UserManagement() {
  const { isAdmin } = useAuth();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [filteredProfiles, setFilteredProfiles] = useState<Profile[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  
  // Filtros
  const [searchName, setSearchName] = useState('');
  const [filterCompany, setFilterCompany] = useState('all');
  const [filterRole, setFilterRole] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');

  const [newUserData, setNewUserData] = useState<NewUserData>({
    email: '',
    password: '',
    full_name: '',
    company_id: '',
    role: 'operador'
  });

  const fetchCompanies = async () => {
    try {
      const { data, error } = await db
        .from('companies')
        .select('id, name')
        .eq('is_active', true)
        .order('name');

      if (error) throw error;
      setCompanies(data || []);
    } catch (error: any) {
      console.error('Erro ao carregar empresas:', error);
    }
  };

  const fetchProfiles = async () => {
    try {
      const { data: profilesData, error: profilesError } = await db
        .from('profiles')
        .select('id, full_name, is_active, created_at, updated_at, company_id')
        .order('created_at', { ascending: false });

      if (profilesError) throw profilesError;

      const { data: companiesData } = await db
        .from('companies')
        .select('id, name');

      const companyMap = new Map(companiesData?.map(c => [c.id, c.name]) || []);

      const profilesWithRoles = await Promise.all(
        (profilesData || []).map(async (profile) => {
          const { data: roleData } = await db
            .from('user_roles')
            .select('role')
            .eq('user_id', profile.id)
            .maybeSingle();

          return {
            ...profile,
            role: (roleData?.role || 'operador') as 'admin' | 'operador',
            company_name: companyMap.get(profile.company_id) || 'Empresa não encontrada'
          };
        })
      );

      setProfiles(profilesWithRoles);
      setFilteredProfiles(profilesWithRoles);
    } catch (error: any) {
      toast({
        title: "Erro ao carregar usuários",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      fetchProfiles();
      fetchCompanies();
    }
  }, [isAdmin]);

  useEffect(() => {
    let filtered = profiles;

    if (searchName.trim()) {
      filtered = filtered.filter(p => 
        p.full_name.toLowerCase().includes(searchName.toLowerCase())
      );
    }

    if (filterCompany !== 'all') {
      filtered = filtered.filter(p => p.company_id === filterCompany);
    }

    if (filterRole !== 'all') {
      filtered = filtered.filter(p => p.role === filterRole);
    }

    if (filterStatus !== 'all') {
      const isActive = filterStatus === 'active';
      filtered = filtered.filter(p => p.is_active === isActive);
    }

    setFilteredProfiles(filtered);
  }, [searchName, filterCompany, filterRole, filterStatus, profiles]);

  const createUser = async () => {
    if (!newUserData.email || !newUserData.email.includes('@')) {
      toast({
        title: "Email inválido",
        description: "Por favor, insira um email válido",
        variant: "destructive",
      });
      return;
    }

    if (!newUserData.password || newUserData.password.length < 6) {
      toast({
        title: "Senha muito curta",
        description: "A senha deve ter no mínimo 6 caracteres",
        variant: "destructive",
      });
      return;
    }

    if (!newUserData.full_name || newUserData.full_name.trim().length < 3) {
      toast({
        title: "Nome incompleto",
        description: "Por favor, insira o nome completo do usuário",
        variant: "destructive",
      });
      return;
    }

    if (!newUserData.company_id) {
      toast({
        title: "Empresa não selecionada",
        description: "Por favor, selecione uma empresa",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsCreating(true);

      const { data, error } = await db.functions.invoke('create-user-admin', {
        body: newUserData
      });

      if (error) throw new Error(error.message || 'Erro de conexão');
      if (!data.success) throw new Error(data.error || 'Erro ao criar usuário');

      toast({
        title: "Usuário criado com sucesso!",
        description: `${newUserData.full_name} foi cadastrado.`,
      });

      setIsCreateDialogOpen(false);
      setNewUserData({
        email: '',
        password: '',
        full_name: '',
        company_id: '',
        role: 'operador'
      });
      fetchProfiles();
    } catch (error: any) {
      toast({
        title: "Erro ao criar usuário",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  };

  const updateProfile = async (id: string, updates: Partial<Profile>) => {
    try {
      if (updates.role) {
        const { data: existingRole } = await db
          .from('user_roles')
          .select('id')
          .eq('user_id', id)
          .maybeSingle();

        if (existingRole) {
          await db.from('user_roles').update({ role: updates.role }).eq('user_id', id);
        } else {
          await db.from('user_roles').insert({ user_id: id, role: updates.role });
        }
        
        const { role, ...profileUpdates } = updates;
        updates = profileUpdates;
      }

      if (Object.keys(updates).length > 0) {
        await db.from('profiles').update(updates).eq('id', id);
      }

      toast({ title: "Usuário atualizado" });
      fetchProfiles();
    } catch (error: any) {
      toast({ title: "Erro ao atualizar", description: error.message, variant: "destructive" });
    }
  };

  const resetPassword = async (email: string) => {
    try {
      await db.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      toast({ title: "Email enviado", description: "Link de reset enviado para o usuário" });
    } catch (error: any) {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    }
  };

  const deleteUser = async (userId: string, userName: string) => {
    try {
      await db.from('user_roles').delete().eq('user_id', userId);
      await db.from('profiles').delete().eq('id', userId);
      toast({ title: "Usuário removido", description: `${userName} foi removido` });
      fetchProfiles();
    } catch (error: any) {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    }
  };

  if (!isAdmin) {
    return (
      <DashboardShell>
        <div className="flex items-center justify-center h-[60vh]">
          <Card className="max-w-md text-center">
            <CardContent className="pt-8">
              <div className="w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Users className="w-8 h-8 text-destructive" />
              </div>
              <h2 className="text-xl font-semibold text-ds-text-strong mb-2">Acesso Negado</h2>
              <p className="text-ds-text-muted">Você não tem permissão para acessar esta área.</p>
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
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-ds-text-strong">Gerenciamento de Usuários</h1>
            <p className="text-ds-text-muted">Gerencie os usuários do sistema</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/admin/companies">
                <Building2 className="w-4 h-4 mr-2" />
                Empresas
              </Link>
            </Button>
            <Button onClick={fetchProfiles} variant="outline" disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Atualizar
            </Button>
            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <UserPlus className="w-4 h-4 mr-2" />
                  Novo Usuário
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                  <DialogTitle>Criar Novo Usuário</DialogTitle>
                  <DialogDescription>
                    Preencha os dados para criar um novo usuário
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="email">Email *</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="usuario@empresa.com"
                      value={newUserData.email}
                      onChange={(e) => setNewUserData({ ...newUserData, email: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="password">Senha *</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="Mínimo 6 caracteres"
                      value={newUserData.password}
                      onChange={(e) => setNewUserData({ ...newUserData, password: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="full_name">Nome Completo *</Label>
                    <Input
                      id="full_name"
                      placeholder="Nome do usuário"
                      value={newUserData.full_name}
                      onChange={(e) => setNewUserData({ ...newUserData, full_name: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="company">Empresa *</Label>
                    <Select value={newUserData.company_id} onValueChange={(value) => setNewUserData({ ...newUserData, company_id: value })}>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione a empresa" />
                      </SelectTrigger>
                      <SelectContent>
                        {companies.map((company) => (
                          <SelectItem key={company.id} value={company.id}>
                            {company.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="role">Função *</Label>
                    <Select value={newUserData.role} onValueChange={(value: 'admin' | 'operador') => setNewUserData({ ...newUserData, role: value })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="operador">Operador</SelectItem>
                        <SelectItem value="admin">Administrador</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)} disabled={isCreating}>
                    Cancelar
                  </Button>
                  <Button onClick={createUser} disabled={isCreating}>
                    {isCreating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                    Criar Usuário
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader>
            <CardTitle>Filtros</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>Buscar por nome</Label>
                <Input
                  placeholder="Digite o nome..."
                  value={searchName}
                  onChange={(e) => setSearchName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Empresa</Label>
                <Select value={filterCompany} onValueChange={setFilterCompany}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas</SelectItem>
                    {companies.map((company) => (
                      <SelectItem key={company.id} value={company.id}>
                        {company.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Função</Label>
                <Select value={filterRole} onValueChange={setFilterRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas</SelectItem>
                    <SelectItem value="admin">Administrador</SelectItem>
                    <SelectItem value="operador">Operador</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={filterStatus} onValueChange={setFilterStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos</SelectItem>
                    <SelectItem value="active">Ativo</SelectItem>
                    <SelectItem value="inactive">Inativo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Users List */}
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Usuários ({filteredProfiles.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {filteredProfiles.map((profile) => (
                  <div
                    key={profile.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between p-4 border border-ds-border-subtle rounded-card bg-ds-bg-surface hover:bg-ds-bg-surface-alt transition-colors gap-4"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-ds-text-strong">{profile.full_name}</span>
                        <Badge variant={profile.role === 'admin' ? 'default' : 'secondary'}>
                          {profile.role === 'admin' ? 'Admin' : 'Operador'}
                        </Badge>
                        <Badge variant={profile.is_active ? 'success' : 'destructive'}>
                          {profile.is_active ? 'Ativo' : 'Inativo'}
                        </Badge>
                      </div>
                      <p className="text-sm text-ds-text-muted">{profile.company_name}</p>
                      <p className="text-xs text-ds-text-muted">
                        Criado em {format(new Date(profile.created_at), 'dd/MM/yyyy', { locale: ptBR })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`active-${profile.id}`} className="text-sm">Ativo</Label>
                        <Switch
                          id={`active-${profile.id}`}
                          checked={profile.is_active}
                          onCheckedChange={(checked) => updateProfile(profile.id, { is_active: checked })}
                        />
                      </div>
                      <Select
                        value={profile.role}
                        onValueChange={(value: 'admin' | 'operador') => updateProfile(profile.id, { role: value })}
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="operador">Operador</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => resetPassword(profile.full_name)}
                        title="Resetar senha"
                      >
                        <KeyRound className="w-4 h-4" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive">
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Confirmar exclusão</AlertDialogTitle>
                            <AlertDialogDescription>
                              Tem certeza que deseja excluir {profile.full_name}? Esta ação não pode ser desfeita.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteUser(profile.id, profile.full_name)}>
                              Excluir
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardShell>
  );
}
