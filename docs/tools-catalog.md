# Catálogo Web administrável

Antes de merge/promoção, seguir o [checklist de implantação e rollback](tools-catalog-deployment.md). Ele exige recursos exclusivos por ambiente e autorização específica para migrations/bootstrap; não executa configuração de produção.

## Entrega incremental

1. Fluxo vertical: duas senhas, sessões isoladas, cadastro, upload privado, verificação, aprovação/publicação, download autorizado e despublicação. Inclui interfaces mínimas de edição, versões, categorias, revogação e auditoria para tornar o fluxo utilizável.
2. Aperfeiçoar gestão em lote, organização de categorias e experiência de manutenção de muitas ferramentas.
3. Ampliar histórico por ferramenta e UX de versões. Integração Desktop em fase posterior.

Não há convites, contas de técnicos, grupos ou Google OAuth no catálogo. O OIDC do Control/Suporte permanece intacto.

## Arquitetura

React Web → `/api/catalog/*` → sessão/CSRF/autorização → PostgreSQL.

Uploads: API autoriza e registra a intenção → browser envia diretamente ao Blob **privado** → backend lê o objeto uma vez, confere tamanho/formato e calcula SHA-256 → administrador aprova/publica.

Downloads: backend verifica sessão, visibilidade e publicação atual → emite URL GET assinada válida por 60 segundos para arquivos no Blob privado → browser baixa diretamente do Blob. Versões legadas importadas do GitHub mantêm a URL oficial pública e são identificadas explicitamente como públicas na origem. Nenhum instalador passa pela Function durante o download.

Todo o portal Web exige sessão do catálogo: `/`, `/catalog`, `/tools`, downloads e demais rotas exibem somente login antes da confirmação da sessão. O administrador tem acesso a todas as ferramentas; técnicos consultam as publicadas autorizadas. Listagens, categorias, downloads e manifesto legado recusam visitantes com HTTP 401. Escritas administrativas do técnico retornam 403. A opção `public` permanece somente como compatibilidade de metadados antigos e significa acesso por técnicos autenticados, nunca visitantes; novos cadastros oferecem somente Técnicos/Administrador. Nenhuma migração é necessária para essa mudança. Control, Agent e updater não recebem este gate e mantêm suas políticas próprias.

## Configuração

Somente no backend: `CATALOG_DATABASE_URL`, `CATALOG_ORIGIN` (origem HTTPS exata), `CATALOG_RATE_SECRET` (aleatório, mínimo 32 caracteres), `BLOB_STORE_ID` e credenciais Blob injetadas pela Vercel. TLS PostgreSQL com verificação de certificado; desabilitação permitida pelo validador existente apenas em loopback para testes locais. A URL Neon com `sslmode=require` ou `verify-full` é normalizada antes de criar o pool: o flag é removido e TLS com certificado verificado continua obrigatório. Outros overrides SSL na URL são recusados.

Usar banco separado para homologação. A migração `server/catalog/migrations/001_catalog.sql` usa ledger `catalog_schema_migrations`, separado do Control. Nunca altera as quatro migrações existentes. Revisar antes de aplicar; dry-run não executa/parsa o SQL pendente.

```powershell
# Defina as variáveis no processo local por um canal seguro, sem imprimir valores.
# CATALOG_ADMIN_ENABLED=1 apenas no processo administrativo local.
npm.cmd run catalog:admin -- migrate --dry-run
npm.cmd run catalog:admin -- migrate --apply
npm.cmd run catalog:admin -- password --role admin --password-file <arquivo-privado-fora-do-repositorio>
npm.cmd run catalog:admin -- password --role technician --password-file <outro-arquivo-privado>
```

O CLI recusa uso sem `CATALOG_ADMIN_ENABLED=1`. Senhas de 14 a 128 caracteres, diferentes entre os papéis, hash Argon2id (64 MiB, 3 iterações, paralelismo 1). Não há senha padrão. Nunca inserir senhas, hashes operacionais ou URLs de banco no Git. Excluir os arquivos de senha após o bootstrap seguro.

