# Catálogo CENTRAL SOS — checklist de implantação

## Estado e autorização

Este documento prepara a implantação; não autoriza migration, bootstrap, conexão de recursos, merge ou deployment. O PR deve permanecer em draft até o responsável conferir os itens abaixo. Produção não foi configurada nesta revisão. Os testes com DDL usam clusters PostgreSQL locais descartáveis, sem conexão com Neon existente.

O catálogo de homologação já usa Neon e Blob privados isolados no projeto `centralsos-2xh9`. Não copiar a conexão, o store, as senhas, o segredo de rate limit, o token OIDC ou os arquivos locais desse projeto para produção. O launcher `dev:web` verifica explicitamente os recursos de homologação e não é um bootstrap de produção.

## 1. Recursos e ambiente

- [ ] Identificar por projeto/ambiente o destino de produção aprovado e sua origem HTTPS final; não assumir a URL de homologação.
- [ ] Criar/selecionar PostgreSQL exclusivo do catálogo de produção, separado do catálogo de homologação e do Control. Registrar a identidade do banco sem publicar sua connection string. Usar TLS com certificado verificado.
- [ ] Preparar snapshot/backup do banco de destino e registrar como restaurá-lo em um recurso separado.
- [ ] Criar/selecionar um Blob **privado de produção**, sem conexão com homologação. Confirmar acesso privado e permissões do projeto/runtime.
- [ ] Configurar as variáveis somente no ambiente correspondente; Preview/Development não recebem credenciais de Production, nem Production recebe recursos de homologação.
- [ ] Confirmar que Control/Agent/OIDC/updater mantêm suas variáveis, origem e permissões próprias.

| Variável | Configuração esperada no backend |
| --- | --- |
| `CATALOG_DATABASE_URL` | URL do PostgreSQL de produção do catálogo, por canal de segredo. Nunca a URL de homologação/Control. |
| `CATALOG_DATABASE_TLS` | `verify-full`, ou omitida para esse padrão. Nunca `disable` fora dos testes em loopback. |
| `CATALOG_DATABASE_CA` | CA específica somente se o banco exigir; preservar verificação do certificado. |
| `CATALOG_ORIGIN` | Origem HTTPS exata do portal, sem caminho/query/fragmento, por exemplo `https://<dominio-real-aprovado>`. |
| `CATALOG_RATE_SECRET` | Segredo aleatório exclusivo, no mínimo 32 caracteres; gerar/guardar por canal administrativo seguro. |
| `BLOB_STORE_ID` | Identificador do store privado do ambiente correto. |
| `VERCEL_OIDC_TOKEN` | Credencial de runtime fornecida pela Vercel e autorizada ao store correto; não copiar o token local de desenvolvimento. |
| `CATALOG_ADMIN_ENABLED` | **Ausente na Function pública.** Usar `1` somente no processo administrativo explicitamente autorizado. |

Nenhuma variável secreta usa `VITE_`. Não colocar senhas de acesso em variáveis do frontend: elas são verificadas por hash Argon2id no PostgreSQL. As variáveis `CONTROL_*` e do updater não substituem as variáveis do catálogo.

## 2. Migration de schema

- [ ] Revisar `server/catalog/migrations/001_catalog.sql` e confirmar que o banco de destino é o aprovado.
- [ ] Executar primeiro o dry-run **somente após autorização para acessar esse banco**; registrar checksum e estado pendente/aplicado.
- [ ] Se houver checksum divergente ou schema sem ledger, parar. Não editar migration aplicada nem apagar ledger/tabelas.
- [ ] Obter autorização explícita antes de `--apply`, incluindo confirmação do recurso e backup.
- [ ] Aplicar uma vez e repetir o dry-run para confirmar idempotência/checksum. Não incluir migration no build/startup/Function.

Os comandos abaixo são procedimentos futuros, não foram executados contra produção. O arquivo de ambiente administrativo deve ficar fora do repositório, protegido por ACL e conter somente as configurações do recurso aprovado. O Node precisa incluir as dependências de desenvolvimento porque o CLI usa o loader TypeScript existente.

```powershell
node --env-file="<arquivo-privado-administrativo>" scripts/catalog-admin.mjs migrate --dry-run
# Somente depois de autorização explícita:
node --env-file="<arquivo-privado-administrativo>" scripts/catalog-admin.mjs migrate --apply
node --env-file="<arquivo-privado-administrativo>" scripts/catalog-admin.mjs migrate --dry-run
```

O ledger é `catalog_schema_migrations`, independente do Control. O dry-run consulta o ledger e calcula checksum; **não prova que SQL pendente executará**. A execução de SQL foi testada em PostgreSQL real descartável; a confirmação no banco de destino exige aplicação autorizada.

## 3. Senhas iniciais e sessões

- [ ] Criar duas senhas fortes e diferentes, com 14–128 caracteres, exclusivas do ambiente. Não reutilizar exemplos ou senhas de homologação.
- [ ] Guardar os arquivos de bootstrap fora do Git, com acesso restrito, e enviar as senhas aos responsáveis por canal seguro.
- [ ] Provisionar por CLI local autorizado; nunca imprimir senha/hash nem colocar valores na linha de comando.
- [ ] Confirmar os dois papéis habilitados sem consultar/exibir os hashes. Excluir os arquivos de bootstrap quando dispensáveis, preservando as senhas no cofre administrativo.

```powershell
node --env-file="<arquivo-privado-administrativo>" scripts/catalog-admin.mjs password --role admin --password-file "<arquivo-privado-senha-admin>"
node --env-file="<arquivo-privado-administrativo>" scripts/catalog-admin.mjs password --role technician --password-file "<arquivo-privado-senha-tecnico>"
```

