# Integração QuitaPlus

## Visão geral

Esta integração implementa um sistema completo de pagamentos usando a API QuitaPlus (Cappta), com proxy no servidor para segurança e autenticação automática.

## Arquitetura

### Servidor (funções de borda do Supabase)

1. **`quitaplus-token`** (`/functions/v1/quitaplus-token`)
   - Obtém e guarda em cache os tokens de acesso OAuth2
   - Faz nova tentativa com espera crescente para erros 429 e 5xx
   - Cache com margem antes da expiração

2. **`quitaplus-proxy`** (`/functions/v1/quitaplus-proxy`)
   - Proxy transparente para todas as chamadas QuitaPlus
   - Injeta automaticamente `Authorization: Bearer <token>`
   - Nova tentativa automática em caso de falha

### Interface

- **`useQuitaMais`**: hook React para falar com a API
- Todas as chamadas passam pelo proxy do servidor
- Nenhuma credencial fica exposta no navegador

## Configuração de ambiente

### Segredos do Supabase (obrigatórios)

```bash
# URL base da API
QUITAPLUS_BASE_URL=https://api-sandbox.cappta.com.br  # homologação
# QUITAPLUS_BASE_URL=https://api.cappta.com.br         # produção

# Credenciais OAuth2
QUITAPLUS_CLIENT_ID=seu_client_id
QUITAPLUS_CLIENT_SECRET=seu_client_secret
```

### Como configurar os segredos

1. Acesse o painel do Supabase
2. Vá em Configurações do projeto → Funções de borda
3. Adicione os segredos acima

## Endpoints da API

### Autenticação
- **Endpoint**: `https://api-sandbox.cappta.com.br/connect/token`
- **Método**: POST
- **Content-Type**: `application/x-www-form-urlencoded`
- **Corpo**: `grant_type=client_credentials&client_id=X&client_secret=Y`

### Funcionalidades

1. **Teste de conectividade**
   ```typescript
   const isConnected = await testConnectivity()
   ```

2. **Criar link de pagamento**
   ```typescript
   const link = await createPaymentLink({
     amount: 10000, // em centavos
     payer: { name: "João", email: "joao@email.com", ... },
     checkout: { maskFee: true, installments: 12 }
   })
   ```

3. **Buscar detalhes do link**
   ```typescript
   const details = await getPaymentLinkDetails(linkId)
   ```

## Testes com cURL

### 1. Testar a obtenção do token

```bash
curl -X POST https://gsbbrkbeyxsqqjqhptrn.supabase.co/functions/v1/quitaplus-token \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Resposta esperada:**
```json
{
  "accessToken": "eyJ...",
  "tokenType": "Bearer",
  "expiresIn": 3600,
  "expiresAt": 1640995200000,
  "fromCache": false
}
```

### 2. Testar o proxy (exemplo de endpoint hipotético)

```bash
curl -X GET https://gsbbrkbeyxsqqjqhptrn.supabase.co/functions/v1/quitaplus-proxy/payment-links \
  -H "Content-Type: application/json"
```

### 3. Criar link de pagamento pelo proxy

```bash
curl -X POST https://gsbbrkbeyxsqqjqhptrn.supabase.co/functions/v1/quitaplus-proxy/payment-links \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 10000,
    "payer": {
      "name": "João Silva",
      "email": "joao@email.com",
      "phoneNumber": "11999999999",
      "document": "12345678901"
    },
    "checkout": {
      "maskFee": true,
      "installments": 12
    }
  }'
```

## Nova tentativa e tratamento de erros

### Códigos de status tratados

- **429 (limite de taxa)**: nova tentativa usando o cabeçalho `Retry-After` ou espera exponencial
- **5xx (erros do servidor)**: nova tentativa com espera exponencial
- **4xx (erros do cliente)**: sem nova tentativa; o erro volta na hora

### Estratégia de espera

```
Tentativa 1: imediata
Tentativa 2: 2^1 = 2 segundos
Tentativa 3: 2^2 = 4 segundos
Máximo: 3 tentativas
```

## Lista de aceite

### Funcionalidades básicas
- [ ] A obtenção do token OAuth2 funciona
- [ ] O cache do token está operacional
- [ ] O proxy injeta o cabeçalho Authorization automaticamente
- [ ] O teste de conectividade passa
- [ ] A criação do link de pagamento funciona
- [ ] A busca dos detalhes do link funciona

### Segurança
- [ ] Nenhuma credencial exposta na interface
- [ ] Todas as chamadas passam pelo proxy do servidor
- [ ] Os tokens ficam em cache com segurança no servidor
- [ ] O CORS está configurado corretamente

### Resiliência
- [ ] Nova tentativa automática para 429 e 5xx
- [ ] Espera exponencial implementada
- [ ] Cache de token com margem antes da expiração
- [ ] Registros detalhados para depuração

### Testes
- [ ] O cURL do token funciona
- [ ] O cURL do proxy funciona
- [ ] A interface funciona
- [ ] As mensagens de erro são claras

### Ambientes
- [ ] Homologação configurada e testada
- [ ] Segredos de produção documentados
- [ ] Processo de publicação documentado

## Registros e depuração

### Ver os registros das funções de borda

1. **Função de token**: https://supabase.com/dashboard/project/gsbbrkbeyxsqqjqhptrn/functions/quitaplus-token/logs
2. **Função de proxy**: https://supabase.com/dashboard/project/gsbbrkbeyxsqqjqhptrn/functions/quitaplus-proxy/logs

### Mensagens importantes nos registros

- `Token obtained successfully` — token obtido com sucesso
- `Using cached token` — usando token em cache
- `Proxy response: 200 for https://...` — resposta do proxy
- `Request failed with 429, retrying in Xms` — falha por limite de taxa, nova tentativa
- `All retry attempts failed` — todas as tentativas falharam

## Migração da versão anterior

### Removido
- Função `quitamais-auth` (substituída por `quitaplus-token`)
- Chamadas diretas do navegador para a Cappta
- Vários endpoints de teste de OAuth

### Adicionado
- `quitaplus-token` — gestão centralizada de tokens
- `quitaplus-proxy` — proxy transparente com autenticação
- Cache de tokens
- Nova tentativa com espera crescente
- Registros estruturados

## Solução de problemas

### Erro: "Missing QUITAPLUS_CLIENT_ID"
- Verifique se os segredos estão configurados no Supabase
- Confirme os nomes exatos: `QUITAPLUS_CLIENT_ID` e `QUITAPLUS_CLIENT_SECRET`

### Erro: "Authentication failed"
- Verifique se as credenciais estão corretas
- Confirme se o ambiente (homologação ou produção) está certo
- Veja os registros da função `quitaplus-token`

### Erro: "Proxy error"
- Verifique se o endpoint QuitaPlus existe
- Confirme se o caminho do proxy está correto
- Veja os registros da função `quitaplus-proxy`

### Limite de taxa (429)
- O sistema faz nova tentativa automaticamente
- Veja os registros para confirmar a espera
- Se continuar, reduza a frequência das requisições

## Links úteis

- [Funções de borda do Supabase](https://supabase.com/dashboard/project/gsbbrkbeyxsqqjqhptrn/functions)
- [Segredos das funções de borda](https://supabase.com/dashboard/project/gsbbrkbeyxsqqjqhptrn/settings/functions)
- [Documentação QuitaPlus/Cappta](https://developers.cappta.com.br/) (se disponível)