Depois do bootstrap, o painel permite trocar senhas e encerrar sessões. Rotação incrementa a geração da credencial e remove todas as sessões daquele papel. Recuperação fora da Web:

```powershell
npm.cmd run catalog:admin -- revoke --role admin
npm.cmd run catalog:admin -- password --role admin --password-file <novo-arquivo-privado>
```

Cookies separados `__Secure-central_sos_catalog`: HttpOnly, Secure, SameSite=Strict, Path=/api; administrador expira em 1 hora, técnico em 4 horas. O caminho inclui o manifesto legado, sem conceder acesso ao Control, que usa autenticação independente. O cookie antigo em `/api/catalog` é removido ao entrar. Logout remove a sessão persistida. Nenhum token fica em localStorage. Mutações exigem Origin exata e token CSRF da sessão; login exige JSON e Origin exata. Limites persistidos: 5 tentativas por fonte/5 minutos e 100 por papel/5 minutos; 60 operações autenticadas por sessão/minuto. No Vercel usa-se o header de IP sobrescrito pela plataforma; fora dele, o endereço do socket.

## Arquivos e aprovação

Formatos iniciais EXE, MSI e ZIP, até 100 MiB. Caminho único por versão, tamanho limitado na URL PUT e sobrescrita desabilitada. A verificação usa bytes (PE, contêiner MSI ou ZIP), tamanho exato e SHA-256 calculado no servidor; não aceita URL, caminho ou hash enviados pelo cliente. Essa verificação **não é análise antimalware**: a aprovação é responsabilidade explícita do administrador.

Intenção de upload expira em 20 minutos; URL PUT em 10 minutos. Arquivo verificado não fica disponível automaticamente. O painel oferece “Verificar envio” para finalizar um envio cujo retorno tenha falhado. Versões duplicadas são recusadas e não substituem silenciosamente arquivos. Intenções expiradas precisam de atendimento administrativo; objetos órfãos devem ser identificados antes de futura limpeza, nunca apagados automaticamente nesta entrega.

Despublicação/exclusão lógica bloqueiam novas URLs; URLs anteriormente emitidas podem funcionar até expirar, e downloads já iniciados podem continuar. URLs assinadas são credenciais temporárias: não registrar em logs, histórico, analytics ou auditoria. Copiar a URL permanente de um Blob privado não dá acesso; copiar uma URL assinada permite acesso durante sua validade.

Auditoria identifica papel e referência irreversível de sessão. **Senhas compartilhadas não identificam individualmente o técnico/administrador.** Registros administrativos preservam ações e referências de ferramentas/versões, sem registrar senha, token ou URL assinada.

## Catálogo legado

Existe uma única listagem, na home `/`, depois de confirmar a sessão. O hero e a identidade visual do portal permanecem; ferramentas, categorias e versões vêm somente do PostgreSQL. Técnicos e administradores veem os mesmos cards, com ações de gestão exclusivas do administrador. `/catalog` redireciona para `/`; `/tools` e `/installations` para `/#tools`. Não há outra consulta/listagem GitHub de ferramentas na home. O serviço legado é preservado para compatibilidade e importação administrativa, sem montar um segundo catálogo Web.

A incorporação usa o manifesto oficial e identidade determinística por repositório/ID original e por `(repositório, tag, assetName)`. Não exige alteração de schema: a referência canônica da origem é preservada na versão, e a API expõe apenas a origem tipada, sem caminhos de Blob. Nomes conflitantes exigem mapeamento explícito; divergências de arquivo, tamanho, hash ou proprietário são recusadas. A reexecução preserva edições, exclusões lógicas e despublicações; não republica nem restaura silenciosamente. Novas versões importadas ficam verificadas, mas aguardam aprovação/publicação explícita.

```powershell
# Apenas no processo administrativo, com configuração privada de homologação.
# CATALOG_ADMIN_ENABLED=1 é obrigatório.
npm.cmd run catalog:admin -- import-legacy --tag tools-v0.1.0 --dry-run
# Executar somente após autorização da importação de dados:
npm.cmd run catalog:admin -- import-legacy --tag tools-v0.1.0 --apply
# Conflitos já revisados podem usar --mapping-file <arquivo-de-mapeamento>.
```