O armazenamento usa Argon2id (64 MiB, três iterações, paralelismo 1), nunca texto claro. Troca de senha revoga sessões daquele papel. A sessão administrativa dura uma hora; técnica, quatro horas. Senhas compartilhadas não oferecem identificação individual na auditoria.

## 4. Dados e arquivos

- [ ] Confirmar que o catálogo usa apenas PostgreSQL como fonte de metadados; não copiar fixtures de homologação.
- [ ] Se os três legados forem desejados no destino, autorizar separadamente a importação de dados. Executar `import-legacy --tag tools-v0.1.0 --dry-run`, revisar conflitos/IDs/origens e só depois autorizar `--apply`.
- [ ] Conferir tamanho, formato e SHA-256 reais dos assets; a importação verifica bytes e não executa instaladores.
- [ ] Aprovar/publicar explicitamente as versões importadas. Reexecução preserva edições, remoções e despublicações; não republica automaticamente.
- [ ] Ferramentas restritas usam Blob privado. As URLs oficiais de GitHub Releases públicas continuam públicas; despublicação do portal não revoga esses links.
- [ ] Confirmar upload limitado a EXE/MSI/ZIP, 100 MiB, sem sobrescrita; formato/hash verificado não substitui revisão antimalware/licenciamento pelo administrador.

## 5. Gate de validação antes do merge/promoção

- [ ] Aprovar testes automatizados de catálogo/PostgreSQL, autorização, ESM, Web, Validation, Tools, Control, Release e Diagnosis; typecheck e builds Web/Cliente/Suporte.
- [ ] Validar Preview/homologação Vercel, com sua origem HTTPS exata e recursos isolados, antes de promover produção. Localhost não confirma o empacotamento, a resolução de rewrites ou o binário nativo Argon2 do runtime Linux da Vercel.
- [ ] Confirmar `/api/catalog/session` e demais caminhos da Function sem fallback HTML; confirmar imports ESM `.js`, dependências nativas e autenticação OIDC do Blob no deployment real.
- [ ] Visitante em `/`, `/catalog`, `/tools` e downloads vê somente login; catálogo não é consultado antes da sessão.
- [ ] APIs anônimas retornam 401; técnico tentando cadastrar/editar/publicar/upload/auditoria recebe 403.
- [ ] Login técnico/admin, CSRF, cookies HttpOnly/Secure/SameSite=Strict, expiração, logout e rate limiting funcionam na origem do deployment.
- [ ] Administrador cadastra → envia arquivo inofensivo → confere hash → aprova/publica; técnico consulta/baixa; administrador despublica; novo download retorna 404.
- [ ] URL permanente do Blob privado sem assinatura não permite download. URLs GET emitidas duram até 60 segundos; download já iniciado pode continuar após despublicação.
- [ ] Atualizar/reiniciar preserva sessão e dados; desktop/mobile/console não apresentam erros.
- [ ] Smoke tests independentes de Control/Agent/updater continuam funcionando; não aplicar login do catálogo a esses endpoints.
- [ ] Registrar responsável, commit SHA, deployment, identidades dos recursos e autorização final de merge/promoção. Não habilitar auto-merge.

Os testes novos de catálogo permitem até 90 segundos de espera por `pg_ctl` e 120 segundos por comando da fixture, pois o checkpoint de encerramento em Windows pode ultrapassar 15 segundos. Fsync, verificações funcionais e isolamento do cluster permanecem ativos; os padrões dos testes existentes do Control e timeouts da aplicação não mudam.

## 6. Rollback e contenção

- [ ] Registrar antes da promoção o último deployment **compatível com o acesso obrigatório** e sua configuração de produção. O `main` anterior a este PR possui portal público e não é um rollback aceitável para o requisito atual.
- [ ] Em falha, suspender promoção e novas operações do catálogo. Se houver risco de acesso, revogar/desabilitar os dois papéis pelo CLI administrativo autorizado, mantendo Control/Agent/updater independentes.
- [ ] Se existir baseline segura, reverter/promover manualmente esse deployment somente após conferir origem, recursos e variáveis de **produção**. Não promover Preview nem copiar envs de homologação.
- [ ] Se não existir baseline segura, manter o catálogo indisponível/com acesso negado e corrigir ou preparar manutenção restrita ao portal. Não reabrir o catálogo público nem desligar autenticação como contorno.
- [ ] Não executar down migration/drop/delete automático: preservar tabelas, ledger, auditoria, metadados e arquivos Blob. Esta migration é aditiva; rollback de código não apaga dados.
- [ ] Se precisar restaurar backup, restaurar primeiro em banco separado e validar; troca de recurso/reprocessamento/republicação requer nova autorização.
- [ ] Não apagar objetos órfãos ou assets GitHub durante rollback. Links já emitidos podem expirar naturalmente; links GitHub públicos e cópias já baixadas não são revogáveis pelo catálogo.

Contenção deliberada (não executar sem autorização do recurso):

```powershell
node --env-file="<arquivo-privado-administrativo>" scripts/catalog-admin.mjs revoke --role technician
node --env-file="<arquivo-privado-administrativo>" scripts/catalog-admin.mjs revoke --role admin
```

O comando `revoke` do CLI desabilita o papel e revoga suas sessões; reprovisionar a senha pelo comando `password` é necessário para reativá-lo. A ação Web “Encerrar sessões” apenas revoga sessões, sem desabilitar o papel. Ao trocar `CATALOG_RATE_SECRET`, planejar revogação/relogin dos dois papéis, pois ele também deriva os tokens CSRF. Nenhum rollback deve enfraquecer TLS, cookies, CSRF ou autorização.
