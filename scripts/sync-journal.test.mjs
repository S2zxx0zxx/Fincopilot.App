import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BLOG_HOST, BLOG_ID, normalizeEntry, parsePage, collect, renderIndex, renderReadme, replaceSection, publishedIst, sync } from './sync-journal.mjs'

const entry = (id = '4437585684925087727', url = 'https://' + BLOG_HOST + '/2026/11/24000.html') => ({
  id: { $t: 'tag:blogger.com,1999:blog-' + BLOG_ID + '.post-' + id },
  link: [{ rel: 'alternate', type: 'text/html', href: url }],
  title: { $t: 'बैंक में ₹24,000 हैं—पूरे पैसे खर्च करने से पहले यह हिसाब समझिए' },
  category: [{ term: 'हिंदी' }, { term: 'बैंक बैलेंस' }],
  published: { $t: '2026-11-10T19:56:21.950-08:00' },
  updated: { $t: '2026-11-10T19:56:21.951-08:00' },
})
const feed = (entries, total = entries.length, id = BLOG_ID) => ({
  feed: {
    id: { $t: 'tag:blogger.com,1999:blog-' + id },
    'openSearch$totalResults': { $t: String(total) },
    entry: entries,
  },
})

test('canonical post, language and timezone normalize correctly', () => {
  const p = normalizeEntry(entry())
  assert.equal(p.id, '4437585684925087727')
  assert.equal(p.language, 'Hindi')
  assert.equal(p.published_at, '2026-11-11T03:56:21.950Z')
  assert.equal(publishedIst(p.published_at), '11 Nov 2026')
})
test('unapproved URL and blog identity never reach index', () => {
  assert.throws(() => normalizeEntry(entry('12', 'https://evil.example/2026/11/24000.html')), /outside canonical/)
  assert.throws(() => normalizeEntry(entry('12', 'http://thepaisajournal.blogspot.com/2026/11/24000.html')), /outside canonical/)
  assert.throws(() => normalizeEntry(entry('12', 'https://thepaisajournal.blogspot.com/2026/11/24000.html?ref=spam')), /outside canonical/)
  assert.throws(() => parsePage(feed([entry()], 1, 'other-blog')), /identity mismatch/)
})
test('malformed and missing feed data fail closed', () => {
  assert.throws(() => parsePage(feed([entry()], -1)), /Invalid/)
  assert.throws(() => parsePage(feed([entry()], 20001)), /excessive/)
  assert.throws(() => normalizeEntry({ ...entry(), published: {$t:'bad date'} }), /timestamp/)
})
test('published-only directory renders safe text and retains archive', () => {
  const a = normalizeEntry(entry())
  const b = { ...a, id:'2', title:'Markdown [trick] <tag>', url:'https://' + BLOG_HOST + '/2026/11/example.html' }
  const index = renderIndex([a,b])
  assert.match(index, /11 Nov 2026/)
  assert.match(index, /Markdown \\[trick\\] \\<tag\\>/)
  assert.match(index, /24000\.html/)
  assert.equal((renderReadme([a]).match(/THE_PAISA_JOURNAL:START/g) || []).length, 1)
})
test('README edits are idempotent and preserve original content', () => {
  const before = '# FinCoPilot\n\nOriginal details and product guides.\n'
  const section = renderReadme([normalizeEntry(entry())])
  const first = replaceSection(before, section)
  assert.match(first, /Original details/)
  assert.equal(replaceSection(first, section), first)
  assert.throws(() => replaceSection(before + '\n<!-- THE_PAISA_JOURNAL:END -->', section), /Invalid/)
})
test('feed pagination cannot silently truncate archives', async () => {
  const entries = [entry('1'), entry('2','https://' + BLOG_HOST + '/2026/11/two.html')]
  const fetcher = async (url) => ({
    ok: true, url,
    async json() { return feed(entries, 3) }
  })
  await assert.rejects(() => collect(fetcher), /Incomplete feed/)
})
test('feed accepts real entry and rejects redirects outside blog host', async () => {
  const fetcher = async (url) => ({ok:true,url,async json(){return feed([entry()])}})
  const posts = await collect(fetcher)
  assert.equal(posts.length,1)
  const attack = async (url) => ({ok:true,url:'https://example.com/other',async json(){return feed([entry()])}})
  await assert.rejects(() => collect(attack), /redirect rejected/)
})

test('integration: writes real index once and fails closed on empty feed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paisa-journal-'))
  try {
    await writeFile(join(dir, 'README.md'), '# FinCoPilot original content\n')
    const fetcher = async url => ({ ok:true, url, async json(){ return feed([entry()]) } })
    await sync(dir, fetcher)
    const first = await readFile(join(dir, 'journal/posts.json'), 'utf8')
    assert.match(first, /4437585684925087727/)
    const readme = await readFile(join(dir, 'README.md'), 'utf8')
    await sync(dir, fetcher)
    assert.equal(await readFile(join(dir, 'README.md'), 'utf8'), readme)
    await assert.rejects(
      () => sync(dir, async url => ({ ok:true, url, async json(){return feed([],0)} })),
      /unexpectedly empty/
    )
    assert.equal(await readFile(join(dir, 'journal/posts.json'), 'utf8'), first)
  } finally {
    await rm(dir, {recursive:true,force:true})
  }
})
