import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RECURRENCE_PLANNER_HORIZON_DAYS = 45;
const RECURRENCE_DEFAULT_HOUR = '09:00';
const SAO_PAULO_TZ = 'America/Sao_Paulo';

export async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL ?? '',
      process.env.SUPABASE_ANON_KEY ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        }
      }
    );

    const url = new URL(req.url);
    const pathParts = url.pathname.split('/');

    // POST /recurrences/plan
    if (req.method === 'POST' && pathParts.includes('plan')) {
      const body = await req.json().catch(() => ({}));
      const horizonDays = body.horizon_days || RECURRENCE_PLANNER_HORIZON_DAYS;
      
      const result = await runPlanner(supabase, horizonDays);
      
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /recurrences/dispatch
    if (req.method === 'POST' && pathParts.includes('dispatch')) {
      const body = await req.json().catch(() => ({}));
      const limit = body.limit || 200;
      
      const result = await runDispatcher(supabase, limit);
      
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /charges/:id/executions
    if (req.method === 'GET' && pathParts.includes('charges') && pathParts.includes('executions')) {
      const chargeId = pathParts[pathParts.indexOf('charges') + 1];
      const params = new URLSearchParams(url.search);
      
      const filters = {
        status: params.get('status'),
        from: params.get('from'),
        to: params.get('to'),
        limit: parseInt(params.get('limit') || '100')
      };

      const result = await getChargeExecutions(supabase, chargeId, filters);
      
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /executions/:id/mark
    if (req.method === 'POST' && pathParts.includes('executions') && pathParts.includes('mark')) {
      const executionId = pathParts[pathParts.indexOf('executions') + 1];
      const body = await req.json();
      
      const result = await markExecution(supabase, executionId, body);
      
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Handle actions from body
    if (req.method === 'POST') {
      const body = await req.json();
      
      if (body.action === 'plan') {
        const horizonDays = body.horizon_days || RECURRENCE_PLANNER_HORIZON_DAYS;
        const result = await runPlanner(supabase, horizonDays);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      if (body.action === 'dispatch') {
        const limit = body.limit || 200;
        const result = await runDispatcher(supabase, limit);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      if (body.action === 'get_executions') {
        const result = await getChargeExecutions(supabase, body.charge_id, {
          status: body.status,
          from: body.from,
          to: body.to,
          limit: body.limit || 100
        });
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      if (body.action === 'mark_execution') {
        const result = await markExecution(supabase, body.execution_id, {
          status: body.status,
          reason: body.reason
        });
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in recurrences-manager function:', error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// Fase A - Planner: Gerar execuções futuras
async function runPlanner(supabase: any, horizonDays: number) {
  console.log(`Running Planner with horizon: ${horizonDays} days`);
  
  const stats = {
    charges_analyzed: 0,
    executions_created: 0,
    executions_skipped: 0,
    errors: []
  };

  try {
    // Buscar cobranças recorrentes ativas
    const { data: charges, error: chargesError } = await supabase
      .from('charges')
      .select('*')
      .neq('recurrence_type', 'pontual')
      .eq('is_active', true)
      .order('created_at');

    if (chargesError) throw chargesError;

    console.log(`Found ${charges?.length || 0} recurring charges`);

    const horizonDate = new Date();
    horizonDate.setDate(horizonDate.getDate() + horizonDays);

    for (const charge of charges || []) {
      stats.charges_analyzed++;
      
      try {
        // Calculate next execution dates
        const executionDates = calculateNextExecutions(charge, horizonDate);
        
        for (const scheduledFor of executionDates) {
          // Check if execution already exists
          const { data: existingExecution } = await supabase
            .from('charge_executions')
            .select('id')
            .eq('charge_id', charge.id)
            .eq('scheduled_for', scheduledFor.toISOString())
            .single();

          if (existingExecution) {
            stats.executions_skipped++;
            continue;
          }

          // Create new execution
          const { error: insertError } = await supabase
            .from('charge_executions')
            .insert({
              charge_id: charge.id,
              scheduled_for: scheduledFor.toISOString(),
              status: 'SCHEDULED',
              planned_at: new Date().toISOString(),
              attempts: 0
            });

          if (insertError) {
            console.error(`Error creating execution for charge ${charge.id}:`, insertError);
            stats.errors.push(`Error creating execution for charge ${charge.id}: ${insertError.message}`);
          } else {
            stats.executions_created++;
            console.log(`Created execution for charge ${charge.id} at ${scheduledFor.toISOString()}`);
          }
        }
      } catch (error) {
        console.error(`Error processing charge ${charge.id}:`, error);
        stats.errors.push(`Error processing charge ${charge.id}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('Error in runPlanner:', error);
    stats.errors.push(`Global planner error: ${error.message}`);
  }

  console.log('Planner completed:', stats);
  return stats;
}

// Fase B - Dispatcher: Marcar READY + criar payment links
async function runDispatcher(supabase: any, limit: number) {
  console.log(`Running Dispatcher with limit: ${limit}`);
  
  const stats = {
    executions_processed: 0,
    executions_ready: 0,
    payment_links_created: 0,
    errors: []
  };

  try {
    // Buscar execuções SCHEDULED que estão vencidas
    const { data: executions, error: executionsError } = await supabase
      .from('charge_executions')
      .select(`
        *,
        charges!inner(
          id,
          payer_name,
          payer_email,
          payer_document,
          payer_phone,
          amount,
          description,
          creditor_name,
          creditor_document
        )
      `)
      .eq('status', 'SCHEDULED')
      .lte('scheduled_for', new Date().toISOString())
      .limit(limit);

    if (executionsError) throw executionsError;

    console.log(`Found ${executions?.length || 0} executions to dispatch`);

    for (const execution of executions || []) {
      stats.executions_processed++;
      
      try {
        // Check idempotency
        const eventKey = `CE:READY:${execution.id}`;
        const { data: existingEvent } = await supabase
          .from('mock_events')
          .select('id')
          .eq('event_key', eventKey)
          .single();

        if (existingEvent) {
          console.log(`Execution ${execution.id} already processed (found mock event)`);
          continue;
        }

        const charge = execution.charges;
        
        // Create payment link
        const { data: paymentLink, error: linkError } = await supabase
          .from('payment_links')
          .insert({
            link_id: `exec_${execution.id}_${Date.now()}`,
            link_url: `${process.env.BASE_URL || 'http://localhost:3000'}/payment?charge=${charge.id}&execution=${execution.id}`,
            guid: `guid_${execution.id}_${Date.now()}`,
            amount: charge.amount,
            payer_name: charge.payer_name,
            payer_email: charge.payer_email,
            payer_document: charge.payer_document,
            payer_phone_number: charge.payer_phone,
            creditor_name: charge.creditor_name || 'Sistema',
            creditor_document: charge.creditor_document || '00000000000',
            description: `${charge.description} - Recorrência`,
            order_type: 'recurring_charge',
            status: 'active',
            ui_snapshot: {
              execution_id: execution.id,
              charge_id: charge.id,
              scheduled_for: execution.scheduled_for,
              recurrence_type: 'recurring'
            }
          })
          .select()
          .single();

        if (linkError) {
          console.error(`Error creating payment link for execution ${execution.id}:`, linkError);
          stats.errors.push(`Error creating payment link for execution ${execution.id}: ${linkError.message}`);
          continue;
        }

        stats.payment_links_created++;

        // Update execution to READY
        const { error: updateError } = await supabase
          .from('charge_executions')
          .update({
            status: 'READY',
            payment_link_id: paymentLink.id,
            dispatched_at: new Date().toISOString()
          })
          .eq('id', execution.id);

        if (updateError) {
          console.error(`Error updating execution ${execution.id}:`, updateError);
          stats.errors.push(`Error updating execution ${execution.id}: ${updateError.message}`);
          continue;
        }

        // Create idempotency record
        await supabase
          .from('mock_events')
          .insert({
            provider: 'RECURRENCE_DISPATCHER',
            event_key: eventKey,
            payload: {
              execution_id: execution.id,
              charge_id: charge.id,
              payment_link_id: paymentLink.id,
              scheduled_for: execution.scheduled_for
            },
            processed_at: new Date().toISOString()
          });

        stats.executions_ready++;
        console.log(`Dispatched execution ${execution.id} with payment link ${paymentLink.id}`);

      } catch (error) {
        console.error(`Error processing execution ${execution.id}:`, error);
        stats.errors.push(`Error processing execution ${execution.id}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('Error in runDispatcher:', error);
    stats.errors.push(`Global dispatcher error: ${error.message}`);
  }

  console.log('Dispatcher completed:', stats);
  return stats;
}

// Calcular próximas execuções
function calculateNextExecutions(charge: any, horizonDate: Date): Date[] {
  const executions: Date[] = [];
  
  // Parse start date
  const startDate = new Date(charge.created_at);
  
  // Set default time if not specified
  const [hour, minute] = RECURRENCE_DEFAULT_HOUR.split(':');
  startDate.setHours(parseInt(hour), parseInt(minute), 0, 0);
  
  let currentDate = new Date(startDate);
  const now = new Date();
  
  // Skip past dates
  while (currentDate <= now) {
    currentDate = getNextRecurrenceDate(currentDate, charge.recurrence_type);
  }
  
  // Generate future dates within horizon
  while (currentDate <= horizonDate) {
    // Check end date if exists
    if (charge.recurrence_end_date && currentDate > new Date(charge.recurrence_end_date)) {
      break;
    }
    
    executions.push(new Date(currentDate));
    currentDate = getNextRecurrenceDate(currentDate, charge.recurrence_type);
  }
  
  return executions;
}

// Calculate next recurrence date
function getNextRecurrenceDate(currentDate: Date, recurrenceType: string): Date {
  const nextDate = new Date(currentDate);
  
  switch (recurrenceType.toLowerCase()) {
    case 'diaria':
      nextDate.setDate(nextDate.getDate() + 1);
      break;
    case 'semanal':
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case 'quinzenal':
      nextDate.setDate(nextDate.getDate() + 15);
      break;
    case 'mensal':
      nextDate.setMonth(nextDate.getMonth() + 1);
      // Handle month edge cases (e.g., Jan 31 -> Feb 28)
      if (nextDate.getDate() !== currentDate.getDate()) {
        nextDate.setDate(0); // Last day of previous month
      }
      break;
    case 'semestral':
      nextDate.setMonth(nextDate.getMonth() + 6);
      if (nextDate.getDate() !== currentDate.getDate()) {
        nextDate.setDate(0);
      }
      break;
    case 'anual':
      nextDate.setFullYear(nextDate.getFullYear() + 1);
      if (nextDate.getDate() !== currentDate.getDate()) {
        nextDate.setDate(0);
      }
      break;
    default:
      // Unknown recurrence type, add 1 day as fallback
      nextDate.setDate(nextDate.getDate() + 1);
  }
  
  return nextDate;
}

// Get charge executions
async function getChargeExecutions(supabase: any, chargeId: string, filters: any) {
  console.log(`Getting executions for charge ${chargeId}`, filters);

  let query = supabase
    .from('charge_executions')
    .select('*')
    .eq('charge_id', chargeId)
    .order('execution_date', { ascending: false })
    .limit(filters.limit || 100);

  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  
  if (filters.from) {
    query = query.gte('execution_date', filters.from);
  }
  
  if (filters.to) {
    query = query.lte('execution_date', filters.to);
  }

  const { data: executions, error } = await query;
  
  if (error) {
    console.error('Error fetching executions:', error);
    throw error;
  }

  console.log(`Found ${executions?.length || 0} executions for charge ${chargeId}`);
  return { executions: executions || [] };
}

// Mark execution status
async function markExecution(supabase: any, executionId: string, body: any) {
  console.log(`Marking execution ${executionId} as ${body.status}`);

  const validStatuses = ['SKIPPED', 'CANCELED', 'FAILED'];
  if (!validStatuses.includes(body.status)) {
    throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
  }

  const { data: execution, error: updateError } = await supabase
    .from('charge_executions')
    .update({
      status: body.status,
      last_error: body.reason || null,
      finished_at: new Date().toISOString()
    })
    .eq('id', executionId)
    .select()
    .single();

  if (updateError) throw updateError;

  return { execution };
}
