const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CodeFiles } = require("./code-files.cjs");
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sage-files-test-"));
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe cleanup target");
    await fs.rm(resolved, {recursive:true,force:true});
  });
  return new CodeFiles(directory);
}
test("native files retain exact newlines, diff, Git versions, new topics and deletions", async t => {
  const repo = await fixture(t); await repo.prepare();
  const a = await repo.checkpoint();
  await fs.writeFile(path.join(repo.root,"sum.py"), "def solve():\n    return 1\n");
  const b = await repo.checkpoint();
  assert.notEqual(a.commit,b.commit); assert.equal(b.files[0].comparison,null);
  assert.equal((await repo.checkpoint()).commit,b.commit);
  const recovery = await repo.checkpoint({interrupted:true});
  assert.equal(recovery.commit,b.commit);
  assert.equal(recovery.interrupted,false, "a normal recovered version is not an interrupted edit");
  await fs.writeFile(path.join(repo.root,"sum.py"), "def solve():\n    return 2\n");
  const c = await repo.checkpoint({interrupted:true});
  assert.equal(c.files[0].comparison.before,b.files[0].code); assert.equal(c.interrupted,true);
  assert.equal((await repo.checkpoint()).interrupted,true, "an unchanged discussion does not mark an interrupted file complete");
  await fs.writeFile(path.join(repo.root,"tree.py"),"class Tree: pass\n");
  const d = await repo.checkpoint();
  assert.equal(d.files.length,2); assert.equal(d.active_file,"tree.py");
  await fs.unlink(path.join(repo.root,"tree.py"));
  assert.equal((await repo.checkpoint()).files.length,1);
  assert.equal(await repo.git("show",`${b.commit}:sum.py`),"def solve():\n    return 1");
});
test("private and generated artifacts stay out of Git; invalid file aborts checkpoint", async t => {
  const repo=await fixture(t);await repo.prepare();
  await fs.writeFile(path.join(repo.root,".env"),"private");
  await fs.mkdir(path.join(repo.root,"__pycache__"));
  await fs.writeFile(path.join(repo.root,"__pycache__/secret.txt"),"private");
  assert.equal((await repo.checkpoint()).files.length,0);
  await fs.writeFile(path.join(repo.root,"huge.py"),"x".repeat(80001));
  await assert.rejects(repo.checkpoint(),/上限/);
  assert.equal(await repo.git("ls-files"),"");
});
test("old pinned code seeds once and never overwrites newer local work", async t => {
  const repo=await fixture(t);
  await repo.seed([{filename:"old.py",code:"old\n"}]);
  await fs.writeFile(path.join(repo.root,"old.py"),"new\n");
  await repo.seed([{filename:"old.py",code:"stale\n"}]);
  assert.equal((await repo.read())[0].code,"new\n");
  const bad=await fixture(t);await assert.rejects(bad.seed([{filename:"../escape.py",code:"bad"}]),/文件名/);
});
