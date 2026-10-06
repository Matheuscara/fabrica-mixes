// Fábrica de Mixes: progresso ao vivo, upload com arrastar/soltar, confirmações.
'use strict'

const initialSig = document.body.dataset.sig
const uploadBox = document.querySelector('[data-upload]')
let leaving = false // formulário enviado: a página já vai trocar sozinha

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

// ── Edição em andamento: nunca recarregar por cima ────────────────────
// Em vez de marcar o formulário como "sujo" pra sempre no primeiro evento, compara o valor
// atual com o que veio do servidor: desfez a edição, a página volta a se atualizar sozinha.
const FIELD = 'input, select, textarea'
const TYPING_GRACE_MS = 15000
let lastFieldActivity = 0

for (const type of ['input', 'change', 'keydown', 'focusin']) {
  document.addEventListener(
    type,
    e => {
      if (e.target.matches?.(FIELD)) lastFieldActivity = Date.now()
    },
    true,
  )
}

function changed(field) {
  if (field.disabled || field.readOnly) return false
  switch (field.type) {
    case 'checkbox':
    case 'radio':
      return field.checked !== field.defaultChecked
    case 'select-one': {
      // Sem `selected` no HTML, o padrão é a primeira opção habilitada.
      let initial = -1
      for (const [i, option] of [...field.options].entries()) if (option.defaultSelected) initial = i
      if (initial < 0 && field.size <= 1) initial = [...field.options].findIndex(o => !o.disabled)
      return field.selectedIndex !== initial
    }
    case 'select-multiple':
      return [...field.options].some(o => o.selected !== o.defaultSelected)
    case 'file':
    case 'hidden':
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
      return false
    default:
      return typeof field.defaultValue === 'string' && field.value !== field.defaultValue
  }
}

// O formulário de upload fica de fora: o estilo é guardado na sessão e os campos de arquivo se esvaziam.
function unsavedForms() {
  return [...document.forms].filter(form => form !== uploadBox && [...form.elements].some(changed))
}

function typingNow() {
  const active = document.activeElement
  return !!active?.matches?.(FIELD) && active.type !== 'file' && Date.now() - lastFieldActivity < TYPING_GRACE_MS
}

function reloadPage() {
  if (unsavedForms().length && !confirm('Você tem alterações não salvas. Atualizar a página mesmo assim e descartá-las?')) return
  location.reload()
}

// ── Progresso + recarregar quando algo muda no servidor ───────────────
const POLL_MS = 3000
let pollTimer = 0
let polling = false
let staleNotice = null
let staleDismissed = false

async function poll() {
  clearTimeout(pollTimer)
  if (polling) return
  polling = true
  try {
    const res = await fetch('/api/poll', { cache: 'no-store', headers: { accept: 'application/json' } })
    if (res.ok) {
      const state = await res.json()
      showProgress(state.progress ?? {})
      if (state.sig !== initialSig) serverChanged()
    }
  } catch {
    // servidor reiniciando ou rede oscilando; tenta de novo
  } finally {
    polling = false
  }
  schedulePoll()
}

function schedulePoll() {
  clearTimeout(pollTimer)
  if (!document.hidden) pollTimer = setTimeout(poll, POLL_MS)
}

// Aba escondida (celular bloqueado, outra aba) não gasta rede; ao voltar, confere na hora.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(pollTimer)
  else poll()
})
addEventListener('pageshow', e => {
  if (!e.persisted) return
  leaving = false
  poll()
})
schedulePoll()

document.addEventListener('play', event => {
  if (!event.target.matches?.('audio.song-audio')) return
  for (const audio of document.querySelectorAll('audio.song-audio')) {
    if (audio !== event.target) audio.pause()
  }
}, true)

function showProgress(progress) {
  for (const [id, pct] of Object.entries(progress)) {
    for (const bar of document.querySelectorAll(`[data-progress="${id}"]`)) {
      const fill = bar.querySelector(':scope > span')
      if (fill) fill.style.width = `${pct}%`
      if (bar.getAttribute('role') === 'progressbar') bar.setAttribute('aria-valuenow', pct)
    }
    for (const text of document.querySelectorAll(`[data-progress-text="${id}"]`)) text.textContent = `${pct}%`
  }
}

