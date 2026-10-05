// Fábrica de Mixes: progresso ao vivo, upload com arrastar/soltar, confirmações.

let busy = false // upload rolando ou resultado de upload na tela: não recarrega sozinho

// ── Progresso + recarregar quando algo muda no servidor ───────────────
const initialSig = document.body.dataset.sig

async function poll() {
  try {
    const res = await fetch('/api/poll', { cache: 'no-store' })
    if (res.ok) {
      const state = await res.json()
      for (const [id, pct] of Object.entries(state.progress)) {
        for (const el of document.querySelectorAll(`[data-progress="${id}"] > span`)) el.style.width = `${pct}%`
        for (const el of document.querySelectorAll(`[data-progress-text="${id}"]`)) el.textContent = `${pct}%`
      }
      const editing = document.querySelector('form[data-dirty]')
      if (state.sig !== initialSig && !busy && !editing) {
        location.reload()
        return
      }
    }
  } catch {
    // servidor reiniciando; tenta de novo
  }
  setTimeout(poll, 3000)
}
setTimeout(poll, 3000)

document.addEventListener('input', e => {
  if (e.target.form) e.target.form.dataset.dirty = '1'
})

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
})

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const field = document.getElementById(btn.dataset.copy)
    try {
      await navigator.clipboard.writeText(field.value)
    } catch {
      // http sem TLS não tem clipboard API
      field.select()
      document.execCommand('copy')
    }
    btn.textContent = 'Copiado!'
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

// ── Upload ────────────────────────────────────────────────────────────
const box = document.querySelector('[data-upload]')
if (box) setupUpload(box)

function setupUpload(box) {
  const url = box.dataset.upload
  const accepted = box.dataset.accept.split(',')
  const styleInput = box.querySelector('[name=style]')
  const zone = box.querySelector('.dropzone')
  const log = box.querySelector('.upload-log')
  const summary = box.querySelector('.upload-summary')
  const queue = []
  const totals = { added: 0, restored: 0, duplicate: 0, error: 0 }
  let running = false

  const LABEL = {
    song: { added: 'música adicionada', restored: 'música restaurada', duplicate: 'música já existia', error: 'erro' },
    visual: { added: 'visual adicionado', restored: 'visual restaurado', duplicate: 'visual já existia', error: 'erro' },
  }

  function wanted(name) {
    const dot = name.lastIndexOf('.')
    return !name.startsWith('.') && dot > 0 && accepted.includes(name.slice(dot).toLowerCase())
  }

  function enqueue(items) {
    for (const { file, folder } of items) {
      if (!wanted(file.name)) continue
      const li = document.createElement('li')
      const name = document.createElement('span')
      const state = document.createElement('span')
      name.textContent = folder ? `${folder}/${file.name}` : file.name
      state.textContent = 'na fila'
      state.className = 'muted'
      li.append(name, state)
      log.append(li)
      queue.push({ file, style: folder || styleInput.value.trim(), state })
    }
    if (!running && queue.length) drain()
  }

  async function drain() {
    running = busy = true
    while (queue.length) await send(queue.shift())
    running = false
    if (!totals.duplicate && !totals.error) {
      location.reload()
      return
    }
    summary.textContent = `${totals.added + totals.restored} adicionados, ${totals.duplicate} já existiam, ${totals.error} com erro. `
    const reload = document.createElement('button')
    reload.type = 'button'
    reload.textContent = 'OK, atualizar a página'
    reload.onclick = () => location.reload()
    summary.append(reload)
  }

  function send({ file, style, state }) {
    const { promise, resolve } = Promise.withResolvers()
    const form = new FormData()
    form.append('style', style) // tem que vir antes do arquivo
    form.append('file', file)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) state.textContent = `${Math.round((e.loaded / e.total) * 100)}%`
    }
    xhr.upload.onload = () => {
      state.textContent = 'processando…'
    }
    xhr.onload = () => {
      let result
      try {
        result = JSON.parse(xhr.responseText).results[0]
      } catch {
        result = { status: 'error', message: `HTTP ${xhr.status}` }
      }
      totals[result.status]++
      const label = LABEL[result.kind ?? 'song'][result.status]
      state.textContent = `${label}${result.message ? `: ${result.message}` : ''}`
      state.className = result.status
      resolve()
    }
    xhr.onerror = () => {
      totals.error++
      state.textContent = 'erro de rede'
      state.className = 'error'
      resolve()
    }
    xhr.send(form)
    return promise
  }

  // Pasta arrastada: percorre subpastas; música herda o nome da pasta onde está.
  async function walk(entry, folder, out) {
    if (entry.isFile) {
      const { promise, resolve, reject } = Promise.withResolvers()
      entry.file(resolve, reject)
      out.push({ file: await promise, folder })
      return
    }
    const reader = entry.createReader()
    for (;;) {
      const { promise, resolve, reject } = Promise.withResolvers()
      reader.readEntries(resolve, reject)
      const batch = await promise
      if (!batch.length) break
      for (const child of batch) await walk(child, entry.name, out)
    }
  }

  zone.addEventListener('dragover', e => {
    e.preventDefault()
    zone.classList.add('over')
  })
  zone.addEventListener('dragleave', () => zone.classList.remove('over'))
  zone.addEventListener('drop', async e => {
    e.preventDefault()
    zone.classList.remove('over')
    // As entries precisam ser lidas antes do primeiro await.
    const entries = [...e.dataTransfer.items].map(item => item.webkitGetAsEntry?.()).filter(Boolean)
    if (!entries.length) {
      enqueue([...e.dataTransfer.files].map(file => ({ file, folder: '' })))
      return
    }
    const items = []
    for (const entry of entries) await walk(entry, '', items)
    enqueue(items)
  })

  for (const input of box.querySelectorAll('input[type=file]')) {
    input.addEventListener('change', () => {
      enqueue(
        [...input.files].map(file => {
          const parts = (file.webkitRelativePath || '').split('/')
          return { file, folder: parts.length > 1 ? parts.at(-2) : '' }
        }),
      )
      input.value = ''
    })
  }
}