O dry-run não escreve dados nem baixa instaladores. O apply confere os bytes dos assets oficiais, tamanho, formato e SHA-256 antes da transação de escrita, aceita redirects somente nos hosts oficiais previstos e revalida conflitos dentro da transação. Não executa os arquivos. Não há endpoint HTTP de importação ou importação automática no startup.

Na homologação, a importação e publicação de Firebird 2.5.9.27139, IBOConsole 1.1.9.6 e Nuvem Contábil 1.0.29 foram autorizadas pelo usuário. Os três hashes reais foram conferidos e as versões foram publicadas no mesmo catálogo persistente. Nenhum schema, Release ou asset GitHub foi alterado. Arquivos de GitHub Releases públicos continuam públicos independentemente das permissões do catálogo; despublicar bloqueia a emissão de novos links pelo portal, mas não revoga a URL pública original. Ferramenta realmente restrita deve usar Blob privado.

Verificação de homologação: HEAD anônimo dos assets Firebird-2.5.9.27139_0_x64.exe, Iboconsole.exe e nuvem_contabil_1_0_29.exe em tools-v0.1.0 retornou HTTP 200. Para restrição efetiva, é necessário cadastrar versões no Blob privado, conferir hashes e autorização, migrar as referências e tratar separadamente a retirada dos assets públicos, com autorização. Arquivos que já foram baixados não podem ser revogados retroativamente. Nenhum asset ou Release existente foi alterado nesta correção.

## Testes e prévia

```powershell
npm.cmd run test:catalog
$env:CONTROL_TEST_POSTGRES_BIN='<pasta-de-binarios-PostgreSQL>'
npm.cmd run test:catalog:integration
# Opcional e explícito: store privado exclusivamente de homologação, credenciais locais ignoradas.
$env:CATALOG_TEST_REAL_BLOB='1'
node --env-file=<arquivo-local-de-credenciais-Blob> --test tests/catalog-integration/Catalog.test.mjs
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:web
npm.cmd run test:tools
npm.cmd run test:validation
npm.cmd run test:control
git diff --check
```

O teste PostgreSQL cria seu próprio cluster local descartável; nunca usa um banco existente. O modo normal usa fixture de transporte de arquivos; a opção explícita de Blob valida upload/download e negação sem assinatura no armazenamento real. Arquivos inofensivos de teste não são ferramentas homologadas.

## Desenvolvimento conjunto com os recursos de homologação existentes

Na worktree `codex/tools-password-catalog`, execute:

```powershell
npm.cmd run dev:web -- --port 1423
# Equivalente: npm.cmd run catalog:dev
```

Abre `https://localhost:1423/`; `/catalog` continua como alias. Um processo inicia a API (HTTP interno em 127.0.0.1:1432) antes do Vite HTTPS (127.0.0.1:1423); Ctrl+C encerra os dois. O browser usa somente a origem HTTPS do frontend, inclusive login/cookies/CSRF. Não há autenticação simplificada nem cookie inseguro para desenvolvimento.

A configuração ignorada `.control-build/catalog-development.local.json` contém somente caminhos para `envFile`, `rateSecretFile`, `tlsKey`, `tlsCert`, e identificação explícita de `projectId`, `neonProjectId`, `blobStoreId`, `team` e `vercelCli`. `CATALOG_DEV_CONFIG` pode indicar outro arquivo privado. O launcher verifica o vínculo exclusivamente com `centralsos-2xh9` e os IDs do Neon/Blob de homologação, carrega apenas variáveis server-side e faz uma consulta de prontidão somente leitura. **Não executa migração, bootstrap, rotação nem apaga dados no startup.** Os mesmos dados e sessões persistem após reiniciar.

O Blob usa o OIDC de desenvolvimento existente. Quando próximo de expirar, o launcher utiliza a CLI já autenticada para **ler** `development` do mesmo projeto, salvando o resultado em arquivo privado ao lado do segredo local. Não modifica variáveis remotas nem faz deployment. Falha de login CLI/configuração interrompe o startup com código sanitizado. Nenhum segredo usa prefixo `VITE_`.