function serverChanged() {
  if (leaving || upload?.holdsPage()) return // o resumo do upload tem o próprio botão de atualizar
  if (unsavedForms().length) {
    showStale()
    return
  }
  if (typingNow()) return // espera a pessoa parar de digitar
  if ([...document.querySelectorAll('audio, video')].some(media => !media.paused && !media.ended)) {
    showStale('Há novidades no servidor. Atualize quando terminar de ouvir.')
    return
  }
  location.reload()
}

function showStale(message = 'Há novidades no servidor. A página espera você salvar ou desfazer a edição.') {
  if (staleNotice || staleDismissed) return
  staleNotice = el('p', 'toast stale')
  staleNotice.setAttribute('role', 'status')
  const button = el('button', '', 'Atualizar agora')
  button.type = 'button'
  button.addEventListener('click', e => {
    e.stopPropagation()
    reloadPage()
  })
  staleNotice.append(el('span', '', message), button)
  staleNotice.addEventListener('click', () => {
    staleNotice.remove()
    staleNotice = null
    staleDismissed = true
  })
  ;(document.querySelector('main') || document.body).append(staleNotice)
}

// ── Avisos: some sozinho (erro fica até clicar) e sai da URL pra não voltar no F5 ──
for (const toast of document.querySelectorAll('.toast')) {
  toast.addEventListener('click', () => toast.remove())
  if (toast.classList.contains('ok')) setTimeout(() => toast.remove(), 6000)
}
if (/[?&](msg|err)=/.test(location.search)) {
  const url = new URL(location.href)
  url.searchParams.delete('msg')
  url.searchParams.delete('err')
  history.replaceState(null, '', url)
}

// ── Confirmações e copiar ─────────────────────────────────────────────
document.addEventListener('submit', e => {
  const msg = e.target.dataset.confirm
  if (msg && !confirm(msg)) e.preventDefault()
  if (!e.defaultPrevented) leaving = true
})

for (const btn of document.querySelectorAll('[data-copy]')) {
  const label = btn.textContent
  let restore = 0
  btn.addEventListener('click', async () => {
    const field = document.getElementById(btn.dataset.copy)
    if (!field) return
    let copied = false
    try {
      await navigator.clipboard.writeText(field.value)
      copied = true
    } catch {
      // http sem TLS (rede local) não tem clipboard API: cai pro jeito antigo
      field.focus()
      field.select()
      field.setSelectionRange?.(0, field.value.length)
      try {
        copied = document.execCommand('copy')
      } catch {
        copied = false
      }
    }
    btn.textContent = copied ? 'Copiado!' : 'Texto selecionado: copie manualmente'
    clearTimeout(restore)
    restore = setTimeout(() => (btn.textContent = label), 2500)
  })
}

// ── <details> abertos sobrevivem ao recarregar ────────────────────────
const openKey = `open:${location.pathname}`
const openSet = new Set(JSON.parse(sessionStorage.getItem(openKey) || '[]'))
for (const d of document.querySelectorAll('details[data-key]')) {
  if (openSet.has(d.dataset.key)) d.open = true
  d.addEventListener('toggle', () => {
    if (d.open) openSet.add(d.dataset.key)
    else openSet.delete(d.dataset.key)
    sessionStorage.setItem(openKey, JSON.stringify([...openSet]))
  })
}

// Ao salvar/criar um prompt, o redirecionamento aponta para o estilo editado.
if (location.hash.startsWith('#style-')) {
  const selected = document.getElementById(location.hash.slice(1))
  if (selected?.matches('details[data-key]')) {
    selected.open = true
    selected.scrollIntoView({ block: 'start' })
  }
}

// ── Menu lateral do canal (no celular vira gaveta) ────────────────────
const sidebar = document.getElementById('channel-nav')
const sidebarToggle = document.querySelector('.sidebar-toggle')
if (sidebar && sidebarToggle) setupSidebar(sidebar, sidebarToggle, document.querySelector('.sidebar-backdrop'))

