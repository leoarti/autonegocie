# Sistema de Pagamentos QuitaMais

## Project info

**URL**: https://lovable.dev/projects/eaddac47-07ed-4011-8ff8-fc1b25fafe6b

## Sobre o Projeto

Sistema completo de pagamentos integrado com a API QuitaMais para processamento de transações via cartão de crédito. O projeto oferece:

### ✅ Funcionalidades Implementadas
- **Múltiplas opções de pagamento**: Parcelamento flexível, pagamento único com desconto, valores personalizados
- **Formulário completo**: Captura de dados do pagador e informações do cartão de crédito
- **Validação em tempo real**: CPF/CNPJ, telefone, e-mail, dados do cartão
- **Integração QuitaMais**: Processamento via API oficial da Cappta
- **Armazenamento seguro**: Histórico de transações no Firestore
- **Interface responsiva**: Design otimizado para conversão

### Dados Capturados
**Dados do Pagador:**
- Nome completo
- CPF ou CNPJ (com formatação automática)
- E-mail (validação de formato)
- Telefone (formato brasileiro: (11) 99999-9999)

**Dados do Cartão:**
- Nome no cartão
- Número do cartão (formatação automática: 0000 0000 0000 0000)
- Data de validade (MM/AA)
- CVV (3 ou 4 dígitos)

### Opções de Pagamento
1. **Menor Parcela**: R$ 124,75 em 12x
2. **Pagamento Único**: R$ 1.197,60 (desconto de R$ 299,40)
3. **Parcelamento Popular**: R$ 249,50 em 6x (opção mais escolhida)
4. **Valor Personalizado**: Cliente define o valor da parcela

## How can I edit this code?

There are several ways of editing your application.

**Use Lovable**

Simply visit the [Lovable Project](https://lovable.dev/projects/eaddac47-07ed-4011-8ff8-fc1b25fafe6b) and start prompting.

Changes made via Lovable will be committed automatically to this repo.

**Use your preferred IDE**

If you want to work locally using your own IDE, you can clone this repo and push changes. Pushed changes will also be reflected in Lovable.

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS
- Firebase (Auth e Firestore)
- QuitaMais API (Payment Processing)

## ⚠️ Configuração Necessária

### 1. Credenciais QuitaMais
Defina no ambiente do servidor em `functions/`:
- `QUITA_MAIS_MERCHANT_ID` - ID do comerciante QuitaMais
- `QUITA_MAIS_CREDITOR_NAME` - Nome do credor
- `QUITA_MAIS_CREDITOR_DOCUMENT` - Documento do credor

O admin também pode gravar esses valores em Firestore (`app_settings/quita_mais`) pela tela de configurações.

### 2. Dados das transações
As cobranças e transações ficam no Firestore, com campos como:

- `transaction_id` - ID único da transação
- `merchant_id` - ID do merchant QuitaMais
- `creditor_name` - Nome do credor
- `creditor_document` - Documento do credor
- `amount_in_cents` - Valor em centavos
- `installments` - Número de parcelas
- `payer_document` - CPF/CNPJ do pagador
- `payer_email` - E-mail do pagador
- `payer_phone_number` - Telefone do pagador
- `payer_name` - Nome do pagador
- `card_holder_name` - Nome no cartão
- `card_number_last_four` - Últimos 4 dígitos do cartão
- `status` - Status da transação (AUTHORIZED, REJECTED, PENDING)
- `authorization_code` - Código de autorização

### 3. Fluxo de Pagamento

1. Cliente acessa `/payment`
2. Seleciona opção de pagamento desejada
3. Preenche dados pessoais e do cartão
4. Sistema valida dados em tempo real
5. Edge function processa via API QuitaMais
6. Transação é salva no banco de dados
7. Cliente recebe confirmação

### 4. Segurança

- Validação robusta de CPF/CNPJ
- Formatação automática de campos
- Criptografia SSL end-to-end
- RLS (Row Level Security) habilitado
- Logs detalhados para auditoria

## How can I deploy this project?

Simply open [Lovable](https://lovable.dev/projects/eaddac47-07ed-4011-8ff8-fc1b25fafe6b) and click on Share -> Publish.

## Can I connect a custom domain to my Lovable project?

Yes, you can!

To connect a domain, navigate to Project > Settings > Domains and click Connect Domain.

Read more here: [Setting up a custom domain](https://docs.lovable.dev/tips-tricks/custom-domain#step-by-step-guide)