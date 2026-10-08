# Sistema de Cobrança Integrado ao Quita+

Sistema completo de cobrança com autenticação por papéis, cobranças pontuais e recorrentes integradas ao Quita+.

## Funcionalidades

### Autenticação e autorização
- Login e senha com hash bcrypt (Supabase Auth)
- Controle de acesso por papel: administrador e operador
- Clientes acessam sem login
- Cookies httpOnly e proteção contra CSRF (nativo do Supabase)
- Limite de taxa de requisições (nativo do Supabase)

### Cobranças
- **Pontuais**: cobrança única com link instantâneo
- **Recorrentes**: diária, semanal, quinzenal, mensal, semestral, anual
- Configuração de parcelas e dos campos `maskFee` e `installments`
- Integração no servidor com o Quita+

### Processamento automático
- Tarefa agendada para recorrências (fuso `America/Sao_Paulo`)
- Controle de idempotência
- Registros completos de auditoria
- Nova tentativa automática com espera exponencial

## Arquitetura

### Banco de dados
- `profiles`: usuários com papéis (administrador/operador)
- `charges`: cobranças pontuais e recorrentes
- `charge_executions`: registro de cada tentativa de processamento

### Funções de borda
- `quitaplus-proxy`: integração com a API Quita+
- `process-charge`: processa uma cobrança individual
- `recurring-charges-cron`: tarefa automática para recorrências

### Interface
- Página pública: demonstração de pagamento
- Painel autenticado: gestão de cobranças
- Papéis: o administrador gerencia usuários; o operador cria cobranças

## Configuração

### 1. Configurar segredos no Supabase
```bash
# Já configurados:
- QUITAPLUS_CLIENT_ID
- QUITAPLUS_CLIENT_SECRET
- QUITA_MAIS_MERCHANT_ID
```

### 2. Configurar a tarefa agendada
```sql
-- Executar no editor SQL do Supabase
SELECT cron.schedule(
  'recurring-charges-processor',
  '*/15 * * * *', -- A cada 15 minutos
  $$
  SELECT net.http_post(
    url := 'https://gsbbrkbeyxsqqjqhptrn.supabase.co/functions/v1/recurring-charges-cron',
    headers := '{"Authorization": "Bearer ' || current_setting('app.settings.service_role_key') || '", "Content-Type": "application/json"}'::jsonb,
    body := '{"cron": true}'::jsonb
  ) as request_id;
  $$
);
```

### 3. Criar o primeiro usuário administrador
```sql
-- Após o primeiro cadastro, promover a administrador:
UPDATE profiles SET role = 'admin' WHERE email = 'seu@email.com';
```

## Testes

### Cobrança pontual
1. Entre como operador ou administrador
2. Painel → Nova cobrança
3. Preencha os dados do pagador
4. Tipo: "Pontual"
5. O link é gerado na hora

### Cobrança recorrente
1. Nova cobrança → Tipo: "Mensal"
2. Intervalo: 1; data de fim: opcional
3. A primeira cobrança é processada
4. As próximas ficam agendadas pela tarefa automática

### Validação do JSON canônico
```json
{
  "orderDetails": {
    "merchantId": "54.329.414/0001-98",
    "initiatorKey": null,
    "expiresAt": "2025-11-26 00:00:01",
    "description": "Teste",
    "details": null,
    "payer": { ... },
    "bankslip": { ... },
    "checkout": { ... }
  }
}
```

## Monitoramento

- **Registros**: Funções de borda do Supabase → `quitaplus-proxy`
- **Auditoria**: tabela `charge_executions`
- **Status da tarefa agendada**: registros de `recurring-charges-cron`

O sistema está pronto para produção.
