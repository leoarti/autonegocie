import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL!
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    // Verificar autenticação do usuário
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      throw new Error('Não autorizado')
    }

    // Criar cliente com token do usuário para verificar permissões
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    
    if (userError || !user) {
      throw new Error('Usuário não autenticado')
    }

    // Verificar se usuário é admin
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .single()

    if (roleData?.role !== 'admin') {
      throw new Error('Apenas administradores podem criar usuários')
    }

    const { email, password, full_name, company_id, role } = await req.json()

    // Validações
    if (!email || !password || !full_name || !company_id || !role) {
      throw new Error('Todos os campos são obrigatórios')
    }

    if (password.length < 6) {
      throw new Error('A senha deve ter no mínimo 6 caracteres')
    }

    if (!['admin', 'operador'].includes(role)) {
      throw new Error('Role inválida')
    }

    console.log('Criando usuário:', { email, full_name, company_id, role })

    // Criar usuário no Auth
    const { data: userData, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name
      }
    })

    if (createError) {
      console.error('Erro ao criar usuário:', createError)
      
      // Tratamento específico de erros - ordem importa!
      // Verificar "already registered" PRIMEIRO (contém "email" na mensagem)
      if (createError.message?.includes('already registered') || createError.message?.includes('duplicate')) {
        throw new Error('Este email já está cadastrado no sistema')
      }
      
      // Verificar problemas de senha
      if (createError.message?.includes('password')) {
        throw new Error('A senha deve ter no mínimo 6 caracteres e incluir letras e números')
      }
      
      // Verificar formato de email APENAS com padrões específicos
      if (createError.message?.includes('invalid email') || 
          createError.message?.includes('email format') ||
          createError.message?.includes('valid email')) {
        throw new Error('Formato de email inválido')
      }
      
      throw new Error('Erro ao criar usuário: ' + createError.message)
    }

    console.log('Usuário criado no Auth:', userData.user.id)

    // Aguardar trigger automático completar (100ms)
    await new Promise(resolve => setTimeout(resolve, 100))

    // Atualizar profile (trigger já criou o registro)
    const { error: profileError } = await supabase
      .from('profiles')
      .update({
        full_name,
        company_id,
        is_active: true
      })
      .eq('id', userData.user.id)

    if (profileError) {
      console.error('Erro ao atualizar profile:', profileError)
      
      // Tentar deletar o usuário criado
      await supabase.auth.admin.deleteUser(userData.user.id)
      
      if (profileError.code === '23503') {
        throw new Error('Empresa inválida. Verifique se a empresa existe e está ativa')
      }
      
      throw new Error('Erro ao configurar perfil do usuário. Tente novamente')
    }

    console.log('Profile atualizado')

    // Atualizar role (trigger já criou o registro)
    const { error: roleError } = await supabase
      .from('user_roles')
      .update({ role })
      .eq('user_id', userData.user.id)

    if (roleError) {
      console.error('Erro ao atualizar role:', roleError)
      
      // Tentar deletar profile e usuário
      await supabase.from('profiles').delete().eq('id', userData.user.id)
      await supabase.auth.admin.deleteUser(userData.user.id)
      
      throw new Error('Erro ao atribuir função ao usuário. Tente novamente')
    }

    console.log('Role atualizada:', role)

    return new Response(JSON.stringify({
      success: true,
      user_id: userData.user.id,
      message: 'Usuário criado com sucesso'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    console.error('Erro na função create-user-admin:', error)
    
    // Retornar mensagem de erro amigável
    const errorMessage = error.message || 'Erro ao criar usuário. Tente novamente'
    
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage,
      details: error.details || null
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }

}