TLS local: certificado mkcert para localhost/127.0.0.1; chaves e CA fora do Git. A CA deve ser instalada pelo usuário no armazenamento de confiança de seu perfil, após conferir a impressão digital. O launcher nunca instala autoridades certificadoras nem ignora erros TLS. A configuração HTTPS de produção não muda.

O frontend trata respostas vazias, HTML, indisponibilidade e falhas de rede com mensagens compreensíveis. O proxy retorna JSON/503 se a API estiver indisponível. Logs contêm método, status e tempo; falhas desconhecidas podem incluir apenas códigos sanitizados de conexão/banco, sem SQL, body, cookie, URL assinada, senha ou conexão PostgreSQL. Aprovação e remoção lógica usam confirmação em dois passos dentro do card, sem diálogo nativo que possa bloquear a WebView de teste.

### Homologação realizada

Na home unificada, o administrador criou “Teste catálogo único — ZIP inofensivo”, enviou ZIP vazio de 22 bytes ao Blob privado, publicou mediante confirmação no card e editou a categoria. O técnico consultou e baixou o arquivo; o SHA-256 do download coincidiu com o upload. Após despublicar pela mesma home, uma sessão técnica ainda válida recebeu 404 para novo download. A ferramenta de teste foi deixada despublicada, com histórico/arquivo preservados. Reiniciar frontend/API preservou a sessão, os metadados, a categoria editada e o estado despublicado. O dry-run posterior confirmou os três legados já importados, sem duplicação. As capturas mostram login, home, catálogo do técnico e ações administrativas; layouts desktop/mobile não apresentaram overflow horizontal. Uma resposta 503 anterior não se repetiu no ciclo completo de homologação; sua causa específica não foi confirmada.

No navegador, foram confirmados os dois logins, cadastro de uma ferramenta de teste, upload de ZIP vazio de 22 bytes para o Blob privado, verificação de SHA-256, aprovação/publicação, download técnico e despublicação. O download gravado em Downloads foi comparado byte a byte com o upload. A sessão técnica válida recebeu HTTP 404 ao solicitar novo download após despublicação; sem sessão, endpoints do catálogo/manifesto retornaram 401; operações administrativas do técnico retornaram 403. Logout invalidou a sessão persistida. O cadastro, arquivo e publicação sobreviveram à reinicialização do processo, sem migração ou bootstrap no Neon.

As rotas `/`, `/catalog`, `/tools`, `/download/client` e `/download/support` exibiram somente login para visitante. Layouts foram verificados no navegador em 1280 px e 390 px, sem overflow horizontal. Ctrl+C fechou os listeners de API e frontend, que foram reiniciados pelo mesmo comando. A ferramenta inofensiva de teste local foi deixada despublicada para novo teste manual; não é um instalador homologado. Credenciais permanecem nos arquivos privados existentes, sem serem apresentadas em screenshots ou logs.

Para Preview Vercel, conectar store privado e definir variáveis apenas no projeto/ambiente de homologação. Não implantar em produção, executar migrações fora desse recurso ou fazer merge sem autorização.

A prévia local completa usa `node --env-file=<credenciais-Blob-locais> scripts/catalog-preview.mjs`, com `CONTROL_TEST_POSTGRES_BIN`, `CATALOG_PREVIEW_TLS_KEY` e `CATALOG_PREVIEW_TLS_CERT` fornecidos no processo. Ela cria um novo cluster PostgreSQL local e senhas aleatórias em um diretório privado fora do repositório; não usa Neon nem altera banco existente. Ouve `https://localhost:1442/catalog`. Certificado local deve ser reconhecido pelo usuário; não há desativação automática da validação TLS. Encerrar o processo fecha o cluster; a prévia não é um serviço Windows instalado.

A Function de catálogo tem limite de 120 segundos; a leitura/verificação do arquivo tem timeout próprio de 60 segundos. A `.vercelignore` exclui credenciais locais, artefatos, binários Rust e arquivos de teste locais do upload da prévia. Nenhuma variável `CATALOG_*` deve usar o prefixo `VITE_`.
