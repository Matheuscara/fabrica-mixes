# Política de segurança

[English](SECURITY.md) | [Português (Brasil)](SECURITY.pt-BR.md) · Visão geral do projeto: [README em português](README.pt-BR.md) | [README in English](README.md)

## Versões suportadas

Só a branch `main` recebe correções. Atualize com `git pull && docker compose up -d --build`
antes de relatar um problema.

| Versão | Suportada |
| --- | --- |
| `main` | Sim |
| Commits e forks antigos | Não |

## Modelo de segurança

A Fábrica de Mixes foi feita para uso pessoal, numa máquina ou rede de confiança.

- **Não há autenticação nem controle de acesso.** Qualquer pessoa ou programa que alcance a porta
  pode enviar arquivos, alterar canais, aprovar renders e excluir músicas, visuais, vídeos e canais.
- **Não há proteção contra CSRF.** Uma página maliciosa aberta num navegador que alcança o site pode
  enviar formulários para ele. Não navegue em sites desconhecidos no mesmo navegador/perfil que usa
  para acessar a Fábrica, ou proteja o acesso com um proxy que exija login.
- **Os arquivos enviados são processados pelo ffmpeg.** Mídia maliciosa pode explorar falhas de
  decodificação. Envie só arquivos seus e reconstrua a imagem com frequência para atualizar o ffmpeg.
- **Uploads grandes podem encher o disco** (limite padrão de 4 GB por arquivo, `MAX_UPLOAD_MB`).

## Como implantar com segurança

- Mantenha o padrão `BIND_HOST=127.0.0.1` e acesse por túnel SSH, VPN ou proxy reverso com login
  (SSO, oauth2-proxy, Authelia, autenticação básica etc.).
- **Nunca** use `BIND_HOST=0.0.0.0`, encaminhe a porta no roteador ou publique o serviço na internet,
  nem o deixe acessível em redes não confiáveis (Wi-Fi público, rede compartilhada).
- Em rede local, use o IP da interface certa em `BIND_HOST` e um firewall que libere só os
  dispositivos necessários. O Docker publica portas com regras próprias de iptables, que podem passar
  por cima do `ufw`/firewalld; use a cadeia `DOCKER-USER` se precisar filtrar.
- Rodando sem Docker, o processo Node escuta em todas as interfaces: bloqueie a porta no firewall.
- Faça backups da pasta de dados (veja o [README](README.pt-BR.md)) — a falta de autenticação
  significa que um acesso indevido pode apagar tudo.

## Como relatar uma vulnerabilidade

**Não abra issue pública** para falhas de segurança.

Use o relato privado do GitHub: aba **Security → Report a vulnerability** do repositório
(<https://github.com/Matheuscara/fabrica-mixes/security/advisories/new>). Inclua:

- o que acontece e qual o impacto;
- passos para reproduzir (commit usado, configuração do `.env` sem segredos, requisições ou arquivos);
- se possível, uma sugestão de correção.

Este é um projeto pessoal, sem prazo garantido de resposta. Depois da correção na `main`, o aviso é
publicado com crédito a quem relatou, se desejar.

A ausência de login e de proteção CSRF descrita acima é uma limitação conhecida e documentada, não
uma vulnerabilidade nova. Relatos sobre como o app se comporta exposto além do que este documento
recomenda também ficam fora do escopo. Relate, por exemplo: acesso a arquivos fora da pasta de dados
(path traversal), execução de comandos, XSS nas páginas, ou falhas que afetem o host além do container.