function setupSidebar(nav, toggle, backdrop) {
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  // O CSS decide o ponto de quebra: se o botão ☰ aparece, o menu é gaveta.
  const isDrawer = () => toggle.getClientRects().length > 0
  const isOpen = () => document.body.classList.contains('sidebar-open')
  const sync = () => {
    // Gaveta fechada fica fora do Tab e dos leitores de tela; no desktop o menu é sempre navegável.
    nav.inert = isDrawer() && !isOpen()
  }

  function open() {
    document.body.classList.add('sidebar-open')
    toggle.setAttribute('aria-expanded', 'true')
    toggle.setAttribute('aria-label', 'Fechar menu do canal')
    sync()
    const target = nav.querySelector('[aria-current="page"]') || nav.querySelector(FOCUSABLE)
    target?.focus()
  }

  function close(restoreFocus) {
    if (!isOpen()) return
    document.body.classList.remove('sidebar-open')
    toggle.setAttribute('aria-expanded', 'false')
    toggle.setAttribute('aria-label', 'Abrir menu do canal')
    sync()
    if (restoreFocus && isDrawer()) toggle.focus()
  }

  toggle.addEventListener('click', () => (isOpen() ? close(true) : open()))
  backdrop?.addEventListener('click', () => close(true))
  nav.querySelector('.sidebar-close')?.addEventListener('click', () => close(true))
  nav.addEventListener('click', e => {
    if (e.target.closest('a[href]')) close(false)
  })

  document.addEventListener('keydown', e => {
    if (!isOpen() || !isDrawer()) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
      return
    }
    if (e.key !== 'Tab') return
    const items = [...nav.querySelectorAll(FOCUSABLE)].filter(item => item.getClientRects().length)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    const inside = nav.contains(document.activeElement)
    if (e.shiftKey && (!inside || document.activeElement === first)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
      e.preventDefault()
      first.focus()
    }
  })

  addEventListener('resize', () => {
    if (!isDrawer()) close(false)
    sync()
  })
  // Voltar pelo histórico (bfcache) não pode reabrir a página com a gaveta aberta.
  addEventListener('pageshow', () => close(false))
  sync()
}

// Gráficos entram uma vez ao aparecer na tela; sem JS ou com movimento reduzido, continuam visíveis.
const charts = document.querySelector('.chart-grid')
if (charts && 'IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  charts.classList.add('will-animate')
  const observer = new IntersectionObserver(entries => {
    if (!entries[0]?.isIntersecting) return
    charts.classList.add('in-view')
    observer.disconnect()
  }, { threshold: 0.1 })
  observer.observe(charts)
}

// ── Upload ────────────────────────────────────────────────────────────
const upload = uploadBox ? setupUpload(uploadBox) : null

