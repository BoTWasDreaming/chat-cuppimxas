# Cuppimxas

Chat em HTML, CSS e JavaScript, integrado ao Firebase Realtime Database existente. Não precisa de build para publicar.

## Abrir localmente

Na pasta que contém `index.html`:

```sh
python -m http.server 4173 --bind 127.0.0.1
```

Abra `http://127.0.0.1:4173`. Use um servidor HTTP, pois o JavaScript usa módulos e não deve ser aberto por `file://`. O chat real precisa de internet para carregar o SDK do Firebase e acessar o banco.

Para atualizar a hospedagem, envie juntos `index.html`, `app.js`, `notifications.js`, `styles.css`, `theme.css` e `logo.png`. O HTML agora compartilha código e estilos em arquivos separados. Não basta enviar apenas o HTML.

## Funcionalidades

- Visual responsivo para computador e celular, painel lateral e composição de mensagens.
- Resposta por duplo clique, dois toques ou botão ↩. A citação abre a mensagem original quando ela ainda existe.
- Seis figurinhas prontas e até 24 figurinhas pessoais por conta, sincronizadas no Firebase em `stickers/{username}/{id}`. Adições e exclusões são feitas por figurinha e atualizadas em tempo real, sem substituir a biblioteca inteira. As figurinhas locais da versão anterior são importadas ao entrar; a cópia local só é removida depois da confirmação do servidor.
- Todas as figurinhas têm apresentação quadrada. Imagens estáticas importadas são recortadas ao centro em 384 × 384 e convertidas para WebP. GIFs de até 2 MB mantêm seus bytes e todos os quadros da animação, com recorte quadrado apenas na apresentação, sem conversão para imagem estática.
- Um clique na figurinha envia uma mensagem independente imediatamente, sem usar a prévia de anexos nem exigir o botão de envio. Texto e foto em rascunho são preservados e não acompanham a figurinha. A resposta selecionada pode acompanhar esse envio. Cliques repetidos durante o envio são bloqueados; em caso de falha, o painel reabre para tentar novamente.
- Anexos com prévia quadrada de 88 × 88 e botão de remoção no canto superior direito. No balão, fotos mantêm a proporção original, sem recorte, dentro dos limites de largura e altura da conversa. Fotos podem ser escolhidas ou coladas, recebem compressão e podem ter legenda. Limite de entrada de 10 MB para PNG, JPEG e WebP; GIFs animados de até 2 MB. Clicar na foto abre a visualização ampliada.
- Os controles de responder e apagar ficam ao lado do balão, centralizados na vertical: à direita de mensagens recebidas e à esquerda das próprias mensagens. Aparecem ao passar o mouse ou focar pelo teclado; no celular, um toque na mensagem revela as ações. A aparição não desloca os balões.
- Mensagens consecutivas da mesma pessoa, no mesmo dia, mostram foto, nome e horário apenas na primeira mensagem. Mudanças de remetente, dia ou avisos do sistema iniciam um novo grupo e exibem o horário novamente. A exclusão de mensagens recalcula o agrupamento automaticamente.
- Rolagem inicial até o fim, inclusive após imagens carregarem. Quem estiver lendo o histórico mantém a posição; a seta mostra quantas mensagens chegaram e leva à última.
- Rascunhos por conversa durante a sessão. Envios repetidos são bloqueados e falhas preservam texto, resposta e anexo.
- Som de duas notas e notificação nativa do navegador para mensagens novas recebidas com a aba oculta ou a janela sem foco. Acompanha geral, grupos, mensagens diretas com amigos e DMs abertas na sessão. O primeiro carregamento do histórico, edições, mensagens de sistema e mensagens próprias não geram alertas. Rajadas de mensagens tocam no máximo um som a cada 1,5 segundo e substituem o popup anterior.
- O sino no rodapé permite solicitar permissão para popups e desativar/reativar alertas. A escolha de ativação fica por conta neste navegador. O som é liberado por interação com a página; popups exigem permissão e HTTPS (ou localhost), e dependem do suporte do navegador. Permissão negada mantém o som disponível. Retornar ao chat fecha o popup e limpa a contagem de mensagens. Sair da conta fecha notificações, encerra o áudio e remove todos os ouvintes, impedindo alertas após logout.
- Administração com busca, filtros, contadores e atualizações em tempo real; edição de nome, moderadores, administradores, banimento, exclusão e recuperação de senha. Administradores promovidos continuam visíveis e podem ter o acesso revogado. O único dono automático é `manobotkk`; `rei_chikit0` foi removido dessa lista. Permissões administrativas concedidas separadamente por `users/{username}/isAdmin` continuam gerenciáveis no painel. A conta fundadora e a própria conta são protegidas contra alterações administrativas pelo painel.
- Encerramento dos ouvintes do banco ao sair, presença após reconexão, validação de nomes de usuário e renderização segura de texto e links.

