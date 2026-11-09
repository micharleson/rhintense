# RH Intense — site e portal conectado

O pacote agora contém o site público e um portal funcional com API, autenticação por sessão e banco SQLite. Não há dados de demonstração pré-carregados.

## Iniciar localmente

Requer Node.js 22.13+ (recomendado Node 24 LTS). O projeto usa módulos nativos do Node, sem dependências externas.

```bash
npm start
```

Abra <http://localhost:3000>. Os arquivos do banco e documentos ficam em `data/` (configurável por `RH_DATA_DIR`). O banco é criado automaticamente na primeira inicialização.

## Primeiro acesso e uso

1. No site, selecione **Acessar portal** e **Cadastrar empresa**.
2. O primeiro cadastro cria uma empresa isolada e uma conta administradora. A senha deve ter ao menos 12 caracteres.
3. Dentro do portal, cadastre funcionários, processos, formulários, documentos e prazos. Os registros ficam associados à empresa da sessão.
4. O formulário público de contato registra solicitações no banco local.

O cadastro público cria uma conta sem verificação por e-mail. Não há fluxo de recuperação de senha, convite por e-mail ou envio automático de notificações; esses serviços precisam ser configurados antes de uma operação pública.

## O que está implementado

- API HTTP no mesmo servidor que publica o site.
- Banco SQLite com empresas, usuários, sessões, funcionários, processos, prazos, formulários/respostas, documentos, solicitações de contato e trilha básica de auditoria.
- Senhas derivadas com `scrypt`; cookies de sessão `HttpOnly`, `SameSite=Lax`, expiração e token CSRF para operações autenticadas.
- Isolamento de registros por empresa e autorização no servidor. Funcionários e documentos podem ser removidos apenas por administradores; equipe autorizada pode incluir e atualizar registros.
- Upload autenticado de arquivos até 10 MB e download como anexo, limitado à empresa da sessão.
- Limitação básica de tentativas em login, criação de conta e contato; cabeçalhos de segurança e consultas SQL parametrizadas.

## API principal

- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET/PATCH /api/companies`
- `GET/POST /api/employees`, `PATCH/DELETE /api/employees/:id`
- `GET/POST /api/processes`, `PATCH/DELETE /api/processes/:id`
- `GET/POST /api/deadlines`, `PATCH/DELETE /api/deadlines/:id`
- `GET/POST /api/forms`, `POST /api/forms/:id/submissions`, `GET /api/forms/:id/submissions`
- `GET/POST /api/documents`, `GET /api/documents/:id/download`, `DELETE /api/documents/:id`
- `POST /api/contact`, `GET /api/health`

## Variáveis de ambiente

- `PORT` (padrão `3000`)
- `RH_DATA_DIR` (padrão `./data`; use volume persistente na hospedagem)
- `NODE_ENV=production` ativa o atributo `Secure` nos cookies. Em produção, sirva o site apenas por HTTPS atrás de um proxy confiável.

## Antes de usar com dados reais

Este pacote não foi implantado nem passou por auditoria de segurança. Como trata informações de RH, não carregue dados reais até revisar privacidade/LGPD e controles com a assessoria responsável. Antes de publicar, configure HTTPS, backups testados, retenção e exclusão de dados, recuperação de conta e verificação de e-mail, armazenamento seguro e monitoramento. Restrinja a criação pública de empresas se o portal não for destinado ao cadastro aberto.

O SQLite é adequado para uma instalação pequena em um único servidor com disco persistente. Para várias réplicas, hospedagem serverless ou maior volume, use banco e armazenamento compatíveis com essa arquitetura, com migração e testes próprios. Os documentos são gravados localmente em `data/uploads/`; o processo de backup precisa incluir essa pasta.
