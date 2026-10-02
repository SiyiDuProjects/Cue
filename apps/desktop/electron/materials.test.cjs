const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Materials } = require('./materials.cjs');

test('background UTF-8, paging, revisions and private-path rejection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-materials-'));
  try {
    await fs.mkdir(path.join(root, 'materials'));
    await fs.writeFile(path.join(root, 'materials', '简历.md'), '中文项目\n'.repeat(7000));
    await fs.writeFile(path.join(root, 'materials', '.env'), 'SECRET');
    const library = new Materials(root);
    const list = await library.call('list_materials');
    assert.deepEqual(list.files.map(f => f.path), ['简历.md']);
    const first = await library.call('read_material', { path: '简历.md' });
    const rest = await library.call('read_material', { path: '简历.md', revision: first.revision, offset: first.next_offset });
    assert.equal(first.text + rest.text, '中文项目\n'.repeat(7000));
    for (const name of ['../.env', '.env', 'C:/secret.md', 'sub/../../secret.md', '..\\secret.md'])
      await assert.rejects(library.call('read_material', { path: name }));
    await fs.writeFile(path.join(root, 'materials', '简历.md'), 'updated');
    await assert.rejects(library.call('read_material', { path: '简历.md', revision: first.revision, offset: first.next_offset }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