function setupUpload(box) {
  const url = box.dataset.upload
  const accepted = (box.dataset.accept || '').split(',').map(ext => ext.trim().toLowerCase())
  const styleInput = box.querySelector('[name=style]')
  const newStyleInput = box.querySelector('[name=new_style]')
  const zone = box.querySelector('.dropzone')
  const log = box.querySelector('.upload-log')
  const summary = box.querySelector('.upload-summary')
  const pickers = [...box.querySelectorAll('input[type=file]')]
  const filePicker = pickers.find(input => !input.hasAttribute('webkitdirectory')) || pickers[0]
  const baseTitle = document.title

  const STATUSES = ['added', 'restored', 'duplicate', 'error']
  const LABEL = {
    song: { added: 'música adicionada', restored: 'música restaurada', duplicate: 'música repetida' },
    visual: { added: 'visual adicionado', restored: 'visual restaurado', duplicate: 'visual repetido' },
  }
  const JUNK = new Set(['thumbs.db', 'desktop.ini'])
  const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus'])

  const items = [] // tudo que entrou desde que a página abriu (o resumo vale até atualizar)
  const queue = []
  const skipped = [] // formato não aceito
  let running = false
  let reading = 0 // leituras de pasta em andamento
  let found = 0
  let note = ''
  let batchStart = 0
  let batchBase = 0
  let lastLogScroll = 0
  const ui = {}

  // O select mostra todos os estilos existentes; texto livre só aparece ao criar um novo.
  // Mantém a escolha anterior, inclusive texto digitado no antigo datalist.
  const styleKey = `upload-style:${location.pathname}`
  const savedStyle = (() => {
    try { return sessionStorage.getItem(styleKey) || '' } catch { return '' }
  })()
  if (savedStyle && [...styleInput.options].some(option => option.value === savedStyle)) {
    styleInput.value = savedStyle
  } else if (savedStyle) {
    styleInput.value = '__new__'
    newStyleInput.value = savedStyle
  }
  function chosenStyle() {
    return styleInput.value === '__new__' ? newStyleInput.value.trim() : styleInput.value
  }
  function updateStyle() {
    newStyleInput.closest('label').hidden = styleInput.value !== '__new__'
    try { sessionStorage.setItem(styleKey, chosenStyle()) } catch {}
  }
  styleInput.addEventListener('change', () => {
    updateStyle()
    if (styleInput.value === '__new__') newStyleInput.focus()
  })
  newStyleInput.addEventListener('input', updateStyle)
  updateStyle()

  function classify(name) {
    if (name.startsWith('.') || JUNK.has(name.toLowerCase())) return 'junk'
    const dot = name.lastIndexOf('.')
    return dot > 0 && accepted.includes(name.slice(dot).toLowerCase()) ? 'ok' : 'skip'
  }

  function working() {
    return running || reading > 0
  }

  function addItem(path, file, style) {
    const li = el('li', 'queued')
    const name = el('span', 'upload-file', path)
    name.title = path
    const status = el('span', 'upload-status', 'na fila')
    li.append(name, status)
    log.append(li)
    const item = { path, file, style, size: file ? file.size : 0, loaded: 0, status: 'queued', kind: '', retryable: false, li, statusEl: status }
    items.push(item)
    return item
  }

  function setItem(item, status, text) {
    item.status = status
    item.li.className = status
    item.statusEl.textContent = text
    if (status !== 'sending') item.li.style.removeProperty('--progress')
  }

  function enqueue(entries, emptyNote) {
    let taken = 0
    let missingStyle = 0
    for (const { file, folder } of entries) {
      const path = folder ? `${folder}/${file.name}` : file.name
      const kind = classify(file.name)
      if (kind === 'junk') continue
      if (kind === 'skip') {
        skipped.push(path)
        continue
      }
      const style = folder || chosenStyle()
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
      if (!style && AUDIO_EXT.has(ext)) {
        const item = addItem(path, file, '')
        item.retryable = true
        item.needsStyle = true
        setItem(item, 'error', 'escolha um estilo e tente de novo')
        missingStyle++
        continue
      }
      queue.push(addItem(path, file, style))
      taken++
    }
    if (missingStyle) {
      note = 'Escolha ou crie um estilo para músicas soltas; depois clique em “Tentar de novo”.'
      if (styleInput.value === '__new__') newStyleInput.focus()
      else styleInput.focus()
    } else if (taken) note = ''
    else if (emptyNote) note = entries.length ? 'Nenhum arquivo compatível: envie áudio, imagem ou vídeo.' : emptyNote
    render()
    if (!running && queue.length) drain()
  }

  async function drain() {
    running = true
    batchStart = Date.now()
    batchBase = measure().loaded
    render()
    while (queue.length) await send(queue.shift())
    running = false
    render()
    revealFirstError()
  }

  function send(item) {
    return new Promise(resolve => {
      let settled = false
      const finish = result => {
        if (settled) return
        settled = true
        settle(item, result)
        resolve()
      }
      const form = new FormData()
      form.append('style', item.style) // tem que vir antes do arquivo
      form.append('file', item.file)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', url)
      xhr.setRequestHeader('Accept', 'application/json')
      item.loaded = 0
      setItem(item, 'sending', 'enviando…')
      reveal(item.li)
      xhr.upload.onprogress = e => {
        if (!e.lengthComputable || !e.total) return
        const ratio = Math.min(1, e.loaded / e.total)
        item.loaded = ratio * item.size
        const pct = `${Math.floor(ratio * 100)}%`
        item.li.style.setProperty('--progress', pct)
        item.statusEl.textContent = `enviando ${pct}`
        render()
      }
      xhr.upload.onload = () => {
        item.loaded = item.size
        setItem(item, 'processing', 'processando no servidor…')
        render()
      }
      xhr.onload = () => finish(parseResponse(xhr))
      xhr.onerror = () => finish({ status: 'error', message: 'falha de rede (a conexão caiu?)', retryable: true })
      xhr.ontimeout = () => finish({ status: 'error', message: 'o servidor demorou demais para responder', retryable: true })
      xhr.onabort = () => finish({ status: 'error', message: 'envio interrompido', retryable: true })
      try {
        xhr.send(form)
      } catch (err) {
        finish({ status: 'error', message: err?.message || 'não foi possível enviar', retryable: true })
      }
    })
  }

  function parseResponse(xhr) {
    let result = null
    try {
      result = JSON.parse(xhr.responseText)?.results?.[0] ?? null
    } catch {}
    const httpOk = xhr.status >= 200 && xhr.status < 300
    if (result && STATUSES.includes(result.status)) {
      if (httpOk) return result
      return { ...result, status: 'error', message: result.message || httpProblem(xhr.status), retryable: xhr.status >= 500 }
    }
    return { status: 'error', message: httpProblem(xhr.status), retryable: xhr.status !== 413 }
  }

  function httpProblem(status) {
    if (status === 401 || status === 403) return `acesso negado (HTTP ${status}): atualize a página e entre de novo`
    if (status === 404) return 'canal não encontrado (HTTP 404)'
    if (status === 413) return 'arquivo grande demais para o servidor (HTTP 413)'
    if (status === 502 || status === 503 || status === 504) return `servidor indisponível (HTTP ${status})`
    if (!status) return 'sem resposta do servidor'
    return `resposta inesperada do servidor (HTTP ${status})`
  }

  function settle(item, result) {
    const status = STATUSES.includes(result.status) ? result.status : 'error'
    item.kind = result.kind === 'visual' ? 'visual' : 'song'
    item.loaded = item.size
    item.retryable = status === 'error' && !!result.retryable
    let text
    if (status === 'error') text = `erro: ${result.message || 'falha desconhecida'}`
    else {
      const label = LABEL[item.kind][status]
      text = result.message ? `${label}: ${result.message}` : label
    }
    setItem(item, status, text)
    render()
  }

  function retryFailed() {
    let waitingForStyle = false
    for (const item of items) {
      if (item.status !== 'error' || !item.retryable) continue
      if (item.needsStyle) {
        const style = chosenStyle()
        if (!style) {
          waitingForStyle = true
          continue
        }
        item.style = style
        item.needsStyle = false
      }
      item.retryable = false
      item.loaded = 0
      setItem(item, 'queued', 'na fila (nova tentativa)')
      queue.push(item)
    }
    if (waitingForStyle) note = 'Escolha ou crie um estilo para músicas soltas antes de tentar de novo.'
    else note = ''
    render()
    if (!running && queue.length) drain()
  }

  // Nada novo entrou: dá pra fechar o aviso sem atualizar.
  function dismiss() {
    if (working()) return
    items.length = 0
    skipped.length = 0
    note = ''
    log.replaceChildren()
    render()
    filePicker?.closest('label')?.focus()
  }

  // ── Resumo ──
  function measure() {
    const count = { queued: 0, sending: 0, processing: 0, added: 0, restored: 0, duplicate: 0, error: 0 }
    const kinds = { song: 0, visual: 0 }
    let total = 0
    let loaded = 0
    let retryable = 0
    for (const item of items) {
      count[item.status]++
      if (item.status === 'added' || item.status === 'restored') kinds[item.kind]++
      if (item.retryable) retryable++
      if (!item.file) continue
      total += item.size
      loaded += item.status === 'queued' ? 0 : item.status === 'sending' ? item.loaded : item.size
    }
    return { count, kinds, total, loaded, retryable }
  }

  function ensureUi() {
    if (ui.headline) return
    ui.headline = el('span', 'upload-headline')
    ui.detail = el('span', 'upload-detail')
    ui.bar = el('span', 'bar upload-progress')
    ui.fill = el('span')
    ui.bar.append(ui.fill)
    ui.bar.setAttribute('role', 'progressbar')
    ui.bar.setAttribute('aria-label', 'Progresso do envio')
    ui.bar.setAttribute('aria-valuemin', '0')
    ui.bar.setAttribute('aria-valuemax', '100')
    ui.counts = el('span', 'upload-counts')
    ui.note = el('span', 'upload-note')
    ui.actions = el('span', 'upload-actions')
    ui.retry = el('button')
    ui.retry.dataset.uploadRetry = ''
    ui.retry.addEventListener('click', retryFailed)
    ui.refresh = el('button', 'primary', 'Atualizar página')
    ui.refresh.dataset.uploadRefresh = ''
    ui.refresh.addEventListener('click', reloadPage)
    ui.dismiss = el('button', '', 'Fechar aviso')
    ui.dismiss.dataset.uploadDismiss = ''
    ui.dismiss.addEventListener('click', dismiss)
    for (const button of [ui.retry, ui.refresh, ui.dismiss]) button.type = 'button'
    ui.countsKey = ''
    summary.replaceChildren(ui.headline, ui.detail, ui.bar, ui.counts, ui.note, ui.actions)
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text
    node.hidden = !text
  }

  function render() {
    const busy = working()
    if (!items.length && !skipped.length && !note && !busy) {
      summary.replaceChildren()
      summary.removeAttribute('data-state')
      summary.removeAttribute('aria-busy')
      box.removeAttribute('aria-busy')
      for (const key of Object.keys(ui)) delete ui[key]
      document.title = baseTitle
      return
    }
    ensureUi()
    const { count, kinds, total, loaded, retryable } = measure()
    const n = items.length
    const done = count.added + count.restored + count.duplicate + count.error
    const fresh = count.added + count.restored
    const ratio = total ? loaded / total : n ? done / n : 0
    const pct = Math.floor(ratio * 100)

    let state
    let headline
    let detail
    if (running) {
      state = 'sending'
      headline = `Enviando ${Math.min(done + 1, n)} de ${plural(n, 'arquivo', 'arquivos')}`
      detail = [`${pct}%`, total ? `${formatBytes(loaded)} de ${formatBytes(total)}` : '', eta(loaded, total)].filter(Boolean).join(' · ')
    } else if (reading) {
      state = 'reading'
      headline = 'Lendo pastas…'
      detail = plural(found, 'arquivo encontrado', 'arquivos encontrados')
    } else {
      state = count.error ? 'error' : count.duplicate || skipped.length || !fresh ? 'warn' : 'done'
      headline = !n ? 'Nenhum arquivo enviado' : count.error ? `Envio terminou com ${plural(count.error, 'erro', 'erros')}` : 'Envio concluído'
      const parts = [kinds.song && plural(kinds.song, 'música', 'músicas'), kinds.visual && plural(kinds.visual, 'visual', 'visuais')].filter(Boolean)
      detail = fresh
        ? `${fresh === 1 ? 'Entrou' : 'Entraram'} ${parts.join(' e ')} na biblioteca. Atualize a página para ver.`
        : n
          ? 'Nada novo entrou na biblioteca.'
          : ''
    }

    summary.dataset.state = state
    summary.setAttribute('aria-busy', String(busy)) // leitor de tela anuncia só o resultado final
    if (busy) box.setAttribute('aria-busy', 'true')
    else box.removeAttribute('aria-busy')
    setText(ui.headline, headline)
    setText(ui.detail, detail)

    ui.bar.hidden = !n
    ui.fill.style.width = `${busy ? pct : 100}%`
    ui.bar.setAttribute('aria-valuenow', String(busy ? pct : 100))
    ui.bar.setAttribute('aria-valuetext', detail || headline)

    renderCounts(count, fresh)
    setText(ui.note, reading && running ? `Lendo mais pastas… ${plural(found, 'arquivo encontrado', 'arquivos encontrados')}` : note)

    const actions = []
    if (!busy && retryable) {
      ui.retry.textContent = `Tentar de novo (${retryable})`
      actions.push(ui.retry)
    }
    if (!busy) actions.push(fresh ? ui.refresh : ui.dismiss)
    if (actions.length !== ui.actions.children.length || actions.some((b, i) => ui.actions.children[i] !== b)) {
      ui.actions.replaceChildren(...actions)
    }

    document.title = busy ? `${pct}% · enviando · ${baseTitle}` : baseTitle
  }

  function renderCounts(count, fresh) {
    const chips = []
    if (fresh) {
      const restored = count.restored ? ` (${plural(count.restored, 'restaurado', 'restaurados')})` : ''
      chips.push(['added', `${plural(fresh, 'adicionado', 'adicionados')}${restored}`])
    }
    if (count.duplicate) chips.push(['duplicate', `${count.duplicate} já ${count.duplicate === 1 ? 'existia' : 'existiam'}`])
    if (count.error) chips.push(['error', `${count.error} com erro`])
    if (skipped.length) chips.push(['skipped', `${plural(skipped.length, 'ignorado', 'ignorados')} (formato)`])
    if (count.queued) chips.push(['queued', `${count.queued} na fila`])
    const key = JSON.stringify(chips) + skipped.length
    if (key === ui.countsKey) return
    ui.countsKey = key
    ui.counts.replaceChildren(
      ...chips.map(([cls, text]) => {
        const chip = el('span', `count ${cls}`, text)
        if (cls === 'skipped') {
          const names = skipped.slice(0, 15).join('\n')
          chip.title = skipped.length > 15 ? `${names}\n… e mais ${skipped.length - 15}` : names
        }
        return chip
      }),
    )
  }

  function eta(loaded, total) {
    const seconds = (Date.now() - batchStart) / 1000
    const rate = (loaded - batchBase) / seconds
    if (seconds < 3 || rate <= 0 || loaded >= total) return ''
    const left = (total - loaded) / rate
    if (left < 60) return `faltam ~${Math.max(5, Math.ceil(left / 5) * 5)} s`
    if (left < 3600) return `faltam ~${Math.ceil(left / 60)} min`
    return `faltam ~${Math.floor(left / 3600)} h ${Math.floor((left % 3600) / 60)} min`
  }

  // ── Lista: acompanha o arquivo atual sem rolar a página ──
  for (const type of ['wheel', 'touchstart', 'pointerdown']) {
    log.addEventListener(type, () => (lastLogScroll = Date.now()), { passive: true })
  }

  function reveal(li, force = false) {
    if (!force && Date.now() - lastLogScroll < 4000) return // a pessoa está lendo a lista
    if (log.scrollHeight <= log.clientHeight) return
    const frame = log.getBoundingClientRect()
    const row = li.getBoundingClientRect()
    if (row.top < frame.top) log.scrollTop -= frame.top - row.top
    else if (row.bottom > frame.bottom) log.scrollTop += row.bottom - frame.bottom
  }

  function revealFirstError() {
    const failed = items.find(item => item.status === 'error')
    if (failed) reveal(failed.li, true)
  }

  // ── Pasta arrastada: percorre subpastas; música herda o nome da pasta onde está ──
  function readFile(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject))
  }

  function readBatch(reader) {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject))
  }

  function readProblem(err) {
    const reason = {
      NotFoundError: 'arquivo sumiu ou foi movido',
      NotReadableError: 'sem permissão de leitura',
      SecurityError: 'o navegador bloqueou a leitura',
      EncodingError: 'caminho inválido',
    }[err?.name]
    return `não foi possível ler: ${reason || err?.message || 'erro desconhecido'}`
  }

  async function walk(entry, folder, out, failures) {
    const path = (entry.fullPath || entry.name).replace(/^\//, '')
    try {
      if (entry.isFile) {
        const kind = classify(entry.name)
        if (kind === 'junk') return
        if (kind === 'skip') {
          skipped.push(folder ? `${folder}/${entry.name}` : entry.name)
          return
        }
        out.push({ file: await readFile(entry), folder })
        found++
        render()
        return
      }
      if (!entry.isDirectory) return
      const reader = entry.createReader()
      for (;;) {
        const batch = await readBatch(reader) // vem em lotes (Chrome: 100 por vez)
        if (!batch.length) break
        for (const child of batch) await walk(child, entry.name, out, failures)
      }
    } catch (err) {
      failures.push({ path: entry.isDirectory ? `${path}/` : path, message: readProblem(err) })
    }
  }

  async function takeDrop(dataTransfer) {
    // As entries precisam ser pegas antes do primeiro await: depois o DataTransfer esvazia.
    const entries = []
    const loose = []
    for (const item of Array.from(dataTransfer.items || [])) {
      if (item.kind !== 'file') continue
      const entry = item.webkitGetAsEntry?.()
      if (entry) entries.push(entry)
      else {
        const file = item.getAsFile()
        if (file) loose.push({ file, folder: '' })
      }
    }
    if (!entries.length && !loose.length) {
      for (const file of Array.from(dataTransfer.files || [])) loose.push({ file, folder: '' })
    }
    if (!entries.length) {
      enqueue(loose, 'Nada para enviar: solte arquivos ou pastas.')
      return
    }
    if (!reading) found = 0
    const skippedBefore = skipped.length
    reading++
    render()
    const out = [...loose]
    const failures = []
    try {
      for (const entry of entries) await walk(entry, '', out, failures)
    } catch (err) {
      failures.push({ path: 'itens soltos', message: readProblem(err) })
    } finally {
      reading--
    }
    for (const { path, message } of failures) setItem(addItem(path, null, ''), 'error', message)
    const emptyNote = skipped.length > skippedBefore ? 'Nenhum arquivo compatível nas pastas soltas.' : 'Nenhum arquivo encontrado nas pastas soltas.'
    enqueue(out, failures.length ? '' : emptyNote)
  }

  const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files')
  let dragDepth = 0
  zone.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth++
    zone.classList.add('over')
  })
  zone.addEventListener('dragover', e => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  })
  zone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) zone.classList.remove('over')
  })
  zone.addEventListener('drop', e => {
    e.preventDefault()
    dragDepth = 0
    zone.classList.remove('over')
    takeDrop(e.dataTransfer).catch(err => {
      note = readProblem(err)
      render()
    })
  })
  // Arquivo solto fora da área abriria no navegador e derrubaria o envio em andamento.
  document.addEventListener('dragover', e => {
    if (!hasFiles(e) || zone.contains(e.target)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'none'
  })
  document.addEventListener('drop', e => {
    if (hasFiles(e) && !zone.contains(e.target)) e.preventDefault()
  })

  // ── Escolher arquivos/pasta: teclado e clique na área ──
  for (const input of pickers) {
    input.addEventListener('change', () => {
      const files = [...input.files]
      input.value = '' // permite escolher os mesmos de novo
      enqueue(
        files.map(file => {
          const parts = (file.webkitRelativePath || '').split('/')
          return { file, folder: parts.length > 1 ? parts[parts.length - 2] : '' }
        }),
        files.length ? 'Nenhum arquivo compatível na seleção.' : '',
      )
    })
    const label = input.closest('label')
    if (!label) continue
    if (!label.hasAttribute('tabindex')) label.tabIndex = 0
    if (!label.hasAttribute('role')) label.setAttribute('role', 'button')
    label.addEventListener('keydown', e => {
      if (e.target !== label || (e.key !== 'Enter' && e.key !== ' ')) return
      e.preventDefault()
      if (!e.repeat) input.click()
    })
  }

  zone.addEventListener('click', e => {
    if (e.target.closest('label, input, button, a, select, textarea, summary')) return
    if (getSelection()?.toString()) return
    filePicker?.click()
  })

  addEventListener('beforeunload', e => {
    if (!working()) return
    e.preventDefault()
    e.returnValue = ''
  })

  return { holdsPage: () => working() || !!summary.dataset.state }
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`
}
