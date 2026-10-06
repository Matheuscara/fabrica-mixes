# Security policy

[English](SECURITY.md) | [Português (Brasil)](SECURITY.pt-BR.md) · Project overview: [README](README.md) | [README em português](README.pt-BR.md)

## Supported versions

Only the `main` branch receives fixes. Update with `git pull && docker compose up -d --build`
before reporting a problem.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Older commits and forks | No |

## Security model

Fábrica de Mixes is built for personal use on a trusted machine or network.

- **There is no authentication or access control.** Any person or program that can reach the port
  can upload files, change channels, approve renders, and delete songs, visuals, videos, and channels.
- **There is no CSRF protection.** A malicious page opened in a browser that can reach the site can
  submit forms to it. Do not browse unknown sites in the same browser/profile you use to access
  Fábrica, or protect access with a proxy that requires login.
- **Uploaded files are processed by ffmpeg.** Malicious media can exploit decoding bugs. Upload only
  your own files and rebuild the image often to keep ffmpeg up to date.
- **Large uploads can fill the disk** (default limit of 4 GB per file, `MAX_UPLOAD_MB`).

## Deploying safely

- Keep the default `BIND_HOST=127.0.0.1` and access the app through an SSH tunnel, a VPN, or a
  reverse proxy with login (SSO, oauth2-proxy, Authelia, basic authentication, etc.).
- **Never** use `BIND_HOST=0.0.0.0`, forward the port on your router, or publish the service to the
  internet, and do not leave it reachable on untrusted networks (public Wi-Fi, shared networks).
- On a local network, set `BIND_HOST` to the IP of the right interface and use a firewall that allows
  only the devices you need. Docker publishes ports with its own iptables rules, which can bypass
  `ufw`/firewalld; use the `DOCKER-USER` chain if you need filtering.
- When running without Docker, the Node process listens on all interfaces: block the port in your
  firewall.
- Back up the data folder (see the [README](README.md)) — the lack of authentication means that
  unauthorized access can delete everything.

## Reporting a vulnerability

**Do not open a public issue** for security problems.

Use GitHub private reporting: the repository's **Security → Report a vulnerability** tab
(<https://github.com/Matheuscara/fabrica-mixes/security/advisories/new>). Include:

- what happens and what the impact is;
- steps to reproduce (commit used, `.env` configuration without secrets, requests or files);
- if possible, a suggested fix.

This is a personal project with no guaranteed response time. Once the fix lands on `main`, the
advisory is published with credit to the reporter, if they wish.

The lack of login and CSRF protection described above is a known, documented limitation, not a new
vulnerability. Reports about how the app behaves when exposed beyond what this document recommends
are also out of scope. Do report, for example: access to files outside the data folder (path
traversal), command execution, XSS in the pages, or flaws that affect the host beyond the container.
