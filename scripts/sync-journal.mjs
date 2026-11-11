#!/usr/bin/env node
/**
 * Maintain a reader-first index of actually published The Paisa Journal articles.
 * The Blogger public feed is the single source; no writing credentials or LLM.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const BLOG_HOST = 'thepaisajournal.blogspot.com'
export const BLOG_ID = '4641110635458833733'
export const BLOG_HOME = 'https://' + BLOG_HOST + '/'
export const START = '<!-- THE_PAISA_JOURNAL:START -->'
export const END = '<!-- THE_PAISA_JOURNAL:END -->'
const PAGE_SIZE = 100
const MAX_POSTS = 10000

const clean = (value, max = 240) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, max)
const escapeMd = (value) => clean(value).replace(/[\\`*_{}\[\]<>()!|#]/g, '\\$&')

export function normalizeEntry(entry) {
  const idRaw = clean(entry?.id?.$t, 170)
  const match = idRaw.match(/^tag:blogger\.com,1999:blog-4641110635458833733\.post-(\d{1,25})$/)
  if (!match) throw Error('Unexpected post ID or Blogger blog owner')
  const alternate = (entry.link || []).find(link => link.rel === 'alternate' && link.type === 'text/html')
  if (!alternate?.href) throw Error('Post has no HTML alternate link')
  const uri = new URL(alternate.href)
  if (uri.protocol !== 'https:' || uri.hostname !== BLOG_HOST || uri.username || uri.password ||
      uri.port || uri.search || uri.hash || !/^\/\d{4}\/\d{2}\/[a-zA-Z0-9_.~-]+\.html$/.test(uri.pathname)) {
    throw Error('Post URL outside canonical Blogger publication: ' + alternate.href)
  }
  const published = new Date(entry?.published?.$t)
  const updated = new Date(entry?.updated?.$t)
  if (!Number.isFinite(published.valueOf()) || !Number.isFinite(updated.valueOf())) {
    throw Error('Invalid Blogger published/updated timestamp')
  }
  const title = clean(entry?.title?.$t, 240)
  if (title.length < 8) throw Error('Invalid/empty post title')
  const labels = (entry.category || []).map(c => clean(c.term, 64)).filter(Boolean).slice(0, 15)
  const h = labels.some(x => x === 'हिंदी' || /^hindi$/i.test(x))
  const he = labels.some(x => /^hinglish$/i.test(x))
  const e = labels.some(x => /^english$/i.test(x))
  const language = [h, he, e].filter(Boolean).length === 1 ? (h ? 'Hindi' : he ? 'Hinglish' : 'English') : 'Unspecified'
  return {
    id: match[1], url: uri.href, title, language, labels,
    published_at: published.toISOString(), updated_at: updated.toISOString(),
  }
}

export function parsePage(data) {
  const feed = data?.feed
  if (!feed || feed.id?.$t !== 'tag:blogger.com,1999:blog-' + BLOG_ID) {
    throw Error('Blogger feed identity mismatch: refusing to replace archive')
  }
  const total = Number(feed['openSearch$totalResults']?.$t)
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_POSTS) {
    throw Error('Invalid or excessive Blogger result count')
  }
  const entries = (feed.entry || []).map(normalizeEntry)
  return { total, entries }
}

export async function collect(fetcher = globalThis.fetch) {
  const found = new Map()
  let total = null
  for (let offset = 1; offset <= MAX_POSTS; offset += PAGE_SIZE) {
    const url = BLOG_HOME + 'feeds/posts/default?alt=json&max-results=' + PAGE_SIZE + '&start-index=' + offset
    const response = await fetcher(url, { redirect: 'follow', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
    if (!response.ok || new URL(response.url).origin !== 'https://' + BLOG_HOST) {
      throw Error('Blogger feed HTTP or redirect rejected at offset ' + offset)
    }
    const parsed = parsePage(await response.json())
    if (total === null) total = parsed.total
    if (parsed.total !== total) throw Error('Feed changed during pagination: retry on next run')
    for (const p of parsed.entries) {
      const previous = found.get(p.id)
      if (previous && (previous.url !== p.url || previous.title !== p.title)) {
        throw Error('Conflicting duplicate post ID: ' + p.id)
      }
      found.set(p.id, p)
    }
    if (found.size >= total) break
    if (parsed.entries.length === 0 || (offset - 1 + parsed.entries.length) >= total) {
      throw Error('Incomplete feed; refusing to truncate existing archive')
    }
  }
  if (found.size !== total) throw Error('Incomplete Blogger index: ' + found.size + '/' + total)
  return [...found.values()].sort((a,b) => b.published_at.localeCompare(a.published_at) || b.id.localeCompare(a.id))
}

export function publishedIst(iso) {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso))
}
export function renderIndex(posts) {
  const lines = [
    '# The Paisa Journal — published article archive', '',
    'Original money and everyday-life guides in Hindi, Hinglish and English. This index links to articles actually published at ' + BLOG_HOME + '.', '',
    'Published dates use India Standard Time (IST). Titles are maintained from the public Blogger feed; articles remain on Blogger.', '',
    '[Read the journal](' + BLOG_HOME + ') · [Explore FinCoPilot](https://fincopilot.app/welcome/)', '',
    '## All published articles', '',
  ]
  if (!posts.length) lines.push('_No public articles have been indexed yet._', '')
  let month = ''
  for (const p of posts) {
    const key = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(p.published_at))
    if (key !== month) {
      month = key
      lines.push('### ' + escapeMd(key), '')
    }
    lines.push('- **' + publishedIst(p.published_at) + ' · ' + p.language + '** — [' + escapeMd(p.title) + '](' + p.url + ')')
  }
  return lines.join('\n') + '\n'
}

export function renderReadme(posts) {
  const lines = [
    START,
    '## Read & Learn — The Paisa Journal', '',
    'Practical money and everyday-life stories in Hindi, Hinglish and English. An associated publication in the PARAT ecosystem; some articles may mention FinCoPilot with clear disclosure.', '',
    '[Visit The Paisa Journal](' + BLOG_HOME + ') · [Browse every published article](JOURNAL_INDEX.md)', '',
    '### Latest from the journal', '',
  ]
  if (!posts.length) lines.push('_No published articles yet._')
  for (const p of posts.slice(0, 5)) {
    lines.push('- [' + escapeMd(p.title) + '](' + p.url + ') · ' + publishedIst(p.published_at) + ' · ' + p.language)
  }
  lines.push('', END)
  return lines.join('\n')
}

export function replaceSection(readme, generated) {
  const first = readme.indexOf(START), last = readme.indexOf(END)
  if (first === -1 && last === -1) return readme.trimEnd() + '\n\n---\n\n' + generated + '\n'
  if (first < 0 || last < first || readme.indexOf(START, first + 1) !== -1 || readme.indexOf(END, last + 1) !== -1) {
    throw Error('Invalid README journal markers; refusing edits')
  }
  return readme.slice(0, first) + generated + readme.slice(last + END.length)
}

export async function sync(root = process.cwd(), fetcher = globalThis.fetch) {
  const posts = await collect(fetcher)
  // Fail closed if a transient feed issue appears to erase a previously populated index.
  let previousCount = 0
  try {
    const previous = JSON.parse(await readFile(resolve(root, 'journal/posts.json'), 'utf8'))
    if (previous.blog_id !== BLOG_ID || previous.source !== BLOG_HOME || !Array.isArray(previous.posts)) {
      throw Error('Existing journal archive has an unexpected source identity')
    }
    previousCount = previous.posts.length
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (previousCount > 0 && posts.length === 0) {
    throw Error('Feed unexpectedly empty; retaining last-known-good article archive')
  }
  const data = JSON.stringify({ source: BLOG_HOME, blog_id: BLOG_ID, posts }, null, 2) + '\n'
  const index = renderIndex(posts)
  const readmePath = resolve(root, 'README.md')
  const readme = await readFile(readmePath, 'utf8')
  const nextReadme = replaceSection(readme, renderReadme(posts))
  await mkdir(resolve(root, 'journal'), { recursive: true })
  await Promise.all([
    writeFile(resolve(root, 'journal/posts.json'), data),
    writeFile(resolve(root, 'JOURNAL_INDEX.md'), index),
    ...(nextReadme === readme ? [] : [writeFile(readmePath, nextReadme)]),
  ])
  console.log('Indexed ' + posts.length + ' published article(s) from ' + BLOG_HOST)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  sync().catch(error => { console.error('Journal sync failed; no commit will be made:', error.message); process.exitCode = 1 })
}