Os campos adicionais das mensagens são opcionais: `replyTo: { key, user, display, text }` e `sticker: { id, name, image? }`. Mensagens antigas de texto e foto continuam sendo exibidas.

## Verificação

```sh
npm install
npm run check
npm test
```

Os testes usam o Microsoft Edge instalado no caminho padrão do Windows. Em outros ambientes, instale o Chromium do Playwright com `npx playwright install chromium`.

A suíte inicia seu próprio servidor, intercepta o Firebase e usa dados simulados. **Nenhuma conta, conversa ou permissão real é alterada pelos testes.** As capturas ficam em `test-results/`, ignorado pelo Git.

Notificações e áudio são simulados nos testes, sem produzir sons ou popups do sistema operacional. Os testes verificam mensagens em segundo plano, canal não aberto, DM, permissão negada, clique para abrir a conversa, silêncio em primeiro plano, notificações desativadas, fechamento ao retornar/sair, limpeza dos ouvintes e reentrada sem alertar o histórico. A apresentação nativa final depende das permissões e configurações do navegador/sistema operacional.

Os alertas funcionam com a página aberta em segundo plano. Receber com a aba ou o navegador totalmente fechado exige push no servidor e um service worker, que não fazem parte da integração atual.

Cobertura: histórico longo e imagens atrasadas, respostas e dois toques em fotos, posição de leitura e contador, anexos quadrados removíveis, falhas de envio, GIFs preservados, biblioteca remota e atualizações em tempo real, migração local com falha/repetição, separação de bibliotecas por conta, remoção do dono automático, rascunhos e troca de canal durante envio, promoção/revogação de administradores, conteúdo HTML malicioso, limpeza de ouvintes ao sair e posição dos controles em computador e celular.

## Limite da integração existente

O projeto recebido usa autenticação legada: compara SHA-256 de senha no navegador e lê dados de usuários no Realtime Database. **Isso não equivale a autenticação e autorização no servidor.** As verificações de administrador e banimento na interface não substituem regras do banco.

As regras do Firebase e um backend de autenticação não estão incluídos neste repositório. Esta alteração preserva as contas e o formato existentes; não modifica regras nem migra credenciais. A segurança das permissões exige uma migração para Firebase Authentication (ou backend autenticado), com regras que autorizem cada operação e separem perfis públicos de credenciais e dados privados. O funcionamento contra o Firebase real e suas permissões precisa ser validado no ambiente de hospedagem.

A sincronização de figurinhas requer leitura e escrita no caminho `stickers/{username}` para a conta correspondente. Na verificação HTTP anterior somente de leitura, `stickers/manobotkk.json?shallow=true` retornou **401 / Permission denied**. As regras fornecidas na conversa não incluíam o nó `stickers`; a publicação das regras desse nó deve ser feita no Firebase Console.

O botão “+ Criar” permite escolher e preparar uma figurinha mesmo quando a biblioteca não carrega. Se o salvamento falhar, o botão “Enviar figurinha” permite enviá-la diretamente, acompanhado de um aviso explícito de que **não foi salva na conta**. Ela não é anexada ao campo de mensagem. A imagem preparada é mantida na memória da sessão para permitir tentar salvar novamente, sem recorrer a uma biblioteca apenas local. “Tentar reconectar” refaz a assinatura da biblioteca depois de corrigida a conexão ou a permissão; “Salvar na conta novamente” repete o salvamento da imagem preparada. Sair da conta encerra essas tentativas e limpa o estado da sessão.

As regras de acesso devem validar a identidade no servidor; não libere escrita pública para contornar esse erro.
