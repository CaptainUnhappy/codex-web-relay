'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { createThreadImages } = require('../lib/thread-images');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-image-test-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9N8AAAAASUVORK5CYII=', 'base64');
  const images = createThreadImages({ maxBytes: 1000, maxEntries: 8 });
  const register = file => images.withImages({ threadId: 'thread', messages: [{ attachments: [{ filePath: file, name: '图片' }] }] }).messages[0].attachments[0];
  try {
    const file = path.join(directory, 'photo.png');
    fs.writeFileSync(file, png);
    const reference = register(file);
    assert(reference.previewId && !reference.filePath, 'history only sends an opaque attachment reference');
    assert.strictEqual(register(file).previewId, reference.previewId, 'repeated reads reuse the image reference');
    assert((await images.read(reference.previewId)).data.equals(png));
    const markdownFile = process.platform === 'win32' ? `/${file.replace(/\\/g, '/')}` : file;
    const imageMarkdown = `![按钮](${markdownFile})`;
    const projected = images.withImages({ threadId: 'thread', messages: [{ role: 'assistant', text: imageMarkdown }] }).messages[0].text;
    assert.strictEqual(projected, `![按钮](codex-image:${reference.previewId})`, 'assistant local Markdown images must become the existing opaque image reference');
    const project = text => images.withImages({ threadId: 'thread', messages: [{ role: 'assistant', text }] }).messages[0].text;
    assert.strictEqual(project(`![按钮](<${markdownFile}> "说明")`), projected, 'angle paths and optional titles resolve');
    assert.strictEqual(project(`![按钮](${require('url').pathToFileURL(file).href})`), projected, 'local file URLs use the same image reference');
    const spacedFile = path.join(directory, 'photo (中文).png'); fs.writeFileSync(spacedFile, png);
    const spacedMarkdown = `![括号](<${spacedFile.replace(/\\/g, '/')}>)`;
    const spacedId = project(spacedMarkdown).match(/codex-image:([\w-]+)/)?.[1];
    assert(spacedId && (await images.read(spacedId)).data.equals(png), 'spaces, Unicode and parentheses in image paths work');
    assert(project(`![括号](${spacedFile.replace(/\\/g, '/')})`).includes(`codex-image:${spacedId}`), 'balanced parentheses work without angle brackets');
    for (const literal of [`\`${imageMarkdown}\``, `\`\`${imageMarkdown}\`\``, `\`\`\`\`${imageMarkdown}\`\`\`\``, `\`\`\`markdown\n${imageMarkdown}\n\`\`\``, `~~~\n${imageMarkdown}\n~~~`, `\`\`\`\n${imageMarkdown}`, `    ${imageMarkdown}`, `\t${imageMarkdown}`]) {
      assert.strictEqual(project(literal), literal, 'inline and fenced code remain literal');
    }
    for (const target of ['relative.png', '//server/share/image.png', 'file://server/share/image.png', 'https://example.test/a.png', 'javascript:alert(1)', '/secret.txt']) {
      const literal = `![不加载](${target})`; assert.strictEqual(project(literal), literal, 'unsupported targets are never registered');
    }
    assert.strictEqual(images.withImages({ threadId: 'thread', messages: [{ role: 'user', text: imageMarkdown }] }).messages[0].text, imageMarkdown, 'user text cannot register arbitrary local files');
    const live = images.withStatusImages({ threadId: 'thread', preview: imageMarkdown, final: imageMarkdown,
      steps: [{ kind: 'assistant', text: imageMarkdown }, { kind: 'tool', text: imageMarkdown }] });
    assert.strictEqual(live.preview, projected); assert.strictEqual(live.final, projected);
    assert.strictEqual(live.steps[0].text, projected); assert.strictEqual(live.steps[1].text, imageMarkdown);
    await assert.rejects(images.read(file), error => error.status === 404, 'filesystem paths must not be accepted');
    await assert.rejects(images.read('../photo.png'), error => error.status === 404);
    await assert.rejects(createThreadImages().read(reference.previewId), error => error.status === 404, 'references from another service cannot expose files');
    assert(!register('relative.png').previewId);
    assert(!register('\\\\server\\share\\photo.png').previewId, 'UNC paths must not trigger network authentication');
    const html = path.join(directory, 'pretend.png'); fs.writeFileSync(html, '<html><script>alert(1)</script>');
    await assert.rejects(images.read(register(html).previewId), error => error.status === 415, 'content sniffing rejects non-image files even with image extensions');
    const svg = path.join(directory, 'photo.svg'); fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await assert.rejects(images.read(register(svg).previewId), error => error.status === 415, 'active SVG content is not served');
    const big = path.join(directory, 'big.png'); fs.writeFileSync(big, Buffer.concat([png, Buffer.alloc(1100)]));
    await assert.rejects(images.read(register(big).previewId), error => error.status === 415);
    await assert.rejects(images.read(register(path.join(directory, 'missing.png')).previewId), error => error.status === 404);

    register(file); // Keep the original reference in this intentionally small LRU map.
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const extract = name => {
      const start = source.indexOf(`async function ${name}(`);
      const tail = source.slice(start + 1); const end = tail.search(/\n(?:async )?function /);
      return source.slice(start, start + 1 + end);
    };
    let mutations = 0;
    const context = vm.createContext({ URL, threadImages: images, isAuthorized: req => req.authorized,
      json: (res, status, data) => { res.status = status; res.data = data; },
      readJsonRequest: async req => req.payload,
      isCodexThreadId: id => id === 'thread',
      getCodexAppServerBackend: () => ({ readGoal: async () => null, changeGoal: async (id, payload) => { mutations++; return { goal: { objective: payload.objective } }; } }),
      appServerErrorResponse: (res, error) => { throw error; },
    });
    vm.runInContext(extract('handleThreadImage') + extract('handleThreadGoal'), context);
    const request = (url, authorized = true, method = 'GET', payload) => ({ url, authorized, method, payload, headers: { host: 'localhost' } });
    const response = () => ({ writeHead(status, headers) { this.status = status; this.headers = headers; }, end(data) { this.data = data; } });
    let res = response();
    await context.handleThreadImage(request(`/codex/image?id=${reference.previewId}`, false), res);
    assert.strictEqual(res.status, 401, 'an opaque ID alone is not authorization');
    res = response(); await context.handleThreadImage(request(`/codex/image?id=${reference.previewId}`), res);
    assert.strictEqual(res.status, 200); assert(res.data.equals(png));
    assert.strictEqual(res.headers['content-type'], 'image/png');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['cache-control'], 'private, no-store');
    res = response(); await context.handleThreadImage(request(`/codex/image?id=${reference.previewId}`, true, 'HEAD'), res);
    assert.strictEqual(res.data, undefined);
    res = response(); await context.handleThreadGoal(request('/codex/goal', false, 'POST', { threadId: 'thread' }), res);
    assert.strictEqual(res.status, 401); assert.strictEqual(mutations, 0);
    res = response(); await context.handleThreadGoal(request('/codex/goal', true, 'POST', { threadId: '../' }), res);
    assert.strictEqual(res.status, 400); assert.strictEqual(mutations, 0);
    res = response(); await context.handleThreadGoal(request('/codex/goal?thread=thread'), res);
    assert.strictEqual(res.data.goal, null);
    res = response(); await context.handleThreadGoal(request('/codex/goal', true, 'POST', { threadId: 'thread', action: 'update', objective: '保存' }), res);
    assert.strictEqual(res.data.goal.objective, '保存'); assert.strictEqual(mutations, 1);
    console.log('Image and Goal routes passed: authorization, opaque IDs, MIME checks, limits, missing files and Goal request scope.');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
