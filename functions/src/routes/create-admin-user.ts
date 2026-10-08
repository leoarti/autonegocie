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
    // Initialize Supabase client with service role (admin privileges)
    const supabaseUrl = process.env.SUPABASE_URL!
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    console.log('Creating admin user...')

    // Create admin user using Supabase Auth Admin API
    const { data: userData, error: userError } = await supabase.auth.admin.createUser({
      email: 'admin@sistema.com',
      password: 'Auto2025@',
      email_confirm: true, // Skip email confirmation
      user_metadata: {
        full_name: 'Administrador do Sistema'
      }
    })

    if (userError) {
      console.error('Error creating user:', userError)
      
      // If user already exists, that's ok
      if (userError.message?.includes('User already registered')) {
        return new Response(JSON.stringify({
          success: true,
          message: 'Admin user already exists',
          userId: null
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        })
      }
      
      throw userError
    }

    console.log('User created successfully:', userData.user.id)

    // Update the profile to ensure admin role
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({
        id: userData.user.id,
        full_name: 'Administrador do Sistema',
        is_active: true
      })

    if (!profileError) {
      await supabase.from('user_roles').upsert({
        id: userData.user.id,
        user_id: userData.user.id,
        role: 'admin',
      })
    }

    if (profileError) {
      console.error('Error updating profile:', profileError)
      throw profileError
    }

    console.log('Admin user and profile created successfully')

    return new Response(JSON.stringify({
      success: true,
      message: 'Admin user created successfully',
      userId: userData.user.id
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    console.error('Error in create-admin-user function:', error)
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }

}
