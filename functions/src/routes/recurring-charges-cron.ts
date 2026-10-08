import { createClient, functionUrl } from '../db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    console.log('Starting recurring charges cron job...')
    
    // Initialize Supabase client
    const supabaseUrl = process.env.SUPABASE_URL!
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const supabase = createClient(supabaseUrl, supabaseKey)
    
    // Get current time in São Paulo timezone
    const now = new Date()
    const saoPauloTime = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }))
    
    console.log(`Processing charges at: ${saoPauloTime.toISOString()}`)
    
    // Find charges that need to be processed
    const { data: charges, error: chargesError } = await supabase
      .from('charges')
      .select('*')
      .eq('is_active', true)
      .neq('recurrence_type', 'pontual')
      .eq('status', 'pending')
      .lte('next_charge_date', saoPauloTime.toISOString())
      .order('next_charge_date', { ascending: true })
    
    if (chargesError) {
      throw new Error(`Error fetching charges: ${chargesError.message}`)
    }
    
    if (!charges || charges.length === 0) {
      console.log('No charges to process')
      return new Response(
        JSON.stringify({ 
          message: 'No charges to process',
          processed_at: saoPauloTime.toISOString()
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    
    console.log(`Found ${charges.length} charges to process`)
    
    const results = []
    
    // Process each charge
    for (const charge of charges) {
      try {
        console.log(`Processing charge ${charge.id} for ${charge.payer_name}`)
        
        // Check if charge end date has passed
        if (charge.recurrence_end_date) {
          const endDate = new Date(charge.recurrence_end_date)
          if (saoPauloTime > endDate) {
            console.log(`Charge ${charge.id} has passed end date, deactivating`)
            
            await supabase
              .from('charges')
              .update({ 
                is_active: false,
                status: 'cancelled'
              })
              .eq('id', charge.id)
            
            results.push({
              chargeId: charge.id,
              status: 'deactivated',
              reason: 'end_date_reached'
            })
            continue
          }
        }
        
        // Call process-charge function
        const { data: processResult, error: processError } = await supabase.functions.invoke('process-charge', {
          body: {
            chargeId: charge.id,
            immediate: false
          }
        })
        
        if (processError) {
          console.error(`Error processing charge ${charge.id}:`, processError)
          results.push({
            chargeId: charge.id,
            status: 'error',
            error: processError.message
          })
        } else {
          console.log(`Successfully processed charge ${charge.id}`)
          results.push({
            chargeId: charge.id,
            status: 'processed',
            result: processResult
          })
        }
        
        // Add delay between charges to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000))
        
      } catch (error: any) {
        console.error(`Error processing charge ${charge.id}:`, error)
        results.push({
          chargeId: charge.id,
          status: 'error',
          error: error.message
        })
      }
    }
    
    const successCount = results.filter(r => r.status === 'processed').length
    const errorCount = results.filter(r => r.status === 'error').length
    const deactivatedCount = results.filter(r => r.status === 'deactivated').length
    
    console.log(`Cron job completed: ${successCount} processed, ${errorCount} errors, ${deactivatedCount} deactivated`)
    
    return new Response(
      JSON.stringify({
        success: true,
        processed_at: saoPauloTime.toISOString(),
        summary: {
          total: charges.length,
          processed: successCount,
          errors: errorCount,
          deactivated: deactivatedCount
        },
        results
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
    
  } catch (error: any) {
    console.error('Error in recurring-charges-cron:', error)
    return new Response(
      JSON.stringify({ 
        error: 'Cron job failed',
        details: error.message,
        timestamp: new Date().toISOString()
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }

}
